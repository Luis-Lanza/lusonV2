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
var ErrRetiredLocation = errors.New("retired inventory location")

type Location struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}
type Metadata struct {
	Locations []Location `json:"locations"`
	Brands    []string   `json:"brands"`
}
type Query struct {
	LocationID int
	// Kind selects batteries, other products or both. The absent value is the
	// battery-only listing every caller had before the second kind existed.
	Kind                    catalog.KindFilter
	Search, Brand, Polarity string
	Page, PageSize          int
}

// Item is one row of the stock screen: the variant identity of its own kind plus
// the three stock numbers of the location. The identity is the only catalogue
// shape the wire carries, so a product row never invents a battery attribute.
type Item struct {
	catalog.Identity
	Existing  int64 `json:"existing"`
	Reserved  int64 `json:"reserved"`
	Available int64 `json:"available"`
	// The catalogue columns of the row are kept for the in-process readers that
	// build an Item from their own statement; they are never part of the wire,
	// which carries the identity above.
	CatalogEntryID int             `json:"-"`
	Brand          string          `json:"-"`
	Model          string          `json:"-"`
	Capacity       catalog.Decimal `json:"-"`
	Polarity       string          `json:"-"`
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
	if q.LocationID < 1 || q.LocationID > 32767 || q.Page < 1 || q.Page > 1000000 || (q.PageSize != 10 && q.PageSize != 25 && q.PageSize != 50) || !q.Kind.Valid() || (q.Polarity != "" && q.Polarity != "L" && q.Polarity != "R") || !textValid(q.Search, 128) || !textValid(q.Brand, 128) {
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
	rows, err := tx.Query(ctx, `SELECT id,name FROM locations WHERE deleted_at IS NULL ORDER BY id`)
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
	rows, err = tx.Query(ctx, `SELECT DISTINCT e.brand FROM catalog_entries e WHERE `+activeBattery+` ORDER BY e.brand`)
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

// activeBattery is the single definition of "this battery is part of the operating
// catalog": the brand list and the brand probe both compose it as `e`, so a change
// to the rule reaches both at once. A brand is a battery attribute only, so the
// other product kind never contributes one. History paths never apply it - an
// archived battery must stay visible in past evidence.
const activeBattery = `e.deleted_at IS NULL AND e.kind = 'battery'`

// Count and items share both predicates and a repeatable-read read-only snapshot.
// A retired entry is no longer part of the operating inventory, and the kind
// selection is the same predicate on both: an absent kind is the battery-only
// listing, `all` reads both kinds and `other` reads the products alone.
const filtered = ` FROM inventory_balances b
 JOIN catalog_variants v ON v.id=b.variant_id
 JOIN catalog_entries e ON e.id=v.catalog_entry_id
 WHERE b.location_id=$1 AND e.deleted_at IS NULL
 AND ($5='all' OR e.kind=$5)
 AND ($2='' OR e.brand ILIKE $2 ESCAPE '\' OR e.model ILIKE $2 ESCAPE '\' OR e.name ILIKE $2 ESCAPE '\')
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
	var retired bool
	err = tx.QueryRow(ctx, `SELECT id,name,deleted_at IS NOT NULL FROM locations WHERE id=$1`, q.LocationID).Scan(&result.Location.ID, &result.Location.Name, &retired)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, ErrInvalid
	}
	if err != nil {
		return result, err
	}
	if q.Brand != "" {
		var exists bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM catalog_entries e WHERE e.brand=$1 AND `+activeBattery+`)`, q.Brand).Scan(&exists); err != nil {
			return result, err
		}
		if !exists {
			return result, ErrInvalid
		}
	}
	if retired {
		return result, ErrRetiredLocation
	}
	args := []any{q.LocationID, literalPattern(q.Search), q.Brand, q.Polarity, string(q.Kind.Filter())}
	if err = tx.QueryRow(ctx, `SELECT count(*)`+filtered, args...).Scan(&result.TotalVariants); err != nil {
		return result, err
	}
	args = append(args, q.PageSize, int64(q.Page-1)*int64(q.PageSize))
	rows, err := tx.Query(ctx, `SELECT v.id,e.id,e.kind,coalesce(e.brand,''),coalesce(e.model,''),
  e.capacity_ah::text,coalesce(v.polarity,''),coalesce(e.name,''),b.existing,b.reserved,b.available`+filtered+` ORDER BY v.id LIMIT $6 OFFSET $7`, args...)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	type row struct {
		variant            catalog.Row
		existing, reserved int64
		available          int64
	}
	selected := make([]row, 0, q.PageSize)
	entries := make([]int32, 0, q.PageSize)
	for rows.Next() {
		var item row
		var capacity *string
		if err = rows.Scan(&item.variant.VariantID, &item.variant.CatalogEntryID, &item.variant.Kind,
			&item.variant.Brand, &item.variant.Model, &capacity, &item.variant.Polarity, &item.variant.Name,
			&item.existing, &item.reserved, &item.available); err != nil {
			return result, err
		}
		// A numeric column never travels as a float: its own text is parsed back
		// into the canonical decimal of the contract.
		if capacity != nil {
			item.variant.Capacity = *capacity
		}
		if item.variant.Kind == catalog.OtherKind {
			entries = append(entries, int32(item.variant.CatalogEntryID))
		}
		selected = append(selected, item)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return result, err
	}
	// The typed fields of the listed products are one statement, never an N+1
	// lookup, and a row this contract could not publish fails the read closed.
	fields, err := catalog.ReadFields(ctx, tx, entries)
	if err != nil {
		return result, err
	}
	for _, item := range selected {
		identity, err := item.variant.Identity(fields[item.variant.CatalogEntryID])
		if err != nil {
			return result, err
		}
		entry := Item{Identity: identity, Existing: item.existing, Reserved: item.reserved,
			Available: item.available, CatalogEntryID: item.variant.CatalogEntryID,
			Brand: item.variant.Brand, Model: item.variant.Model, Polarity: item.variant.Polarity}
		if identity.Battery != nil {
			entry.Capacity = catalog.Decimal(identity.Battery.Capacity)
		}
		result.Items = append(result.Items, entry)
	}
	if err = tx.Commit(ctx); err != nil {
		return result, err
	}
	return result, nil
}
