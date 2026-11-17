// Package otherproducts owns the warehouse administrator's other-product catalog:
// a free-named product with typed custom fields, living in the same catalog
// identity as batteries so the future transfer vertical reuses the existing
// engine. The database is the catalog authority, so this package never allocates
// an identity, never deletes an entry and never decides the retirement rules
// itself: it sends the canonical input and publishes the database's own refusal.
// A product is born with exactly one polarity-less variant, which the existing
// balance fan-out stocks with zero in every active location.
package otherproducts

import (
	"context"
	"errors"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/catalog"
)

var (
	ErrInvalid     = errors.New("invalid other product")
	ErrForbidden   = errors.New("other product forbidden")
	ErrNotFound    = errors.New("other product not found")
	ErrConflict    = errors.New("other product conflict")
	ErrHasStock    = errors.New("other product has stock")
	ErrHasPending  = errors.New("other product has pending operations")
	ErrUnavailable = errors.New("other product store unavailable")
)

const (
	// minName and maxName are the admitted byte length of a product name, measured
	// after trimming. The column is unbounded text, so the bound is this contract's,
	// checked before any statement.
	minName = 3
	maxName = 64
	// maxFields is the admitted number of custom fields of one product.
	maxFields = 20
	// maxFieldName is the admitted byte length of a field name, measured after
	// trimming, because the schema refuses a name that is not already trimmed.
	maxFieldName = 40
	// maxUnit is the admitted byte length of the optional unit of a number field,
	// measured after trimming for the same reason.
	maxUnit = 8
	// maxText is the admitted byte length of a text field value. A value is
	// preserved exactly, never trimmed.
	maxText = 200
	// maxNumberIntegral is the admitted number of integral digits of a number field.
	// Together with the six fractional digits it is the whole range of the column
	// (numeric(18,6)), so a value the column would round or overflow never reaches it.
	maxNumberIntegral = 12
	// catalogRetirementFenceKey and catalogRetirementFenceSub are the common
	// integrity fence every stock, reservation and retirement writer takes. It is
	// the same pair the battery retirement uses.
	catalogRetirementFenceKey = 714025
	catalogRetirementFenceSub = 1
	// writeTimeout bounds one catalog write well below the HTTP write timeout.
	writeTimeout = 10 * time.Second
	// listTimeout bounds one catalog page read the same way.
	listTimeout = 10 * time.Second
)

// MaxPage, DefaultPageSize and the admitted page sizes are the price matrix's own
// read bounds, restated here so this contract refuses an inadmissible page before
// any statement.
const (
	MaxPage         = 1_000_000
	DefaultPageSize = 10
	pageSizeSmall   = 10
	pageSizeMedium  = 25
	pageSizeLarge   = 50
	// maxSearch is the free-text bound of the catalog filter.
	maxSearch = 128
)

// Kind is the type of a custom field value: a number, which may declare a unit,
// or free text.
type Kind string

const (
	KindNumber Kind = "number"
	KindText   Kind = "text"
)

// Field is one typed custom field of a product. A number field carries Number and
// an optional Unit; a text field carries Text and no unit. The mutually exclusive
// values are pointers because the catalog stores exactly one of them.
type Field struct {
	Name   string
	Kind   Kind
	Unit   string
	Number *catalog.Decimal
	Text   *string
}

// Product is the created, edited or listed product with the identity the database
// allocated. It is the record the HTTP surface validates once more before echoing
// it back.
type Product struct {
	ID     int64
	Name   string
	Fields []Field
}

// CreateInput is one product creation: the free name and the whole field set.
type CreateInput struct {
	Name   string
	Fields []Field
}

// EditInput is one replacement of an active product. It carries the name and the
// whole field set, because an edit replaces the fields instead of merging them,
// and it never carries an id: the id is the path's identity, not an editable
// field.
type EditInput struct {
	Name   string
	Fields []Field
}

// Query is the frozen read filter: a case-insensitive search on the product name
// and the page of the catalog.
type Query struct {
	Search   string
	Page     int
	PageSize int
}

// Page is one page of the catalog together with the total of matching products.
type Page struct {
	Products []Product
	Page     int
	PageSize int
	Total    int64
}

// CanonicalName admits a product name and returns the trimmed form the catalog
// holds. A name that is invalid UTF-8, or that still carries a control character
// or a NUL after trimming, or is shorter than 3 or longer than 64 bytes after
// trimming is refused, so no untrimmed, control-bearing or over-long name ever
// reaches the database.
func CanonicalName(value string) (string, error) {
	if !utf8.ValidString(value) {
		return "", ErrInvalid
	}
	name := strings.TrimSpace(value)
	if !validText(name) {
		return "", ErrInvalid
	}
	if len(name) < minName || len(name) > maxName {
		return "", ErrInvalid
	}
	return name, nil
}

// numberPattern is the admitted spelling of a number field before it is
// canonicalized: an optional sign, at most eighteen digits and at most six
// decimals, which is the whole text form of the numeric(18,6) column.
var numberPattern = regexp.MustCompile(`^-?[0-9]{1,18}(\.[0-9]{1,6})?$`)

// CanonicalNumber admits the value of a number field and returns the canonical
// decimal text the column holds: no leading zero in the integral part, no trailing
// zero in the fraction and no negative zero, so "005.50" travels as "5.5".
//
// It is deliberately not catalog.ParseDecimal: a capacity is a positive battery
// property, while a number field is any value the product declares, so zero and a
// negative value are values here. The bound is the column's own numeric(18,6): at
// most twelve integral and six fractional digits, refused here so the database
// never rounds or overflows what the operator typed.
func CanonicalNumber(value string) (catalog.Decimal, error) {
	if !numberPattern.MatchString(value) {
		return "", ErrInvalid
	}
	negative := strings.HasPrefix(value, "-")
	whole, fraction, _ := strings.Cut(strings.TrimPrefix(value, "-"), ".")
	integral := strings.TrimLeft(whole, "0")
	if integral == "" {
		integral = "0"
	}
	if len(integral) > maxNumberIntegral {
		return "", ErrInvalid
	}
	fraction = strings.TrimRight(fraction, "0")
	if integral == "0" && fraction == "" {
		// Zero is a value; a negative zero is only a spelling, and the catalog never
		// holds it.
		if negative {
			return "", ErrInvalid
		}
		return catalog.Decimal("0"), nil
	}
	canonical := integral
	if fraction != "" {
		canonical += "." + fraction
	}
	if negative {
		canonical = "-" + canonical
	}
	return catalog.Decimal(canonical), nil
}

// CanonicalFields decides the whole field set before any statement runs: at most
// twenty fields, each with a trimmed name of 1 to 40 bytes that is unique inside
// its product ignoring case, and a value of exactly one kind. A number field
// requires its canonical decimal in the column's own range — twelve integral and
// six fractional digits, zero and negative values included — and admits an
// optional unit of 1 to 8 bytes; a text field requires 1 to 200 bytes and admits
// no unit. The client's order is preserved and its slice is never modified.
func CanonicalFields(fields []Field) ([]Field, error) {
	if len(fields) > maxFields {
		return nil, ErrInvalid
	}
	canonical := make([]Field, 0, len(fields))
	seen := make(map[string]bool, len(fields))
	for _, field := range fields {
		item, err := canonicalField(field)
		if err != nil {
			return nil, err
		}
		key := strings.ToLower(item.Name)
		if seen[key] {
			return nil, ErrInvalid
		}
		seen[key] = true
		canonical = append(canonical, item)
	}
	return canonical, nil
}

func canonicalField(field Field) (Field, error) {
	if !utf8.ValidString(field.Name) || !validText(field.Name) {
		return Field{}, ErrInvalid
	}
	name := strings.TrimSpace(field.Name)
	if len(name) < 1 || len(name) > maxFieldName {
		return Field{}, ErrInvalid
	}
	switch field.Kind {
	case KindNumber:
		if field.Number == nil || field.Text != nil {
			return Field{}, ErrInvalid
		}
		number, err := CanonicalNumber(string(*field.Number))
		if err != nil {
			return Field{}, ErrInvalid
		}
		item := Field{Name: name, Kind: KindNumber, Number: &number}
		if field.Unit != "" {
			if !utf8.ValidString(field.Unit) || !validText(field.Unit) {
				return Field{}, ErrInvalid
			}
			unit := strings.TrimSpace(field.Unit)
			if len(unit) < 1 || len(unit) > maxUnit {
				return Field{}, ErrInvalid
			}
			item.Unit = unit
		}
		return item, nil
	case KindText:
		if field.Text == nil || field.Number != nil || field.Unit != "" {
			return Field{}, ErrInvalid
		}
		text := *field.Text
		if !utf8.ValidString(text) || !validText(text) || len(text) < 1 || len(text) > maxText {
			return Field{}, ErrInvalid
		}
		return Field{Name: name, Kind: KindText, Text: &text}, nil
	}
	return Field{}, ErrInvalid
}

// validText admits text without a NUL or a control character. A control character
// never belongs to a name, a field name or a unit, so the catalog cannot hold a
// record its own readers would refuse.
func validText(value string) bool {
	for _, r := range value {
		if r == 0 || unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// CanonicalCreate decides the whole creation: the free name and every field.
func CanonicalCreate(in CreateInput) (CreateInput, error) {
	name, err := CanonicalName(in.Name)
	if err != nil {
		return CreateInput{}, err
	}
	fields, err := CanonicalFields(in.Fields)
	if err != nil {
		return CreateInput{}, err
	}
	return CreateInput{Name: name, Fields: fields}, nil
}

// CanonicalEdit decides the whole replacement. The name and the field set are the
// whole document: an edit never carries ids or a partial field set.
func CanonicalEdit(in EditInput) (EditInput, error) {
	name, err := CanonicalName(in.Name)
	if err != nil {
		return EditInput{}, err
	}
	fields, err := CanonicalFields(in.Fields)
	if err != nil {
		return EditInput{}, err
	}
	return EditInput{Name: name, Fields: fields}, nil
}

// ValidPage admits only the page and page size of the frozen read contract, so
// every other value is refused before the database is touched.
func ValidPage(page, pageSize int) bool {
	return page >= 1 && page <= MaxPage &&
		(pageSize == pageSizeSmall || pageSize == pageSizeMedium || pageSize == pageSizeLarge)
}

// ValidQuery admits the read filter: the page, the size and a search that fits the
// database's own text bounds.
func ValidQuery(q Query) bool {
	return ValidPage(q.Page, q.PageSize) && utf8.ValidString(q.Search) &&
		!strings.ContainsRune(q.Search, 0) && utf8.RuneCountInString(q.Search) <= maxSearch
}

// Store is the other-product catalog writer. It holds the pool and the
// authentication service, because the warehouse administrator gate is the same
// authority the administration surface uses, rechecked here so a caller outside
// the HTTP surface cannot write either.
type Store struct {
	pool    *pgxpool.Pool
	service *auth.Service
}

func New(pool *pgxpool.Pool, service *auth.Service) *Store {
	return &Store{pool: pool, service: service}
}

// Administrator applies the same warehouse administrator gate the administration
// surface uses. The HTTP surface applies it before any method, framing or body
// work, and every operation below rechecks it, so the gate is one authority even
// when the surface and the store are asked separately.
func (s *Store) Administrator(ctx context.Context, token string) error {
	if ctx == nil || s == nil || s.service == nil {
		return ErrUnavailable
	}
	return s.service.Administrator(ctx, token)
}

// fail retains cancellation semantics but never driver/config/SQL details.
func fail(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return ErrUnavailable
}

func pgError(err error) *pgconn.PgError {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return pg
	}
	return nil
}

// writeError publishes the database's own refusal of a creation or an edit. A
// duplicate active product name is a conflict; a repeated field name inside one
// product is the contract's own limit, so it stays an invalid request; a domain
// check, a name the shape refuses or a malformed argument is invalid as well.
func writeError(err error) error {
	if pg := pgError(err); pg != nil {
		switch pg.Code {
		case "23505":
			if pg.ConstraintName == "catalog_entry_fields_name" {
				return ErrInvalid
			}
			return ErrConflict
		case "23503", "23514", "22003", "22P02":
			return ErrInvalid
		}
	}
	return err
}

// retiredError publishes the database's own retirement refusal. The pre-checked
// blocker carries the precise cause; this fallback only names a conflict when the
// trigger refused for a reason the pre-check did not see.
func retiredError(err error) error {
	if pg := pgError(err); pg != nil && pg.Code == "23514" && pg.ConstraintName == "catalog_retirement_blocked" {
		return ErrConflict
	}
	return err
}

func (s *Store) begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return nil, fail(ctx)
	}
	return tx, nil
}

// Create is one atomic operation: the entry, its single polarity-less variant and
// its fields are written in one transaction, so no caller ever observes a product
// without its variant or a product with half a field set. Identities are allocated
// by the database sequences and the variant trigger fans a zero balance row out to
// every active location. The response is read back from the written rows, never
// assembled from the input.
func (s *Store) Create(ctx context.Context, token string, in CreateInput) (Product, error) {
	if ctx == nil || s == nil || s.pool == nil || s.service == nil {
		return Product{}, ErrUnavailable
	}
	if err := s.service.Administrator(ctx, token); err != nil {
		return Product{}, err
	}
	canonical, err := CanonicalCreate(in)
	if err != nil {
		return Product{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	tx, err := s.begin(ctx)
	if err != nil {
		return Product{}, err
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	var id int32
	if err = tx.QueryRow(ctx, `INSERT INTO catalog_entries(kind,name) VALUES('other',$1)
 RETURNING id`, canonical.Name).Scan(&id); err != nil {
		return Product{}, writeError(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO catalog_variants(catalog_entry_id) VALUES($1)`, id); err != nil {
		return Product{}, writeError(err)
	}
	if err = insertFields(ctx, tx, id, canonical.Fields); err != nil {
		return Product{}, err
	}
	product, err := readProduct(ctx, tx, int64(id))
	if err != nil {
		return Product{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Product{}, fail(ctx)
	}
	return product, nil
}

// Edit replaces the name and the whole field set of an active product in one
// transaction: the fields are values, not evidence, so they are replaced instead
// of merged and the previous set is removed in the same statement pair. The
// update's own row count is the decision, so there is no read-then-write window: a
// retired product has left the editable catalog and is answered exactly like an
// unknown one, and so is a battery that never belonged here.
func (s *Store) Edit(ctx context.Context, token string, id int64, in EditInput) (Product, error) {
	if ctx == nil || s == nil || s.pool == nil || s.service == nil {
		return Product{}, ErrUnavailable
	}
	if err := s.service.Administrator(ctx, token); err != nil {
		return Product{}, err
	}
	if id < 1 || id > math.MaxInt32 {
		return Product{}, ErrInvalid
	}
	canonical, err := CanonicalEdit(in)
	if err != nil {
		return Product{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	tx, err := s.begin(ctx)
	if err != nil {
		return Product{}, err
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	tag, err := tx.Exec(ctx, `UPDATE catalog_entries SET name=$2
 WHERE id=$1 AND deleted_at IS NULL AND kind='other'`, int32(id), canonical.Name)
	if err != nil {
		return Product{}, writeError(err)
	}
	if tag.RowsAffected() == 0 {
		return Product{}, ErrNotFound
	}
	if _, err = tx.Exec(ctx, `DELETE FROM catalog_entry_fields WHERE catalog_entry_id=$1`, int32(id)); err != nil {
		return Product{}, writeError(err)
	}
	if err = insertFields(ctx, tx, int32(id), canonical.Fields); err != nil {
		return Product{}, err
	}
	product, err := readProduct(ctx, tx, id)
	if err != nil {
		return Product{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Product{}, fail(ctx)
	}
	return product, nil
}

// Retire retires a product in the same shape the battery catalog does: the common
// fence is taken first, an already retired product is a successful no-op, and the
// database's blocker names stock or an open operation before anything is written.
// A retirement is never reversed and nothing is ever deleted.
func (s *Store) Retire(ctx context.Context, token string, id int64) error {
	if ctx == nil || s == nil || s.pool == nil || s.service == nil {
		return ErrUnavailable
	}
	if err := s.service.Administrator(ctx, token); err != nil {
		return err
	}
	if id < 1 || id > math.MaxInt32 {
		return ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	tx, err := s.begin(ctx)
	if err != nil {
		return err
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	// Ordered fence first: the blocker is then authoritative for every writer that
	// moves stock, reserves a variant or retires an entry.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1,$2)`, catalogRetirementFenceKey, catalogRetirementFenceSub); err != nil {
		return fail(ctx)
	}
	var retired bool
	if err = tx.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM catalog_entries
 WHERE id=$1 AND kind='other'`, int32(id)).Scan(&retired); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fail(ctx)
	}
	// A repeated retirement is the same successful answer, exactly like the battery
	// catalog: the marker is not rewritten a second time.
	if retired {
		return tx.Commit(ctx)
	}
	blocker, err := retirementBlocker(ctx, tx, id)
	if err != nil {
		return err
	}
	switch blocker {
	case "":
	case "stock":
		return ErrHasStock
	case "operations":
		return ErrHasPending
	default:
		return ErrConflict
	}
	if _, err = tx.Exec(ctx, `UPDATE catalog_entries SET deleted_at=CURRENT_TIMESTAMP
 WHERE id=$1 AND deleted_at IS NULL`, int32(id)); err != nil {
		return retiredError(err)
	}
	return tx.Commit(ctx)
}

// retirementBlocker asks the database's own function, which is the same decision
// the retirement guard applies to every catalog entry, batteries and products
// alike. It is called under the fence so the answer holds for the following update.
func retirementBlocker(ctx context.Context, q querier, id int64) (string, error) {
	var blocker *string
	if err := q.QueryRow(ctx, `SELECT catalog_entry_retirement_blocker($1::integer)`, int32(id)).Scan(&blocker); err != nil {
		return "", fail(ctx)
	}
	if blocker == nil {
		return "", nil
	}
	return *blocker, nil
}

// List reads one page of the product catalog: one count and one page statement, so
// the total is the database's own number, plus one statement for the fields of the
// listed products. Only the other-product kind of the catalog is ever listed, and
// only while it is active.
func (s *Store) List(ctx context.Context, token string, q Query) (Page, error) {
	if ctx == nil || s == nil || s.pool == nil || s.service == nil {
		return Page{}, ErrUnavailable
	}
	if err := s.service.Administrator(ctx, token); err != nil {
		return Page{}, err
	}
	// Every rejected page, size or filter stops here, before the first statement.
	if !ValidQuery(q) {
		return Page{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, listTimeout)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Page{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	page := Page{Page: q.Page, PageSize: q.PageSize, Products: []Product{}}
	args := []any{literalPattern(q.Search)}
	if tx.QueryRow(ctx, "SELECT count(*)"+productFilter, args...).Scan(&page.Total) != nil {
		return Page{}, fail(ctx)
	}
	args = append(args, int64(q.PageSize), int64(q.Page-1)*int64(q.PageSize))
	rows, err := tx.Query(ctx, "SELECT e.id,e.name"+productFilter+
		" ORDER BY e.id LIMIT $2 OFFSET $3", args...)
	if err != nil {
		return Page{}, fail(ctx)
	}
	for rows.Next() {
		var product Product
		var name string
		if rows.Scan(&product.ID, &name) != nil {
			rows.Close()
			return Page{}, fail(ctx)
		}
		canonical, err := CanonicalName(name)
		if err != nil || canonical != name || product.ID < 1 ||
			(len(page.Products) > 0 && product.ID <= page.Products[len(page.Products)-1].ID) {
			rows.Close()
			return Page{}, ErrUnavailable
		}
		product.Name = canonical
		product.Fields = []Field{}
		page.Products = append(page.Products, product)
	}
	if rows.Err() != nil {
		rows.Close()
		return Page{}, fail(ctx)
	}
	rows.Close()
	if err = readFields(ctx, tx, page.Products); err != nil {
		return Page{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Page{}, fail(ctx)
	}
	return page, nil
}

// productFilter is shared by the count and the page, so both answer the same
// question: the active products of the catalog, and only that kind of entry.
const productFilter = ` FROM catalog_entries e
 WHERE e.deleted_at IS NULL AND e.kind='other'
 AND ($1='' OR e.name ILIKE $1 ESCAPE '\')`

// literalPattern makes the search a literal substring instead of a pattern, so a
// typed % or _ never widens the catalog query.
func literalPattern(search string) string {
	if search == "" {
		return ""
	}
	return "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(search) + "%"
}

type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

// insertFields writes the whole field set of one product. The unit, the number and
// the text are mutually exclusive in the schema, so the absent ones are written as
// NULL instead of an empty value the check would refuse.
func insertFields(ctx context.Context, tx pgx.Tx, id int32, fields []Field) error {
	for _, field := range fields {
		var unit, number, text any
		if field.Unit != "" {
			unit = field.Unit
		}
		if field.Number != nil {
			number = string(*field.Number)
		}
		if field.Text != nil {
			text = *field.Text
		}
		if _, err := tx.Exec(ctx, `INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,unit,number_value,text_value)
 VALUES($1,$2,$3,$4,$5,$6)`, id, field.Name, string(field.Kind), unit, number, text); err != nil {
			return writeError(err)
		}
	}
	return nil
}

// readProduct reads the written product back and validates the persisted record
// before it can be echoed: the identity and the whole field set.
func readProduct(ctx context.Context, q querier, id int64) (Product, error) {
	product := Product{ID: id, Fields: []Field{}}
	var name string
	err := q.QueryRow(ctx, `SELECT id,name FROM catalog_entries WHERE id=$1 AND kind='other'`, int32(id)).Scan(
		&product.ID, &name)
	if errors.Is(err, pgx.ErrNoRows) {
		return Product{}, ErrNotFound
	}
	if err != nil {
		return Product{}, fail(ctx)
	}
	canonical, err := CanonicalName(name)
	if err != nil || canonical != name || product.ID < 1 {
		return Product{}, ErrUnavailable
	}
	product.Name = canonical
	products := []Product{product}
	if err = readFields(ctx, q, products); err != nil {
		return Product{}, err
	}
	return products[0], nil
}

// readFields reads the persisted fields of the given products in one statement and
// attaches them in place. Every row is validated: a row this contract could not
// publish is a store failure, never a product with a partial field set.
func readFields(ctx context.Context, q querier, products []Product) error {
	if len(products) == 0 {
		return nil
	}
	ids := make([]int32, len(products))
	index := make(map[int64]int, len(products))
	for i, product := range products {
		ids[i] = int32(product.ID)
		index[product.ID] = i
	}
	rows, err := q.Query(ctx, `SELECT catalog_entry_id,name,kind,unit,number_value::text,text_value
 FROM catalog_entry_fields WHERE catalog_entry_id = ANY($1::integer[])
 ORDER BY catalog_entry_id,id`, ids)
	if err != nil {
		return fail(ctx)
	}
	defer rows.Close()
	for rows.Next() {
		var entryID int64
		var name, kind string
		var unit, number, text *string
		if rows.Scan(&entryID, &name, &kind, &unit, &number, &text) != nil {
			return fail(ctx)
		}
		position, known := index[entryID]
		if !known {
			return ErrUnavailable
		}
		field, err := storedField(name, kind, unit, number, text)
		if err != nil {
			return err
		}
		if len(products[position].Fields) >= maxFields {
			return ErrUnavailable
		}
		products[position].Fields = append(products[position].Fields, field)
	}
	if rows.Err() != nil {
		return fail(ctx)
	}
	return nil
}

// storedField validates one persisted field and returns it in the canonical shape
// this contract publishes. A decimal never travels as a float: the column's own
// text is parsed back into the catalog decimal.
func storedField(name, kind string, unit, number, text *string) (Field, error) {
	if !utf8.ValidString(name) || !validText(name) ||
		len(name) < 1 || len(name) > maxFieldName || strings.TrimSpace(name) != name {
		return Field{}, ErrUnavailable
	}
	field := Field{Name: name, Kind: Kind(kind)}
	switch field.Kind {
	case KindNumber:
		if number == nil || text != nil {
			return Field{}, ErrUnavailable
		}
		value, err := CanonicalNumber(*number)
		if err != nil {
			return Field{}, ErrUnavailable
		}
		field.Number = &value
		if unit != nil {
			if !utf8.ValidString(*unit) || !validText(*unit) ||
				len(*unit) < 1 || len(*unit) > maxUnit || strings.TrimSpace(*unit) != *unit {
				return Field{}, ErrUnavailable
			}
			field.Unit = *unit
		}
	case KindText:
		if text == nil || number != nil || unit != nil {
			return Field{}, ErrUnavailable
		}
		if !utf8.ValidString(*text) || !validText(*text) || len(*text) < 1 || len(*text) > maxText {
			return Field{}, ErrUnavailable
		}
		value := *text
		field.Text = &value
	default:
		return Field{}, ErrUnavailable
	}
	return field, nil
}
