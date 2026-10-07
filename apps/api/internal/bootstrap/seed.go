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
	for table, want := range map[string]int{"initialization_metadata": 1, "locations": 3, "catalog_entries": 95, "catalog_variants": 190, "inventory_balances": 570} {
		if counts[table] != want {
			return false, fmt.Errorf("initialized dataset incomplete in %s", table)
		}
	}
	var sourceSHA, fixtureSHA, origin string
	if err := tx.QueryRow(ctx, "SELECT source_sha256,fixture_sha256,stock_origin FROM initialization_metadata WHERE id=1").Scan(&sourceSHA, &fixtureSHA, &origin); err != nil {
		return false, err
	}
	if sourceSHA != source.SourceSHA || fixtureSHA != fixtureHash() || origin != stockOrigin {
		return false, errors.New("initialization provenance differs from embedded fixture")
	}
	if err := checkEntries(ctx, tx, source); err != nil {
		return false, err
	}
	rows, err := tx.Query(ctx, "SELECT id,catalog_entry_id,polarity FROM catalog_variants ORDER BY id")
	if err != nil {
		return false, err
	}
	variants := source.Variants()
	index := 0
	for rows.Next() {
		var id, entry int
		var polarity string
		if err := rows.Scan(&id, &entry, &polarity); err != nil {
			rows.Close()
			return false, err
		}
		expected := variants[index]
		index++
		if id != expected.ID || entry != expected.CatalogID || polarity != string(expected.Polarity) {
			rows.Close()
			return false, errors.New("preloaded variants differ from fixture")
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
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
func checkEntries(ctx context.Context, tx pgx.Tx, source catalog.Catalog) error {
	rows, err := tx.Query(ctx, "SELECT id,brand,model,capacity_ah::text FROM catalog_entries ORDER BY id")
	if err != nil {
		return err
	}
	defer rows.Close()
	index := 0
	for rows.Next() {
		var id int
		var brand, model, capacity string
		if err := rows.Scan(&id, &brand, &model, &capacity); err != nil {
			return err
		}
		expected := source.Entries[index]
		index++
		decimal, err := catalog.ParseDecimal(capacity)
		if err != nil || id != expected.ID || brand != expected.Brand || model != expected.Model || decimal != expected.Capacity {
			return errors.New("preloaded catalog differs from fixture")
		}
	}
	return rows.Err()
}
