package sales

import (
	"context"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/catalog"
)

type Store struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// fail retains cancellation semantics but never driver/config/SQL details.
func fail(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return ErrUnavailable
}

type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

// resolveBranch is the actor-to-branch authority: the branch a session sells in is
// the account's own provisioned location, never a value from the request. An account
// without a provisioned branch assignment, a retired account and a retired branch are
// all refused instead of being defaulted to some other branch.
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

// Create applies one immutable sale atomically in the actor's own branch: the header,
// every line and the stock decrement are one transaction, so a refused line leaves the
// ledger exactly as it was. The client supplies how the total was settled, the client and
// the lines; the branch, the actor, the per-branch correlative, the warranty number, the
// frozen minimum, the frozen warranty term, the subtotal and the payment label are the
// database's own.
//
// Lines are inserted in ascending variant order, which is the database's balance-row
// lock order, and the document completeness plus its total are deferred triggers, so a
// document that does not add up is still refused at commit.
func (s *Store) Create(ctx context.Context, actor auth.Identity, input CreateInput) (Sale, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Sale{}, ErrUnavailable
	}
	if !branchClerk(actor) {
		return Sale{}, ErrForbidden
	}
	payload, err := Validate(input)
	if err != nil {
		return Sale{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Sale{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	branch, err := resolveBranch(ctx, tx, actor)
	if err != nil {
		return Sale{}, err
	}
	var id int64
	// The branch correlative, the warranty number and the payment label are omitted on
	// purpose: the admission trigger allocates the first two and the third is a generated
	// column. created_by_account_id is the session identity, never a value from the
	// request, and each amount is written under its own method so the database can judge
	// the sum.
	cash, card, transfer := amountsOf(payload.Payments)
	err = tx.QueryRow(ctx, `INSERT INTO sales(branch_location_id,cash_amount,card_amount,transfer_amount,
  customer_name,customer_phone,customer_document,total,created_by_account_id)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
		branch, string(cash), string(card), string(transfer), payload.Customer.Name,
		payload.Customer.Phone, payload.Customer.Document, string(payload.Total),
		int64(actor.AccountID)).Scan(&id)
	if err != nil {
		return Sale{}, mapFailure(ctx, err)
	}
	for _, line := range payload.Lines {
		// The frozen floor and the subtotal are omitted on purpose: the line trigger
		// writes them from the branch's stored pair of the sold variant's battery (brand
		// + model + capacity), so both polarities of one battery are sold at the same
		// pair, and it derives the subtotal from the sold quantity. The line keeps the
		// polarity it sells: the warranty term is the seller's own input of this sale
		// and is stored as stated.
		if _, err := tx.Exec(ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price,warranty_months)
 VALUES($1,$2,$3,$4,$5)`, id, int32(line.VariantID), line.Quantity, string(line.UnitPrice),
			int16(line.WarrantyMonths)); err != nil {
			return Sale{}, mapFailure(ctx, err)
		}
	}
	sale, err := loadSale(ctx, tx, id)
	if err != nil {
		return Sale{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Sale{}, mapFailure(ctx, err)
	}
	return sale, nil
}

// loadSale reads one persisted sale with its lines exactly as the database stored it:
// the document numbers, the frozen prices, the frozen term and the derived subtotals.
func loadSale(ctx context.Context, q querier, id int64) (Sale, error) {
	sale, err := readHeader(ctx, q, id, 0)
	if err != nil {
		return Sale{}, err
	}
	rows, err := q.Query(ctx, `SELECT variant_id,quantity,unit_price::text,min_price::text,warranty_months,
  subtotal::text FROM sale_lines WHERE sale_id=$1 ORDER BY variant_id`, id)
	if err != nil {
		return Sale{}, fail(ctx)
	}
	defer rows.Close()
	lines := make([]SaleLine, 0, 4)
	for rows.Next() {
		var line SaleLine
		var unit, minimum, subtotal string
		if rows.Scan(&line.VariantID, &line.Quantity, &unit, &minimum, &line.WarrantyMonths,
			&subtotal) != nil {
			return Sale{}, fail(ctx)
		}
		// A persisted line outside the admitted bounds means the ledger is not what this
		// domain wrote, so the read fails closed instead of describing it.
		line.UnitPrice = Money(unit)
		line.MinPrice = Money(minimum)
		line.Subtotal = Money(subtotal)
		if line.UnitPrice.String() != unit || line.MinPrice.String() != minimum ||
			line.Subtotal.String() != subtotal ||
			!line.UnitPrice.AtLeast(line.MinPrice) ||
			line.VariantID < 1 || line.VariantID > math.MaxInt32 ||
			line.Quantity < 1 || line.Quantity > MaxQuantity ||
			line.WarrantyMonths < MinWarrantyMonths || line.WarrantyMonths > MaxWarrantyMonths ||
			(len(lines) > 0 && line.VariantID <= lines[len(lines)-1].VariantID) {
			return Sale{}, ErrUnavailable
		}
		lines = append(lines, line)
		if len(lines) > MaxLines {
			return Sale{}, ErrUnavailable
		}
	}
	if rows.Err() != nil {
		return Sale{}, fail(ctx)
	}
	if len(lines) == 0 {
		return Sale{}, ErrUnavailable
	}
	sale.Lines = lines
	return sale, nil
}

// readHeader reads one sale header. A non-zero branch is the read scope: a sale of
// another branch is not found, exactly like an unknown document. The three amount columns
// are read back as canonical text and rebuilt into the frozen-order payments, and the
// label is the generated column the database derived from them.
func readHeader(ctx context.Context, q querier, id, branch int64) (Sale, error) {
	var sale Sale
	var method, cash, card, transfer, total string
	scope := ""
	args := []any{id}
	if branch != 0 {
		scope = " AND s.branch_location_id=$2"
		args = append(args, branch)
	}
	err := q.QueryRow(ctx, `SELECT s.id,s.branch_location_id,s.branch_sequence,s.warranty_number,
  s.payment_method,s.cash_amount::text,s.card_amount::text,s.transfer_amount::text,
  s.customer_name,s.customer_phone,s.customer_document,s.total::text,
  s.created_by_account_id,s.created_at FROM sales s WHERE s.id=$1`+scope, args...).Scan(
		&sale.ID, &sale.BranchLocationID, &sale.BranchSequence, &sale.WarrantyNumber, &method,
		&cash, &card, &transfer, &sale.Customer.Name, &sale.Customer.Phone,
		&sale.Customer.Document, &total, &sale.CreatedByAccountID, &sale.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Sale{}, ErrNotFound
	}
	if err != nil {
		return Sale{}, fail(ctx)
	}
	payments, paid, ok := paymentsOf(cash, card, transfer)
	sale.PaymentMethod = PaymentMethod(method)
	sale.Payments = payments
	sale.Total = Money(total)
	totalCents, canonical := centsOf(sale.Total)
	// A persisted sale always carries one to three payments that close against its total,
	// and its derived label agrees with them: a record outside that shape is not what this
	// domain wrote, so the read fails closed instead of describing it.
	if !ok || !canonical || sale.Total.String() != total || len(payments) < 1 ||
		paid != totalCents || !sale.PaymentMethod.Recorded() ||
		(len(payments) > 1) != (sale.PaymentMethod == PaymentMixed) ||
		sale.BranchLocationID <= warehouseLocationID ||
		sale.BranchSequence < 1 || sale.WarrantyNumber == "" ||
		sale.CreatedByAccountID < 1 || sale.CreatedAt.IsZero() {
		return Sale{}, ErrUnavailable
	}
	return sale, nil
}

// maxBranchName is the bound of a branch name this store publishes: the column has no
// stored bound, so the read keeps a text it can print.
const maxBranchName = 200

// Read reads one persisted sale of the actor's own branch with its lines joined to the
// catalogue, so the emitted document stays legible with the prices of the sale. The
// snapshot is the history read's, and the document is resolved by one header statement
// plus one variant-ordered line statement, so the catalogue identity of a line is never
// an N+1 lookup. A sale of another branch is not found.
func (s *Store) Read(ctx context.Context, actor auth.Identity, id int64) (Detail, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Detail{}, ErrUnavailable
	}
	if !branchClerk(actor) {
		return Detail{}, ErrForbidden
	}
	// Only a positive document id reaches the database; an aliased or impossible one
	// stays not found exactly like an unknown document.
	if id < 1 {
		return Detail{}, ErrNotFound
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	branch, err := resolveBranch(ctx, s.pool, actor)
	if err != nil {
		return Detail{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Detail{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	sale, err := readHeader(ctx, tx, id, int64(branch))
	if err != nil {
		return Detail{}, err
	}
	detail := Detail{
		ID: sale.ID, BranchLocationID: sale.BranchLocationID, BranchSequence: sale.BranchSequence,
		WarrantyNumber: sale.WarrantyNumber, PaymentMethod: sale.PaymentMethod,
		Payments: sale.Payments, Customer: sale.Customer, Total: sale.Total,
		CreatedByAccountID: sale.CreatedByAccountID, CreatedAt: sale.CreatedAt,
	}
	// The name of the branch that sold is resolved by joining the document's own branch
	// row, so the warranty is printed with the branch it belongs to. A missing or retired
	// branch row means the document is not what this domain wrote, so the read fails
	// closed instead of describing an empty branch.
	var branchName string
	switch err := tx.QueryRow(ctx, `SELECT l.name FROM sales s
 JOIN locations l ON l.id=s.branch_location_id AND l.deleted_at IS NULL
 WHERE s.id=$1 AND s.branch_location_id=$2`, id, int64(branch)).Scan(&branchName); {
	case errors.Is(err, pgx.ErrNoRows):
		return Detail{}, ErrUnavailable
	case err != nil:
		return Detail{}, fail(ctx)
	}
	if strings.TrimSpace(branchName) == "" || !boundedText(branchName, 1, maxBranchName) {
		return Detail{}, ErrUnavailable
	}
	detail.BranchName = branchName
	rows, err := tx.Query(ctx, `SELECT l.variant_id,l.quantity,l.unit_price::text,l.min_price::text,
  l.warranty_months,l.subtotal::text,e.id,e.brand,e.model,e.capacity_ah::text,v.polarity
 FROM sale_lines l
 JOIN catalog_variants v ON v.id=l.variant_id
 JOIN catalog_entries e ON e.id=v.catalog_entry_id
 WHERE l.sale_id=$1 ORDER BY l.variant_id`, id)
	if err != nil {
		return Detail{}, fail(ctx)
	}
	defer rows.Close()
	lines := make([]DetailLine, 0, 4)
	for rows.Next() {
		var line DetailLine
		var unit, minimum, subtotal, capacity string
		if rows.Scan(&line.VariantID, &line.Quantity, &unit, &minimum, &line.WarrantyMonths,
			&subtotal, &line.CatalogEntryID, &line.Brand, &line.Model, &capacity,
			&line.Polarity) != nil {
			return Detail{}, fail(ctx)
		}
		line.UnitPrice = Money(unit)
		line.MinPrice = Money(minimum)
		line.Subtotal = Money(subtotal)
		if line.UnitPrice.String() != unit || line.MinPrice.String() != minimum ||
			line.Subtotal.String() != subtotal ||
			!line.UnitPrice.AtLeast(line.MinPrice) ||
			line.VariantID < 1 || line.VariantID > math.MaxInt32 ||
			line.Quantity < 1 || line.Quantity > MaxQuantity ||
			line.WarrantyMonths < MinWarrantyMonths || line.WarrantyMonths > MaxWarrantyMonths ||
			line.CatalogEntryID < 1 || line.Brand == "" || line.Model == "" ||
			(line.Polarity != "L" && line.Polarity != "R") ||
			(len(lines) > 0 && line.VariantID <= lines[len(lines)-1].VariantID) {
			return Detail{}, ErrUnavailable
		}
		if line.Capacity, err = catalog.ParseDecimal(capacity); err != nil {
			return Detail{}, ErrUnavailable
		}
		lines = append(lines, line)
		if len(lines) > MaxLines {
			return Detail{}, ErrUnavailable
		}
	}
	if rows.Err() != nil {
		return Detail{}, fail(ctx)
	}
	if len(lines) == 0 {
		return Detail{}, ErrUnavailable
	}
	detail.Lines = lines
	if tx.Commit(ctx) != nil {
		return Detail{}, fail(ctx)
	}
	return detail, nil
}

// List reads one newest-first page of the actor's own branch history. The page is one
// count plus one page statement, so the total is the database's own number and the line
// count of each row is summed by the database, never by a Go loop over every line.
func (s *Store) List(ctx context.Context, actor auth.Identity, q ListQuery) (Page, error) {
	result := Page{Page: q.Page, PageSize: q.PageSize, Sales: []Summary{}}
	if ctx == nil || s == nil || s.pool == nil {
		return Page{}, ErrUnavailable
	}
	if !branchClerk(actor) {
		return Page{}, ErrForbidden
	}
	// Every rejected page or filter stops here, before the first statement.
	if !ValidListQuery(q) {
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
	args := []any{branch, literalPattern(q.Search), q.PaymentMethod}
	if tx.QueryRow(ctx, "SELECT count(*)"+listFilter, args...).Scan(&result.TotalSales) != nil {
		return Page{}, fail(ctx)
	}
	args = append(args, int64(q.PageSize), int64(q.Page-1)*int64(q.PageSize))
	rows, err := tx.Query(ctx, `SELECT s.id,s.branch_sequence,s.warranty_number,s.payment_method,
  s.customer_name,s.total::text,s.created_at,
  (SELECT count(*) FROM sale_lines l WHERE l.sale_id=s.id)`+listFilter+
		` ORDER BY s.id DESC LIMIT $4 OFFSET $5`, args...)
	if err != nil {
		return Page{}, fail(ctx)
	}
	defer rows.Close()
	for rows.Next() {
		var summary Summary
		var method, total string
		var lines int64
		if rows.Scan(&summary.ID, &summary.BranchSequence, &summary.WarrantyNumber, &method,
			&summary.CustomerName, &total, &summary.CreatedAt, &lines) != nil {
			return Page{}, fail(ctx)
		}
		summary.PaymentMethod = PaymentMethod(method)
		summary.Total = Money(total)
		// A persisted sale always has between one and MaxLines lines, and its label is one
		// the database derived from its own amounts.
		if !summary.PaymentMethod.Recorded() || summary.Total.String() != total ||
			summary.BranchSequence < 1 || summary.WarrantyNumber == "" ||
			summary.CreatedAt.IsZero() || lines < 1 || lines > MaxLines ||
			(len(result.Sales) > 0 && summary.ID >= result.Sales[len(result.Sales)-1].ID) {
			return Page{}, ErrUnavailable
		}
		summary.Lines = int(lines)
		result.Sales = append(result.Sales, summary)
	}
	if rows.Err() != nil {
		return Page{}, fail(ctx)
	}
	if tx.Commit(ctx) != nil {
		return Page{}, fail(ctx)
	}
	return result, nil
}

// listFilter is shared by the count and the page, so both answer the same question. The
// search is a literal substring of the warranty number or the client name, and the
// history is always scoped to the actor's own branch.
const listFilter = ` FROM sales s
 WHERE s.branch_location_id=$1
 AND ($2='' OR s.warranty_number ILIKE $2 ESCAPE '\' OR s.customer_name ILIKE $2 ESCAPE '\')
 AND ($3='' OR s.payment_method=$3)`

// Sellable reads the point-of-sale catalogue of the actor's own branch: every variant of
// the catalogue once, each with the stock of the branch, whether the branch can sell it
// right now, and the suggested price the counter starts from plus the minimum it can
// never go under. The pair belongs to the battery of the variant, so the two polarities
// of one battery are offered together at the same pair. A variant whose battery has no
// price in this branch is still listed, with empty prices and Sellable=false, because the
// counter must show the row with its action disabled (S7) instead of hiding it. The
// warranty term is not read here: the seller states it on the sale.
func (s *Store) Sellable(ctx context.Context, actor auth.Identity, q SellableQuery) (SellablePage, error) {
	result := SellablePage{Page: q.Page, PageSize: q.PageSize, Items: []SellableItem{}}
	if ctx == nil || s == nil || s.pool == nil {
		return SellablePage{}, ErrUnavailable
	}
	if !branchClerk(actor) {
		return SellablePage{}, ErrForbidden
	}
	if !ValidSellableQuery(q) {
		return SellablePage{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	branch, err := resolveBranch(ctx, s.pool, actor)
	if err != nil {
		return SellablePage{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return SellablePage{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	args := []any{branch, literalPattern(q.Search), q.Brand, capacityArg(q.Capacity), q.Polarity}
	if tx.QueryRow(ctx, "SELECT count(*)"+sellableFilter, args...).Scan(&result.TotalVariants) != nil {
		return SellablePage{}, fail(ctx)
	}
	args = append(args, int64(q.PageSize), int64(q.Page-1)*int64(q.PageSize))
	rows, err := tx.Query(ctx, `SELECT v.id,e.id,e.brand,e.model,e.capacity_ah::text,v.polarity,
  coalesce(p.suggested_price::text,''),coalesce(p.min_price::text,''),
  coalesce(b.existing,0),coalesce(b.reserved,0),coalesce(b.available,0)`+sellableFilter+
		` ORDER BY v.id LIMIT $6 OFFSET $7`, args...)
	if err != nil {
		return SellablePage{}, fail(ctx)
	}
	defer rows.Close()
	for rows.Next() {
		var item SellableItem
		var capacity, suggested, minimum string
		if rows.Scan(&item.VariantID, &item.CatalogEntryID, &item.Brand, &item.Model, &capacity,
			&item.Polarity, &suggested, &minimum, &item.Existing, &item.Reserved,
			&item.Available) != nil {
			return SellablePage{}, fail(ctx)
		}
		if item.VariantID < 1 || item.CatalogEntryID < 1 || item.Brand == "" || item.Model == "" ||
			(item.Polarity != "L" && item.Polarity != "R") ||
			(len(result.Items) > 0 && item.VariantID <= result.Items[len(result.Items)-1].VariantID) {
			return SellablePage{}, ErrUnavailable
		}
		if item.Capacity, err = catalog.ParseDecimal(capacity); err != nil {
			return SellablePage{}, ErrUnavailable
		}
		// The price is the branch's own reading of the battery: it is present on both
		// columns or on neither, and a published pair is canonical and never under its own
		// floor. A branch pair the price list could not have written is not described.
		switch {
		case suggested == "" && minimum == "":
			item.Sellable = false
			item.SuggestedPrice, item.MinPrice = "", ""
		case suggested != "" && minimum != "":
			item.SuggestedPrice = Money(suggested)
			item.MinPrice = Money(minimum)
			if item.SuggestedPrice.String() != suggested || item.MinPrice.String() != minimum ||
				!item.SuggestedPrice.AtLeast(item.MinPrice) {
				return SellablePage{}, ErrUnavailable
			}
			item.Sellable = true
		default:
			return SellablePage{}, ErrUnavailable
		}
		// The availability is the branch's own balance row: a missing row is the honest
		// zero, and a shape the ledger could not hold is not described.
		if item.Existing < 0 || item.Reserved < 0 || item.Reserved > item.Existing ||
			item.Available != item.Existing-item.Reserved {
			return SellablePage{}, ErrUnavailable
		}
		result.Items = append(result.Items, item)
	}
	if rows.Err() != nil {
		return SellablePage{}, fail(ctx)
	}
	if tx.Commit(ctx) != nil {
		return SellablePage{}, fail(ctx)
	}
	return result, nil
}

// sellableFilter is shared by the count and the page, so both answer the same question.
// Every variant matched by the filters is one row, priced or not: the pair is joined
// through the battery and the balance through the branch, both as LEFT JOINs, so a
// variant without a price in this branch -- the row the counter must show blocked -- and
// a variant without a balance row still appear exactly once. The join on the battery also
// gives both polarities of one battery the same pair, and no row here is duplicated,
// because a battery has at most one price per branch and a variant one balance per branch.
const sellableFilter = ` FROM catalog_variants v
 JOIN catalog_entries e ON e.id=v.catalog_entry_id
 LEFT JOIN branch_prices p ON p.catalog_entry_id=e.id AND p.branch_location_id=$1
 LEFT JOIN inventory_balances b ON b.location_id=$1 AND b.variant_id=v.id
 WHERE ($2='' OR e.brand ILIKE $2 ESCAPE '\' OR e.model ILIKE $2 ESCAPE '\')
 AND ($3='' OR e.brand=$3) AND ($4::numeric IS NULL OR e.capacity_ah=$4::numeric)
 AND ($5='' OR v.polarity=$5)
 AND e.deleted_at IS NULL`

// capacityArg turns the optional capacity filter into a nullable numeric parameter, so
// an absent filter never casts an empty string.
func capacityArg(capacity catalog.Decimal) any {
	if capacity == "" {
		return nil
	}
	return string(capacity)
}

// literalPattern turns a free search into a literal substring, so % and _ in the
// operator's own words never become wildcards.
func literalPattern(search string) string {
	if search == "" {
		return ""
	}
	return "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(search) + "%"
}

// mapFailure publishes the database's own decision and nothing else: SQLSTATE is the
// only trusted evidence, the offending variant is read from the database's own detail
// when the refusal names one, and cancellation keeps its semantics.
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
		// LV001: the sale scope guard. The warehouse never sells, a sale belongs to an
		// active branch and only that branch's own account registers it.
		case "LV001":
			return ErrForbidden
		// LV003: the variant has no price in this branch, so it is not sellable.
		case "LV003":
			return &NotSellable{VariantID: variantOf(pg)}
		// LV004: the charged price is under the branch's frozen minimum.
		case "LV004":
			return &BelowMinimum{VariantID: variantOf(pg)}
		// LV005: the branch cannot cover the sale.
		case "LV005":
			return &InsufficientStock{VariantID: variantOf(pg)}
		// A refused amount, a refused document shape or an unknown variant is the same
		// public refusal, because the database decides it.
		case "23503", "23514", "22003":
			return ErrInvalid
		}
		// LV006, LV007 and LV008 restate invariants this store already derived (at least
		// one line, the exact total, the correlative bound), so reaching them means the
		// ledger is not what this domain wrote: fail closed, never publish them.
	}
	return ErrUnavailable
}

// variantOf reads the offending variant from the database's own detail. A refusal
// without a reusable id keeps a zero id, so the error still names the refusal.
func variantOf(pg *pgconn.PgError) int64 {
	value, err := strconv.ParseInt(pg.Detail, 10, 64)
	if err != nil || value < 1 || value > math.MaxInt32 {
		return 0
	}
	return value
}
