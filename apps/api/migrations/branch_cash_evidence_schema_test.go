package migrations_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/testpg"
	"luson/api/migrations"
)

// migration062 is the photographic receipt of a branch expense (S3, S5, S6): the four nullable
// columns that hold one photo in the movement's own row, the constraints that state its shape and
// the two reads of the ledger restated column by column. 001-061 are applied and checksummed, so
// this version is additive, adds no trigger of its own and rewrites no row.
const migration062 = "062_branch_cash_evidence.sql"

// TestBranchCashEvidenceMigrationShape reads the embedded migration exactly as PostgreSQL receives
// it. It proves the file states the four columns, the five constraints that enforce S6 in the
// database, the two reads without a whole-row copy, and that it neither rewrites a row nor adds a
// trigger: the immutability of the receipt is the one the ledger already carries (S5).
func TestBranchCashEvidenceMigrationShape(t *testing.T) {
	b, err := migrations.Files.ReadFile(migration062)
	if err != nil {
		t.Fatal("the receipt migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// The four nullable columns of one receipt, in the movement's own row (S3): the bytes, the
		// validated content type, the size and the digest.
		"ADD COLUMN evidence_bytes bytea",
		"ADD COLUMN evidence_content_type text",
		"ADD COLUMN evidence_size integer",
		"ADD COLUMN evidence_sha256 text",
		// All four or none (S1): one receipt is four facts that travel together.
		"ADD CONSTRAINT branch_cash_movements_evidence_shape",
		"(evidence_bytes IS NULL) = (evidence_content_type IS NULL)",
		"(evidence_bytes IS NULL) = (evidence_size IS NULL)",
		"(evidence_bytes IS NULL) = (evidence_sha256 IS NULL)",
		// Only a gasto carries one (S2).
		"ADD CONSTRAINT branch_cash_movements_evidence_expense",
		"CHECK (evidence_bytes IS NULL OR kind = 'gasto')",
		// The size is the real length of the bytes and stays inside the documented cap (S6).
		"ADD CONSTRAINT branch_cash_movements_evidence_size",
		"evidence_size = octet_length(evidence_bytes)",
		"evidence_size BETWEEN 1 AND 8388608",
		// The content type is one of the two formats the product accepts, and the digest is the
		// lowercase hexadecimal of SHA-256 (S6).
		"ADD CONSTRAINT branch_cash_movements_evidence_type",
		"evidence_content_type IN ('image/jpeg','image/png')",
		"ADD CONSTRAINT branch_cash_movements_evidence_sha256",
		`evidence_sha256 ~ '^[0-9a-f]{64}$'`,
		// The book publishes the three metadata columns and never the bytes (S7): the view is
		// restated with them appended, so every reader of 061 keeps its column order.
		"CREATE OR REPLACE VIEW branch_cash_ledger AS",
		"movement.evidence_content_type",
		"movement.evidence_size",
		"movement.evidence_sha256",
		// The correction path of the admission reads the corrected movement column by column: the
		// row now carries the bytes of a receipt, and a row variable would copy them on every
		// correction of the branch.
		"CREATE OR REPLACE FUNCTION admit_branch_cash_movement() RETURNS trigger LANGUAGE plpgsql AS $$",
		"SELECT movement.branch_location_id,",
		"FROM branch_cash_movements movement WHERE movement.id=NEW.corrects_id FOR UPDATE",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("the receipt migration must state %q", required)
		}
	}
	// Nothing is rewritten, nothing is dropped and no guard is added or replaced: the receipt is
	// immutable by inheritance of the trigger of 034 and by nothing else (S5).
	for _, forbidden := range []string{
		"CREATE TRIGGER",
		"UPDATE branch_cash_movements",
		"DELETE FROM",
		"DROP TABLE",
		"DROP COLUMN",
		"DROP TRIGGER",
		"SELECT * INTO corrected",
		"SELECT * FROM branch_cash_movements",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("the receipt migration must not %q: it is additive and the ledger is untouched", forbidden)
		}
	}
	// The ledger row is never read whole again: this migration is where the last whole-row copy of
	// the table disappears, so no read of the book drags the bytes of a receipt. The account of the
	// admission is a different table and keeps the row it always read.
	if strings.Contains(sql, "SELECT *") && !strings.Contains(sql, "SELECT * INTO actor FROM auth_accounts") {
		t.Error("the receipt migration must read the ledger column by column")
	}
	for _, documented := range []string{"S3", "S5", "S6"} {
		if !strings.Contains(sql, documented) {
			t.Errorf("the receipt migration must document %s", documented)
		}
	}
}

// evidenceDB applies the settlement chain through 062 and provisions the three known locations with
// one account each. The till of the branch is funded by the tests that need a pay-out, because the
// drawer of 060 is not what they decide.
func evidenceDB(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 62)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x'),(3,'sucursal_b','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	return ctx, p
}

// applyEvidenceMigration applies the file of this delivery alone, so a test can write the rows of
// the previous schema and then upgrade them.
func applyEvidenceMigration(t *testing.T, ctx context.Context, p *pgxpool.Pool) {
	t.Helper()
	b, err := migrations.Files.ReadFile(migration062)
	if err != nil {
		t.Fatal("the receipt migration must be embedded", err)
	}
	if _, err := p.Exec(ctx, string(b)); err != nil {
		t.Fatalf("the receipt migration must apply on the schema of 061: %v", err)
	}
}

// evidenceJPEG builds one real JPEG of the given size in Go: the fixtures of this delivery are
// generated, never checked in, and the database refuses nothing about their content.
func evidenceJPEG(t *testing.T, width, height int) []byte {
	t.Helper()
	canvas := image.NewRGBA(image.Rect(0, 0, width, height))
	canvas.Set(0, 0, color.RGBA{R: 10, G: 20, B: 30, A: 255})
	var buffer bytes.Buffer
	if err := jpeg.Encode(&buffer, canvas, nil); err != nil {
		t.Fatalf("the JPEG fixture could not be built: %v", err)
	}
	return buffer.Bytes()
}

// evidencePNG builds one real PNG of the given size in Go.
func evidencePNG(t *testing.T, width, height int) []byte {
	t.Helper()
	canvas := image.NewRGBA(image.Rect(0, 0, width, height))
	canvas.Set(0, 0, color.RGBA{R: 200, G: 100, B: 50, A: 255})
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, canvas); err != nil {
		t.Fatalf("the PNG fixture could not be built: %v", err)
	}
	return buffer.Bytes()
}

// evidenceDigest is the SHA-256 of one fixture as lowercase hexadecimal, which is the only spelling
// the column admits.
func evidenceDigest(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// receipt is the four columns of one row as a test states them: a nil field is the column the test
// leaves out, so "all four or none" is provable one column at a time.
type receipt struct {
	body        []byte
	contentType *string
	size        *int64
	sha256      *string
}

// fullReceipt is the receipt of one fixture exactly as the store writes it: the bytes, the format
// its decode proved, the real length and the digest of those bytes.
func fullReceipt(body []byte, contentType string) receipt {
	size := int64(len(body))
	digest := evidenceDigest(body)
	return receipt{body: body, contentType: &contentType, size: &size, sha256: &digest}
}

// columns renders the four values as the SQL arguments of one insert: a nil field is SQL NULL.
func (r receipt) columns() []any {
	var body, contentType, size, digest any
	if r.body != nil {
		body = r.body
	}
	if r.contentType != nil {
		contentType = *r.contentType
	}
	if r.size != nil {
		size = *r.size
	}
	if r.sha256 != nil {
		digest = *r.sha256
	}
	return []any{body, contentType, size, digest}
}

// tryEvidence writes one movement with the receipt the test states and returns the error instead of
// asserting, so the same call is used where the row must be admitted and where it must be refused.
func tryEvidence(ctx context.Context, p *pgxpool.Pool, branch, account int, kind, amount, description string,
	motive *int64, r receipt) error {
	columns := r.columns()
	_, err := p.Exec(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,description,
 category_id,created_by_account_id,evidence_bytes,evidence_content_type,evidence_size,evidence_sha256)
 VALUES($1::smallint,$2,$3::numeric,$4,$5,$6::integer,$7,$8,$9,$10)`,
		branch, kind, amount, description, motive, account,
		columns[0], columns[1], columns[2], columns[3])
	return err
}

// receiptOf reads one row's receipt as one value -- the type, the size, the digest and, beside them,
// the real length of the stored bytes and the digest the database computes over them -- so "the
// receipt is the one that was written" is one comparison instead of a promise about four columns.
func receiptOf(t *testing.T, ctx context.Context, p *pgxpool.Pool, id int64) string {
	t.Helper()
	var stored string
	if err := p.QueryRow(ctx, `SELECT concat_ws(':',
  coalesce(evidence_content_type,'-'),coalesce(evidence_size::text,'-'),
  coalesce(evidence_sha256,'-'),coalesce(octet_length(evidence_bytes)::text,'-'),
  coalesce(encode(sha256(evidence_bytes),'hex'),'-'))
 FROM branch_cash_movements WHERE id=$1`, id).Scan(&stored); err != nil {
		t.Fatalf("the receipt of movement %d could not be read: %v", id, err)
	}
	return stored
}

// evidenceRow writes one expense with a real receipt and returns the id the tests below read back.
func evidenceRow(t *testing.T, ctx context.Context, p *pgxpool.Pool) int64 {
	t.Helper()
	alquiler := motiveOf(t, ctx, p, "Alquiler")
	body := evidenceJPEG(t, 2, 2)
	size := int64(len(body))
	var id int64
	if err := p.QueryRow(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,description,
 category_id,created_by_account_id,evidence_bytes,evidence_content_type,evidence_size,evidence_sha256)
 VALUES(2,'gasto',10.00,'Alquiler de marzo',$1,2,$2,'image/jpeg',$3,$4) RETURNING id`,
		alquiler, body, size, evidenceDigest(body)).Scan(&id); err != nil {
		t.Fatalf("the receipt fixture could not be written: %v", err)
	}
	return id
}

// fundedEvidenceDB is the fixture of the tests that write a pay-out: the same database with the till
// of branch 2 holding what the contribution left in it (060).
func fundedEvidenceDB(t *testing.T) (context.Context, *pgxpool.Pool, *int64) {
	t.Helper()
	ctx, p := evidenceDB(t)
	if err := tryExpense(ctx, p, 2, 2, "aporte", "100.00", "Fondo de la caja"); err != nil {
		t.Fatalf("the contribution must be admitted: %v", err)
	}
	motive := motiveOf(t, ctx, p, "Alquiler")
	return ctx, p, &motive
}

// TestEvidenceColumnsTravelTogether proves S1 in the database: the four columns of the receipt are
// all present or all absent, and a row without one is a row of the ledger like every other.
func TestEvidenceColumnsTravelTogether(t *testing.T) {
	ctx, p, motive := fundedEvidenceDB(t)
	body := evidenceJPEG(t, 2, 2)
	full := fullReceipt(body, "image/jpeg")

	// A pay-out with no receipt is the row every version of this ledger already wrote (S1).
	if err := tryEvidence(ctx, p, 2, 2, "gasto", "10.00", "Flete", motive, receipt{}); err != nil {
		t.Fatalf("a pay-out without a receipt must be admitted (S1): %v", err)
	}
	// One receipt is four facts that travel together: any column left out is refused.
	for name, partial := range map[string]receipt{
		"only bytes":           {body: body},
		"bytes and type":       {body: body, contentType: full.contentType},
		"bytes, type and size": {body: body, contentType: full.contentType, size: full.size},
		"only the type":        {contentType: full.contentType},
		"only the size":        {size: full.size},
		"only the digest":      {sha256: full.sha256},
		"size and digest":      {size: full.size, sha256: full.sha256},
	} {
		err := tryEvidence(ctx, p, 2, 2, "gasto", "1.00", "Flete", motive, partial)
		if err == nil {
			t.Fatalf("a receipt with %s must be refused (S1)", name)
		}
		execRefusal(t, err, "23514")
	}
	// The four together are one receipt, stored exactly as it was stated.
	if err := tryEvidence(ctx, p, 2, 2, "gasto", "10.00", "Flete con foto", motive, full); err != nil {
		t.Fatalf("a complete receipt must be admitted (S3): %v", err)
	}
	var id int64
	if err := p.QueryRow(ctx, `SELECT id FROM branch_cash_movements WHERE description='Flete con foto'
 ORDER BY id DESC LIMIT 1`).Scan(&id); err != nil {
		t.Fatal("the admitted expense could not be read")
	}
	want := "image/jpeg:" + itoa(int64(len(body))) + ":" + evidenceDigest(body) + ":" +
		itoa(int64(len(body))) + ":" + evidenceDigest(body)
	if got := receiptOf(t, ctx, p, id); got != want {
		t.Fatalf("the stored receipt is not the one that was written: got %q want %q", got, want)
	}
}

// TestOnlyAnExpenseCarriesAReceipt proves S2 in the database: `gasto` carries a receipt and the
// other three kinds never do, whatever the row states.
func TestOnlyAnExpenseCarriesAReceipt(t *testing.T) {
	ctx, p, motive := fundedEvidenceDB(t)
	full := fullReceipt(evidenceJPEG(t, 2, 2), "image/jpeg")
	before := cashLedger(t, ctx, p)

	// The contribution, the collection and the correction of a movement name no receipt (S2).
	for _, kind := range []string{"aporte", "recaudacion"} {
		err := tryEvidence(ctx, p, 2, 2, kind, "1.00", "Movimiento con comprobante", nil, full)
		execRefusal(t, err, "23514")
	}
	target := evidenceRow(t, ctx, p)
	body := fullReceipt(evidenceJPEG(t, 2, 2), "image/jpeg")
	_, err := p.Exec(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,description,
 created_by_account_id,corrects_id,evidence_bytes,evidence_content_type,evidence_size,evidence_sha256)
 VALUES(2,'correccion',1.00,'Corrijo el flete',2,$1,$2,$3,$4,$5)`,
		target, body.body, *body.contentType, *body.size, *body.sha256)
	execRefusal(t, err, "23514")
	// The two refused rows wrote nothing: the ledger holds the fixture and the one pay-out of it.
	if after := cashLedger(t, ctx, p); strings.Count(after, ",") != strings.Count(before, ",")+1 {
		t.Fatalf("a refused receipt writes nothing (S2): %q before, %q after", before, after)
	}
	var corrections int64
	if err := p.QueryRow(ctx, `SELECT count(*) FROM branch_cash_movements WHERE kind='correccion'`).
		Scan(&corrections); err != nil {
		t.Fatal("the ledger could not be read")
	}
	if corrections != 0 {
		t.Fatalf("the refused correction is not a row of the ledger: %d", corrections)
	}
	// And the pay-out with the same receipt is the row this delivery exists for.
	if err := tryEvidence(ctx, p, 2, 2, "gasto", "10.00", "Flete", motive, full); err != nil {
		t.Fatalf("an expense carries a receipt (S2): %v", err)
	}
	if target < 1 {
		t.Fatal("the fixture row of the correction must exist")
	}
}

// TestEvidenceSizeIsTheRealLengthOfTheBytes proves S6 in the database: the size column is the real
// length of the bytes, never zero and never above the documented cap, and the boundary is the cap
// itself.
func TestEvidenceSizeIsTheRealLengthOfTheBytes(t *testing.T) {
	ctx, p, motive := fundedEvidenceDB(t)
	body := evidenceJPEG(t, 2, 2)
	digest := evidenceDigest(body)
	contentType := "image/jpeg"
	size := int64(len(body))
	stated := func(value int64) receipt {
		return receipt{body: body, contentType: &contentType, size: &value, sha256: &digest}
	}

	// A size that is not the length of the bytes, a zero and the whole cap over a short body are
	// refused.
	for name, value := range map[string]int64{
		"one byte more": size + 1,
		"one byte less": size - 1,
		"zero":          0,
		"the whole cap": 8388608,
		"above the cap": 8388609,
	} {
		err := tryEvidence(ctx, p, 2, 2, "gasto", "1.00", "Flete", motive, stated(value))
		if err == nil {
			t.Fatalf("the size %s must be refused (S6)", name)
		}
		execRefusal(t, err, "23514")
	}
	// The real length is admitted, and it is what the row states.
	if err := tryEvidence(ctx, p, 2, 2, "gasto", "1.00", "Flete", motive, stated(size)); err != nil {
		t.Fatalf("the real length of the bytes must be admitted (S6): %v", err)
	}
	// The cap is a boundary and not a coefficient: 8 MB of bytes with their own length is the
	// largest receipt the table holds, and one byte above it is refused.
	largest := make([]byte, 8388608)
	largestSize, largestDigest := int64(len(largest)), evidenceDigest(largest)
	if err := tryEvidence(ctx, p, 2, 2, "gasto", "1.00", "Flete", motive,
		receipt{body: largest, contentType: &contentType, size: &largestSize, sha256: &largestDigest}); err != nil {
		t.Fatalf("the cap is the largest admitted receipt (S6): %v", err)
	}
	above := append(largest, 0)
	aboveSize, aboveDigest := int64(len(above)), evidenceDigest(above)
	err := tryEvidence(ctx, p, 2, 2, "gasto", "1.00", "Flete", motive,
		receipt{body: above, contentType: &contentType, size: &aboveSize, sha256: &aboveDigest})
	execRefusal(t, err, "23514")
}

// TestEvidenceContentTypeIsOneOfTheTwoFormats proves S6 in the database: the content type of a
// receipt is one of the two formats the product accepts, and the digest is the lowercase
// hexadecimal of the SHA-256 and nothing else.
func TestEvidenceContentTypeIsOneOfTheTwoFormats(t *testing.T) {
	ctx, p, motive := fundedEvidenceDB(t)
	body := evidenceJPEG(t, 2, 2)
	digest := evidenceDigest(body)
	size := int64(len(body))

	// SVG and every other format the product does not accept are refused by name (S6).
	for _, declared := range []string{"image/gif", "image/svg+xml", "text/plain", "image/jpg",
		"IMAGE/JPEG", "image/jpeg; charset=utf-8", ""} {
		contentType := declared
		err := tryEvidence(ctx, p, 2, 2, "gasto", "1.00", "Flete", motive,
			receipt{body: body, contentType: &contentType, size: &size, sha256: &digest})
		if err == nil {
			t.Fatalf("the content type %q must be refused (S6)", declared)
		}
		execRefusal(t, err, "23514")
	}
	// The digest is the canonical lowercase hexadecimal of 32 bytes: an invented text, an
	// uppercase one, a shorter one and a longer one are all refused.
	for _, declared := range []string{"not-a-digest", strings.ToUpper(digest), digest[:63], digest + "0"} {
		contentType, sha := "image/jpeg", declared
		err := tryEvidence(ctx, p, 2, 2, "gasto", "1.00", "Flete", motive,
			receipt{body: body, contentType: &contentType, size: &size, sha256: &sha})
		if err == nil {
			t.Fatalf("the digest %q must be refused (S6)", declared)
		}
		execRefusal(t, err, "23514")
	}
	// Both admitted formats are stored with the digest of their bytes and the size of their bytes.
	for _, fixture := range []struct {
		body        []byte
		contentType string
	}{
		{evidenceJPEG(t, 3, 3), "image/jpeg"},
		{evidencePNG(t, 3, 3), "image/png"},
	} {
		if err := tryEvidence(ctx, p, 2, 2, "gasto", "1.00", "Flete", motive,
			fullReceipt(fixture.body, fixture.contentType)); err != nil {
			t.Fatalf("a %s receipt must be admitted (S6): %v", fixture.contentType, err)
		}
	}
}

// TestEvidenceIsImmutableByInheritance proves S5 on a live database: no trigger is added for the
// receipt, because the ledger already refuses every UPDATE and every DELETE of a row, and the four
// new columns are no hole in that refusal.
func TestEvidenceIsImmutableByInheritance(t *testing.T) {
	ctx, p, _ := fundedEvidenceDB(t)
	id := evidenceRow(t, ctx, p)
	before := receiptOf(t, ctx, p, id)

	for _, statement := range []string{
		`UPDATE branch_cash_movements SET evidence_bytes='\x00' WHERE id=$1`,
		`UPDATE branch_cash_movements SET evidence_content_type='image/png' WHERE id=$1`,
		`UPDATE branch_cash_movements SET evidence_size=1 WHERE id=$1`,
		`UPDATE branch_cash_movements SET evidence_sha256=NULL WHERE id=$1`,
		`DELETE FROM branch_cash_movements WHERE id=$1`,
	} {
		_, err := p.Exec(ctx, statement, id)
		execRefusal(t, err, "P0001")
	}
	if after := receiptOf(t, ctx, p, id); after != before {
		t.Fatalf("the receipt of an admitted movement never moves (S5): %q before, %q after", before, after)
	}
	// The refusal is the guard of 034 and not a trigger of this delivery: the ledger carries the
	// same triggers it carried before the receipt existed.
	var triggers string
	if err := p.QueryRow(ctx, `SELECT string_agg(tgname,',' ORDER BY tgname) FROM pg_trigger
 WHERE tgrelid='branch_cash_movements'::regclass AND NOT tgisinternal`).Scan(&triggers); err != nil {
		t.Fatalf("the triggers of the ledger could not be read: %v", err)
	}
	want := "admit_branch_cash_movement,admit_branch_expense,protect_branch_cash_movements," +
		"protect_branch_cash_movements_truncate,stamp_branch_expense_before_insert," +
		"verify_branch_expense_category_before_insert"
	if triggers != want {
		t.Fatalf("the receipt adds no trigger of its own (S5): got %q want %q", triggers, want)
	}
}

// TestTheLiveReadsNameTheirColumns proves the audit of the table on the live schema: the definition
// PostgreSQL holds for the ledger's admission reads the corrected movement column by column, so no
// correction drags the bytes of a receipt into its own statement, and the book publishes the three
// metadata columns of the receipt and never the bytes (S7).
func TestTheLiveReadsNameTheirColumns(t *testing.T) {
	ctx, p := evidenceDB(t)
	var admission string
	if err := p.QueryRow(ctx, `SELECT pg_get_functiondef('admit_branch_cash_movement'::regproc)`).
		Scan(&admission); err != nil {
		t.Fatalf("the admission of the ledger could not be read: %v", err)
	}
	for _, forbidden := range []string{"SELECT * FROM branch_cash_movements",
		"INTO corrected FROM branch_cash_movements", "branch_cash_movements%ROWTYPE"} {
		if strings.Contains(admission, forbidden) {
			t.Errorf("the live admission must not read the ledger with %q", forbidden)
		}
	}
	if !strings.Contains(admission, "INTO corrected_branch, corrected_kind") {
		t.Error("the live admission must state the columns of the movement it reads")
	}
	var book string
	if err := p.QueryRow(ctx, `SELECT pg_get_viewdef('branch_cash_ledger'::regclass)`).Scan(&book); err != nil {
		t.Fatalf("the book of the drawer could not be read: %v", err)
	}
	if strings.Contains(book, "evidence_bytes") {
		t.Error("the book never publishes the bytes of a receipt (S7)")
	}
	for _, column := range []string{"evidence_content_type", "evidence_size", "evidence_sha256"} {
		if !strings.Contains(book, column) {
			t.Errorf("the book publishes the metadata of the receipt, missing %s", column)
		}
	}
}

// TestHistoricalMovementsKeepNullReceipts proves S3 and S5 on a live database: the rows recorded
// before this delivery are not rewritten, they read with the four columns null, they still read as
// the same book, and the book publishes the receipt as metadata and never as bytes (S7).
func TestHistoricalMovementsKeepNullReceipts(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 61)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x'),(3,'sucursal_b','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	// Two rows of the schema of 061: the contribution that funds the till and a pay-out of it.
	if err := tryExpense(ctx, p, 2, 2, "aporte", "100.00", "Fondo de la caja"); err != nil {
		t.Fatalf("the row of the previous schema must be admitted: %v", err)
	}
	alquiler := motiveOf(t, ctx, p, "Alquiler")
	if _, err := p.Exec(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,
 description,category_id,created_by_account_id) VALUES(2,'gasto',45.50,'Flete del mes',$1,2)`,
		alquiler); err != nil {
		t.Fatalf("the row of the previous schema must be admitted: %v", err)
	}
	before := cashLedger(t, ctx, p)

	applyEvidenceMigration(t, ctx, p)

	if after := cashLedger(t, ctx, p); after != before {
		t.Fatalf("the receipt migration must not rewrite a row (S5): %q before, %q after", before, after)
	}
	var nulls int64
	if err := p.QueryRow(ctx, `SELECT count(*) FROM branch_cash_movements
 WHERE evidence_bytes IS NULL AND evidence_content_type IS NULL AND evidence_size IS NULL
   AND evidence_sha256 IS NULL`).Scan(&nulls); err != nil {
		t.Fatalf("the historical rows could not be read: %v", err)
	}
	if nulls != 2 {
		t.Fatalf("every historical row reads with no receipt (S3): %d of 2", nulls)
	}
	// The book of the previous schema reads with the three metadata columns appended and no receipt
	// stated on either row.
	var published string
	if err := p.QueryRow(ctx, `SELECT coalesce(string_agg(coalesce(evidence_content_type,'-')||':'
         ||coalesce(evidence_size::text,'-')||':'||coalesce(evidence_sha256,'-'),',' ORDER BY id),'')
 FROM branch_cash_ledger WHERE branch_location_id=2`).Scan(&published); err != nil {
		t.Fatalf("the book could not be read: %v", err)
	}
	if published != "-:-:-,-:-:-" {
		t.Fatalf("a row without a receipt publishes nothing about one, got %q", published)
	}
	var bytesColumns int64
	if err := p.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns
 WHERE table_name='branch_cash_movements' AND column_name='evidence_bytes'`).Scan(&bytesColumns); err != nil {
		t.Fatal("the shape of the ledger could not be read")
	}
	if bytesColumns != 1 {
		t.Fatal("the bytes of a receipt live in the movement's own row (S3)")
	}
	var viewBytes int64
	if err := p.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns
 WHERE table_name='branch_cash_ledger' AND column_name='evidence_bytes'`).Scan(&viewBytes); err != nil {
		t.Fatal("the shape of the book could not be read")
	}
	if viewBytes != 0 {
		t.Fatal("the book publishes the receipt as metadata and never as bytes (S7)")
	}
}

// itoa renders one small number as the decimal text a receipt publishes, so the expectations below
// are one string and never a promise about a format.
func itoa(value int64) string { return strconv.FormatInt(value, 10) }
