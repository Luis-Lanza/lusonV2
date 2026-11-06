// Package bootstrap owns explicitly gated, one-time trial data initialization.
package bootstrap

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/fixtures"
	"luson/api/internal/catalog"
	"luson/api/internal/config"
	"luson/api/internal/db"
)

const stockOrigin = "fictional-local-trial-v1"

// Initialize is the later server's entry point. Production applies only schema;
// it cannot silently acquire fictional balances. Schema and seed each have
// their own transaction, so a failed seed leaves a usable, empty schema.
func Initialize(ctx context.Context, pool *pgxpool.Pool, profile config.Profile) error {
	if profile != config.Production && profile != config.LocalTrial {
		return errors.New("unsupported initialization profile")
	}
	if err := db.Apply(ctx, pool); err != nil {
		return err
	}
	if profile == config.LocalTrial {
		return Seed(ctx, pool, profile)
	}
	return nil
}

// Seed never repairs partial datasets or overwrites operational quantities.
func Seed(ctx context.Context, pool *pgxpool.Pool, profile config.Profile) error {
	if profile != config.LocalTrial {
		return errors.New("fictional initialization requires explicit local-trial profile")
	}
	source, err := catalog.Load()
	if err != nil {
		return err
	}
	return db.Locked(ctx, pool, func(tx pgx.Tx) error {
		initialized, err := state(ctx, tx, source)
		if err != nil {
			return err
		}
		if initialized {
			return nil
		}
		for _, location := range catalog.Locations() {
			if _, err := tx.Exec(ctx, "INSERT INTO locations(id,name) VALUES($1,$2)", location.ID, location.Name); err != nil {
				return err
			}
		}
		for _, entry := range source.Entries {
			if _, err := tx.Exec(ctx, "INSERT INTO catalog_entries(id,brand,model,capacity_ah) VALUES($1,$2,$3,$4::numeric)", entry.ID, entry.Brand, entry.Model, string(entry.Capacity)); err != nil {
				return err
			}
		}
		for _, variant := range source.Variants() {
			if _, err := tx.Exec(ctx, "INSERT INTO catalog_variants(id,catalog_entry_id,polarity) VALUES($1,$2,$3)", variant.ID, variant.CatalogID, string(variant.Polarity)); err != nil {
				return err
			}
			for _, location := range catalog.Locations() {
				existing := trialQuantity(location.ID, variant.ID)
				if _, err := tx.Exec(ctx, "INSERT INTO inventory_balances(location_id,variant_id,existing,reserved) VALUES($1,$2,$3,0)", location.ID, variant.ID, existing); err != nil {
					return err
				}
			}
		}
		if _, err := tx.Exec(ctx, "INSERT INTO initialization_metadata(id,source_sha256,fixture_sha256,stock_origin) VALUES(1,$1,$2,$3)", source.SourceSHA, fixtureHash(), stockOrigin); err != nil {
			return err
		}
		_, err = state(ctx, tx, source)
		return err
	})
}

// trialQuantity is fictional, deterministic, varied and deliberately includes
// zero stock. Each location has a distinct quantity for every variant.
func trialQuantity(locationID, variantID int) int64 { return int64((variantID*7 + locationID*11) % 31) }
func fixtureHash() string {
	hash := sha256.Sum256(fixtures.Catalog)
	return hex.EncodeToString(hash[:])
}

// Check accepts a fully empty schema or a complete initialized dataset;
// abnormal partial data is an error, not an invitation to backfill it.
func Check(ctx context.Context, pool *pgxpool.Pool) error {
	source, err := catalog.Load()
	if err != nil {
		return err
	}
	return db.Locked(ctx, pool, func(tx pgx.Tx) error { _, err := state(ctx, tx, source); return err })
}
func state(ctx context.Context, tx pgx.Tx, source catalog.Catalog) (bool, error) {
	counts := map[string]int{}
	// Names are fixed internal identifiers, never caller-controlled SQL.
	for _, table := range []string{"initialization_metadata", "locations", "catalog_entries", "catalog_variants", "inventory_balances"} {
		var n int
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n); err != nil {
			return false, err
		}
		counts[table] = n
	}
	if counts["initialization_metadata"] == 0 {
		for table, n := range counts {
			if n != 0 {
				return false, fmt.Errorf("partial existing dataset in %s; initialization refused", table)
			}
		}
		return false, nil
	}
	if counts["locations"] < len(catalog.Locations()) {
		return false, errors.New("initialized dataset incomplete in locations")
	}
	if counts["initialization_metadata"] != 1 {
		return false, errors.New("initialized dataset incomplete in initialization_metadata")
	}
	var sourceSHA, fixtureSHA, origin string
	if err := tx.QueryRow(ctx, "SELECT source_sha256,fixture_sha256,stock_origin FROM initialization_metadata WHERE id=1").Scan(&sourceSHA, &fixtureSHA, &origin); err != nil {
		return false, err
	}
	if sourceSHA != source.SourceSHA || fixtureSHA != fixtureHash() || origin != stockOrigin {
		return false, errors.New("initialization provenance differs from embedded fixture")
	}
	rows, err := observe(ctx, tx, source)
	if err != nil {
		return false, err
	}
	if err := verifyFixture(source, rows); err != nil {
		return false, err
	}
	for _, location := range catalog.Locations() {
		var name string
		if err := tx.QueryRow(ctx, "SELECT name FROM locations WHERE id=$1", location.ID).Scan(&name); err != nil {
			return false, err
		}
		if name != location.Name {
			return false, errors.New("preloaded locations differ")
		}
	}
	// FK, PK and quantity checks protect balances. Do not compare their values
	// with trial stock: those quantities may already be operationally changed.
	return true, nil
}

// seedRows are the observed rows the fixture comparison needs. The database is
// the catalog authority, so rows past the seeded identities are operational
// data: they are observed and then ignored, never repaired or refused.
type seedRows struct {
	entries  []entryRow
	variants []variantRow
	// missing holds only the (active branch, fixture variant) pairs the database
	// reported as having no balance row, never the whole matrix.
	missing []missingBalance
}

type entryRow struct {
	id    int
	brand string
	model string
}

type variantRow struct {
	id       int
	entryID  int
	polarity catalog.Polarity
}

// missingBalance is one active branch that has no balance row for a fixture
// variant: the pair the integrity check must refuse.
type missingBalance struct {
	locationID int
	variantID  int
}

// observe reads exactly the fixture identities and the balance pairs that are absent
// from the active branch set. Both the catalog and the branch set grow at runtime, so
// an unscoped read would scale with the whole branch x variant matrix on every startup
// check, and it would have to parse values the fixture never authored. Allocated
// identities and retired branches are simply not part of what this check proves.
func observe(ctx context.Context, tx pgx.Tx, source catalog.Catalog) (seedRows, error) {
	var rows seedRows
	entryIDs := make([]int32, 0, len(source.Entries))
	for _, entry := range source.Entries {
		entryIDs = append(entryIDs, int32(entry.ID))
	}
	variantIDs := make([]int32, 0, len(source.Entries)*2)
	for _, variant := range source.Variants() {
		variantIDs = append(variantIDs, int32(variant.ID))
	}
	// Identity and authored labels only: an administrator may edit a capacity, so the
	// check neither reads nor parses that value.
	entries, err := tx.Query(ctx, "SELECT id,brand,model FROM catalog_entries WHERE id=ANY($1::integer[]) ORDER BY id", entryIDs)
	if err != nil {
		return rows, err
	}
	for entries.Next() {
		var row entryRow
		if err := entries.Scan(&row.id, &row.brand, &row.model); err != nil {
			entries.Close()
			return rows, err
		}
		rows.entries = append(rows.entries, row)
	}
	err = entries.Err()
	entries.Close()
	if err != nil {
		return rows, err
	}
	variants, err := tx.Query(ctx, "SELECT id,catalog_entry_id,polarity FROM catalog_variants WHERE id=ANY($1::integer[]) ORDER BY id", variantIDs)
	if err != nil {
		return rows, err
	}
	for variants.Next() {
		var row variantRow
		var polarity string
		if err := variants.Scan(&row.id, &row.entryID, &polarity); err != nil {
			variants.Close()
			return rows, err
		}
		row.polarity = catalog.Polarity(polarity)
		rows.variants = append(rows.variants, row)
	}
	err = variants.Err()
	variants.Close()
	if err != nil {
		return rows, err
	}
	// The database answers only the pairs that are missing for the fixture variants in
	// the active branches: an intact matrix costs one bounded query that returns no
	// rows, instead of loading every balance the deployment has.
	missing, err := tx.Query(ctx, `SELECT l.id,v.id FROM locations l
CROSS JOIN unnest($1::integer[]) AS v(id)
WHERE l.deleted_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM inventory_balances b WHERE b.location_id=l.id AND b.variant_id=v.id)
ORDER BY l.id,v.id`, variantIDs)
	if err != nil {
		return rows, err
	}
	for missing.Next() {
		var row missingBalance
		if err := missing.Scan(&row.locationID, &row.variantID); err != nil {
			missing.Close()
			return rows, err
		}
		rows.missing = append(rows.missing, row)
	}
	err = missing.Err()
	missing.Close()
	return rows, err
}

// verifyFixture proves the embedded fixture is still intact while the database
// stays the catalog authority. Every fixture identity keeps its exact values and
// every fixture variant keeps a balance row in every active branch; batteries and
// branches created after the seed, their balances and archived fixture rows are
// operational history and never fail an integrity check.
func verifyFixture(source catalog.Catalog, rows seedRows) error {
	if err := verifyEntries(source, rows.entries); err != nil {
		return err
	}
	if err := verifyVariants(source, rows.variants); err != nil {
		return err
	}
	return verifyBalances(rows.missing)
}

// verifyEntries compares only the fixture prefix; rows arrive ordered by id and
// the fixture owns ids 1..N, so an allocated battery can never occupy or replace
// a seeded identity.
func verifyEntries(source catalog.Catalog, rows []entryRow) error {
	if len(rows) < len(source.Entries) {
		return errors.New("initialized dataset incomplete in catalog_entries")
	}
	// Only the seeded identity is proven. A brand, model or capacity is operational
	// data an administrator may legitimately edit, so a changed value is not a
	// defect; a missing or misordered identity still is.
	for i, expected := range source.Entries {
		if rows[i].id != expected.ID {
			return errors.New("preloaded catalog identity differs from fixture")
		}
	}
	return nil
}

// verifyVariants applies the same fixture prefix the seed wrote.
func verifyVariants(source catalog.Catalog, rows []variantRow) error {
	variants := source.Variants()
	if len(rows) < len(variants) {
		return errors.New("initialized dataset incomplete in catalog_variants")
	}
	for i, expected := range variants {
		row := rows[i]
		if row.id != expected.ID || row.entryID != expected.CatalogID || row.polarity != expected.Polarity {
			return errors.New("preloaded variants differ from fixture")
		}
	}
	return nil
}

// verifyBalances fails when an active branch is missing the balance row the
// operating catalog requires for a fixture variant. Balances of allocated variants
// and of retired branches are never asked for, so this check cannot scale with the
// deployment, and a missing pair still fails it.
func verifyBalances(missing []missingBalance) error {
	if len(missing) != 0 {
		return errors.New("initialized dataset incomplete in inventory_balances")
	}
	return nil
}
