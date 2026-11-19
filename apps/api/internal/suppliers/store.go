package suppliers

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"luson/api/internal/auth"
	"luson/api/internal/catalog"
)

const (
	// writeTimeout bounds one mutation well below the HTTP write timeout.
	writeTimeout = 10 * time.Second
	// readTimeout bounds one read the same way.
	readTimeout = 10 * time.Second
)

// offerLock serializes the replacement of one supplier's offer set, so two
// concurrent assignments cannot interleave their delete and insert steps. It is
// keyed by the supplier identity in its own namespace, so it can never collide with
// the operation-key or catalogue-retirement fences. Transaction scoped: the database
// releases it on commit, rollback or disconnect.
func offerLock(supplierID int64) int64 {
	h := sha256.Sum256([]byte("luson.supplier/offers/v1:" + strconv.FormatInt(supplierID, 10)))
	return int64(binary.BigEndian.Uint64(h[:8]))
}

// beginWrite opens the transaction one mutation owns.
func (s *Store) beginWrite(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return nil, fail(ctx)
	}
	return tx, nil
}

// rollback releases the transaction even when the request was cancelled, so a
// failure never leaves the connection holding locks.
func rollback(tx pgx.Tx) {
	cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
	defer done()
	_ = tx.Rollback(cleanup)
}

// snapshot opens the read-only, repeatable-read transaction one page read owns, so
// the count and the page answer the same question.
func (s *Store) snapshot(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fail(ctx)
	}
	return tx, nil
}

// Create writes one supplier. The database allocates the identity and enforces the
// unique active name, so a duplicate is the database's own refusal and the response
// is read back from the written row, never assembled from the input.
func (s *Store) Create(ctx context.Context, actor auth.Identity, in CreateInput) (Supplier, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Supplier{}, ErrUnavailable
	}
	if !WarehouseAdmin(actor) {
		return Supplier{}, ErrForbidden
	}
	canonical, err := CanonicalCreate(in)
	if err != nil {
		return Supplier{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	tx, err := s.beginWrite(ctx)
	if err != nil {
		return Supplier{}, err
	}
	defer rollback(tx)
	if err = checkAssignment(ctx, tx, actor); err != nil {
		return Supplier{}, err
	}
	var id int64
	if err = tx.QueryRow(ctx, `INSERT INTO suppliers(name,contact) VALUES($1,$2)
 RETURNING id`, canonical.Name, canonical.Contact).Scan(&id); err != nil {
		return Supplier{}, writeError(err)
	}
	supplier, err := loadSupplier(ctx, tx, id)
	if err != nil {
		return Supplier{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Supplier{}, fail(ctx)
	}
	return supplier, nil
}

// Edit replaces the name and the contact of an active supplier. The offer set is not
// part of the document and is never touched here. The update's own row count is the
// decision, so there is no read-then-write window: a retired supplier has left the
// editable list and is answered exactly like an unknown one.
func (s *Store) Edit(ctx context.Context, actor auth.Identity, id int64, in EditInput) (Supplier, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Supplier{}, ErrUnavailable
	}
	if !WarehouseAdmin(actor) {
		return Supplier{}, ErrForbidden
	}
	if id < 1 {
		return Supplier{}, ErrInvalid
	}
	canonical, err := CanonicalEdit(in)
	if err != nil {
		return Supplier{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	tx, err := s.beginWrite(ctx)
	if err != nil {
		return Supplier{}, err
	}
	defer rollback(tx)
	if err = checkAssignment(ctx, tx, actor); err != nil {
		return Supplier{}, err
	}
	tag, err := tx.Exec(ctx, `UPDATE suppliers SET name=$2,contact=$3
 WHERE id=$1 AND deleted_at IS NULL`, id, canonical.Name, canonical.Contact)
	if err != nil {
		return Supplier{}, writeError(err)
	}
	if tag.RowsAffected() == 0 {
		return Supplier{}, ErrNotFound
	}
	supplier, err := loadSupplier(ctx, tx, id)
	if err != nil {
		return Supplier{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Supplier{}, fail(ctx)
	}
	return supplier, nil
}

// Retire retires a supplier one way: the row stays, marked, because persisted ingress
// documents keep naming it, and nothing is ever deleted. A repeated retirement is a
// conflict, not a second success, because the retirement is an operating decision
// taken once.
func (s *Store) Retire(ctx context.Context, actor auth.Identity, id int64) error {
	if ctx == nil || s == nil || s.pool == nil {
		return ErrUnavailable
	}
	if !WarehouseAdmin(actor) {
		return ErrForbidden
	}
	if id < 1 {
		return ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	tx, err := s.beginWrite(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if err = checkAssignment(ctx, tx, actor); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE suppliers SET deleted_at=CURRENT_TIMESTAMP
 WHERE id=$1 AND deleted_at IS NULL`, id)
	if err != nil {
		return writeError(err)
	}
	if tag.RowsAffected() == 0 {
		var retired bool
		err = tx.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM suppliers WHERE id=$1`, id).Scan(&retired)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fail(ctx)
		}
		return ErrConflict
	}
	if err = tx.Commit(ctx); err != nil {
		return fail(ctx)
	}
	return nil
}

// Read serves one supplier with its current offer set. A retired supplier stays
// readable: its documents name it and its own history is evidence, so the read
// marks it instead of hiding it.
func (s *Store) Read(ctx context.Context, actor auth.Identity, id int64) (Detail, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Detail{}, ErrUnavailable
	}
	if !WarehouseAdmin(actor) {
		return Detail{}, ErrForbidden
	}
	if id < 1 {
		return Detail{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, readTimeout)
	defer cancel()
	if err := checkAssignment(ctx, s.pool, actor); err != nil {
		return Detail{}, err
	}
	tx, err := s.snapshot(ctx)
	if err != nil {
		return Detail{}, err
	}
	defer rollback(tx)
	detail, err := readDetail(ctx, tx, id)
	if err != nil {
		return Detail{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Detail{}, fail(ctx)
	}
	return detail, nil
}

// List reads one page of suppliers: the active ones first by name and the retired
// ones last, each marked, with the kinds derived from its offers and the exact number
// of offers. One count and one page statement answer the same question, and one
// aggregate statement answers the offers of the whole page.
func (s *Store) List(ctx context.Context, actor auth.Identity, page, pageSize int) (Page, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Page{}, ErrUnavailable
	}
	if !WarehouseAdmin(actor) {
		return Page{}, ErrForbidden
	}
	// Every rejected page stops here, before the first statement.
	if !ValidPage(page, pageSize) {
		return Page{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, readTimeout)
	defer cancel()
	if err := checkAssignment(ctx, s.pool, actor); err != nil {
		return Page{}, err
	}
	tx, err := s.snapshot(ctx)
	if err != nil {
		return Page{}, err
	}
	defer rollback(tx)
	result := Page{Page: page, PageSize: pageSize, Suppliers: []Summary{}}
	if tx.QueryRow(ctx, "SELECT count(*) FROM suppliers").Scan(&result.Total) != nil {
		return Page{}, fail(ctx)
	}
	rows, err := tx.Query(ctx, `SELECT id,name,contact,deleted_at IS NOT NULL
 FROM suppliers
 ORDER BY (deleted_at IS NOT NULL), lower(name), id
 LIMIT $1 OFFSET $2`, int64(pageSize), int64(page-1)*int64(pageSize))
	if err != nil {
		return Page{}, fail(ctx)
	}
	ids := make([]int64, 0, pageSize)
	for rows.Next() {
		var id int64
		var name, contact string
		var retired bool
		if rows.Scan(&id, &name, &contact, &retired) != nil {
			rows.Close()
			return Page{}, fail(ctx)
		}
		supplier, err := storedSupplier(id, name, contact)
		if err != nil {
			rows.Close()
			return Page{}, err
		}
		// The order is the contract's: an active row never follows a retired one.
		if len(result.Suppliers) > 0 && result.Suppliers[len(result.Suppliers)-1].Retired && !retired {
			rows.Close()
			return Page{}, ErrUnavailable
		}
		result.Suppliers = append(result.Suppliers, Summary{ID: supplier.ID, Name: supplier.Name,
			Contact: supplier.Contact, Retired: retired, Kinds: []catalog.Kind{}})
		ids = append(ids, supplier.ID)
	}
	if rows.Err() != nil {
		rows.Close()
		return Page{}, fail(ctx)
	}
	rows.Close()
	if err = readKinds(ctx, tx, ids, result.Suppliers); err != nil {
		return Page{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Page{}, fail(ctx)
	}
	return result, nil
}

// readKinds fills the derived kinds and the exact offer count of every listed
// supplier from one aggregate statement, never a lookup per row.
func readKinds(ctx context.Context, q querier, ids []int64, summaries []Summary) error {
	if len(ids) == 0 {
		return nil
	}
	index := make(map[int64]int, len(summaries))
	for i, summary := range summaries {
		index[summary.ID] = i
	}
	rows, err := q.Query(ctx, `SELECT o.supplier_id,e.kind,count(*)
 FROM supplier_offers o
 JOIN catalog_entries e ON e.id=o.catalog_entry_id
 WHERE o.supplier_id = ANY($1::bigint[])
 GROUP BY o.supplier_id,e.kind
 ORDER BY o.supplier_id,e.kind`, ids)
	if err != nil {
		return fail(ctx)
	}
	defer rows.Close()
	counts := make(map[int64]map[catalog.Kind]int64, len(ids))
	for rows.Next() {
		var id int64
		var kind string
		var count int64
		if rows.Scan(&id, &kind, &count) != nil {
			return fail(ctx)
		}
		if _, known := index[id]; !known || count < 1 {
			return ErrUnavailable
		}
		if kind != string(catalog.BatteryKind) && kind != string(catalog.OtherKind) {
			return ErrUnavailable
		}
		if counts[id] == nil {
			counts[id] = make(map[catalog.Kind]int64, 2)
		}
		counts[id][catalog.Kind(kind)] = count
	}
	if rows.Err() != nil {
		return fail(ctx)
	}
	for id, kinds := range counts {
		summary := &summaries[index[id]]
		battery, other := kinds[catalog.BatteryKind], kinds[catalog.OtherKind]
		if battery > 0 {
			summary.Kinds = append(summary.Kinds, catalog.BatteryKind)
		}
		if other > 0 {
			summary.Kinds = append(summary.Kinds, catalog.OtherKind)
		}
		summary.Offers = battery + other
	}
	return nil
}

// ReplaceOffers writes the whole offer set of one supplier in one transaction: the
// set is state, not history, so it is replaced instead of merged, and a refused
// assignment leaves the previous state exactly as it was. The set is serialized with
// one advisory lock per supplier and the database's own trigger is the authority for
// both retirement rules.
func (s *Store) ReplaceOffers(ctx context.Context, actor auth.Identity, id int64, entryIDs []int64) (Detail, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Detail{}, ErrUnavailable
	}
	if !WarehouseAdmin(actor) {
		return Detail{}, ErrForbidden
	}
	if id < 1 {
		return Detail{}, ErrInvalid
	}
	set, err := CanonicalOffers(entryIDs)
	if err != nil {
		return Detail{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	tx, err := s.beginWrite(ctx)
	if err != nil {
		return Detail{}, err
	}
	defer rollback(tx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", offerLock(id)); err != nil {
		return Detail{}, fail(ctx)
	}
	if err = checkAssignment(ctx, tx, actor); err != nil {
		return Detail{}, err
	}
	var retired bool
	err = tx.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM suppliers WHERE id=$1`, id).Scan(&retired)
	if errors.Is(err, pgx.ErrNoRows) {
		return Detail{}, ErrNotFound
	}
	if err != nil {
		return Detail{}, fail(ctx)
	}
	if retired {
		return Detail{}, ErrConflict
	}
	if _, err = tx.Exec(ctx, `DELETE FROM supplier_offers WHERE supplier_id=$1`, id); err != nil {
		return Detail{}, offerError(err)
	}
	for _, entry := range set {
		if _, err = tx.Exec(ctx, `INSERT INTO supplier_offers(supplier_id,catalog_entry_id)
 VALUES($1,$2)`, id, entry); err != nil {
			return Detail{}, offerError(err)
		}
	}
	detail, err := readDetail(ctx, tx, id)
	if err != nil {
		return Detail{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Detail{}, fail(ctx)
	}
	return detail, nil
}

// Catalog reads the first page of the assignable catalogue: the active entries of
// both kinds, at entry level, because that is what a supplier offers. It carries no
// stock number and never mutates the catalogue.
func (s *Store) Catalog(ctx context.Context, actor auth.Identity, q EntryQuery) (EntryPage, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return EntryPage{}, ErrUnavailable
	}
	if !WarehouseAdmin(actor) {
		return EntryPage{}, ErrForbidden
	}
	if !ValidEntryQuery(q) {
		return EntryPage{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, readTimeout)
	defer cancel()
	if err := checkAssignment(ctx, s.pool, actor); err != nil {
		return EntryPage{}, err
	}
	tx, err := s.snapshot(ctx)
	if err != nil {
		return EntryPage{}, err
	}
	defer rollback(tx)
	result := EntryPage{PageSize: q.PageSize, Entries: []Offer{}}
	args := []any{string(q.Kind), literalPattern(q.Search)}
	if tx.QueryRow(ctx, "SELECT count(*)"+entryFilter, args...).Scan(&result.Total) != nil {
		return EntryPage{}, fail(ctx)
	}
	args = append(args, int64(q.PageSize))
	rows, err := tx.Query(ctx, `SELECT e.id,e.kind,coalesce(e.brand,''),coalesce(e.model,''),e.capacity_ah::text,coalesce(e.name,'')`+
		entryFilter+` ORDER BY e.id LIMIT $3`, args...)
	if err != nil {
		return EntryPage{}, fail(ctx)
	}
	var previous int64
	for rows.Next() {
		var id int64
		var kind, brand, model, name string
		var capacity *string
		if rows.Scan(&id, &kind, &brand, &model, &capacity, &name) != nil {
			rows.Close()
			return EntryPage{}, fail(ctx)
		}
		offer, err := storedOffer(id, kind, brand, model, text(capacity), name)
		if err != nil || id <= previous {
			rows.Close()
			return EntryPage{}, ErrUnavailable
		}
		previous = id
		result.Entries = append(result.Entries, offer)
	}
	if rows.Err() != nil {
		rows.Close()
		return EntryPage{}, fail(ctx)
	}
	rows.Close()
	if err = tx.Commit(ctx); err != nil {
		return EntryPage{}, fail(ctx)
	}
	return result, nil
}

// entryFilter is shared by the count and the page, so both answer the same question:
// the active catalogue entries, at entry level, of the selected kind and matching the
// literal search over brand, model and name.
const entryFilter = ` FROM catalog_entries e
 WHERE e.deleted_at IS NULL
 AND ($1='' OR e.kind=$1)
 AND ($2='' OR e.brand ILIKE $2 ESCAPE '\' OR e.model ILIKE $2 ESCAPE '\' OR e.name ILIKE $2 ESCAPE '\')`

// OfferedVariants reads the variants of the entries one supplier offers, which is
// what the ingress picker needs: the assignment is entry level and the document names
// variants, so one offered battery expands to every one of its polarities. The read
// carries no stock number at all, and a retired supplier fills no picker because it
// can no longer supply.
func (s *Store) OfferedVariants(ctx context.Context, actor auth.Identity, id int64, q VariantQuery) (VariantPage, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return VariantPage{}, ErrUnavailable
	}
	if !WarehouseAdmin(actor) {
		return VariantPage{}, ErrForbidden
	}
	if id < 1 {
		return VariantPage{}, ErrInvalid
	}
	if !ValidVariantQuery(q) {
		return VariantPage{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, readTimeout)
	defer cancel()
	if err := checkAssignment(ctx, s.pool, actor); err != nil {
		return VariantPage{}, err
	}
	tx, err := s.snapshot(ctx)
	if err != nil {
		return VariantPage{}, err
	}
	defer rollback(tx)
	var retired bool
	err = tx.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM suppliers WHERE id=$1`, id).Scan(&retired)
	if errors.Is(err, pgx.ErrNoRows) {
		return VariantPage{}, ErrNotFound
	}
	if err != nil {
		return VariantPage{}, fail(ctx)
	}
	if retired {
		return VariantPage{}, ErrConflict
	}
	result := VariantPage{PageSize: OfferedVariantsPageSize, Items: []Variant{}}
	rows, err := tx.Query(ctx, `SELECT v.id,e.id,e.kind,coalesce(e.brand,''),coalesce(e.model,''),
  e.capacity_ah::text,coalesce(v.polarity,''),coalesce(e.name,'')
 FROM catalog_variants v
 JOIN catalog_entries e ON e.id=v.catalog_entry_id
 JOIN supplier_offers o ON o.catalog_entry_id=e.id AND o.supplier_id=$1
 WHERE e.deleted_at IS NULL
 AND ($2='' OR e.kind=$2)
 AND ($3='' OR e.brand ILIKE $3 ESCAPE '\' OR e.model ILIKE $3 ESCAPE '\' OR e.name ILIKE $3 ESCAPE '\')
 ORDER BY v.id
 LIMIT $4`, id, string(q.Kind), literalPattern(q.Search), int64(OfferedVariantsPageSize))
	if err != nil {
		return VariantPage{}, fail(ctx)
	}
	selected := make([]catalog.Row, 0, 8)
	entryIDs := make([]int32, 0, 8)
	for rows.Next() {
		var row catalog.Row
		var capacity *string
		if rows.Scan(&row.VariantID, &row.CatalogEntryID, &row.Kind, &row.Brand, &row.Model,
			&capacity, &row.Polarity, &row.Name) != nil {
			rows.Close()
			return VariantPage{}, fail(ctx)
		}
		// A numeric column never travels as a float: its own text is parsed back into
		// the canonical decimal of the contract.
		if capacity != nil {
			row.Capacity = *capacity
		}
		if row.VariantID < 1 || row.CatalogEntryID < 1 ||
			(len(selected) > 0 && row.VariantID <= selected[len(selected)-1].VariantID) {
			rows.Close()
			return VariantPage{}, ErrUnavailable
		}
		if row.Kind == catalog.OtherKind {
			entryIDs = append(entryIDs, int32(row.CatalogEntryID))
		}
		selected = append(selected, row)
	}
	if rows.Err() != nil {
		rows.Close()
		return VariantPage{}, fail(ctx)
	}
	rows.Close()
	// The typed fields of the listed products are one statement, never a lookup per
	// item, and a row this contract could not publish fails the read closed.
	fields, err := catalog.ReadFields(ctx, tx, entryIDs)
	if err != nil {
		return VariantPage{}, fail(ctx)
	}
	for _, row := range selected {
		identity, err := row.Identity(fields[row.CatalogEntryID])
		if err != nil {
			return VariantPage{}, ErrUnavailable
		}
		result.Items = append(result.Items, Variant{Identity: identity, CatalogEntryID: int64(row.CatalogEntryID)})
	}
	if err = tx.Commit(ctx); err != nil {
		return VariantPage{}, fail(ctx)
	}
	return result, nil
}

// readDetail reads one supplier with the whole current offer set. It is shared by the
// detail read and by the assignment's own response, so both publish the same shape.
func readDetail(ctx context.Context, q querier, id int64) (Detail, error) {
	supplier, retired, err := loadSupplierRow(ctx, q, id)
	if err != nil {
		return Detail{}, err
	}
	offers, err := loadOffers(ctx, q, id)
	if err != nil {
		return Detail{}, err
	}
	return Detail{ID: supplier.ID, Name: supplier.Name, Contact: supplier.Contact,
		Retired: retired, Offers: offers, Kinds: Kinds(offers)}, nil
}

// loadSupplier reads one supplier row of any retirement state and validates it.
func loadSupplier(ctx context.Context, q querier, id int64) (Supplier, error) {
	supplier, _, err := loadSupplierRow(ctx, q, id)
	return supplier, err
}

func loadSupplierRow(ctx context.Context, q querier, id int64) (Supplier, bool, error) {
	var name, contact string
	var retired bool
	err := q.QueryRow(ctx, `SELECT name,contact,deleted_at IS NOT NULL FROM suppliers WHERE id=$1`, id).
		Scan(&name, &contact, &retired)
	if errors.Is(err, pgx.ErrNoRows) {
		return Supplier{}, false, ErrNotFound
	}
	if err != nil {
		return Supplier{}, false, fail(ctx)
	}
	supplier, err := storedSupplier(id, name, contact)
	if err != nil {
		return Supplier{}, false, err
	}
	return supplier, retired, nil
}

// loadOffers reads the whole current offer set of one supplier in ascending entry
// order.
func loadOffers(ctx context.Context, q querier, id int64) ([]Offer, error) {
	rows, err := q.Query(ctx, `SELECT e.id,e.kind,coalesce(e.brand,''),coalesce(e.model,''),
  e.capacity_ah::text,coalesce(e.name,'')
 FROM supplier_offers o
 JOIN catalog_entries e ON e.id=o.catalog_entry_id
 WHERE o.supplier_id=$1
 ORDER BY e.id`, id)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	offers := []Offer{}
	var previous int64
	for rows.Next() {
		var entry int64
		var kind, brand, model, name string
		var capacity *string
		if rows.Scan(&entry, &kind, &brand, &model, &capacity, &name) != nil {
			return nil, fail(ctx)
		}
		offer, err := storedOffer(entry, kind, brand, model, text(capacity), name)
		if err != nil || entry <= previous {
			return nil, ErrUnavailable
		}
		previous = entry
		offers = append(offers, offer)
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	return offers, nil
}

// text reads a nullable text column into the value the validators expect.
func text(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// literalPattern makes the search a literal substring instead of a pattern, so a
// typed % or _ never widens the catalogue query.
func literalPattern(search string) string {
	if search == "" {
		return ""
	}
	return "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(search) + "%"
}
