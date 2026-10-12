package httpapi

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"luson/api/internal/transfers"
)

const countBody = `{"variant_id":1,"operation_key":"count-http-key-001","expected_revision":"0","actual_quantity":"1","reason":"  recount evidence  "}`

func TestC3CountDecoder(t *testing.T) {
	decode := func(body string, propose bool) (countMutation, error) {
		r := httptest.NewRequest("POST", "/", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		return decodeCountMutation(r, propose)
	}
	for _, actual := range []string{"0", "9007199254740993", "9223372036854775807"} {
		body := strings.Replace(countBody, `"actual_quantity":"1"`, `"actual_quantity":"`+actual+`"`, 1)
		got, err := decode(body, true)
		if err != nil || countInt(got.Actual) != actual || got.Reason != "  recount evidence  " {
			t.Fatal("lossless decode", err)
		}
	}
	decision := strings.Replace(countBody, `,"actual_quantity":"1"`, "", 1)
	if _, err := decode(decision, false); err != nil {
		t.Fatal("decision schema", err)
	}
	if _, err := decode(countBody, false); err != transfers.ErrInvalid {
		t.Fatal("decision accepted actual")
	}
	for name, body := range map[string]string{
		"null": "null", "array": "[]", "empty": "{}", "junk": countBody + "{}", "nested": `{"variant_id":{"value":1}}`,
		"duplicate":         strings.Replace(countBody, `"variant_id":1`, `"variant_id":1,"variant_id":1`, 1),
		"escaped_duplicate": strings.Replace(countBody, `"variant_id":1`, `"variant_id":1,"variant_\u0069d":1`, 1),
		"missing_actual":    decision,
		"missing_revision":  strings.Replace(countBody, `"expected_revision":"0",`, "", 1),
		"missing_reason":    strings.Replace(countBody, `,"reason":"  recount evidence  "`, "", 1),
		"missing_key":       strings.Replace(countBody, `"operation_key":"count-http-key-001",`, "", 1),
		"missing_variant":   strings.Replace(countBody, `"variant_id":1,`, "", 1),
		"alias":             strings.Replace(countBody, "actual_quantity", "actual", 1),
		"invalid_utf8":      countBody + string([]byte{255}), "oversize": strings.Repeat(" ", 64<<10) + countBody,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := decode(body, true); err != transfers.ErrInvalid {
				t.Fatal("invalid schema admitted", err)
			}
		})
	}
	for _, member := range []string{`"actor_location_id":1`, `"effective_credit":"1"`, `"status":"pending"`, `"request_id":"1"`, `"revision":"1"`, `"delta":"1"`} {
		if _, err := decode(strings.TrimSuffix(countBody, "}")+","+member+"}", true); err != transfers.ErrInvalid {
			t.Fatal("authority/computed member admitted", member)
		}
	}
	for _, field := range []string{"actual_quantity", "expected_revision"} {
		original := `"` + field + `":"1"`
		if field == "expected_revision" {
			original = `"expected_revision":"0"`
		}
		for _, token := range []string{`"00"`, `"01"`, `"-0"`, `"-1"`, `"+1"`, `"1.0"`, `"1e0"`, `" 1"`, `"1 "`, `"9223372036854775808"`, `1`, `0`, `1.0`, `1e0`, `null`, `true`, `[]`, `{}`} {
			if _, err := decode(strings.Replace(countBody, original, `"`+field+`":`+token, 1), true); err != transfers.ErrInvalid {
				t.Fatal("decimal coercion", field, token)
			}
		}
	}
	if _, err := decode(strings.Replace(countBody, `"expected_revision":"0"`, `"expected_revision":"9223372036854775807"`, 1), true); err != transfers.ErrInvalid {
		t.Fatal("overflowing next revision")
	}
	if _, err := decode(strings.Replace(countBody, `"expected_revision":"0"`, `"expected_revision":"9223372036854775806"`, 1), true); err != nil {
		t.Fatal("max revision rejected")
	}
	for _, token := range []string{`"1"`, `0`, `-1`, `1.0`, `1e0`, `2147483648`, `null`, `true`} {
		if _, err := decode(strings.Replace(countBody, `"variant_id":1`, `"variant_id":`+token, 1), true); err != transfers.ErrInvalid {
			t.Fatal("variant coercion", token)
		}
	}
	if _, err := decode(strings.Replace(countBody, `"variant_id":1`, `"variant_id":2147483647`, 1), true); err != nil {
		t.Fatal("int32 boundary")
	}
	for _, token := range []string{`null`, `true`, `1`, `""`, `"   "`, `"\u0000"`, `"` + strings.Repeat("x", 2001) + `"`} {
		if _, err := decode(strings.Replace(countBody, `"  recount evidence  "`, token, 1), true); err != transfers.ErrInvalid {
			t.Fatal("invalid reason", token[:1])
		}
	}
	for _, token := range []string{`null`, `1`, `"short"`, `"count-http-key-001!"`, `"` + strings.Repeat("k", 129) + `"`} {
		if _, err := decode(strings.Replace(countBody, `"count-http-key-001"`, token, 1), true); err != transfers.ErrInvalid {
			t.Fatal("invalid operation key")
		}
	}
	for _, media := range []string{"", "text/plain", "application/json;", "application/json; charset=latin1", "application/json; other=x", "application/json; charset=utf-8; charset=utf-8"} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(countBody))
		r.Header.Set("Content-Type", media)
		if _, err := decodeCountMutation(r, true); err != transfers.ErrInvalid {
			t.Fatal("media framing", media)
		}
	}
	r := httptest.NewRequest("POST", "/", strings.NewReader(countBody))
	r.Header = http.Header{"Content-Type": []string{"application/json", "application/json"}}
	if _, err := decodeCountMutation(r, true); err != transfers.ErrInvalid {
		t.Fatal("duplicate media")
	}
	r.Header.Set("Content-Type", "application/json; charset=UTF-8")
	if _, err := decodeCountMutation(r, true); err != nil {
		t.Fatal("UTF-8 charset rejected")
	}
	r.Body = io.NopCloser(transferErrorReader{})
	if _, err := decodeCountMutation(r, true); err != transfers.ErrInvalid {
		t.Fatal("reader error")
	}
	if _, err := decodeCountMutation(nil, true); err != transfers.ErrInvalid {
		t.Fatal("nil request")
	}
}

func TestC3CountDTOExactWire(t *testing.T) {
	actual := int64(math.MaxInt64)
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 6, time.FixedZone("offset", 3600))
	op := transfers.CountOperation{OperationKey: "count-http-key-001", RequestID: math.MaxInt64, VariantID: math.MaxInt32, ActorLocationID: 3, Action: "propose", ExpectedRevision: math.MaxInt64 - 1, Actual: &actual, Reason: " exact ", Revision: math.MaxInt64, RecordedAt: stamp}
	snapshot := transfers.CountCorrections{RequestID: math.MaxInt64, Operations: []transfers.CountOperation{op}, Lines: []transfers.CountLineState{{VariantID: math.MaxInt32, ExpectedQuantity: math.MaxInt64, OriginalActual: math.MaxInt64, OriginalCredit: math.MaxInt64, WorkflowRevision: math.MaxInt64, AppliedRevision: math.MaxInt64, EffectiveActual: math.MaxInt64, EffectiveCredit: math.MaxInt64, Proposals: []transfers.CountProposal{{Revision: math.MaxInt64, Actual: math.MaxInt64, BaseRevision: math.MaxInt64 - 1, BaseCredit: math.MaxInt64, RecordedAt: stamp, Application: &transfers.CountApplication{EffectiveCredit: 0, Delta: -math.MaxInt64, RecordedAt: stamp}}}}}}
	body, err := json.Marshal(countSnapshotRecord(snapshot))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"request_id":"9223372036854775807"`, `"expected_revision":"9223372036854775806"`, `"actual_quantity":"9223372036854775807"`, `"delta":"-9223372036854775807"`, `"variant_id":2147483647`, `"actor_location_id":3`, `"decision":null`, `"recorded_at":"2026-01-02T02:04:05.000000006Z"`} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("missing exact wire member %s", want)
		}
	}
	op.Actual = nil
	encoded, _ := json.Marshal(countOperationRecord(op))
	if !strings.Contains(string(encoded), `"actual_quantity":null`) {
		t.Fatal("decision null omitted")
	}
	empty, _ := json.Marshal(countSnapshotRecord(transfers.CountCorrections{RequestID: 1}))
	if string(empty) != `{"request_id":"1","lines":[],"operations":[]}` {
		t.Fatal("empty arrays changed", string(empty))
	}
}
