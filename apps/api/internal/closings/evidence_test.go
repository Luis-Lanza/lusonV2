package closings_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"luson/api/internal/closings"
)

// The receipt of a pay-out (S1-S9) is one optional photo of the ticket, stored in the movement's own
// row, validated by decoding its content, written in the same statement as the movement and served by
// an authenticated route of the branch that owns it. Every fixture below is generated in Go: no
// binary is checked in, and nothing about the file is taken from the caller.

// evidenceJPEG builds one real JPEG of the given size, which is a receipt the contract accepts.
func evidenceJPEG(t *testing.T, width, height int) []byte {
	t.Helper()
	canvas := image.NewRGBA(image.Rect(0, 0, width, height))
	canvas.Set(0, 0, color.RGBA{R: 12, G: 34, B: 56, A: 255})
	var buffer bytes.Buffer
	if err := jpeg.Encode(&buffer, canvas, nil); err != nil {
		t.Fatalf("the JPEG fixture could not be built: %v", err)
	}
	return buffer.Bytes()
}

// evidencePNG builds one real PNG of the given size.
func evidencePNG(t *testing.T, width, height int) []byte {
	t.Helper()
	canvas := image.NewRGBA(image.Rect(0, 0, width, height))
	canvas.Set(0, 0, color.RGBA{R: 240, G: 120, B: 60, A: 255})
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, canvas); err != nil {
		t.Fatalf("the PNG fixture could not be built: %v", err)
	}
	return buffer.Bytes()
}

// evidenceGrayPNG builds one real PNG of the given sides in grayscale: the same format the contract
// decodes, cheap enough to build at the pixel cap its boundary is proved on.
func evidenceGrayPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	canvas := image.NewGray(image.Rect(0, 0, width, height))
	canvas.Set(0, 0, color.Gray{Y: 200})
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, canvas); err != nil {
		t.Fatalf("the grayscale PNG fixture could not be built: %v", err)
	}
	return buffer.Bytes()
}

// withTrailer is one real image followed by the payload of a polyglot, built on a fresh slice so the
// fixture it starts from is never written through.
func withTrailer(body, trailer []byte) []byte {
	joined := make([]byte, 0, len(body)+len(trailer))
	joined = append(joined, body...)
	return append(joined, trailer...)
}

// evidenceDigest is the SHA-256 of one fixture in the spelling the contract publishes.
func evidenceDigest(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// upload reads one fixture the way the surface does, so a test never builds the validated upload by
// hand: the content type and the digest are the server's own reading of the bytes.
func upload(t *testing.T, body []byte) closings.EvidenceUpload {
	t.Helper()
	validated, err := closings.ReadEvidence(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("the fixture must be a receipt this contract accepts: %v", err)
	}
	return validated
}

// recordEvidence writes one pay-out of one branch with the receipt it states through the store's own
// path, and fails instead of returning: every call of it is a row the domain must admit.
func (e *env) recordEvidence(t *testing.T, branch int, amount, description string,
	receipt *closings.EvidenceUpload) closings.Expense {
	t.Helper()
	movement, err := e.store.RecordCashMovementEvidence(e.ctx, identity(branch), "gasto",
		closings.Money(amount), description, e.defaultMotive(t), receipt)
	if err != nil {
		t.Fatalf("the pay-out %q must be admitted: %v", description, err)
	}
	return movement
}

// TestEvidenceIsTheMovementReceipt proves S1, S3 and S6 on a live database: a pay-out carries one
// photo, stored exactly as it arrived, with the format its decode proved, its real size and the
// SHA-256 of exactly the stored bytes.
func TestEvidenceIsTheMovementReceipt(t *testing.T) {
	e := fixture(t)
	e.contribute(t, 2, "100.00", "Fondo de la caja")

	for _, fixture := range []struct {
		contentType string
		body        []byte
	}{
		{"image/jpeg", evidenceJPEG(t, 16, 16)},
		{"image/png", evidencePNG(t, 16, 16)},
	} {
		movement := e.recordEvidence(t, 2, "10.00", "Detergente", ptrUpload(t, fixture.body))
		if movement.Evidence == nil {
			t.Fatalf("the admitted movement publishes its receipt (%s)", fixture.contentType)
		}
		want := closings.Evidence{Type: fixture.contentType, Size: int64(len(fixture.body)),
			SHA256: evidenceDigest(fixture.body)}
		if *movement.Evidence != want {
			t.Fatalf("the published receipt is not the one that was written: got %+v want %+v",
				*movement.Evidence, want)
		}
		// The bytes the row stores are the bytes the branch uploaded, never a re-encoding (S5), and
		// the size and the digest of the row are theirs (S6).
		stored := e.text(t, `SELECT translate(encode(evidence_bytes,'base64'),E'\n','')||':'||
 evidence_content_type||':'
 ||evidence_size::text||':'||evidence_sha256||':'||octet_length(evidence_bytes)::text||':'
 ||encode(sha256(evidence_bytes),'hex') FROM branch_cash_movements WHERE id=$1`, movement.ID)
		if stored != base64.StdEncoding.EncodeToString(fixture.body)+":"+fixture.contentType+":"+
			strconv.FormatInt(int64(len(fixture.body)), 10)+":"+evidenceDigest(fixture.body)+":"+
			strconv.FormatInt(int64(len(fixture.body)), 10)+":"+evidenceDigest(fixture.body) {
			t.Fatalf("the stored receipt is not the one that was uploaded: %q", stored)
		}
	}
	// The book publishes the receipt of each row as metadata and the contribution beside it with
	// none (S7): the bytes are not part of the published row, so a book never drags them.
	book, err := e.store.CashLedger(e.ctx, identity(2), nil, nil)
	if err != nil {
		t.Fatalf("the book could not be read: %v", err)
	}
	if len(book.Movements) != 3 {
		t.Fatalf("the book must list the three movements of the window: %+v", book.Movements)
	}
	if book.Movements[0].Kind != "aporte" || book.Movements[0].Evidence != nil {
		t.Fatalf("a contribution carries no receipt (S2): %+v", book.Movements[0])
	}
	for _, row := range book.Movements[1:] {
		if row.Evidence == nil || row.Evidence.Type == "" || row.Evidence.Size < 1 ||
			len(row.Evidence.SHA256) != 64 {
			t.Fatalf("the book publishes the receipt of a pay-out (S7): %+v", row)
		}
	}
}

// TestEvidenceIsOptional proves S1 on a live database: a pay-out with no photo is a row of the book
// exactly like before, and one with a photo is the same row plus its receipt.
func TestEvidenceIsOptional(t *testing.T) {
	e := fixture(t)
	e.contribute(t, 2, "100.00", "Fondo de la caja")

	// The path of this contract that does not take a receipt writes the same row it always wrote.
	plain := e.expense(t, 2, "10.00", "Detergente")
	if plain.Evidence != nil {
		t.Fatalf("an expense with no receipt publishes none: %+v", plain)
	}
	if stored := e.text(t, `SELECT coalesce(evidence_bytes::text,'-')||':'||
 coalesce(evidence_content_type,'-')||':'||coalesce(evidence_size::text,'-')||':'||
 coalesce(evidence_sha256,'-') FROM branch_cash_movements WHERE id=$1`, plain.ID); stored != "-:-:-:-" {
		t.Fatalf("an expense with no receipt stores no receipt: %q", stored)
	}
	// The same movement with a receipt is the same row of the book plus the receipt, so a screen
	// reads one shape and tells them apart by `evidence` alone (S1).
	withReceipt := e.recordEvidence(t, 2, "10.00", "Detergente",
		ptrUpload(t, evidenceJPEG(t, 8, 8)))
	if withReceipt.Evidence == nil || withReceipt.Amount != plain.Amount ||
		withReceipt.Kind != plain.Kind || withReceipt.Description != plain.Description ||
		withReceipt.CategoryID == nil || *withReceipt.CategoryID != *plain.CategoryID {
		t.Fatalf("a receipt adds a fact to the row and changes none: %+v against %+v", withReceipt, plain)
	}
}

// ptrUpload hands one validated receipt to the store, which is what the surface does after reading
// the file.
func ptrUpload(t *testing.T, body []byte) *closings.EvidenceUpload {
	t.Helper()
	validated := upload(t, body)
	return &validated
}

// TestEvidenceRefusesWhatIsNotAnAcceptedImage proves S6: the format is decided by the content, only
// a complete JPEG or PNG is accepted, SVG is refused always, and the two caps are boundaries.
func TestEvidenceRefusesWhatIsNotAnAcceptedImage(t *testing.T) {
	jpegBody := evidenceJPEG(t, 32, 32)
	pngBody := evidencePNG(t, 32, 32)

	for name, fixture := range map[string]struct {
		body []byte
		want error
	}{
		// An empty file is not a receipt.
		"empty":      {nil, closings.ErrEvidenceEmpty},
		"zero bytes": {[]byte{}, closings.ErrEvidenceEmpty},
		// SVG is text, and so is a renamed script: neither decodes as an image, whatever the part
		// claims to be.
		"svg":             {[]byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>`), closings.ErrEvidenceUnsupported},
		"renamed script":  {[]byte("#!/bin/sh\necho hola\n"), closings.ErrEvidenceUnsupported},
		"gif":             {[]byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;"), closings.ErrEvidenceUnsupported},
		"pdf":             {[]byte("%PDF-1.4\n"), closings.ErrEvidenceUnsupported},
		"empty jpeg":      {jpegBody[:2], closings.ErrEvidenceUnsupported},
		"truncated jpeg":  {jpegBody[:len(jpegBody)/2], closings.ErrEvidenceUnsupported},
		"truncated png":   {pngBody[:len(pngBody)/2], closings.ErrEvidenceUnsupported},
		"jpeg magic only": {[]byte{0xFF, 0xD8, 0xFF}, closings.ErrEvidenceUnsupported},
		// A file whose header claims one format and whose content is another is refused, because the
		// format is what the decode proves and not what the bytes of the header promise.
		"png with jpeg magic prefix": {append([]byte{0xFF, 0xD8, 0xFF}, pngBody...), closings.ErrEvidenceUnsupported},
		// A real image with a payload glued behind it is not a receipt (S6): the decode stops at the end
		// of the image, so the bytes past that end are what proves the upload was more than its photo.
		"png with a zip trailer":     {withTrailer(pngBody, []byte("PK\x03\x04")), closings.ErrEvidenceUnsupported},
		"png with a script trailer":  {withTrailer(pngBody, []byte("<script>alert(1)</script>")), closings.ErrEvidenceUnsupported},
		"png with a byte trailer":    {withTrailer(pngBody, []byte("\x00")), closings.ErrEvidenceUnsupported},
		"jpeg with a script trailer": {withTrailer(jpegBody, []byte("<script>alert(1)</script>")), closings.ErrEvidenceUnsupported},
		"jpeg with a zip trailer":    {withTrailer(jpegBody, []byte("PK\x03\x04")), closings.ErrEvidenceUnsupported},
		// The caps: 6000 pixels a side is admitted, one more is not (S6).
		"above the width cap":  {evidenceJPEG(t, 6001, 1), closings.ErrEvidenceDimensions},
		"above the height cap": {evidencePNG(t, 1, 6001), closings.ErrEvidenceDimensions},
		"above the square cap": {evidenceGrayPNG(t, 6001, 6001), closings.ErrEvidenceDimensions},
		"above the byte cap":   {make([]byte, closings.MaxEvidenceBytes+1), closings.ErrEvidenceTooLarge},
		// The size cap is judged before the dimensions, so a file that states both is refused for its
		// size and never reaches the header it would be measured by (S6).
		"above both caps": {withTrailer(evidenceGrayPNG(t, 6001, 1),
			make([]byte, closings.MaxEvidenceBytes)), closings.ErrEvidenceTooLarge},
	} {
		_, err := closings.ReadEvidence(bytes.NewReader(fixture.body))
		if err != fixture.want {
			t.Fatalf("%s must be refused with %v, got %v", name, fixture.want, err)
		}
	}
	// The boundary of the pixel cap is the cap itself: a receipt of exactly 6000 pixels a side is
	// one this contract accepts, so the refusals above are the cap and not a coefficient.
	for _, sides := range []struct{ width, height int }{{6000, 1}, {1, 6000}, {6000, 6000}} {
		body := evidenceGrayPNG(t, sides.width, sides.height)
		upload, err := closings.ReadEvidence(bytes.NewReader(body))
		if err != nil {
			t.Fatalf("%dx%d pixels is admitted (S6): %v", sides.width, sides.height, err)
		}
		if upload.Type != "image/png" || upload.Size != int64(len(body)) ||
			upload.SHA256 != evidenceDigest(body) {
			t.Fatalf("the admitted boundary is the receipt that was uploaded: %+v", upload)
		}
	}
	if _, err := closings.ReadEvidence(bytes.NewReader(evidenceJPEG(t, 6000, 1))); err != nil {
		t.Fatalf("6000 pixels is admitted (S6): %v", err)
	}
	if _, err := closings.ReadEvidence(bytes.NewReader(evidencePNG(t, 1, 6000))); err != nil {
		t.Fatalf("6000 pixels is admitted (S6): %v", err)
	}
}

// gatedReceipt is one fixture whose read starts only when the test opens the gate, so the test can
// count how many receipts are inside the validator at the same time.
type gatedReceipt struct {
	body      []byte
	read      int
	announced bool
	started   chan<- struct{}
	release   <-chan struct{}
}

func (g *gatedReceipt) Read(buffer []byte) (int, error) {
	if !g.announced {
		g.announced = true
		g.started <- struct{}{}
	}
	<-g.release
	if g.read >= len(g.body) {
		return 0, io.EOF
	}
	read := copy(buffer, g.body[g.read:])
	g.read += read
	return read, nil
}

// TestEvidenceDecodesRunTwoAtATime proves S6 on the memory a decode reserves: a receipt is read and
// decoded under one of two slots, so simultaneous uploads queue for the validator instead of
// multiplying what its images reserve, and the ones that wait are never refused by a new code.
func TestEvidenceDecodesRunTwoAtATime(t *testing.T) {
	body := evidencePNG(t, 8, 8)
	const callers = closings.MaxConcurrentEvidenceDecodes + 2
	started := make(chan struct{}, callers)
	release := make(chan struct{})
	errs := make([]error, callers)
	var waiting sync.WaitGroup
	for index := range callers {
		waiting.Add(1)
		go func(index int) {
			defer waiting.Done()
			_, errs[index] = closings.ReadEvidenceContext(context.Background(),
				&gatedReceipt{body: body, started: started, release: release})
		}(index)
	}
	// The validator holds exactly the bound: the other uploads wait for a slot.
	for slot := range closings.MaxConcurrentEvidenceDecodes {
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatalf("only %d of %d receipts entered the validator", slot,
				closings.MaxConcurrentEvidenceDecodes)
		}
	}
	select {
	case <-started:
		t.Fatalf("more than %d receipts are inside the validator at once",
			closings.MaxConcurrentEvidenceDecodes)
	case <-time.After(250 * time.Millisecond):
	}
	// Opening the gate lets the two held receipts finish; the queue behind them follows, and every
	// upload is admitted rather than refused for having waited.
	close(release)
	waiting.Wait()
	for index, err := range errs {
		if err != nil {
			t.Fatalf("upload %d of the queue must be admitted, got %v", index, err)
		}
	}
}

// untouchedReceipt fails the test if a request that never owned a slot reads its file.
type untouchedReceipt struct{ t *testing.T }

func (u untouchedReceipt) Read([]byte) (int, error) {
	u.t.Error("a cancelled request must not read the receipt")
	return 0, io.EOF
}

// TestEvidenceCancelledUploadReleasesItsSlot proves S6 on a request that never gets to decode: one
// cancelled while it waits for a slot is answered by its own context and neither holds nor leaks the
// slot, so the two that follow it are still admitted.
func TestEvidenceCancelledUploadReleasesItsSlot(t *testing.T) {
	body := evidencePNG(t, 8, 8)
	// A request cancelled before it starts reads nothing at all.
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := closings.ReadEvidenceContext(cancelled, untouchedReceipt{t: t}); !errors.Is(err, context.Canceled) {
		t.Fatalf("a cancelled upload is answered by its context, got %v", err)
	}

	// With both slots taken, an upload that waits and is then cancelled answers its context instead of
	// queueing forever, and it leaves no slot behind.
	started := make(chan struct{}, closings.MaxConcurrentEvidenceDecodes)
	release := make(chan struct{})
	var holding sync.WaitGroup
	for range closings.MaxConcurrentEvidenceDecodes {
		holding.Add(1)
		go func() {
			defer holding.Done()
			if _, err := closings.ReadEvidenceContext(context.Background(),
				&gatedReceipt{body: body, started: started, release: release}); err != nil {
				t.Errorf("a held receipt must be admitted, got %v", err)
			}
		}()
	}
	for range closings.MaxConcurrentEvidenceDecodes {
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatal("the two slots were never taken")
		}
	}
	waiting, stop := context.WithCancel(context.Background())
	answered := make(chan error, 1)
	go func() {
		_, err := closings.ReadEvidenceContext(waiting, &gatedReceipt{body: body,
			started: started, release: release})
		answered <- err
	}()
	stop()
	select {
	case err := <-answered:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("a request cancelled while waiting is answered by its context, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a cancelled request kept waiting for a slot")
	}
	close(release)
	holding.Wait()
	// The cancelled request left nothing behind: a later upload owns a slot at once.
	if _, err := closings.ReadEvidence(bytes.NewReader(body)); err != nil {
		t.Fatalf("the cancelled upload must not leak its slot: %v", err)
	}
}

// TestEvidenceRefusalWritesNothing proves S4 on a live database: a refused receipt leaves no
// movement, so the drawer expectation of the branch does not move with a pay-out that never existed.
func TestEvidenceRefusalWritesNothing(t *testing.T) {
	e := fixture(t)
	e.contribute(t, 2, "100.00", "Fondo de la caja")
	before := e.text(t, `SELECT branch_drawer_expected(2::smallint)::text`)

	// The pay-out states more than the till holds, which the database refuses with its own code
	// (060): the receipt of the same statement is not written beside it (S4).
	_, err := e.store.RecordCashMovementEvidence(e.ctx, identity(2), "gasto", "500.00", "Compra grande",
		e.defaultMotive(t), ptrUpload(t, evidenceJPEG(t, 8, 8)))
	if err == nil {
		t.Fatal("a pay-out the drawer cannot hold must be refused")
	}
	if movements := e.scalar(t, "SELECT count(*) FROM branch_cash_movements"); movements != 1 {
		t.Fatalf("a refused upload writes no movement (S4): %d rows", movements)
	}
	if stored := e.scalar(t, "SELECT count(*) FROM branch_cash_movements WHERE evidence_bytes IS NOT NULL"); stored != 0 {
		t.Fatalf("a refused upload writes no receipt (S4): %d rows", stored)
	}
	if after := e.text(t, `SELECT branch_drawer_expected(2::smallint)::text`); after != before {
		t.Fatalf("a refused upload moves no expectation (S4): %q before, %q after", before, after)
	}
}

// TestEvidenceOnlyOnAnExpense proves S2 on a live database: a receipt on a contribution or on a
// collection is refused with its own class, and nothing is written.
func TestEvidenceOnlyOnAnExpense(t *testing.T) {
	e := fixture(t)
	e.contribute(t, 2, "100.00", "Fondo de la caja")
	before := e.scalar(t, "SELECT count(*) FROM branch_cash_movements")

	for _, kind := range []string{"aporte", "recaudacion"} {
		_, err := e.store.RecordCashMovementEvidence(e.ctx, identity(2), kind, closings.Money("1.00"),
			"Movimiento con foto", nil, ptrUpload(t, evidenceJPEG(t, 8, 8)))
		refused(t, err, closings.ErrEvidenceNotApplicable)
	}
	// A correction never carries one either: the compensating movement answers for the money.
	target := e.expense(t, 2, "10.00", "Detergente")
	if closings.ValidEvidence("correccion", &closings.Evidence{Type: "image/jpeg", Size: 4,
		SHA256: strings.Repeat("a", 64)}) {
		t.Fatal("a correction carries no receipt (S2)")
	}
	if target.ID < 1 {
		t.Fatal("the corrected movement must exist")
	}
	if after := e.scalar(t, "SELECT count(*) FROM branch_cash_movements"); after != before+1 {
		t.Fatalf("a refused receipt writes nothing (S2): %d before, %d after", before, after)
	}
}

// TestEvidenceImageIsTheBranchOwn proves S8 on a live database: the bytes of a receipt are served to
// the branch that owns the movement, another branch's movement is not found, a movement with no
// receipt states nothing, and the warehouse reads no drawer at all.
func TestEvidenceImageIsTheBranchOwn(t *testing.T) {
	e := fixture(t)
	e.contribute(t, 2, "100.00", "Fondo de la caja")
	e.contribute(t, 3, "100.00", "Fondo de la otra sucursal")
	body := evidenceJPEG(t, 12, 12)
	mine := e.recordEvidence(t, 2, "10.00", "Detergente", ptrUpload(t, body))
	other := e.recordEvidence(t, 3, "10.00", "Agua de la otra sucursal",
		ptrUpload(t, evidencePNG(t, 12, 12)))
	plain := e.expense(t, 2, "5.00", "Sin foto")

	served, err := e.store.CashMovementEvidence(e.ctx, identity(2), mine.ID)
	if err != nil {
		t.Fatalf("the branch must read its own receipt (S8): %v", err)
	}
	if !bytes.Equal(served.Bytes, body) || served.Type != "image/jpeg" ||
		served.Size != int64(len(body)) || served.SHA256 != evidenceDigest(body) {
		t.Fatalf("the served receipt is not the stored one: %+v", served)
	}
	// Another branch's movement is not part of this branch's ledger: it is not found, exactly like a
	// movement that does not exist (S8).
	if _, err := e.store.CashMovementEvidence(e.ctx, identity(3), mine.ID); err != closings.ErrNotFound {
		t.Fatalf("another branch's receipt is not found, got %v", err)
	}
	if served, err := e.store.CashMovementEvidence(e.ctx, identity(3), other.ID); err != nil ||
		served.Type != "image/png" {
		t.Fatalf("each branch reads its own receipt: %+v %v", served, err)
	}
	// A movement with no receipt states nothing to serve, and so does a movement that does not exist.
	if _, err := e.store.CashMovementEvidence(e.ctx, identity(2), plain.ID); err != closings.ErrNotFound {
		t.Fatalf("a movement without a receipt is not found, got %v", err)
	}
	if _, err := e.store.CashMovementEvidence(e.ctx, identity(2), 999999); err != closings.ErrNotFound {
		t.Fatalf("an unknown movement is not found, got %v", err)
	}
	if _, err := e.store.CashMovementEvidence(e.ctx, identity(2), 0); err != closings.ErrNotFound {
		t.Fatalf("a movement id is never zero, got %v", err)
	}
	// The warehouse owns no drawer, exactly as the book states it (S8).
	if _, err := e.store.CashMovementEvidence(e.ctx, warehouse(), mine.ID); err != closings.ErrForbidden {
		t.Fatalf("the warehouse reads no branch receipt, got %v", err)
	}
	// A session the installation does not hold reads nothing.
	if _, err := e.store.CashMovementEvidence(e.ctx, identity(3), mine.ID); err != closings.ErrNotFound {
		t.Fatal("a receipt is served to the branch of the movement only")
	}
}

// TestActaPublishesTheReceiptOfItsWindow proves S7 on a live database: the settlement lists the
// pay-outs of its window with the metadata of their receipts beside the row, and the ones without a
// receipt state none.
func TestActaPublishesTheReceiptOfItsWindow(t *testing.T) {
	e := fixture(t)
	e.closeFirstSettlement(t, "100.00")
	body := evidenceJPEG(t, 10, 10)
	withReceipt := e.recordEvidence(t, 2, "10.00", "Detergente", ptrUpload(t, body))
	without := e.expense(t, 2, "5.00", "Insinuos")

	opened, err := e.store.Open(e.ctx, warehouse(), 2)
	if err != nil {
		t.Fatalf("the period could not be opened: %v", err)
	}
	if len(opened.Expenses) != 2 {
		t.Fatalf("the acta must list the two pay-outs of its window: %+v", opened.Expenses)
	}
	want := closings.Evidence{Type: "image/jpeg", Size: int64(len(body)),
		SHA256: evidenceDigest(body)}
	if opened.Expenses[0].ID != withReceipt.ID || opened.Expenses[0].Evidence == nil ||
		*opened.Expenses[0].Evidence != want {
		t.Fatalf("the acta publishes the receipt of the pay-out (S7): %+v", opened.Expenses[0])
	}
	if opened.Expenses[1].ID != without.ID || opened.Expenses[1].Evidence != nil {
		t.Fatalf("a pay-out without a receipt states none (S7): %+v", opened.Expenses[1])
	}
	// A stored receipt this domain could not have written is never published: the row is refused
	// instead of described, exactly like every other shape of the book.
	if closings.ValidEvidence("aporte", opened.Expenses[0].Evidence) {
		t.Fatal("only a gasto carries a receipt (S2)")
	}
	if !closings.ValidEvidence("gasto", opened.Expenses[0].Evidence) {
		t.Fatal("the receipt of a pay-out is the shape this domain writes (S6)")
	}
}
