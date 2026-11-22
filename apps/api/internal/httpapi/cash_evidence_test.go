package httpapi

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"luson/api/internal/auth"
	"luson/api/internal/closings"
)

// The receipt of a pay-out over HTTP (S1-S9): the drawer route accepts the JSON of always and the
// two-part multipart body of a photo, the refusal of the file keeps its own code, the book and the
// acta publish the metadata and never the bytes, and the image is served by an authenticated route of
// the branch that owns the movement. Every fixture is generated in Go.

// closingEvidenceWire is the metadata of one receipt exactly as this contract publishes it: the type
// the server validated, the size of the stored bytes and their SHA-256. It states three keys and no
// fourth, because the bytes never travel in an answer (S7).
type closingEvidenceWire struct {
	Type   string `json:"type"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// closingEvidenceKeys is the frozen shape of the published receipt.
var closingEvidenceKeys = []string{"type", "size", "sha256"}

// evidenceJPEG builds one real JPEG of the given size, which is a receipt the contract accepts.
func evidenceJPEG(t *testing.T, width, height int) []byte {
	t.Helper()
	canvas := image.NewRGBA(image.Rect(0, 0, width, height))
	canvas.Set(0, 0, color.RGBA{R: 15, G: 25, B: 35, A: 255})
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
	canvas.Set(0, 0, color.RGBA{R: 90, G: 180, B: 20, A: 255})
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, canvas); err != nil {
		t.Fatalf("the PNG fixture could not be built: %v", err)
	}
	return buffer.Bytes()
}

// evidenceGrayPNG builds one real PNG of the given sides in grayscale: the same format the route
// decodes, cheap enough to build at the pixel cap its boundary is proved on.
func evidenceGrayPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	canvas := image.NewGray(image.Rect(0, 0, width, height))
	canvas.Set(0, 0, color.Gray{Y: 210})
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, canvas); err != nil {
		t.Fatalf("the grayscale PNG fixture could not be built: %v", err)
	}
	return buffer.Bytes()
}

// withTrailer is one real image followed by the payload of a polyglot, on a fresh slice so the fixture
// it starts from is never written through.
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

// multipartPart is one part of the two-form body of the drawer route: the JSON of the movement and
// the file of its receipt, which is what the screen uploads.
type multipartPart struct {
	name     string
	filename string
	body     []byte
}

// movementPart is the first part of the contract: exactly the JSON object of the route, unchanged.
func movementPart(body string) multipartPart {
	return multipartPart{name: "movement", filename: "movement.json", body: []byte(body)}
}

// evidencePart is the second part: the file, whose format is decided by its content and never by the
// name it declares.
func evidencePart(body []byte) multipartPart {
	return multipartPart{name: "evidence", filename: "comprobante.jpg", body: body}
}

// upload posts the parts of the receipt contract exactly as a browser would: a multipart body with
// the session, origin and CSRF framing of every other mutation of this contract.
func (f *closingHTTPFixture) upload(t *testing.T, actor int, parts ...multipartPart) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, part := range parts {
		field, err := writer.CreateFormFile(part.name, part.filename)
		if err != nil {
			t.Fatal("the multipart fixture could not be built")
		}
		if _, err := field.Write(part.body); err != nil {
			t.Fatal("the multipart part could not be written")
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal("the multipart fixture could not be closed")
	}
	r := httptest.NewRequest(http.MethodPost, "/api/closings/cash-movements", &body)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	r.RemoteAddr = "127.0.0.1:1234"
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: f.tokens[actor-1]})
	r.Header.Set("X-CSRF-Token", auth.CSRF(f.tokens[actor-1]))
	r.Header.Set("Origin", f.cfg.Origin)
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	return r
}

// evidenceOf reads the receipt of one movement of the book, and whether the book publishes that key
// at all, so "the bytes never appear" is one shape and not a substring search.
func evidenceOf(t *testing.T, w *httptest.ResponseRecorder, id int64) (*closingEvidenceWire, map[string]json.RawMessage) {
	t.Helper()
	var book struct {
		Movements []map[string]json.RawMessage `json:"movements"`
	}
	if json.Unmarshal(w.Body.Bytes(), &book) != nil {
		t.Fatalf("the book is not decodable: %s", w.Body.String())
	}
	for _, row := range book.Movements {
		var rowID int64
		if json.Unmarshal(row["id"], &rowID) != nil || rowID != id {
			continue
		}
		raw, ok := row["evidence"]
		if !ok {
			t.Fatalf("every row of the book states its receipt (S7): %s", w.Body.String())
		}
		if string(raw) == "null" {
			return nil, row
		}
		var evidence closingEvidenceWire
		if json.Unmarshal(raw, &evidence) != nil {
			t.Fatalf("the receipt is not decodable: %s", w.Body.String())
		}
		var shape map[string]json.RawMessage
		if json.Unmarshal(raw, &shape) != nil || len(shape) != len(closingEvidenceKeys) {
			t.Fatalf("the receipt states %d keys, want %d: %s", len(shape), len(closingEvidenceKeys),
				w.Body.String())
		}
		for _, key := range closingEvidenceKeys {
			if _, ok := shape[key]; !ok {
				t.Fatalf("the receipt must state %q: %s", key, w.Body.String())
			}
		}
		return &evidence, row
	}
	t.Fatalf("the book does not list movement %d: %s", id, w.Body.String())
	return nil, nil
}

// TestClosingsCashMovementEvidenceUpload pins S1, S3 and S6 over HTTP: the drawer route accepts the
// two-part body, the answer keeps the key set of a movement, and the book publishes the metadata of
// the stored receipt beside the row that carries it.
func TestClosingsCashMovementEvidenceUpload(t *testing.T) {
	f := closingFixture(t)
	f.closeSettlement(t, 2,
		`{"counted_cash":"0.00","contributed_cash":"100.00","closing_cash":"100.00","observation":"fondo inicial"}`)
	body := evidenceJPEG(t, 16, 16)

	// The two forms of the same route: the part states exactly the JSON the body would state, and the
	// answer is the answer of a movement and nothing more (S9).
	gasto := closingCashMovementReply(t, f.serve(t, f.upload(t, 2,
		movementPart(`{"kind":"gasto","amount":"45.50","description":"Detergente","category_id":1}`),
		evidencePart(body))), 201, closingCashMovementKeys)
	if gasto.ID < 1 || gasto.Kind != "gasto" || gasto.Amount != "45.50" ||
		gasto.Description != "Detergente" || gasto.BranchLocationID != 2 ||
		gasto.CreatedByAccountID != 2 || gasto.CorrectsID != nil {
		t.Fatalf("the recorded expense is not the published movement: %+v", gasto)
	}
	// A pay-out with no photo is the same route and the same row (S1): a multipart body without the
	// second part and the JSON body of always both record it.
	sinFoto := closingCashMovementReply(t, f.serve(t, f.upload(t, 2,
		movementPart(`{"kind":"gasto","amount":"5.00","description":"Insumos","category_id":1}`))), 201,
		closingCashMovementKeys)
	aporte := closingCashMovementReply(t, f.serve(t, f.request(2, "POST", "/api/closings/cash-movements",
		`{"kind":"aporte","amount":"100.00","description":"Cambio para el cajón"}`)), 201,
		closingCashMovementKeys)

	// The book publishes the receipt as its type, its size and its digest, and null on the rows that
	// carry none (S7). The bytes are not part of the answer: the row states the three keys of the
	// metadata and no other.
	read := f.serve(t, f.request(2, "GET", "/api/closings/cash-ledger", ""))
	var book closingCashLedgerWire
	closingCashWire(t, read, 200, closingCashLedgerKeys, &book)
	evidence, row := evidenceOf(t, read, gasto.ID)
	want := closingEvidenceWire{Type: "image/jpeg", Size: int64(len(body)), SHA256: evidenceDigest(body)}
	if evidence == nil || *evidence != want {
		t.Fatalf("the book publishes the stored receipt: got %+v want %+v", evidence, want)
	}
	if len(row) != len(closingCashLedgerRowKeys) {
		t.Fatalf("a row of the book states %d keys, want %d: %s", len(row),
			len(closingCashLedgerRowKeys), read.Body.String())
	}
	for _, id := range []int64{sinFoto.ID, aporte.ID} {
		if evidence, _ := evidenceOf(t, read, id); evidence != nil {
			t.Fatalf("a movement without a receipt states none (S7): %+v", evidence)
		}
	}
	// The refusal of the same photograph on a contribution keeps its own code, and the movement is
	// never written (S2).
	f.refused(t, f.upload(t, 2, movementPart(`{"kind":"aporte","amount":"1.00","description":"Cambio"}`),
		evidencePart(body)), 400, `{"error":"evidence_not_applicable"}`)
}

// TestClosingsCashMovementJSONPathIsUnchanged pins S9 over HTTP: the JSON body of the route is the
// body it always was, key by key, and a receipt is never part of it.
func TestClosingsCashMovementJSONPathIsUnchanged(t *testing.T) {
	f := closingFixture(t)
	f.closeSettlement(t, 2,
		`{"counted_cash":"0.00","contributed_cash":"100.00","closing_cash":"100.00","observation":"fondo inicial"}`)

	// The three kinds of the book are the three requests this contract already served, with exactly
	// the keys the route always published.
	for _, call := range []struct{ body, kind, amount, description string }{
		{`{"kind":"gasto","amount":"45.50","description":"Detergente","category_id":1}`,
			"gasto", "45.50", "Detergente"},
		{`{"kind":"gasto","amount":"5.00","description":"","category_id":1}`, "gasto", "5.00", ""},
		{`{"kind":"aporte","amount":"100.00","description":"Cambio para el cajón"}`,
			"aporte", "100.00", "Cambio para el cajón"},
		{`{"kind":"recaudacion","amount":"20.00","description":"Retiro entre rendiciones"}`,
			"recaudacion", "20.00", "Retiro entre rendiciones"},
	} {
		movement := closingCashMovementReply(t, f.serve(t, f.request(2, "POST",
			"/api/closings/cash-movements", call.body)), 201, closingCashMovementKeys)
		if movement.Kind != call.kind || movement.Amount != call.amount ||
			movement.Description != call.description {
			t.Fatalf("the JSON body records the movement it always recorded: %+v", movement)
		}
	}
	// A receipt is not a key of that body: the JSON path gained nothing (S9).
	f.refused(t, f.request(2, "POST", "/api/closings/cash-movements",
		`{"kind":"gasto","amount":"1.00","description":"Agua","category_id":1,`+
			`"evidence":"image/jpeg"}`), 400, `{"error":"invalid_request"}`)
	// And the book of those movements states no receipt at all.
	read := f.serve(t, f.request(2, "GET", "/api/closings/cash-ledger", ""))
	var book closingCashLedgerWire
	closingCashWire(t, read, 200, closingCashLedgerKeys, &book)
	if len(book.Movements) != 4 {
		t.Fatalf("the book lists the four movements of the JSON path: %+v", book.Movements)
	}
	for _, row := range book.Movements {
		if evidence, _ := evidenceOf(t, read, row.ID); evidence != nil {
			t.Fatalf("no movement of the JSON path carries a receipt: %+v", evidence)
		}
	}
}

// TestClosingsCashMovementEvidenceRefusals pins the refusal table of the contract: every case keeps
// its own status and its own code, and a refused upload writes nothing anywhere.
func TestClosingsCashMovementEvidenceRefusals(t *testing.T) {
	f := closingFixture(t)
	f.closeSettlement(t, 2,
		`{"counted_cash":"0.00","contributed_cash":"100.00","closing_cash":"100.00","observation":"fondo inicial"}`)
	body := evidenceJPEG(t, 8, 8)
	gasto := `{"kind":"gasto","amount":"10.00","description":"Detergente","category_id":1}`

	for _, refusal := range map[string]struct {
		request *http.Request
		answer  string
	}{
		// An empty file is not a receipt.
		"empty": {f.upload(t, 2, movementPart(gasto), evidencePart(nil)),
			`{"error":"evidence_empty"}`},
		// The cap is 8 MB, and the body stops being read there.
		"above the cap": {f.upload(t, 2, movementPart(gasto),
			evidencePart(make([]byte, closings.MaxEvidenceBytes+1))), `{"error":"evidence_too_large"}`},
		// The format is decided by the content: SVG is refused always, and so is a renamed script.
		"svg": {f.upload(t, 2, movementPart(gasto),
			evidencePart([]byte(`<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`))),
			`{"error":"evidence_unsupported"}`},
		"renamed script": {f.upload(t, 2, movementPart(gasto),
			evidencePart([]byte("#!/bin/sh\nrm -rf /\n"))), `{"error":"evidence_unsupported"}`},
		// The dimensions cap is 6000 pixels a side.
		"above the dimensions": {f.upload(t, 2, movementPart(gasto),
			evidencePart(evidenceJPEG(t, 6001, 1))), `{"error":"evidence_dimensions"}`},
		// A real image with a payload glued behind it is refused: the whole upload must be the image (S6).
		"png with a zip trailer": {f.upload(t, 2, movementPart(gasto),
			evidencePart(withTrailer(evidencePNG(t, 4, 4), []byte("PK\x03\x04")))),
			`{"error":"evidence_unsupported"}`},
		"png with a script trailer": {f.upload(t, 2, movementPart(gasto),
			evidencePart(withTrailer(evidencePNG(t, 4, 4), []byte("<script>alert(1)</script>")))),
			`{"error":"evidence_unsupported"}`},
		"jpeg with a script trailer": {f.upload(t, 2, movementPart(gasto),
			evidencePart(withTrailer(evidenceJPEG(t, 4, 4), []byte("<script>alert(1)</script>")))),
			`{"error":"evidence_unsupported"}`},
		"jpeg with a zip trailer": {f.upload(t, 2, movementPart(gasto),
			evidencePart(withTrailer(evidenceJPEG(t, 4, 4), []byte("PK\x03\x04")))),
			`{"error":"evidence_unsupported"}`},
		// The size cap is judged before the sides, so a file that states both is refused for its size.
		"above both caps": {f.upload(t, 2, movementPart(gasto),
			evidencePart(withTrailer(evidenceGrayPNG(t, 6001, 1), make([]byte, closings.MaxEvidenceBytes)))),
			`{"error":"evidence_too_large"}`},
		// Only a gasto carries a receipt.
		"on a contribution": {f.upload(t, 2,
			movementPart(`{"kind":"aporte","amount":"1.00","description":"Cambio"}`), evidencePart(body)),
			`{"error":"evidence_not_applicable"}`},
		"on a collection": {f.upload(t, 2,
			movementPart(`{"kind":"recaudacion","amount":"1.00","description":"Retiro"}`),
			evidencePart(body)), `{"error":"evidence_not_applicable"}`},
		// One receipt is one part; the framing of the request is judged before the file.
		"repeated part": {f.upload(t, 2, movementPart(gasto), evidencePart(body), evidencePart(body)),
			`{"error":"invalid_request"}`},
		"missing movement": {f.upload(t, 2, evidencePart(body)), `{"error":"invalid_request"}`},
		"unknown part": {f.upload(t, 2, movementPart(gasto), evidencePart(body),
			multipartPart{name: "signature", filename: "x.txt", body: []byte("hola")}),
			`{"error":"invalid_request"}`},
		"repeated movement": {f.upload(t, 2, movementPart(gasto), movementPart(gasto),
			evidencePart(body)), `{"error":"invalid_request"}`},
		"empty movement": {f.upload(t, 2, movementPart(""), evidencePart(body)),
			`{"error":"invalid_request"}`},
		// The movement of a multipart body is the JSON of the route, judged by the same decoder.
		"malformed movement": {f.upload(t, 2,
			movementPart(`{"kind":"gasto","amount":10.00,"description":"Agua","category_id":1}`),
			evidencePart(body)), `{"error":"invalid_request"}`},
		"movement without motive": {f.upload(t, 2,
			movementPart(`{"kind":"gasto","amount":"10.00","description":"Agua"}`), evidencePart(body)),
			`{"error":"category_required"}`},
		// A part this route does not read is a framing error, whatever it contains.
		"no parts": {f.upload(t, 2), `{"error":"invalid_request"}`},
	} {
		f.refused(t, refusal.request, 400, refusal.answer)
	}
	// And the book of the branch is the empty book of the previous requests: no refused upload left a
	// movement and no drawer moved (S4).
	read := f.serve(t, f.request(2, "GET", "/api/closings/cash-ledger", ""))
	var book closingCashLedgerWire
	closingCashWire(t, read, 200, closingCashLedgerKeys, &book)
	if len(book.Movements) != 0 || book.Expected != "100.00" {
		t.Fatalf("a refused upload writes nothing and moves no drawer (S4): %+v", book)
	}
}

// TestClosingsCashMovementEvidencePixelBound pins the pixel cap over HTTP (S6): an image of exactly
// 6000×6000 is a receipt the route stores and serves byte for byte, one pixel more is refused with its
// own code and writes nothing, and the size cap is judged before the sides are.
func TestClosingsCashMovementEvidencePixelBound(t *testing.T) {
	f := closingFixture(t)
	f.closeSettlement(t, 2,
		`{"counted_cash":"0.00","contributed_cash":"100.00","closing_cash":"100.00","observation":"fondo inicial"}`)
	gasto := `{"kind":"gasto","amount":"10.00","description":"Detergente","category_id":1}`

	// The cap itself is a receipt: 6000 pixels a side decodes whole and is stored exactly as it arrived.
	body := evidenceGrayPNG(t, 6000, 6000)
	admitted := closingCashMovementReply(t, f.serve(t, f.upload(t, 2, movementPart(gasto),
		evidencePart(body))), 201, closingCashMovementKeys)
	read := f.serve(t, f.request(2, "GET", "/api/closings/cash-ledger", ""))
	evidence, _ := evidenceOf(t, read, admitted.ID)
	want := closingEvidenceWire{Type: "image/png", Size: int64(len(body)), SHA256: evidenceDigest(body)}
	if evidence == nil || *evidence != want {
		t.Fatalf("the book publishes the boundary receipt: got %+v want %+v", evidence, want)
	}
	served := f.serve(t, f.request(2, "GET",
		fmt.Sprintf("/api/closings/cash-movements/%d/evidence", admitted.ID), ""))
	if served.Code != 200 || !bytes.Equal(served.Body.Bytes(), body) {
		t.Fatalf("the route serves the stored boundary receipt byte for byte: %d %d bytes",
			served.Code, served.Body.Len())
	}
	if got := served.Header().Get("Content-Type"); got != "image/png" {
		t.Fatalf("the served type is the stored one, got %q", got)
	}
	if got := served.Header().Get("Content-Length"); got != strconv.Itoa(len(body)) {
		t.Fatalf("the served length is the stored one, got %q", got)
	}

	// One pixel more is refused by the cap and writes nothing.
	f.refused(t, f.upload(t, 2, movementPart(gasto),
		evidencePart(evidenceGrayPNG(t, 6001, 6001))), 400, `{"error":"evidence_dimensions"}`)
	// The size cap is judged before the sides: a file of 8 MB plus one byte is refused for its size.
	f.refused(t, f.upload(t, 2, movementPart(gasto),
		evidencePart(withTrailer(evidenceGrayPNG(t, 6001, 1),
			make([]byte, closings.MaxEvidenceBytes)))), 400, `{"error":"evidence_too_large"}`)

	read = f.serve(t, f.request(2, "GET", "/api/closings/cash-ledger", ""))
	var book closingCashLedgerWire
	closingCashWire(t, read, 200, closingCashLedgerKeys, &book)
	if len(book.Movements) != 1 || book.Expected != "90.00" {
		t.Fatalf("a refused boundary writes nothing and moves no drawer (S4): %+v", book)
	}
}

// TestClosingsCashMovementTruncatedUploadIsInvalidRequest pins the one rule for a body that did not
// arrive complete (S4, S6): an upload cut in the middle is a malformed request, whatever its
// Content-Length states, and it is never an empty success. The two shapes are the connection that dies
// before the bytes it declared and the one that dies inside a body that declared exactly what it sent.
// Both leave the book exactly as it was.
func TestClosingsCashMovementTruncatedUploadIsInvalidRequest(t *testing.T) {
	f := closingFixture(t)
	f.closeSettlement(t, 2,
		`{"counted_cash":"0.00","contributed_cash":"100.00","closing_cash":"100.00","observation":"fondo inicial"}`)
	body, contentType := closingUploadBody(t,
		movementPart(`{"kind":"gasto","amount":"10.00","description":"Detergente","category_id":1}`),
		evidencePart(evidenceJPEG(t, 8, 8)))
	// The body stops inside the second part: the photo never finishes and the closing boundary of the
	// multipart body never arrives.
	cut := len(body) - 40

	for _, shape := range []struct {
		name     string
		declared int
	}{
		{"declares more bytes than it sends", len(body)},
		{"declares exactly what it sends", cut},
	} {
		t.Run(shape.name, func(t *testing.T) {
			before := f.drawerState(t)
			status, answer := f.cutUpload(t, body[:cut], shape.declared, contentType)
			if status != 400 || strings.TrimSpace(answer) != `{"error":"invalid_request"}` {
				t.Fatalf("the upload that %s answers 400 invalid_request, got %d %q", shape.name,
					status, answer)
			}
			if after := f.drawerState(t); after != before {
				t.Fatalf("the upload that %s wrote nothing (S4): %q before, %q after", shape.name,
					before, after)
			}
		})
	}
}

// closingUploadBody is the multipart body of one upload as one buffer, so a test can cut it in the
// middle instead of sending it whole.
func closingUploadBody(t *testing.T, parts ...multipartPart) ([]byte, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, part := range parts {
		field, err := writer.CreateFormFile(part.name, part.filename)
		if err != nil {
			t.Fatal("the multipart fixture could not be built")
		}
		if _, err := field.Write(part.body); err != nil {
			t.Fatal("the multipart part could not be written")
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal("the multipart fixture could not be closed")
	}
	return body.Bytes(), writer.FormDataContentType()
}

// cutUpload sends one upload through a real connection, stops writing at the bytes it holds, shuts
// its own side of the connection and reads the answer: the shape of a client that dies mid-upload
// while the server still has to answer.
func (f *closingHTTPFixture) cutUpload(t *testing.T, body []byte, declared int, contentType string) (int, string) {
	t.Helper()
	server := httptest.NewServer(f.handler)
	t.Cleanup(server.Close)
	conn, err := net.Dial("tcp", server.Listener.Addr().String())
	if err != nil {
		t.Fatalf("the upload connection could not be opened: %v", err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(30 * time.Second)); err != nil {
		t.Fatalf("the upload connection could not be bounded: %v", err)
	}
	token := f.tokens[1]
	head := fmt.Sprintf("POST /api/closings/cash-movements HTTP/1.1\r\nHost: %s\r\n"+
		"Content-Type: %s\r\nContent-Length: %d\r\nConnection: close\r\n"+
		"Cookie: %s=%s\r\nX-CSRF-Token: %s\r\nOrigin: %s\r\nSec-Fetch-Site: same-origin\r\n\r\n",
		server.Listener.Addr().String(), contentType, declared, sessionCookie, token, auth.CSRF(token),
		f.cfg.Origin)
	if _, err := conn.Write([]byte(head)); err != nil {
		t.Fatalf("the upload header could not be written: %v", err)
	}
	if _, err := conn.Write(body); err != nil {
		t.Fatalf("the upload body could not be written: %v", err)
	}
	closed, ok := conn.(*net.TCPConn)
	if !ok {
		t.Fatalf("the upload connection is not a TCP connection: %T", conn)
	}
	// The client goes on to read the answer, but nothing more of the body will ever arrive.
	if err := closed.CloseWrite(); err != nil {
		t.Fatalf("the upload connection could not be half closed: %v", err)
	}
	answer, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatalf("the cut upload answered nothing: %v", err)
	}
	defer answer.Body.Close()
	read, err := io.ReadAll(answer.Body)
	if err != nil {
		t.Fatalf("the answer of the cut upload could not be read: %v", err)
	}
	return answer.StatusCode, string(read)
}

// drawerState is the two facts a cut upload must leave untouched: how many movements the branch wrote
// and what its drawer expects.
func (f *closingHTTPFixture) drawerState(t *testing.T) string {
	t.Helper()
	var state string
	if err := f.p.QueryRow(f.ctx, `SELECT count(*)::text||':'||
 branch_drawer_expected(2::smallint)::text FROM branch_cash_movements`).Scan(&state); err != nil {
		t.Fatalf("the state of the drawer could not be read: %v", err)
	}
	return state
}

// TestClosingsCashMovementEvidenceImage pins S8 over HTTP: the bytes are served by an authenticated
// route of the branch that owns the movement, with the validated content type and the two headers of
// the contract, and every other authority or method is refused by its own answer.
func TestClosingsCashMovementEvidenceImage(t *testing.T) {
	f := closingFixture(t)
	f.closeSettlement(t, 2,
		`{"counted_cash":"0.00","contributed_cash":"100.00","closing_cash":"100.00","observation":"fondo inicial"}`)
	body := evidenceJPEG(t, 20, 20)
	gasto := closingCashMovementReply(t, f.serve(t, f.upload(t, 2,
		movementPart(`{"kind":"gasto","amount":"45.50","description":"Detergente","category_id":1}`),
		evidencePart(body))), 201, closingCashMovementKeys)
	photo := fmt.Sprintf("/api/closings/cash-movements/%d/evidence", gasto.ID)

	served := f.serve(t, f.request(2, "GET", photo, ""))
	if served.Code != 200 || !bytes.Equal(served.Body.Bytes(), body) {
		t.Fatalf("the route must serve the stored bytes: %d %d bytes", served.Code, served.Body.Len())
	}
	if got := served.Header().Get("Content-Type"); got != "image/jpeg" {
		t.Fatalf("the route serves the validated content type, got %q", got)
	}
	if got := served.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("a receipt is never cached, got %q", got)
	}
	if got := served.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("a receipt is never sniffed, got %q", got)
	}
	if got := served.Header().Get("Content-Disposition"); !strings.HasPrefix(got, "inline") {
		t.Fatalf("a receipt is served inline, got %q", got)
	}
	if got := served.Header().Get("Content-Length"); got != strconv.Itoa(len(body)) {
		t.Fatalf("the length of the receipt is the length of the bytes, got %q", got)
	}
	// The method is a read and only a read: HEAD answers the same headers and no body.
	head := f.serve(t, f.request(2, "HEAD", photo, ""))
	if head.Code != 200 || head.Body.Len() != 0 ||
		head.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatalf("HEAD answers the headers of the image and no body: %d %q", head.Code, head.Body.String())
	}
	for _, verb := range []string{"POST", "PUT", "DELETE", "PATCH"} {
		w := f.serve(t, f.request(2, verb, photo, ""))
		closingFailureBody(t, w, 405, `{"error":"method_not_allowed"}`)
		if allow := w.Header().Get("Allow"); allow != "GET, HEAD" {
			t.Fatalf("%s must advertise GET, HEAD, got %q", verb, allow)
		}
	}
	// The authority is the one of the book: the branch of the session owns the movement, another
	// branch's movement is not found, and the warehouse reads no drawer at all.
	f.contribute(t, 3, "10.00", "Cambio de la otra sucursal")
	foreign := closingCashMovementReply(t, f.serve(t, f.upload(t, 3,
		movementPart(`{"kind":"gasto","amount":"10.00","description":"Agua","category_id":1}`),
		evidencePart(evidencePNG(t, 4, 4)))), 201, closingCashMovementKeys)
	if own := f.serve(t, f.request(3, "GET",
		fmt.Sprintf("/api/closings/cash-movements/%d/evidence", foreign.ID), "")); own.Code != 200 ||
		own.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("each branch reads its own receipt: %d %q", own.Code, own.Header().Get("Content-Type"))
	}
	f.refused(t, f.request(3, "GET", photo, ""), 404, `{"error":"not_found"}`)
	f.refused(t, f.request(1, "GET", photo, ""), 403, `{"error":"forbidden"}`)
	// A movement without a receipt and a movement that does not exist are the same absence.
	plain := closingCashMovementReply(t, f.serve(t, f.request(2, "POST", "/api/closings/cash-movements",
		`{"kind":"gasto","amount":"1.00","description":"Insumos","category_id":1}`)), 201,
		closingCashMovementKeys)
	f.refused(t, f.request(2, "GET",
		fmt.Sprintf("/api/closings/cash-movements/%d/evidence", plain.ID), ""), 404,
		`{"error":"not_found"}`)
	f.refused(t, f.request(2, "GET", "/api/closings/cash-movements/999999/evidence", ""), 404,
		`{"error":"not_found"}`)
	// An anonymous caller reads nothing and a query string is not part of this route.
	f.refused(t, f.request(0, "GET", photo, ""), 401, `{"error":"unauthenticated"}`)
	f.refused(t, f.request(2, "GET", photo+"?download=1", ""), 400, `{"error":"invalid_request"}`)
}

// TestClosingsActaPublishesTheReceiptOfItsWindow pins S7 over HTTP: the settlement publishes the
// receipt of each pay-out of its window as metadata, and the bytes never appear in the document.
func TestClosingsActaPublishesTheReceiptOfItsWindow(t *testing.T) {
	f := closingFixture(t)
	f.closeSettlement(t, 2,
		`{"counted_cash":"0.00","contributed_cash":"100.00","closing_cash":"100.00","observation":"fondo inicial"}`)
	body := evidencePNG(t, 6, 6)
	gasto := closingCashMovementReply(t, f.serve(t, f.upload(t, 2,
		movementPart(`{"kind":"gasto","amount":"10.00","description":"Detergente","category_id":1}`),
		evidencePart(body))), 201, closingCashMovementKeys)
	opened := f.open(t, 2)

	document := f.serve(t, f.request(2, "GET", fmt.Sprintf("/api/closings/%d", opened), ""))
	var wire struct {
		Expenses []struct {
			ID       int64                `json:"id"`
			Evidence *closingEvidenceWire `json:"evidence"`
		} `json:"expenses"`
	}
	if document.Code != 200 || json.Unmarshal(document.Body.Bytes(), &wire) != nil {
		t.Fatalf("the settlement is not decodable: %d %s", document.Code, document.Body.String())
	}
	if len(wire.Expenses) != 1 || wire.Expenses[0].ID != gasto.ID ||
		wire.Expenses[0].Evidence == nil {
		t.Fatalf("the acta publishes the receipt of its pay-out (S7): %s", document.Body.String())
	}
	want := closingEvidenceWire{Type: "image/png", Size: int64(len(body)), SHA256: evidenceDigest(body)}
	if *wire.Expenses[0].Evidence != want {
		t.Fatalf("the acta publishes the stored receipt: got %+v want %+v",
			*wire.Expenses[0].Evidence, want)
	}
}
