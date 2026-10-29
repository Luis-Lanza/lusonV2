// Package inventory provides read-only per-location consultation.
package inventory

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/catalog"
	"strings"
	"unicode/utf8"
)

var ErrInvalid = errors.New("invalid inventory request")

type Location struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}
type Metadata struct {
	Locations []Location `json:"locations"`
	Brands    []string   `json:"brands"`
}
type Query struct {
	LocationID              int
	Search, Brand, Polarity string
	Page, PageSize          int
}
type Item struct {
	VariantID      int             `json:"variant_id"`
	CatalogEntryID int             `json:"catalog_entry_id"`
	Brand          string          `json:"brand"`
	Model          string          `json:"model"`
	Capacity       catalog.Decimal `json:"capacity_ah"`
	Polarity       string          `json:"polarity"`
	Existing       int64           `json:"existing"`
	Reserved       int64           `json:"reserved"`
	Available      int64           `json:"available"`
}
type Page struct {
	Location      Location `json:"location"`
	Items         []Item   `json:"items"`
	Page          int      `json:"page"`
	PageSize      int      `json:"page_size"`
	TotalVariants int      `json:"total_variants"`
}
type Store struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// The actor is resolved by authentication, never supplied by query/body fields.
func resolved(actor auth.Identity) bool {
	return actor.AccountID > 0 && actor.Location.ID >= 1 && actor.Location.ID <= 32767 &&
		(actor.AccountID == 1) == (actor.Location.ID == 1) && !actor.MustChangePassword
}
func textValid(text string, limit int) bool {
	return len(text) <= limit && utf8.ValidString(text) && !strings.ContainsRune(text, 0)
}
func (q Query) Validate() error {
	if q.LocationID < 1 || q.LocationID > 32767 || q.Page < 1 || q.Page > 1000000 || (q.PageSize != 10 && q.PageSize != 25 && q.PageSize != 50) || (q.Polarity != "" && q.Polarity != "L" && q.Polarity != "R") || !textValid(q.Search, 128) || !textValid(q.Brand, 128) {
		return ErrInvalid
	}
	return nil
}
func (s *Store) Metadata(ctx context.Context, actor auth.Identity) (Metadata, error) {
	result := Metadata{Locations: []Location{}, Brands: []string{}}
	if !resolved(actor) {
		return result, ErrInvalid
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return result, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	rows, err := tx.Query(ctx, `SELECT id,name FROM locations ORDER BY id`)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var l Location
		if err = rows.Scan(&l.ID, &l.Name); err != nil {
			rows.Close()
			return result, err
		}
		result.Locations = append(result.Locations, l)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return result, err
	}
	rows, err = tx.Query(ctx, `SELECT DISTINCT brand FROM catalog_entries ORDER BY brand`)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var brand string
		if err = rows.Scan(&brand); err != nil {
			rows.Close()
			return result, err
		}
		result.Brands = append(result.Brands, brand)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}

// Count and items share both predicates and a repeatable-read read-only snapshot.
const filtered = ` FROM inventory_balances b
 JOIN catalog_variants v ON v.id=b.variant_id
 JOIN catalog_entries e ON e.id=v.catalog_entry_id
 WHERE b.location_id=$1
 AND ($2='' OR e.brand ILIKE $2 ESCAPE '\' OR e.model ILIKE $2 ESCAPE '\')
 AND ($3='' OR e.brand=$3) AND ($4='' OR v.polarity=$4)`

func literalPattern(search string) string {
	if search == "" {
		return ""
	}
	return "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(search) + "%"
}
func (s *Store) List(ctx context.Context, actor auth.Identity, q Query) (Page, error) {
	result := Page{Items: []Item{}, Page: q.Page, PageSize: q.PageSize}
	if !resolved(actor) || q.Validate() != nil {
		return result, ErrInvalid
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return result, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	err = tx.QueryRow(ctx, `SELECT id,name FROM locations WHERE id=$1`, q.LocationID).Scan(&result.Location.ID, &result.Location.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, ErrInvalid
	}
	if err != nil {
		return result, err
	}
	if q.Brand != "" {
		var exists bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM catalog_entries WHERE brand=$1)`, q.Brand).Scan(&exists); err != nil {
			return result, err
		}
		if !exists {
			return result, ErrInvalid
		}
	}
	args := []any{q.LocationID, literalPattern(q.Search), q.Brand, q.Polarity}
	if err = tx.QueryRow(ctx, `SELECT count(*)`+filtered, args...).Scan(&result.TotalVariants); err != nil {
		return result, err
	}
	args = append(args, q.PageSize, int64(q.Page-1)*int64(q.PageSize))
	rows, err := tx.Query(ctx, `SELECT v.id,e.id,e.brand,e.model,e.capacity_ah::text,v.polarity,b.existing,b.reserved,b.available`+filtered+` ORDER BY v.id LIMIT $5 OFFSET $6`, args...)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var item Item
		var capacity string
		if err = rows.Scan(&item.VariantID, &item.CatalogEntryID, &item.Brand, &item.Model, &capacity, &item.Polarity, &item.Existing, &item.Reserved, &item.Available); err != nil {
			return result, err
		}
		item.Capacity, err = catalog.ParseDecimal(capacity)
		if err != nil {
			return result, err
		}
		result.Items = append(result.Items, item)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}
