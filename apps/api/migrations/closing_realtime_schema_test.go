package migrations_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/migrations"
)

// migration058 is the settlement's own hint: the two writes that freeze a branch -- the warehouse
// opening the rendición and proposing it -- are facts the branch's screen has to learn without a
// reload (S8, S10). The version reuses the audience of the branch (`transfers:<location id>`) and
// adds no scope at all, so the CHECK of 015, its seed, `admit_realtime_audience`, `parsePayload`,
// the `EXCEPT` lists of `readRevisions` and the audience filter of the broker's `install()` keep
// refusing every scope they refused before (S8, S9).
const closingRealtimeMigration = "058_closing_realtime.sql"

// TestClosingRealtimeMigrationShape reads the embedded version exactly as PostgreSQL receives it
// and asserts the contract it installs: one trigger function, one trigger over `branch_closings`
// for INSERT and UPDATE, the bump of the settled branch's own revision, the notification of that
// same audience under the lock of its row, and the guard that keeps a database without the row
// silent instead of imagining an audience. It also asserts what the version must not do -- add a
// scope, seed a row, restate an admission or rewrite a settlement -- because every one of those
// would widen the audience the platform resolves from the session (S9).
func TestClosingRealtimeMigrationShape(t *testing.T) {
	b, err := migrations.Files.ReadFile(closingRealtimeMigration)
	if err != nil {
		t.Fatal("the closing realtime migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// One function and one trigger: the hint is a fact of the row written, not of a caller.
		"CREATE FUNCTION invalidate_branch_closing() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER invalidate_branch_closing_write AFTER INSERT OR UPDATE ON branch_closings",
		"FOR EACH ROW EXECUTE FUNCTION invalidate_branch_closing();",

		// The audience is the settled branch and nothing else: the row is locked, bumped and named by
		// the same expression, read from NEW so an update can never address another branch.
		"PERFORM scope FROM realtime_revisions",
		"WHERE scope = 'transfers:' || NEW.branch_location_id FOR UPDATE",
		"UPDATE realtime_revisions SET revision = revision + 1",
		"WHERE scope = 'transfers:' || NEW.branch_location_id;",
		"PERFORM pg_notify('luson_realtime', 'transfers:' || NEW.branch_location_id);",

		// A database the audience of 015 never seeded stays silent: no invented row and no hint.
		"IF NOT FOUND THEN",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("058 must state %q", required)
		}
	}
	// The version widens nothing: no scope of its own, no schema change and no settlement rewritten.
	for _, forbidden := range []string{
		"CREATE TABLE", "CREATE VIEW", "DROP TABLE", "DROP VIEW", "DROP FUNCTION",
		"ALTER TABLE", "DELETE FROM", "TRUNCATE", "INSERT INTO realtime_revisions",
		"INSERT INTO locations", "UPDATE locations",
		"FUNCTION admit_realtime_audience", "realtime_revisions_scope_check",
		"UPDATE branch_closings", "INSERT INTO branch_closings", "DELETE FROM branch_closings",
		"transfers:0",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("058 must not use %q", forbidden)
		}
	}
	// The decisions a reader has to be able to check without deriving them from the trigger --
	// auditing that comments can be trimmed without breaking this test -- are pinned structurally
	// below: one scope, no other literal and no function of an earlier version rewritten.
	// The version declares exactly one function and one trigger: a second one would be a second rule
	// the reader of this file does not expect.
	if got := strings.Count(sql, "CREATE FUNCTION"); got != 1 {
		t.Errorf("058 must declare exactly one function, found %d", got)
	}
	if got := strings.Count(sql, "CREATE TRIGGER"); got != 1 {
		t.Errorf("058 must declare exactly one trigger, found %d", got)
	}
	// The audience is the settled branch: every scope literal of the file is that one expression, so
	// no other location and no other kind of stream can be addressed by it (S9).
	scope := "'transfers:' || NEW.branch_location_id"
	if got := strings.Count(sql, scope); got != 3 {
		t.Errorf("058 must build its scope from NEW.branch_location_id exactly three times, found %d", got)
	}
	for _, alien := range []string{"'inventory'", "'inventory:0'", "'transfers:1'", "transfers:%",
		"'closing", "'closings"} {
		if strings.Contains(sql, alien) {
			t.Errorf("058 must declare no other scope literal, found %q", alien)
		}
	}
	// The trigger is a writer of a new fact: it never redefines what 004 and 015 installed, because a
	// restatement is where one of their rules is silently lost.
	for _, name := range []string{"protect_realtime_revision", "protect_realtime_revisions_truncate",
		"invalidate_pending_transfers", "invalidate_transfer_insert", "invalidate_inventory_balance",
		"invalidate_balance_change", "admit_realtime_audience", "initialize_branch_inventory",
		"realtime_revisions_scope_check"} {
		if strings.Contains(sql, "CREATE OR REPLACE FUNCTION "+name) ||
			strings.Contains(sql, "FUNCTION "+name+"(") {
			t.Errorf("058 must not redefine %s of 004 or 015", name)
		}
	}
	if strings.Contains(sql, "CREATE OR REPLACE FUNCTION") {
		t.Error("058 must declare its own function instead of replacing one")
	}
	// An AFTER trigger's answer is ignored, and this one never hands the row back: it writes the
	// counter and the hint, and nothing else can be inferred from it.
	if strings.Contains(sql, "RETURN NEW") || strings.Count(sql, "RETURN NULL") != 2 {
		t.Error("058 must return NULL from the guard and from the trigger function")
	}
	t.Logf("058: the settlement hints the stream of its own branch and adds no audience")
}

// closingRealtimeFixture is the prefix applied through 058 with the seeds every settlement needs:
// the catalogue, one account per historical location and the commission rate of branch 2.
func closingRealtimeFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	return fundPrefixThrough(t, 58)
}

// closingHints drains the committed notifications of one moment and returns their payloads, so a
// test reads the audience the platform receives instead of guessing it from the revision counter.
func closingHints(t *testing.T, ctx context.Context, listener *pgxpool.Conn) []string {
	t.Helper()
	hints := []string{}
	for {
		wait, cancel := context.WithTimeout(ctx, 150*time.Millisecond)
		notification, err := listener.Conn().WaitForNotification(wait)
		cancel()
		if err != nil {
			return hints
		}
		hints = append(hints, notification.Payload)
	}
}

// closingRevisions reads the whole counter table: a bump anywhere is visible here, which is how the
// test proves the other audiences were not touched by a settlement.
func closingRevisions(t *testing.T, ctx context.Context, p *pgxpool.Pool) map[string]int64 {
	t.Helper()
	rows, err := p.Query(ctx, `SELECT scope,revision FROM realtime_revisions`)
	if err != nil {
		t.Fatal("the revision counters could not be read")
	}
	defer rows.Close()
	revisions := map[string]int64{}
	for rows.Next() {
		var scope string
		var revision int64
		if err := rows.Scan(&scope, &revision); err != nil {
			t.Fatal("the revision counters could not be read")
		}
		revisions[scope] = revision
	}
	if rows.Err() != nil {
		t.Fatal("the revision counters could not be read")
	}
	return revisions
}

// closingWalk is one write of the settlement and the name it is reported under: the opening is an
// INSERT and the proposal and the closure are UPDATEs, which is exactly the pair the trigger covers.
type closingWalk struct {
	name  string
	write func()
}

// TestClosingBumpsTheBranchStream proves S8 and S9 on a live database: every write the warehouse
// makes to a settlement bumps the revision of that branch's own audience and notifies that same
// audience, while the warehouse's own stream, the neighbour branch's and the inventory counter stay
// exactly where they were. The rows that were never seeded stay silent: a branch the audience of
// 015 never gave a row to is not bumped, so no hint is invented for it.
func TestClosingBumpsTheBranchStream(t *testing.T) {
	ctx, p := closingRealtimeFixture(t)
	listener, err := p.Acquire(ctx)
	if err != nil {
		t.Fatal("the listener connection could not be acquired")
	}
	defer listener.Release()
	if _, err := listener.Exec(ctx, "LISTEN luson_realtime"); err != nil {
		t.Fatal("the settlement hint could not be listened to")
	}
	// A first settlement gives the three writes their document; the reads start once it is closed,
	// so the hints of opening and proposing it are already drained and the walk is the only writer.
	closing := openSettlement(t, ctx, p, 2)
	closeSettlement(t, ctx, p, closing, "0.00", "0.00", "0.00")
	closingHints(t, ctx, listener)
	start := closingRevisions(t, ctx, p)

	var walked int64
	for _, step := range []closingWalk{
		{"opening", func() { walked = openSettlement(t, ctx, p, 2) }},
		{"proposal", func() {
			proposeRound(t, ctx, p, walked, `{"fund":"0.00"}`)
			if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=0.00,
 closing_cash=0.00 WHERE id=$1 AND status IN ('open','rejected')`, walked); err != nil {
				t.Fatalf("the settlement could not be proposed: %v", err)
			}
		}},
		{"closure", func() {
			decideRound(t, ctx, p, walked, "accepted", "")
			if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, walked); err != nil {
				t.Fatalf("the accepted round must close the settlement: %v", err)
			}
		}},
	} {
		before := closingRevisions(t, ctx, p)
		step.write()
		after := closingRevisions(t, ctx, p)
		for scope, was := range before {
			want := was
			if scope == "transfers:2" {
				// One row written is one revision: the counter moves by exactly the write it reports.
				want++
			}
			if after[scope] != want {
				t.Fatalf("the %s must bump only the settled branch: %s went from %d to %d",
					step.name, scope, was, after[scope])
			}
		}
		if hints := closingHints(t, ctx, listener); len(hints) != 1 || hints[0] != "transfers:2" {
			t.Fatalf("the %s must notify the stream of its own branch, got %v", step.name, hints)
		}
	}
	// The whole walk left the inventory counter and both other audiences where they were: a
	// settlement is never a global invalidation and never a fact of another location.
	end := closingRevisions(t, ctx, p)
	for scope, was := range start {
		want := was
		if scope == "transfers:2" {
			want += 3
		}
		if end[scope] != want {
			t.Fatalf("the walk must bump only the settled branch: %s went from %d to %d",
				scope, was, end[scope])
		}
	}
	t.Logf("058: the settlement hints the stream of its own branch and of nothing else")
}

// TestClosingWithoutItsAudienceStaysSilent proves the guard of the function on a live database: the
// row the hint names must exist. A settlement of a branch whose audience 015 never seeded is written
// without a hint, so the broker never receives a scope it would refuse. The proof is one-sided: the
// same write is announced once the counter row is back, so a trigger that simply never fired fails
// this test instead of passing as silence.
func TestClosingWithoutItsAudienceStaysSilent(t *testing.T) {
	ctx, p := closingRealtimeFixture(t)
	listener, err := p.Acquire(ctx)
	if err != nil {
		t.Fatal("the listener connection could not be acquired")
	}
	defer listener.Release()
	if _, err := listener.Exec(ctx, "LISTEN luson_realtime"); err != nil {
		t.Fatal("the settlement hint could not be listened to")
	}
	// The very row the trigger reads: without it there is no audience to address, and the hint of a
	// scope the counters do not hold is exactly what the broker refuses. 004 keeps the counters
	// monotonic against every DELETE, so the two statements that build the hole take its protecting
	// trigger out of the way and put it back before anything else happens.
	if _, err := p.Exec(ctx, `ALTER TABLE realtime_revisions DISABLE TRIGGER protect_realtime_revision;
DELETE FROM realtime_revisions WHERE scope='transfers:2';
ALTER TABLE realtime_revisions ENABLE TRIGGER protect_realtime_revision;`); err != nil {
		t.Fatalf("the audience of branch 2 could not be dropped: %v", err)
	}
	closing := openSettlement(t, ctx, p, 2)
	if hints := closingHints(t, ctx, listener); len(hints) != 0 {
		t.Fatalf("a branch without an audience must not be announced, got %v", hints)
	}
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET observation='' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the settlement could not be rewritten: %v", err)
	}
	if hints := closingHints(t, ctx, listener); len(hints) != 0 {
		t.Fatalf("a hint without its revision row must stay silent, got %v", hints)
	}
	if _, exists := closingRevisions(t, ctx, p)["transfers:2"]; exists {
		t.Fatalf("the missing audience must not be invented")
	}
	// The same write is announced as soon as the audience exists: the silence above is the missing
	// counter and not a trigger that never fires, and the one bump is the one hint (S8, S9).
	if _, err := p.Exec(ctx, `INSERT INTO realtime_revisions(scope) VALUES('transfers:2')`); err != nil {
		t.Fatalf("the audience of branch 2 could not be restored: %v", err)
	}
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET observation='' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the settlement could not be rewritten: %v", err)
	}
	if hints := closingHints(t, ctx, listener); len(hints) != 1 || hints[0] != "transfers:2" {
		t.Fatalf("the same write must announce its own branch once, got %v", hints)
	}
	if revision := closingRevisions(t, ctx, p)["transfers:2"]; revision != 1 {
		t.Fatalf("the announced write must bump the counter once, got %d", revision)
	}
	t.Logf("058: a settlement without its audience row is written silently, and announced once it exists")
}
