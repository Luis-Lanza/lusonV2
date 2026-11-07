package transfers_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/catalog"
	"luson/api/internal/db"
	"luson/api/internal/inventory"
	"luson/api/internal/testpg"
	"luson/api/internal/transfers"
	"luson/api/migrations"
)

// urPrefixFixture is the explicitly approved test-local bootstrap exception.
// Initialize would apply018; Provision calls latest-schema Check. Neither can
// build the historical starting point. Keep their live validators unchanged.
func urPrefixFixture(t *testing.T) (context.Context, *pgxpool.Pool, *transfers.Store) {
	t.Helper()
	ctx, p := urPrefixFixtureAt(t, 18)
	return ctx, p, transfers.New(p)
}

// urPrefixFixtureAt installs the contiguous embedded prefix 001..stop-1 with the
// same lock, exact bytes/checksums and tracking rows db.Apply writes, so the
// normal runner can apply `stop` later on top of populated historical data.
func urPrefixFixtureAt(t *testing.T, stop int) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	// Same lock, contiguous embedded versions, exact bytes/checksums and tracking
	// shape as db.Apply / TestDR1VerifierMigrationUpgrade. Only install001..017.
	err := db.Locked(ctx, p, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `CREATE TABLE schema_migrations(version integer PRIMARY KEY CHECK(version>0),name text NOT NULL,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
			return err
		}
		files, err := migrations.Files.ReadDir(".")
		if err != nil {
			return err
		}
		n := 0
		for _, file := range files {
			if !strings.HasSuffix(file.Name(), ".sql") {
				continue
			}
			prefix, _, ok := strings.Cut(file.Name(), "_")
			version, err := strconv.Atoi(prefix)
			if !ok || err != nil || version != n+1 {
				return fmt.Errorf("noncontiguous embedded migration %s", file.Name())
			}
			if version == stop {
				break
			}
			body, err := migrations.Files.ReadFile(file.Name())
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, string(body)); err != nil {
				return err
			}
			hash := sha256.Sum256(body)
			if _, err := tx.Exec(ctx, "INSERT INTO schema_migrations(version,name,checksum) VALUES($1,$2,$3)", version, file.Name(), hex.EncodeToString(hash[:])); err != nil {
				return err
			}
			n++
		}
		if n != stop-1 {
			return fmt.Errorf("prefix has %d migrations", n)
		}
		return nil
	})
	if err != nil {
		t.Fatal("install real prefix", err)
	}
	urSeedPrefixDataset(t, ctx, p)
	// Duplicate Provision invariants, except its latest-schema Check: exactly
	// three distinct valid credentials, production password hashing, empty account
	// set, exact catalog location identities/order, and one locked transaction.
	credentials := make([]bootstrap.Credentials, 3)
	users, passwords := map[string]bool{}, map[string]bool{}
	hashes := make([]string, 3)
	for i := range credentials {
		c := bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
		if !auth.ValidCredentials(c.Username, c.Password) || users[c.Username] || passwords[c.Password] {
			t.Fatal("invalid prefix credentials")
		}
		users[c.Username], passwords[c.Password] = true, true
		credentials[i] = c
		hashes[i], err = auth.HashPassword(c.Password)
		if err != nil {
			t.Fatal(err)
		}
	}
	err = db.Locked(ctx, p, func(tx pgx.Tx) error {
		var n int
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM auth_accounts").Scan(&n); err != nil {
			return err
		}
		if n != 0 {
			return fmt.Errorf("prefix accounts already present")
		}
		locations := catalog.Locations()
		if len(locations) != len(credentials) {
			return fmt.Errorf("prefix requires three locations")
		}
		for _, location := range locations {
			var name string
			if err := tx.QueryRow(ctx, "SELECT name FROM locations WHERE id=$1", location.ID).Scan(&name); err != nil {
				return err
			}
			if name != location.Name {
				return fmt.Errorf("prefix location mismatch")
			}
		}
		for i, c := range credentials {
			if _, err := tx.Exec(ctx, "INSERT INTO auth_accounts(location_id,username,password_hash) VALUES($1,$2,$3)", i+1, c.Username, hashes[i]); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal("prefix account provisioning", err)
	}
	return ctx, p
}

// urSeedPrefixDataset installs the historical local-trial dataset through the only
// tables and columns that exist at the prefix. bootstrap.Seed is a current-schema
// operation -- it reads catalog_entries.deleted_at, which migration 028 adds -- so it
// cannot build a historical starting point; db.Check still validates the upgrade.
//
// The dataset is the fixture's own and complete: the three locations, its entries with
// both polarities, and the deterministic fictional balance per (location, variant).
// These upgrade tests need that whole matrix, because they snapshot every balance row
// as the proof that the upgrade changed no stock, and page the whole inventory listing
// per location. They read no seed provenance, so no initialization_metadata row is
// written: without it the 014 branch fan-out stays inert and the balances below are the
// only stock in the database, exactly as the seed leaves it.
func urSeedPrefixDataset(t *testing.T, ctx context.Context, p *pgxpool.Pool) {
	t.Helper()
	source, err := catalog.Load()
	if err != nil {
		t.Fatal("embedded catalog is unreadable", err)
	}
	err = db.Locked(ctx, p, func(tx pgx.Tx) error {
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
				if _, err := tx.Exec(ctx, "INSERT INTO inventory_balances(location_id,variant_id,existing,reserved) VALUES($1,$2,$3,0)", location.ID, variant.ID, urTrialQuantity(location.ID, variant.ID)); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal("prefix dataset", err)
	}
}

// urTrialQuantity is the fictional, deterministic, deliberately varied trial stock
// (it includes zero) the historical seed wrote: each location holds a distinct
// quantity of every variant.
func urTrialQuantity(locationID, variantID int) int64 {
	return int64((variantID*7 + locationID*11) % 31)
}

// urEraInventory is the per-location stock listing the prefix era could answer, in the
// same public shape inventory.Store answers with today. The current selection path
// filters catalog_entries.deleted_at, a column migration 028 adds, so it cannot read a
// pre-028 database at all; this helper asks the same question with the columns the
// prefix has. The upgrade assertions below compare this pre-upgrade snapshot with a
// post-upgrade read through the real store, so both sides stay the public stock.
func urEraInventory(t *testing.T, ctx context.Context, p *pgxpool.Pool) []inventory.Page {
	t.Helper()
	var pages []inventory.Page
	for location := 1; location <= 3; location++ {
		var page inventory.Page
		page.Location.ID = location
		if err := p.QueryRow(ctx, "SELECT name FROM locations WHERE id=$1", location).Scan(&page.Location.Name); err != nil {
			t.Fatal("prefix location unreadable", err)
		}
		for number := 1; number <= 4; number++ {
			page.Page, page.PageSize, page.Items = number, 50, []inventory.Item{}
			if err := p.QueryRow(ctx, "SELECT count(*) FROM inventory_balances WHERE location_id=$1", location).Scan(&page.TotalVariants); err != nil {
				t.Fatal("prefix inventory count unreadable", err)
			}
			rows, err := p.Query(ctx, `SELECT v.id,e.id,e.brand,e.model,e.capacity_ah::text,v.polarity,
  b.existing,b.reserved,b.available
  FROM inventory_balances b JOIN catalog_variants v ON v.id=b.variant_id
  JOIN catalog_entries e ON e.id=v.catalog_entry_id
  WHERE b.location_id=$1 ORDER BY v.id LIMIT $2 OFFSET $3`, location, page.PageSize, (number-1)*page.PageSize)
			if err != nil {
				t.Fatal("prefix inventory listing failed", err)
			}
			for rows.Next() {
				var item inventory.Item
				var capacity string
				if err := rows.Scan(&item.VariantID, &item.CatalogEntryID, &item.Brand, &item.Model, &capacity, &item.Polarity, &item.Existing, &item.Reserved, &item.Available); err != nil {
					rows.Close()
					t.Fatal("prefix inventory row unreadable", err)
				}
				if item.Capacity, err = catalog.ParseDecimal(capacity); err != nil {
					rows.Close()
					t.Fatal("prefix inventory capacity unreadable", err)
				}
				page.Items = append(page.Items, item)
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				t.Fatal("prefix inventory listing failed", err)
			}
			pages = append(pages, page)
		}
	}
	return pages
}

// urHistoricalReceipt finalizes the receipt the legacy fixtures used: variant 1
// dispatched with 10 units and 8 arriving. The prefix database therefore holds genuine
// pre-019 history, written with the SQL that prefix era admits.
func urHistoricalReceipt(t *testing.T, ctx context.Context, p *pgxpool.Pool, s *transfers.Store) transfers.Request {
	t.Helper()
	return urEraReceipt(t, ctx, p, s, 2,
		[]transfers.Line{{VariantID: 1, Quantity: 10}},
		[]transfers.Line{{VariantID: 1, Quantity: 8}})
}

// urEraPendingRequest writes the pending request through the tables and columns the
// installed prefix actually has. Store.Create cannot do it there: its availability read
// selects catalog_entries.deleted_at, a column migration 028 adds, so a current-schema
// writer is exactly as unusable on a historical schema as bootstrap.Seed. The intent is
// still the public contract -- transfers.Validate derives the fingerprint the store would
// persist, and Get re-derives it later -- and the 015 creation admission trigger still
// judges the row.
func urEraPendingRequest(t *testing.T, ctx context.Context, p *pgxpool.Pool, creator int, in transfers.CreateInput) int64 {
	t.Helper()
	n, err := transfers.Validate(actor(creator), in)
	if err != nil {
		t.Fatal("historical creation intent", err)
	}
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("historical creation transaction", err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO transfer_requests
   (creator_location_id,kind,origin_location_id,destination_location_id,approver_location_id,retry_key,payload_sha256,status)
   VALUES($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id`,
		n.CreatorID, string(n.Kind), n.OriginID, n.DestinationID, n.ApproverID, n.RetryKey, n.Fingerprint[:]).Scan(&id); err != nil {
		t.Fatal("historical pending request", err)
	}
	for _, line := range n.Items {
		if _, err := tx.Exec(ctx, "INSERT INTO transfer_request_items(request_id,variant_id,quantity) VALUES($1,$2,$3)", id, int32(line.VariantID), line.Quantity); err != nil {
			t.Fatal("historical request item", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal("historical pending request", err)
	}
	return id
}

// urEraReceipt builds the historical received transfer the pre-019 flows produced.
// Approval and dispatch still run through the public store, which reads no post-prefix
// column; the finalization is the two writes the store itself issues, because
// Store.Receive admits the destination catalogue through catalog_entries.deleted_at.
// Everything the receipt *means* stays the database's: the 008 triggers credit the
// destination, derive the shortage/excess rows and judge the document at commit.
func urEraReceipt(t *testing.T, ctx context.Context, p *pgxpool.Pool, s *transfers.Store, creator int, dispatched, arrived []transfers.Line) transfers.Request {
	t.Helper()
	in := input()
	in.Items = dispatched
	r, err := s.Get(ctx, actor(creator), urEraPendingRequest(t, ctx, p, creator, in))
	if err != nil {
		t.Fatal("historical request", err)
	}
	if _, err := s.Approve(ctx, actor(r.Approver.ID), r.ID); err != nil {
		t.Fatal("historical approval", err)
	}
	r, err = s.Dispatch(ctx, actor(r.Origin.ID), r.ID)
	if err != nil {
		t.Fatal("historical dispatch", err)
	}
	actual := make(map[int64]int64, len(arrived))
	for _, line := range arrived {
		actual[line.VariantID] = line.Quantity
	}
	// Which lines the historical finalization owed is the dispatched payload the 008
	// admission trigger demands, never a second copy of the wire input.
	sent := make(map[int64]int64, len(r.Items))
	for _, item := range r.Items {
		sent[item.VariantID] = item.Quantity
	}
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("historical receipt transaction", err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	for variant, expected := range sent {
		quantity, ok := actual[variant]
		if !ok {
			t.Fatal("historical receipt is missing a dispatched variant", variant)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO transfer_receipt_lines(request_id,variant_id,expected_quantity,actual_quantity,available_quantity)
   VALUES($1,$2,$3::bigint,$4::bigint,LEAST($3::bigint,$4::bigint))`, r.ID, int32(variant), expected, quantity); err != nil {
			t.Fatal("historical receipt line", err)
		}
	}
	if _, err := tx.Exec(ctx, "UPDATE transfer_requests SET status='received' WHERE id=$1", r.ID); err != nil {
		t.Fatal("historical receipt finalization", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal("historical receipt finalization", err)
	}
	settled, err := s.Get(ctx, actor(r.Destination.ID), r.ID)
	if err != nil {
		t.Fatal("historical receipt", err)
	}
	return settled
}

// urSeedUnexpectedLine installs the undispatched ("unexpected") receipt line a
// pre-S1 writer could still create: expected 0 for a variant absent from the
// dispatched payload, uncredited, with its mandatory exception row. The 008
// admission triggers accept exactly that shape, so only the post-finalization
// order needs them suspended around the insert.
func urSeedUnexpectedLine(t *testing.T, ctx context.Context, p *pgxpool.Pool, r transfers.Request, variant int32, actual int64) {
	t.Helper()
	switchReceiptAdmission(t, ctx, p, false)
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("seed historical receipt line", err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, err = tx.Exec(ctx, `INSERT INTO transfer_receipt_lines(request_id,variant_id,expected_quantity,actual_quantity,available_quantity) VALUES($1,$2,0,$3,0)`, r.ID, variant, actual); err != nil {
		t.Fatal("seed historical receipt line", err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO transfer_receipt_exceptions(request_id,variant_id,kind,quantity) VALUES($1,$2,'unexpected',$3)`, r.ID, variant, actual); err != nil {
		t.Fatal("seed historical unexpected exception", err)
	}
	// The deferred receipt checks still run at commit: the seeded pair must be
	// internally exact, exactly as the historical finalization left it.
	if err = tx.Commit(ctx); err != nil {
		t.Fatal("historical receipt line violates deferred receipt checks", err)
	}
	switchReceiptAdmission(t, ctx, p, true)
}

func switchReceiptAdmission(t *testing.T, ctx context.Context, p *pgxpool.Pool, enable bool) {
	t.Helper()
	action := "DISABLE"
	if enable {
		action = "ENABLE"
	}
	for _, table := range []string{"transfer_receipt_lines:admit_transfer_receipt_line", "transfer_receipt_exceptions:admit_transfer_receipt_exception"} {
		name, trigger, _ := strings.Cut(table, ":")
		if _, err := p.Exec(ctx, `ALTER TABLE `+name+` `+action+` TRIGGER `+trigger); err != nil {
			t.Fatal("receipt admission trigger", action, err)
		}
	}
}

// urSeedCountCorrection records the audit-only correction a pre-S1 count flow
// could still file against the unexpected line, through the same SQL entrypoint
// the retired store writer used, so the evidence is historical, not fabricated.
func urSeedCountCorrection(t *testing.T, ctx context.Context, p *pgxpool.Pool, r transfers.Request, variant int32, actual int64) {
	t.Helper()
	if _, err := p.Exec(ctx, `SELECT transfer_count_correct($1,$2::integer,$3::smallint,$4,'propose',0,$5,$6)`,
		r.ID, variant, int16(r.Origin.ID), "ur2-unexpected-count-proposal", actual, " count verified "); err != nil {
		t.Fatal("seed historical correction proposal", err)
	}
	if _, err := p.Exec(ctx, `SELECT transfer_count_correct($1,$2::integer,$3::smallint,$4,'accept',1,NULL::bigint,$5)`,
		r.ID, variant, int16(r.Destination.ID), "ur2-unexpected-count-accept", "count confirmed"); err != nil {
		t.Fatal("seed historical correction acceptance", err)
	}
}

// urExpectedPositiveValidated reports pg_constraint.convalidated for the 019
// constraint, i.e. which apply-time branch the migration took.
func urExpectedPositiveValidated(t *testing.T, ctx context.Context, p *pgxpool.Pool) bool {
	t.Helper()
	var validated bool
	if err := p.QueryRow(ctx, `SELECT convalidated FROM pg_constraint WHERE conrelid='transfer_receipt_lines'::regclass AND conname='transfer_receipt_lines_expected_positive'`).Scan(&validated); err != nil {
		t.Fatal("019 constraint missing", err)
	}
	return validated
}

// urAssert019NotValid proves the populated branch of migration 019: historical
// zero-quantity rows keep the constraint unvalidated, survive the upgrade, and
// no new zero-quantity line can be written afterwards.
func urAssert019NotValid(t *testing.T, ctx context.Context, p *pgxpool.Pool, r transfers.Request, variant int32) {
	t.Helper()
	if urExpectedPositiveValidated(t, ctx, p) {
		t.Fatal("019 validated a constraint over historical zero-quantity rows")
	}
	t.Logf("019 branch NOT VALID: convalidated=false")
	historical := func() int {
		var n int
		if err := p.QueryRow(ctx, `SELECT count(*) FROM transfer_receipt_lines WHERE request_id=$1 AND variant_id=$2 AND expected_quantity=0`, r.ID, variant).Scan(&n); err != nil {
			t.Fatal("historical unexpected line unreadable", err)
		}
		return n
	}
	if historical() != 1 {
		t.Fatal("upgrade deleted the historical unexpected line")
	}
	t.Logf("019 upgrade kept %d historical zero-quantity row(s) readable", historical())
	// A fresh in-transit transfer admits dispatched lines only, so the insert
	// below used to be reachable and must now stop at the 019 constraint.
	in := input()
	in.RetryKey = "prefix-expected-positive-refusal"
	in.Items = []transfers.Line{{VariantID: 1, Quantity: 1}}
	fresh := receiptDispatch(t, ctx, transfers.New(p), in)
	_, err := p.Exec(ctx, `INSERT INTO transfer_receipt_lines(request_id,variant_id,expected_quantity,actual_quantity,available_quantity) VALUES($1,2,0,1,0)`, fresh.ID)
	if err == nil || !strings.Contains(err.Error(), "transfer_receipt_lines_expected_positive") {
		t.Fatal("zero-quantity receipt line was not refused by 019", err)
	}
	t.Logf("019 refusal: %v", err)
	var written int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM transfer_receipt_lines WHERE request_id=$1`, fresh.ID).Scan(&written); err != nil || written != 0 {
		t.Fatal("refusal wrote a receipt line", written, err)
	}
	if historical() != 1 {
		t.Fatal("refusal touched the historical unexpected line")
	}
}

// TestUR4CleanPrefixUpgradeValidatesConstraint is the clean-table counterpart of
// the populated branch: with no historical zero row, 019 validates instead.
func TestUR4CleanPrefixUpgradeValidatesConstraint(t *testing.T) {
	ctx, p := urPrefixFixtureAt(t, 19)
	if err := db.Apply(ctx, p); err != nil {
		t.Fatal("apply019 on a clean transfer_receipt_lines", err)
	}
	if !urExpectedPositiveValidated(t, ctx, p) {
		t.Fatal("clean transfer_receipt_lines must get a validated constraint")
	}
	t.Logf("019 branch VALIDATED: convalidated=true on a clean table")
	if err := db.Check(ctx, p); err != nil {
		t.Fatal(err)
	}
}

func expectedSourceDebit(expected, dispatch, retained int64) int64 {
	if dispatch > expected {
		return dispatch - retained
	}
	return expected - retained
}

func TestUR4PopulatedPrefixUpgrade(t *testing.T) {
	for _, scenario := range []string{"sample", "restored", "dispatch_count"} {
		t.Run(scenario, func(t *testing.T) {
			ctx, p, s := urPrefixFixture(t)
			expected, arrival := int64(10), int64(8)
			if scenario == "dispatch_count" {
				expected, arrival = 5, 7
			}
			in := input()
			in.Items = []transfers.Line{{VariantID: 1, Quantity: expected}}
			r := urEraReceipt(t, ctx, p, s, 2, in.Items, []transfers.Line{{VariantID: 1, Quantity: arrival}})
			original, err := s.Get(ctx, actor(r.Origin.ID), r.ID)
			if err != nil {
				t.Fatal(err)
			}
			// Capture returned immutable public operations, not historical table rows.
			var restProposal, restAccept transfers.RestitutionOperation
			var dispatchProposal, dispatchAccept transfers.DispatchReconciliationOperation
			var countProposal, countAccept transfers.CountOperation
			if scenario == "restored" {
				restProposal, err = s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, r3Proposal("upgrade-prefix-rest", 0, 1))
				if err != nil {
					t.Fatal(err)
				}
				restAccept, err = s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, r3Decision("prefix-rest-accept", 1, true))
				if err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "dispatch_count" {
				dispatchProposal = dr2Propose(t, ctx, s, r, r.Origin.ID, 0, 7, "prefix-dispatch")
				dispatchAccept = dr2Decide(t, ctx, s, r, r.Destination.ID, 1, "prefix-dispatch-accept")
				countProposal = c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, 0, 6, "upgrade-prefix-count")
				countAccept = c2StoreDecide(t, ctx, s, r, r.Origin.ID, 1, 1, true, "prefix-count-accept")
			}
			// All scenarios carry pending historical consent through the actual upgrade.
			rev := int64(0)
			if scenario == "dispatch_count" {
				rev = 1
			}
			pending := c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, rev, 9, "upgrade-prefix-pending")
			stock := urEraInventory(t, ctx, p)
			t.Logf("pre-upgrade: historical receipt expected=%d actual=%d over %d stocked variants per location, pending count consent revision %d",
				expected, arrival, stock[0].TotalVariants, rev)
			if err := db.Apply(ctx, p); err != nil {
				t.Fatal("apply018 through normal runner", err)
			}
			// Counts uses018 tables through requiredActionsSQL. Its proof boundary
			// starts here: this test does not prove pre/post migration counter equality.
			counts := dr2Counts(t, ctx, s)
			for i, got := range counts {
				// S7: the pending historical count proposal no longer surfaces as work,
				// so every participant keeps zero totals after the upgrade.
				if got != (transfers.Totals{}) {
					t.Fatal("post-upgrade historical review counters", i, got)
				}
			}
			if err := db.Check(ctx, p); err != nil {
				t.Fatal(err)
			}
			before := urRead(t, ctx, s, r)
			if !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) {
				t.Fatal("upgrade changed public stock")
			}
			got, err := s.Get(ctx, actor(r.Origin.ID), r.ID)
			if err != nil || !urOriginalEqual(original, got) {
				t.Fatal("upgrade lost original receipt", err)
			}
			if before.Original[0].ExpectedQuantity != expected || before.Original[0].ActualQuantity != arrival || len(before.Legacy.Count.Operations) == 0 {
				t.Fatal("missing original/legacy evidence", before)
			}
			t.Logf("post-upgrade: original expected=%d actual=%d preserved with %d legacy count operation(s)",
				before.Original[0].ExpectedQuantity, before.Original[0].ActualQuantity, len(before.Legacy.Count.Operations))
			if scenario == "restored" && (before.Legacy.Restitution.Lines[0].AppliedRetainedQuantity != 1 || urCurrent(t, before).SourceDebit != 9) {
				t.Fatal("lost historical restoration", before)
			}
			if scenario == "dispatch_count" && (urCurrent(t, before).SourceDebit != 7 || urCurrent(t, before).EffectiveCredit != 6) {
				t.Fatal("lost applied dispatch/count baseline", before)
			}
			proposal := urProposal("upgrade-prefix-unified")
			delta := int64(1)
			if scenario == "restored" {
				delta = 0
			}
			if scenario == "dispatch_count" {
				proposal.DispatchQuantity, proposal.ArrivalQuantity, proposal.RetainedQuantity = 6, 6, 0
			}
			proposed, err := s.ProposeUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, proposal)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) {
				t.Fatal("proposal changed stock")
			}
			// Unified ownership must fence old consent without changing any public state.
			frozen, fc := urRead(t, ctx, s, r), dr2Counts(t, ctx, s)
			_, err = s.DecideCount(ctx, actor(r.Origin.ID), r.ID, transfers.CountDecisionInput{VariantID: 1, OperationKey: "prefix-old-accept", ExpectedRevision: rev + 1, Accept: true, Reason: "count confirmed"})
			if err != transfers.ErrDecisionConflict {
				t.Fatal("historical consent reused", err)
			}
			if !reflect.DeepEqual(frozen, urRead(t, ctx, s, r)) || fc != dr2Counts(t, ctx, s) || !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) {
				t.Fatal("failed consent leaked effects")
			}
			decision := urDecision("prefix-unified-accept")
			accepted, err := s.DecideUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, decision)
			if err != nil {
				t.Fatal(err)
			}
			if accepted.SourceExistingBefore == nil || accepted.SourceExistingAfter == nil || accepted.DestinationExistingBefore == nil || accepted.DestinationExistingAfter == nil || *accepted.SourceExistingAfter-*accepted.SourceExistingBefore != delta || *accepted.DestinationExistingAfter != *accepted.DestinationExistingBefore {
				t.Fatal("wrong atomic ledger deltas", accepted)
			}
			stock[0].Items[0].Existing += delta
			stock[0].Items[0].Available += delta
			settled := urRead(t, ctx, s, r)
			current := urCurrent(t, settled)
			if !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) || !reflect.DeepEqual(before.Legacy, settled.Legacy) || !reflect.DeepEqual(before.Original, settled.Original) || current.SourceDebit != expectedSourceDebit(expected, proposal.DispatchQuantity, proposal.RetainedQuantity) || current.EffectiveCredit != proposal.ArrivalQuantity {
				t.Fatal("atomic effects/evidence mismatch", settled)
			}
			if scenario != "dispatch_count" && urUnknown(current.TransitUnknown) != 1 {
				t.Fatal("unknown difference was closed", current)
			}
			// Every historical and unified exact retry must be observationally inert.
			frozen, fc = settled, dr2Counts(t, ctx, s)
			if got := c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, rev, 9, "upgrade-prefix-pending"); !reflect.DeepEqual(got, pending) {
				t.Fatal("pending retry changed")
			}
			if scenario == "restored" {
				got, e := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, r3Proposal("upgrade-prefix-rest", 0, 1))
				if e != nil || !reflect.DeepEqual(got, restProposal) {
					t.Fatal("rest proposal retry", e)
				}
				got, e = s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, r3Decision("prefix-rest-accept", 1, true))
				if e != nil || !reflect.DeepEqual(got, restAccept) {
					t.Fatal("rest acceptance retry", e)
				}
			}
			if scenario == "dispatch_count" {
				if got := dr2Propose(t, ctx, s, r, r.Origin.ID, 0, 7, "prefix-dispatch"); !reflect.DeepEqual(got, dispatchProposal) {
					t.Fatal("dispatch retry")
				}
				if got := dr2Decide(t, ctx, s, r, r.Destination.ID, 1, "prefix-dispatch-accept"); !reflect.DeepEqual(got, dispatchAccept) {
					t.Fatal("dispatch acceptance retry")
				}
				if got := c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, 0, 6, "upgrade-prefix-count"); !reflect.DeepEqual(got, countProposal) {
					t.Fatal("count retry")
				}
				if got := c2StoreDecide(t, ctx, s, r, r.Origin.ID, 1, 1, true, "prefix-count-accept"); !reflect.DeepEqual(got, countAccept) {
					t.Fatal("count acceptance retry")
				}
			}
			if got, e := s.ProposeUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, proposal); e != nil || !reflect.DeepEqual(got, proposed) {
				t.Fatal("unified proposal retry", e)
			}
			if got, e := s.DecideUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, decision); e != nil || !reflect.DeepEqual(got, accepted) {
				t.Fatal("unified acceptance retry", e)
			}
			if !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) || fc != dr2Counts(t, ctx, s) || !reflect.DeepEqual(frozen, urRead(t, ctx, s, r)) {
				t.Fatal("exact retries changed stock/counters/history")
			}
			rejected := c2StoreDecide(t, ctx, s, r, r.Origin.ID, 1, rev+1, false, "prefix-old-reject")
			afterReject := urRead(t, ctx, s, r)
			if afterReject.Legacy.Count.Lines[0].Proposals[rev].State != "rejected" {
				t.Fatal("historical rejection state missing")
			}
			if !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) {
				t.Fatal("historical rejection changed inventory")
			}
			if !reflect.DeepEqual(settled.Original, afterReject.Original) {
				t.Fatal("historical rejection changed original evidence")
			}
			// Copy value structs independently; Version contains values, not pointers.
			// Nullable physical facts remain read-only: never modify their pointees.
			expectedCurrent := append([]transfers.UnifiedCurrentLine(nil), settled.Current...)
			affected := 0
			for i := range expectedCurrent {
				if expectedCurrent[i].VariantID == 1 {
					expectedCurrent[i].Version.Count++
					affected++
				}
			}
			if affected != 1 || !reflect.DeepEqual(expectedCurrent, afterReject.Current) {
				t.Fatal("historical rejection changed more than affected count generation")
			}
			if !reflect.DeepEqual(settled.Lines, afterReject.Lines) || !reflect.DeepEqual(settled.Operations, afterReject.Operations) {
				t.Fatal("historical rejection changed unified evidence")
			}
			oldOps, newOps := settled.Legacy.Count.Operations, afterReject.Legacy.Count.Operations
			if len(newOps) != len(oldOps)+1 {
				t.Fatal("historical rejection must append exactly one operation")
			}
			matches := 0
			for _, op := range newOps {
				if op.OperationKey == rejected.OperationKey {
					if !reflect.DeepEqual(op, rejected) {
						t.Fatal("historical rejection operation evidence mismatch")
					}
					matches++
					continue
				}
				found := false
				for _, old := range oldOps {
					if reflect.DeepEqual(op, old) {
						found = true
						break
					}
				}
				if !found {
					t.Fatal("historical rejection altered prior operations")
				}
			}
			for _, old := range oldOps {
				occurrences := 0
				for _, op := range newOps {
					if reflect.DeepEqual(op, old) {
						occurrences++
					}
				}
				if occurrences != 1 {
					t.Fatal("historical rejection lost or duplicated prior operation")
				}
			}
			if matches != 1 {
				t.Fatal("historical rejection operation missing or duplicated")
			}
			fc = dr2Counts(t, ctx, s)
			if got := c2StoreDecide(t, ctx, s, r, r.Origin.ID, 1, rev+1, false, "prefix-old-reject"); !reflect.DeepEqual(got, rejected) {
				t.Fatal("reject retry changed")
			}
			if fc != dr2Counts(t, ctx, s) || !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) || !reflect.DeepEqual(afterReject, urRead(t, ctx, s, r)) {
				t.Fatal("reject retry effects")
			}
		})
	}
}
