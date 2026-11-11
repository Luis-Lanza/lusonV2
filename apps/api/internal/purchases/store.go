package purchases

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
)

// Store persists and reads the purchase documents of a branch.
type Store struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// fail retains cancellation semantics but never driver/config/SQL details.
func fail(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return ErrUnavailable
}

// purchaseLock serializes one operation key, so an identical concurrent submission
// resolves to a replay instead of a unique violation. Transaction scoped: the database
// releases it on commit, rollback or disconnect.
func purchaseLock(key string) int64 {
	h := sha256.Sum256([]byte("luson.purchase/retry/v1:" + key))
	return int64(binary.BigEndian.Uint64(h[:8]))
}

type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

// branchClerk admits only a completed branch session: the warehouse is not a buyer and a
// session that still must change its password operates nothing.
func branchClerk(actor auth.Identity) bool {
	return actor.AccountID > 1 && actor.Location.ID > warehouseLocationID &&
		actor.Location.ID <= maxBranchLocationID && !actor.MustChangePassword
}

// resolveBranch is the actor-to-branch authority: the branch a session buys in is the
// account's own provisioned location, never a value from the request. An account without a
// provisioned branch assignment, a retired account and a retired branch are all refused
// instead of being defaulted to some other branch.
func resolveBranch(ctx context.Context, q querier, actor auth.Identity) (int16, error) {
	var branch int16
	err := q.QueryRow(ctx, `SELECT a.location_id FROM auth_accounts a
 JOIN locations l ON l.id=a.location_id AND l.deleted_at IS NULL
 WHERE a.id=$1 AND a.location_id=$2 AND a.deleted_at IS NULL AND a.location_id>$3`,
		actor.AccountID, actor.Location.ID, warehouseLocationID).Scan(&branch)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrForbidden
	}
	if err != nil {
		return 0, fail(ctx)
	}
	return branch, nil
}

// Create applies one immutable purchase atomically in the actor's own branch: the header
// and every line of both kinds are one transaction, so a refused line leaves the ledger
// exactly as it was. The branch, the actor, the amounts and the mirror of a
// counter-document are the database's own.
//
// The canonical payload is resolved first, so an identical replay returns the persisted
// document and a different payload under the same operation key is a conflict, never a
// second document.
func (s *Store) Create(ctx context.Context, actor auth.Identity, input CreateInput) (Document, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Document{}, ErrUnavailable
	}
	if !branchClerk(actor) {
		return Document{}, ErrForbidden
	}
	payload, err := Validate(input)
	if err != nil {
		return Document{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Document{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", purchaseLock(payload.OperationKey)); err != nil {
		return Document{}, fail(ctx)
	}
	branch, err := resolveBranch(ctx, tx, actor)
	if err != nil {
		return Document{}, err
	}
	// An operation key that already exists is answered, never repeated. A key of another
	// branch belongs to that branch's document, so it is a conflict here.
	existingID, existingBranch, err := reservedOperation(ctx, tx, payload.OperationKey)
	if err != nil {
		return Document{}, err
	}
	if existingID != 0 {
		existing, err := loadDocument(ctx, tx, existingID)
		if err != nil {
			return Document{}, err
		}
		if existingBranch != branch || !samePayload(existing, payload) {
			return Document{}, ErrRetryConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return Document{}, fail(ctx)
		}
		return existing, nil
	}
	if err := admitMaterials(ctx, tx, payload.ScrapLines); err != nil {
		return Document{}, err
	}
	var id int64
	err = tx.QueryRow(ctx, `INSERT INTO purchases(operation_key,location_id,note,total,paid_cash,paid_transfer,created_by_account_id)
 VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, payload.OperationKey, branch, payload.Note,
		string(payload.Total), string(payload.PaidCash), string(payload.PaidTransfer),
		int64(actor.AccountID)).Scan(&id)
	if err != nil {
		return Document{}, mapFailure(ctx, err)
	}
	for _, line := range payload.UsedLines {
		if _, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,$2,$3,$4)`, id, line.Model, line.Quantity, string(line.UnitPrice)); err != nil {
			return Document{}, mapFailure(ctx, err)
		}
	}
	for _, line := range payload.ScrapLines {
		if _, err := tx.Exec(ctx, `INSERT INTO purchase_scrap_lines(purchase_id,material_id,kg,price_per_kg)
 VALUES($1,$2,$3,$4)`, id, int16(line.MaterialID), string(line.Kg),
			string(line.PricePerKg)); err != nil {
			return Document{}, mapFailure(ctx, err)
		}
	}
	document, err := loadDocument(ctx, tx, id)
	if err != nil {
		return Document{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Document{}, mapFailure(ctx, err)
	}
	return document, nil
}

// Reverse appends the immutable counter-document of one persisted original. The client
// never supplies lines: they are derived from the persisted original, so a partial
// reversal is impossible by construction.
//
// The operation key is serialized first, so an identical concurrent submission resolves to
// a replay instead of a unique violation, and the target row is locked before it is
// judged, so two reversals of one document cannot both pass the check.
func (s *Store) Reverse(ctx context.Context, actor auth.Identity, targetID int64, operationKey, reason string) (Document, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Document{}, ErrUnavailable
	}
	if !branchClerk(actor) {
		return Document{}, ErrForbidden
	}
	if targetID < 1 {
		return Document{}, ErrNotFound
	}
	if !ValidOperationKey(operationKey) {
		return Document{}, ErrInvalid
	}
	canonicalReason, valid := CanonicalReason(reason)
	if !valid {
		return Document{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Document{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", purchaseLock(operationKey)); err != nil {
		return Document{}, fail(ctx)
	}
	branch, err := resolveBranch(ctx, tx, actor)
	if err != nil {
		return Document{}, err
	}
	// An existing operation key is resolved before the target is touched: the same key
	// with the same target and reason is a replay, anything else is a conflict and never a
	// second counter-document.
	existingID, existingBranch, err := reservedOperation(ctx, tx, operationKey)
	if err != nil {
		return Document{}, err
	}
	if existingID != 0 {
		existing, err := loadDocument(ctx, tx, existingID)
		if err != nil {
			return Document{}, err
		}
		if existingBranch != branch || existing.ReversesPurchaseID == nil ||
			*existing.ReversesPurchaseID != targetID || existing.Reason != canonicalReason {
			return Document{}, ErrRetryConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return Document{}, fail(ctx)
		}
		return existing, nil
	}
	// The target row is locked before it is judged, so a concurrent reversal of the same
	// document cannot slip between the check and the insert.
	var location int
	var reverses *int64
	var alreadyReversed bool
	err = tx.QueryRow(ctx, `SELECT p.location_id,p.reverses_purchase_id,
  EXISTS(SELECT 1 FROM purchases counter WHERE counter.reverses_purchase_id=p.id)
 FROM purchases p WHERE p.id=$1 FOR UPDATE`, targetID).Scan(&location, &reverses, &alreadyReversed)
	if errors.Is(err, pgx.ErrNoRows) {
		return Document{}, ErrNotFound
	}
	if err != nil {
		return Document{}, fail(ctx)
	}
	// A document of another branch is not part of this branch's ledger.
	if location != int(branch) {
		return Document{}, ErrNotFound
	}
	if reverses != nil || alreadyReversed {
		return Document{}, ErrAlreadyReversed
	}
	original, err := loadDocument(ctx, tx, targetID)
	if err != nil {
		return Document{}, err
	}
	derived, err := counterOf(original)
	if err != nil {
		return Document{}, err
	}
	var id int64
	err = tx.QueryRow(ctx, `INSERT INTO purchases(operation_key,location_id,note,total,paid_cash,paid_transfer,
  reverses_purchase_id,reason,created_by_account_id)
 VALUES($1,$2,'',$3,$4,$5,$6,$7,$8) RETURNING id`, operationKey, branch,
		string(derived.Total), string(derived.PaidCash), string(derived.PaidTransfer),
		targetID, canonicalReason, int64(actor.AccountID)).Scan(&id)
	if err != nil {
		return Document{}, mapFailure(ctx, err)
	}
	for _, line := range derived.UsedLines {
		if _, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,$2,$3,$4)`, id, line.Model, line.Quantity, string(line.UnitPrice)); err != nil {
			return Document{}, mapFailure(ctx, err)
		}
	}
	for _, line := range derived.ScrapLines {
		if _, err := tx.Exec(ctx, `INSERT INTO purchase_scrap_lines(purchase_id,material_id,kg,price_per_kg)
 VALUES($1,$2,$3,$4)`, id, int16(line.MaterialID), string(line.Kg),
			string(line.PricePerKg)); err != nil {
			return Document{}, mapFailure(ctx, err)
		}
	}
	document, err := loadDocument(ctx, tx, id)
	if err != nil {
		return Document{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Document{}, mapFailure(ctx, err)
	}
	return document, nil
}

// List reads one newest-first page of the actor's own branch history. The page is one
// count plus one page statement: the unit total and the scrap line count of each row are
// summed by the database, never by a Go loop over every line, and the unit total is cast
// to text before it becomes an int64 so an out-of-range sum fails closed.
func (s *Store) List(ctx context.Context, actor auth.Identity, page, pageSize int) (Page, error) {
	result := Page{Page: page, PageSize: pageSize, Purchases: []Summary{}}
	if ctx == nil || s == nil || s.pool == nil {
		return Page{}, ErrUnavailable
	}
	if !branchClerk(actor) {
		return Page{}, ErrForbidden
	}
	// Every rejected page or size stops here, before the first statement.
	if !ValidPage(page, pageSize) {
		return Page{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	branch, err := resolveBranch(ctx, s.pool, actor)
	if err != nil {
		return Page{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Page{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	if tx.QueryRow(ctx, "SELECT count(*) FROM purchases WHERE location_id=$1", branch).Scan(&result.TotalPurchases) != nil {
		return Page{}, fail(ctx)
	}
	rows, err := tx.Query(ctx, `SELECT p.id,p.created_at,p.total::text,p.reverses_purchase_id,
  (SELECT counter.id FROM purchases counter WHERE counter.reverses_purchase_id=p.id),
  coalesce((SELECT sum(unit.quantity) FROM purchase_used_lines unit WHERE unit.purchase_id=p.id),0)::text,
  (SELECT count(*) FROM purchase_scrap_lines scrap WHERE scrap.purchase_id=p.id)
 FROM purchases p WHERE p.location_id=$1
 ORDER BY p.id DESC LIMIT $2 OFFSET $3`,
		branch, int64(pageSize), int64(page-1)*int64(pageSize))
	if err != nil {
		return Page{}, fail(ctx)
	}
	defer rows.Close()
	for rows.Next() {
		var summary Summary
		var total, units string
		var scrap int64
		if rows.Scan(&summary.ID, &summary.CreatedAt, &total, &summary.ReversesPurchaseID,
			&summary.ReversedBy, &units, &scrap) != nil {
			return Page{}, fail(ctx)
		}
		summary.Total = Money(total)
		if _, ok := centsOf(total); !ok || summary.ID < 1 || summary.CreatedAt.IsZero() ||
			scrap < 0 || scrap > MaxLines ||
			(len(result.Purchases) > 0 && summary.ID >= result.Purchases[len(result.Purchases)-1].ID) {
			return Page{}, ErrUnavailable
		}
		// A document carries at most MaxLines used lines of at most MaxQuantity units, so a
		// unit total outside that range is not a document this domain wrote.
		value, err := strconv.ParseInt(units, 10, 64)
		if err != nil || value > MaxLines*MaxQuantity || value < -MaxLines*MaxQuantity {
			return Page{}, ErrUnavailable
		}
		if !signOf(summary.Total, summary.ReversesPurchaseID) {
			return Page{}, ErrUnavailable
		}
		if summary.ReversedBy != nil && (*summary.ReversedBy <= summary.ID || summary.ReversesPurchaseID != nil) {
			return Page{}, ErrUnavailable
		}
		summary.UsedUnits = value
		summary.ScrapLines = int(scrap)
		result.Purchases = append(result.Purchases, summary)
	}
	if rows.Err() != nil {
		return Page{}, fail(ctx)
	}
	if tx.Commit(ctx) != nil {
		return Page{}, fail(ctx)
	}
	return result, nil
}

// Detail reads one persisted document of the actor's own branch: the header, its used
// lines and its scrap lines with the name of their material. A document of another branch
// is not found, exactly like an unknown one.
func (s *Store) Detail(ctx context.Context, actor auth.Identity, id int64) (Document, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Document{}, ErrUnavailable
	}
	if !branchClerk(actor) {
		return Document{}, ErrForbidden
	}
	// Only a positive document id reaches the database; an aliased or impossible one stays
	// not found exactly like an unknown document.
	if id < 1 {
		return Document{}, ErrNotFound
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	branch, err := resolveBranch(ctx, s.pool, actor)
	if err != nil {
		return Document{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Document{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	document, err := loadDocument(ctx, tx, id)
	if err != nil {
		return Document{}, err
	}
	if document.LocationID != int(branch) {
		return Document{}, ErrNotFound
	}
	if tx.Commit(ctx) != nil {
		return Document{}, fail(ctx)
	}
	return document, nil
}

// Models reads the distinct model codes of the active catalogue, ascending and
// deduplicated across brands: "modelos sin repetir entre marcas". There is no mirror list
// to maintain, so a model created in the catalogue appears here by itself, and a model
// typed freely in a purchase never does.
func (s *Store) Models(ctx context.Context, actor auth.Identity) ([]string, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return nil, ErrUnavailable
	}
	if !branchClerk(actor) {
		return nil, ErrForbidden
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if _, err := resolveBranch(ctx, s.pool, actor); err != nil {
		return nil, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	rows, err := tx.Query(ctx, `SELECT model FROM catalog_entries
 WHERE deleted_at IS NULL ORDER BY model COLLATE "C"`)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	models := make([]string, 0, 96)
	for rows.Next() {
		var model string
		if rows.Scan(&model) != nil {
			return nil, fail(ctx)
		}
		// A catalogue model is non-empty text; anything else is not a row this catalogue
		// wrote, so the list fails closed instead of publishing it. The list is
		// deduplicated across brands: "modelos sin repetir entre marcas".
		if !boundedText(model, 1, maxCategoryText) || len(models) >= maxCatalogueRows {
			return nil, ErrUnavailable
		}
		if len(models) > 0 {
			switch {
			case model == models[len(models)-1]:
				continue
			case model < models[len(models)-1]:
				return nil, ErrUnavailable
			}
		}
		models = append(models, model)
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	if tx.Commit(ctx) != nil {
		return nil, fail(ctx)
	}
	return models, nil
}

// Materials reads the reference materials, ordered by id: the list is typed data the
// branch buys by the kilogram, never a client value.
func (s *Store) Materials(ctx context.Context, actor auth.Identity) ([]Material, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return nil, ErrUnavailable
	}
	if !branchClerk(actor) {
		return nil, ErrForbidden
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if _, err := resolveBranch(ctx, s.pool, actor); err != nil {
		return nil, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	rows, err := tx.Query(ctx, "SELECT id,name FROM materials ORDER BY id")
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	materials := make([]Material, 0, 4)
	for rows.Next() {
		var material Material
		if rows.Scan(&material.ID, &material.Name) != nil {
			return nil, fail(ctx)
		}
		if material.ID < 1 || material.ID > maxMaterialID ||
			!boundedText(material.Name, 1, maxCategoryText) ||
			(len(materials) > 0 && material.ID <= materials[len(materials)-1].ID) {
			return nil, ErrUnavailable
		}
		materials = append(materials, material)
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	if tx.Commit(ctx) != nil {
		return nil, fail(ctx)
	}
	return materials, nil
}

// LastPrices reads the anchor the counter shows next to each input: the most recent price
// paid in this branch for a model and for a material, taken from the latest line with a
// positive quantity of a document that is not a counter-document. A model or material never
// bought here is simply absent.
func (s *Store) LastPrices(ctx context.Context, actor auth.Identity) (LastPrices, error) {
	result := LastPrices{Models: []ModelPrice{}, Materials: []MaterialPrice{}}
	if ctx == nil || s == nil || s.pool == nil {
		return LastPrices{}, ErrUnavailable
	}
	if !branchClerk(actor) {
		return LastPrices{}, ErrForbidden
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	branch, err := resolveBranch(ctx, s.pool, actor)
	if err != nil {
		return LastPrices{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return LastPrices{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	rows, err := tx.Query(ctx, `SELECT model,unit_price::text,created_at FROM (
  SELECT line.model AS model,line.unit_price::text AS unit_price,p.created_at AS created_at,
         row_number() OVER (PARTITION BY line.model ORDER BY p.id DESC) AS position
  FROM purchase_used_lines line
  JOIN purchases p ON p.id=line.purchase_id
  WHERE p.location_id=$1 AND p.reverses_purchase_id IS NULL AND line.quantity > 0
 ) latest WHERE position=1 ORDER BY model COLLATE "C"`, branch)
	if err != nil {
		return LastPrices{}, fail(ctx)
	}
	for rows.Next() {
		var price ModelPrice
		var unit string
		if rows.Scan(&price.Model, &unit, &price.PurchasedAt) != nil {
			rows.Close()
			return LastPrices{}, fail(ctx)
		}
		price.UnitPrice = Money(unit)
		model, ok := CanonicalModel(price.Model)
		if !ok || model != price.Model || price.PurchasedAt.IsZero() || !positiveMoney(price.UnitPrice) ||
			len(result.Models) >= maxCatalogueRows ||
			(len(result.Models) > 0 && price.Model <= result.Models[len(result.Models)-1].Model) {
			rows.Close()
			return LastPrices{}, ErrUnavailable
		}
		result.Models = append(result.Models, price)
	}
	if rows.Err() != nil {
		rows.Close()
		return LastPrices{}, fail(ctx)
	}
	rows.Close()
	rows, err = tx.Query(ctx, `SELECT material_id,price_per_kg::text,created_at FROM (
  SELECT line.material_id AS material_id,line.price_per_kg::text AS price_per_kg,
         p.created_at AS created_at,
         row_number() OVER (PARTITION BY line.material_id ORDER BY p.id DESC) AS position
  FROM purchase_scrap_lines line
  JOIN purchases p ON p.id=line.purchase_id
  WHERE p.location_id=$1 AND p.reverses_purchase_id IS NULL AND line.kg > 0
 ) latest WHERE position=1 ORDER BY material_id`, branch)
	if err != nil {
		return LastPrices{}, fail(ctx)
	}
	defer rows.Close()
	for rows.Next() {
		var price MaterialPrice
		var unit string
		if rows.Scan(&price.MaterialID, &unit, &price.PurchasedAt) != nil {
			return LastPrices{}, fail(ctx)
		}
		price.PricePerKg = Money(unit)
		if price.MaterialID < 1 || price.MaterialID > maxMaterialID || price.PurchasedAt.IsZero() ||
			!positiveMoney(price.PricePerKg) ||
			(len(result.Materials) > 0 && price.MaterialID <= result.Materials[len(result.Materials)-1].MaterialID) {
			return LastPrices{}, ErrUnavailable
		}
		result.Materials = append(result.Materials, price)
	}
	if rows.Err() != nil {
		return LastPrices{}, fail(ctx)
	}
	if tx.Commit(ctx) != nil {
		return LastPrices{}, fail(ctx)
	}
	return result, nil
}

// Received reads what the branch has received, derived from every persisted document of
// the branch so a counter-document nets out by construction: per model and per material,
// with the money the branch spent. Rows whose net quantity or weight is zero are omitted.
func (s *Store) Received(ctx context.Context, actor auth.Identity) (Received, error) {
	result := Received{Used: []ReceivedUsed{}, Scrap: []ReceivedScrap{}}
	if ctx == nil || s == nil || s.pool == nil {
		return Received{}, ErrUnavailable
	}
	if !branchClerk(actor) {
		return Received{}, ErrForbidden
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	branch, err := resolveBranch(ctx, s.pool, actor)
	if err != nil {
		return Received{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Received{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	rows, err := tx.Query(ctx, `SELECT line.model,sum(line.quantity)::text,sum(line.amount)::text
 FROM purchase_used_lines line
 JOIN purchases p ON p.id=line.purchase_id
 WHERE p.location_id=$1
 GROUP BY line.model HAVING sum(line.quantity) <> 0
 ORDER BY line.model COLLATE "C"`, branch)
	if err != nil {
		return Received{}, fail(ctx)
	}
	for rows.Next() {
		var row ReceivedUsed
		var quantity, value string
		if rows.Scan(&row.Model, &quantity, &value) != nil {
			rows.Close()
			return Received{}, fail(ctx)
		}
		row.Value = Money(value)
		units, err := strconv.ParseInt(quantity, 10, 64)
		// A received row is an original document netted by its counter-documents, so a
		// positive quantity and a positive value are the only shape this domain wrote.
		if err != nil || units < 1 || units > MaxLines*MaxQuantity ||
			!boundedText(row.Model, 1, maxCategoryText) || !positiveMoney(row.Value) ||
			len(result.Used) >= maxCatalogueRows ||
			(len(result.Used) > 0 && row.Model <= result.Used[len(result.Used)-1].Model) {
			rows.Close()
			return Received{}, ErrUnavailable
		}
		row.Quantity = units
		result.Used = append(result.Used, row)
	}
	if rows.Err() != nil {
		rows.Close()
		return Received{}, fail(ctx)
	}
	rows.Close()
	rows, err = tx.Query(ctx, `SELECT line.material_id,material.name,sum(line.kg)::text,sum(line.amount)::text
 FROM purchase_scrap_lines line
 JOIN purchases p ON p.id=line.purchase_id
 JOIN materials material ON material.id=line.material_id
 WHERE p.location_id=$1
 GROUP BY line.material_id,material.name HAVING sum(line.kg) <> 0
 ORDER BY line.material_id`, branch)
	if err != nil {
		return Received{}, fail(ctx)
	}
	defer rows.Close()
	for rows.Next() {
		var row ReceivedScrap
		var kg, value string
		if rows.Scan(&row.MaterialID, &row.Name, &kg, &value) != nil {
			return Received{}, fail(ctx)
		}
		row.Value = Money(value)
		milli, kgOK := milliOf(kg)
		weight, _ := weightOfMilli(milli)
		// A weight whose kilogram price rounds to the cent can net to a zero value, so a
		// scrap row admits 0.00: what it may never be is negative or out of range.
		if !kgOK || milli < 1 || milli > maxMilli || weight == "" {
			return Received{}, ErrUnavailable
		}
		valueCents, valueOK := centsOf(value)
		if !valueOK || valueCents < 0 || row.MaterialID < 1 || row.MaterialID > maxMaterialID ||
			!boundedText(row.Name, 1, maxCategoryText) ||
			(len(result.Scrap) > 0 && row.MaterialID <= result.Scrap[len(result.Scrap)-1].MaterialID) {
			return Received{}, ErrUnavailable
		}
		row.Kg = weight
		result.Scrap = append(result.Scrap, row)
	}
	if rows.Err() != nil {
		return Received{}, fail(ctx)
	}
	if tx.Commit(ctx) != nil {
		return Received{}, fail(ctx)
	}
	return result, nil
}

// reservedOperation reads the document already persisted under one operation key, if any,
// together with its branch. A key never repeats across documents, so at most one row is
// answered, and the caller compares the payload instead of trusting the key alone.
func reservedOperation(ctx context.Context, q querier, key string) (int64, int16, error) {
	var id int64
	var branch int16
	err := q.QueryRow(ctx, "SELECT id,location_id FROM purchases WHERE operation_key=$1", key).Scan(&id, &branch)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, 0, nil
	}
	if err != nil {
		return 0, 0, fail(ctx)
	}
	return id, branch, nil
}

// admitMaterials refuses a scrap line that names a material the reference table does not
// hold, before any line is written. It is one statement for the whole document.
func admitMaterials(ctx context.Context, q querier, lines []ScrapLine) error {
	if len(lines) == 0 {
		return nil
	}
	ids := make([]int16, len(lines))
	for i, line := range lines {
		ids[i] = int16(line.MaterialID)
	}
	var found int64
	if err := q.QueryRow(ctx, "SELECT count(*) FROM materials WHERE id=ANY($1)", ids).Scan(&found); err != nil {
		return fail(ctx)
	}
	if found != int64(len(ids)) {
		return ErrInvalid
	}
	return nil
}

// samePayload compares a persisted document with a canonical payload, so a replay is
// answered only when it is the same document: the note, the settlement, every model and
// every material, with their quantities and prices.
func samePayload(document Document, payload Payload) bool {
	if document.Note != payload.Note || document.Total != payload.Total ||
		document.PaidCash != payload.PaidCash || document.PaidTransfer != payload.PaidTransfer ||
		document.ReversesPurchaseID != nil || len(document.UsedLines) != len(payload.UsedLines) ||
		len(document.ScrapLines) != len(payload.ScrapLines) {
		return false
	}
	for i, line := range payload.UsedLines {
		persisted := document.UsedLines[i]
		if persisted.Model != line.Model || persisted.Quantity != line.Quantity ||
			persisted.UnitPrice != line.UnitPrice || persisted.Amount != line.Amount {
			return false
		}
	}
	for i, line := range payload.ScrapLines {
		persisted := document.ScrapLines[i]
		if persisted.MaterialID != line.MaterialID || persisted.Kg != line.Kg ||
			persisted.PricePerKg != line.PricePerKg || persisted.Amount != line.Amount {
			return false
		}
	}
	return true
}

// counterOf derives the counter-document of one persisted original: the same lines with
// negated quantity and kg, the same prices, and the negated amounts. A persisted document
// whose amounts are outside the admitted bounds is not a document this domain wrote, so the
// derivation fails closed instead of inventing a reversal the database would refuse.
func counterOf(original Document) (Payload, error) {
	unavailable := func() (Payload, error) { return Payload{}, ErrUnavailable }
	if original.ReversesPurchaseID != nil || original.ReversedBy != nil ||
		original.Reason != "" || len(original.UsedLines)+len(original.ScrapLines) < 1 ||
		len(original.UsedLines) > MaxLines || len(original.ScrapLines) > MaxLines {
		return unavailable()
	}
	total, ok := negateMoney(original.Total, 1)
	if !ok {
		return unavailable()
	}
	cash, ok := negateMoney(original.PaidCash, 0)
	if !ok {
		return unavailable()
	}
	transfer, ok := negateMoney(original.PaidTransfer, 0)
	if !ok {
		return unavailable()
	}
	derived := Payload{Total: total, PaidCash: cash, PaidTransfer: transfer,
		UsedLines:  make([]UsedLine, 0, len(original.UsedLines)),
		ScrapLines: make([]ScrapLine, 0, len(original.ScrapLines))}
	for _, line := range original.UsedLines {
		if line.Quantity < 1 || line.Quantity > MaxQuantity {
			return unavailable()
		}
		amount, ok := usedAmount(-line.Quantity, line.UnitPrice)
		if !ok || amount != negate(line.Amount) {
			return unavailable()
		}
		derived.UsedLines = append(derived.UsedLines, UsedLine{Model: line.Model,
			Quantity: -line.Quantity, UnitPrice: line.UnitPrice, Amount: amount})
	}
	for _, line := range original.ScrapLines {
		milli, ok := milliOf(string(line.Kg))
		if !ok || milli < 1 || milli > maxMilli {
			return unavailable()
		}
		kg, ok := weightOfMilli(-milli)
		if !ok {
			return unavailable()
		}
		amount, ok := scrapAmount(kg, line.PricePerKg)
		if !ok || amount != negate(line.Amount) {
			return unavailable()
		}
		derived.ScrapLines = append(derived.ScrapLines, ScrapLine{MaterialID: line.MaterialID,
			Kg: kg, PricePerKg: line.PricePerKg, Amount: amount})
	}
	return derived, nil
}

// negateMoney renders the negation of a persisted amount. A minimal side is the smallest
// magnitude that side may carry: one cent for the total of an original purchase, zero for a
// paid amount.
func negateMoney(amount Money, minimal int64) (Money, bool) {
	cents, ok := centsOf(string(amount))
	if !ok || cents < minimal || cents < -maxCents || cents > maxCents {
		return "", false
	}
	return moneyOfCents(-cents)
}

// negate renders the negation of a canonical amount without a float.
func negate(amount Money) Money {
	negated, ok := moneyOfCents(mustCents(amount) * -1)
	if !ok {
		return ""
	}
	return negated
}

func mustCents(amount Money) int64 {
	cents, _ := centsOf(string(amount))
	return cents
}

// signOf admits the sign rule of a persisted amount: an original purchase spends money and
// its counter-document returns it, so the sign of the document must be the one its reversal
// binding states.
func signOf(amount Money, reverses *int64) bool {
	cents, ok := centsOf(string(amount))
	if !ok {
		return false
	}
	if reverses == nil {
		return cents > 0
	}
	return cents < 0
}

// positiveMoney admits a persisted price: canonical two-decimal text above zero.
func positiveMoney(amount Money) bool {
	cents, ok := centsOf(string(amount))
	return ok && cents > 0
}

// loadDocument reads one persisted document with both line kinds and the name of every
// material, and fails closed on any persisted shape this domain never wrote.
func loadDocument(ctx context.Context, q querier, id int64) (Document, error) {
	var document Document
	var total, cash, transfer string
	err := q.QueryRow(ctx, `SELECT p.id,p.location_id,p.note,p.total::text,p.paid_cash::text,
  p.paid_transfer::text,p.created_by_account_id,p.created_at,p.reverses_purchase_id,p.reason,
  (SELECT counter.id FROM purchases counter WHERE counter.reverses_purchase_id=p.id)
 FROM purchases p WHERE p.id=$1`, id).Scan(&document.ID, &document.LocationID, &document.Note,
		&total, &cash, &transfer, &document.CreatedByAccountID, &document.CreatedAt,
		&document.ReversesPurchaseID, &document.Reason, &document.ReversedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return Document{}, ErrNotFound
	}
	if err != nil {
		return Document{}, fail(ctx)
	}
	document.Total, document.PaidCash, document.PaidTransfer = Money(total), Money(cash), Money(transfer)
	if document.ID < 1 || document.LocationID <= warehouseLocationID ||
		document.LocationID > maxBranchLocationID || document.CreatedByAccountID < 1 ||
		document.CreatedAt.IsZero() || !validNote(document.Note) ||
		!signOf(document.Total, document.ReversesPurchaseID) ||
		!settles(document.Total, document.PaidCash, document.PaidTransfer) {
		return Document{}, ErrUnavailable
	}
	if document.ReversesPurchaseID != nil {
		reason, ok := CanonicalReason(document.Reason)
		if !ok || reason != document.Reason || *document.ReversesPurchaseID < 1 ||
			*document.ReversesPurchaseID >= document.ID {
			return Document{}, ErrUnavailable
		}
	} else if document.Reason != "" {
		return Document{}, ErrUnavailable
	}
	// A document is only ever reversed by a later document of this branch, and a
	// counter-document is never reversed itself.
	if document.ReversedBy != nil && (*document.ReversedBy <= document.ID || document.ReversesPurchaseID != nil) {
		return Document{}, ErrUnavailable
	}
	used, err := loadUsedLines(ctx, q, document)
	if err != nil {
		return Document{}, err
	}
	scrap, err := loadScrapLines(ctx, q, document)
	if err != nil {
		return Document{}, err
	}
	if len(used)+len(scrap) < 1 {
		return Document{}, ErrUnavailable
	}
	document.UsedLines, document.ScrapLines = used, scrap
	return document, nil
}

// settles admits the settlement of a persisted document: the two paid amounts close against
// its own total, exactly, and each of them is canonical.
func settles(total, cash, transfer Money) bool {
	totalCents, ok := centsOf(string(total))
	if !ok {
		return false
	}
	cashCents, ok := centsOf(string(cash))
	if !ok {
		return false
	}
	transferCents, ok := centsOf(string(transfer))
	if !ok || cashCents < -maxCents || transferCents < -maxCents ||
		totalCents > maxCents || totalCents < -maxCents {
		return false
	}
	if totalCents < 0 {
		// A counter-document returns money: neither side is positive.
		if cashCents > 0 || transferCents > 0 {
			return false
		}
	} else if cashCents < 0 || transferCents < 0 {
		return false
	}
	return cashCents+transferCents == totalCents
}

// loadUsedLines reads the used lines of one document in ascending model order, re-deriving
// every amount from its persisted quantity and price so a tampered row fails the read.
func loadUsedLines(ctx context.Context, q querier, document Document) ([]UsedLine, error) {
	rows, err := q.Query(ctx, `SELECT model,quantity,unit_price::text,amount::text
 FROM purchase_used_lines WHERE purchase_id=$1 ORDER BY model COLLATE "C"`, document.ID)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	lines := make([]UsedLine, 0, 4)
	for rows.Next() {
		var line UsedLine
		var price, amount string
		if rows.Scan(&line.Model, &line.Quantity, &price, &amount) != nil {
			return nil, fail(ctx)
		}
		line.UnitPrice, line.Amount = Money(price), Money(amount)
		model, ok := CanonicalModel(line.Model)
		expected, derived := usedAmount(line.Quantity, line.UnitPrice)
		if !ok || model != line.Model || !positiveMoney(line.UnitPrice) ||
			line.Quantity == 0 || line.Quantity > MaxQuantity || line.Quantity < -MaxQuantity ||
			!derived || expected != line.Amount ||
			(document.ReversesPurchaseID == nil) != (line.Quantity > 0) ||
			(len(lines) > 0 && line.Model <= lines[len(lines)-1].Model) || len(lines) >= MaxLines {
			return nil, ErrUnavailable
		}
		lines = append(lines, line)
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	return lines, nil
}

// loadScrapLines reads the scrap lines of one document in ascending material order with the
// name of their material, re-deriving every amount from its persisted weight and price.
func loadScrapLines(ctx context.Context, q querier, document Document) ([]ScrapLine, error) {
	rows, err := q.Query(ctx, `SELECT line.material_id,material.name,line.kg::text,
  line.price_per_kg::text,line.amount::text
 FROM purchase_scrap_lines line
 JOIN materials material ON material.id=line.material_id
 WHERE line.purchase_id=$1 ORDER BY line.material_id`, document.ID)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	lines := make([]ScrapLine, 0, 4)
	for rows.Next() {
		var line ScrapLine
		var kg, price, amount string
		if rows.Scan(&line.MaterialID, &line.Name, &kg, &price, &amount) != nil {
			return nil, fail(ctx)
		}
		line.Kg, line.PricePerKg, line.Amount = Weight(kg), Money(price), Money(amount)
		milli, kgOK := milliOf(kg)
		expected, derived := scrapAmount(line.Kg, line.PricePerKg)
		if !kgOK || milli == 0 || milli > maxMilli || milli < -maxMilli ||
			!positiveMoney(line.PricePerKg) || !derived || expected != line.Amount ||
			line.MaterialID < 1 || line.MaterialID > maxMaterialID ||
			!boundedText(line.Name, 1, maxCategoryText) ||
			// The weight of a line negates with the document, exactly like its amount.
			(document.ReversesPurchaseID == nil) != (milli > 0) ||
			(len(lines) > 0 && line.MaterialID <= lines[len(lines)-1].MaterialID) ||
			len(lines) >= MaxLines {
			return nil, ErrUnavailable
		}
		lines = append(lines, line)
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	return lines, nil
}

// mapFailure publishes the database's own decision and nothing else: SQLSTATE is the only
// trusted evidence, and cancellation keeps its semantics. LP002 (the settlement), LP003
// (the mirror) and LP005 (the line and sign rules) are refusals this store already derived,
// so reaching them means the request broke a rule the contract publishes as an invalid
// document; LP001 is the branch authority and LP004 the already-reversed document.
func mapFailure(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "LP001":
			return ErrForbidden
		case "LP002", "LP003", "LP005":
			return ErrInvalid
		case "LP004":
			return ErrAlreadyReversed
		// A refused amount or a refused document shape is the same public refusal, because
		// the database decides it. A foreign key is deliberately not mapped: an unknown
		// material is refused before any line is written, so reaching one means the ledger
		// is not what this domain wrote and the read fails closed.
		case "23514", "22003":
			return ErrInvalid
		// 23505 on the single-reversal index is the same already-reversed refusal reached
		// through a concurrent writer; any other unique violation stays unmapped.
		case "23505":
			if pg.ConstraintName == "purchases_single_reversal" {
				return ErrAlreadyReversed
			}
		}
	}
	return ErrUnavailable
}
