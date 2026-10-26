package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"luson/api/internal/transfers"
)

const r4Proposal = `{"variant_id":1,"operation_key":"restitution-test-001","expected_revision":"0","retained_quantity":"1","retained_at_origin":true,"reason":"  retained ☃  "}`
const r4Decision = `{"variant_id":1,"operation_key":"restitution-test-002","expected_revision":"1","reason":"confirmed"}`

func r4Decode(body string, propose bool) (restitutionMutation, error) {
	r := httptest.NewRequest("POST", "/", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	return decodeRestitutionMutation(r, propose)
}

type r4ReadError struct{}

func (r4ReadError) Read([]byte) (int, error) { return 0, errors.New("private body failure") }
func (r4ReadError) Close() error             { return nil }

func TestR4RestitutionDecoder(t *testing.T) {
	t.Run("mandatory proposal preserves evidence", func(t *testing.T) {
		in, err := r4Decode(r4Proposal, true)
		if err != nil || in.VariantID != 1 || in.ExpectedRevision != 0 || in.RetainedQuantity != 1 || !in.RetainedAtOrigin || in.Reason != "  retained ☃  " {
			t.Fatal("valid explicit proposal rejected or changed")
		}
	})
	t.Run("mandatory decision", func(t *testing.T) {
		in, err := r4Decode(r4Decision, false)
		if err != nil || in.ExpectedRevision != 1 || in.RetainedQuantity != 0 || in.RetainedAtOrigin {
			t.Fatal("valid decision rejected or invented retention")
		}
	})
	for _, propose := range []bool{true, false} {
		body := r4Decision
		if propose {
			body = r4Proposal
		}
		var fields map[string]json.RawMessage
		if json.Unmarshal([]byte(body), &fields) != nil {
			t.Fatal("fixture")
		}
		for key := range fields {
			for _, null := range []bool{false, true} {
				copy := make(map[string]json.RawMessage)
				for k, v := range fields {
					copy[k] = v
				}
				if null {
					copy[key] = json.RawMessage("null")
				} else {
					delete(copy, key)
				}
				b, _ := json.Marshal(copy)
				if _, err := r4Decode(string(b), propose); !errors.Is(err, transfers.ErrInvalid) {
					t.Fatalf("missing/null %s admitted", key)
				}
			}
		}
	}
	cases := []string{
		"null", "[]", "true", "{}", r4Proposal + " {}", r4Proposal + "x",
		strings.Replace(r4Proposal, `"variant_id":1`, `"variant_id":1.0`, 1),
		strings.Replace(r4Proposal, `"variant_id":1`, `"variant_id":1e0`, 1),
		strings.Replace(r4Proposal, `"variant_id":1`, `"variant_id":"1"`, 1),
		strings.Replace(r4Proposal, `"variant_id":1`, `"variant_id":2147483648`, 1),
		strings.Replace(r4Proposal, `"variant_id":1`, `"variant_id":0`, 1),
		strings.Replace(r4Proposal, `"expected_revision":"0"`, `"expected_revision":0`, 1),
		strings.Replace(r4Proposal, `"expected_revision":"0"`, `"expected_revision":"00"`, 1),
		strings.Replace(r4Proposal, `"expected_revision":"0"`, `"expected_revision":"9223372036854775807"`, 1),
		strings.Replace(r4Proposal, `"retained_quantity":"1"`, `"retained_quantity":"0"`, 1),
		strings.Replace(r4Proposal, `"retained_quantity":"1"`, `"retained_quantity":"01"`, 1),
		strings.Replace(r4Proposal, `"retained_quantity":"1"`, `"retained_quantity":1`, 1),
		strings.Replace(r4Proposal, `"retained_quantity":"1"`, `"retained_quantity":"9223372036854775808"`, 1),
		strings.Replace(r4Proposal, `"retained_at_origin":true`, `"retained_at_origin":false`, 1),
		strings.Replace(r4Proposal, `"retained_at_origin":true`, `"retained_at_origin":"true"`, 1),
		strings.Replace(r4Proposal, `"reason":"  retained ☃  "`, `"reason":"   "`, 1),
		strings.Replace(r4Proposal, `"reason":"  retained ☃  "`, `"reason":"\u0000"`, 1),
		strings.Replace(r4Proposal, `"reason":"  retained ☃  "`, `"reason":true`, 1),
		strings.Replace(r4Proposal, `"reason":"  retained ☃  "`, `"reason":"`+strings.Repeat("☃", 2001)+`"`, 1),
		strings.Replace(r4Proposal, "☃", string([]byte{0xff}), 1),
		strings.Replace(r4Proposal, `"variant_id":1`, `"variant_id":1,"variant\u005fid":1`, 1),
	}
	for _, value := range []string{`"-1"`, `"+1"`, `"1.0"`, `"1e0"`, `" 1"`, `"1 "`, `""`, `true`, `[]`, `{}`} {
		cases = append(cases, strings.Replace(r4Proposal, `"retained_quantity":"1"`, `"retained_quantity":`+value, 1))
		cases = append(cases, strings.Replace(r4Proposal, `"expected_revision":"0"`, `"expected_revision":`+value, 1))
	}
	for _, key := range []string{strings.Repeat("a", 15), strings.Repeat("a", 129), "restitution key 001", "  restitution-key-001", "restitution-key-001 "} {
		value, _ := json.Marshal(key)
		cases = append(cases, strings.Replace(r4Proposal, `"restitution-test-001"`, string(value), 1))
	}
	for _, field := range []string{"actor_location_id", "action", "accept", "retained", "revision", "source_existing_after", "unknown"} {
		cases = append(cases, strings.TrimSuffix(r4Proposal, "}")+`,"`+field+`":true}`)
	}
	for i, body := range cases {
		if _, err := r4Decode(body, true); !errors.Is(err, transfers.ErrInvalid) {
			t.Fatalf("invalid case %d admitted", i)
		}
	}
	for _, field := range []string{`,"retained_quantity":"1"`, `,"retained_at_origin":true`, `,"action":"accept"`} {
		if _, err := r4Decode(strings.TrimSuffix(r4Decision, "}")+field+"}", false); err == nil {
			t.Fatal("decision expansion admitted")
		}
	}
	for _, typ := range []string{"", "text/json", "application/json; charset=latin1", "application/json; a=b", "application/json; charset=utf-8; charset=utf-8"} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(r4Proposal))
		r.Header.Set("Content-Type", typ)
		if _, err := decodeRestitutionMutation(r, true); err == nil {
			t.Fatal("bad content type admitted")
		}
	}
	r := httptest.NewRequest("POST", "/", strings.NewReader(r4Proposal))
	r.Header.Add("Content-Type", "application/json")
	r.Header.Add("Content-Type", "application/json")
	if _, err := decodeRestitutionMutation(r, true); err == nil {
		t.Fatal("duplicate content type")
	}
	for _, typ := range []string{"application/json", "application/json; charset=UTF-8"} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(r4Proposal))
		r.Header.Set("Content-Type", typ)
		if _, err := decodeRestitutionMutation(r, true); err != nil {
			t.Fatal("valid content type rejected")
		}
	}
	for _, size := range []int{64 << 10, (64 << 10) + 1} {
		body := r4Proposal + strings.Repeat(" ", size-len(r4Proposal))
		_, err := r4Decode(body, true)
		if (err == nil) != (size == 64<<10) {
			t.Fatal("body byte bound")
		}
	}
	r = httptest.NewRequest("POST", "/", nil)
	r.Header.Set("Content-Type", "application/json")
	r.Body = r4ReadError{}
	if _, err := decodeRestitutionMutation(r, true); err == nil {
		t.Fatal("read error admitted")
	}
	r.Body = io.NopCloser(strings.NewReader(""))
	if _, err := decodeRestitutionMutation(r, true); err == nil {
		t.Fatal("empty body admitted")
	}
	if _, err := decodeRestitutionMutation(nil, true); err == nil {
		t.Fatal("nil request admitted")
	}
	max := strings.Replace(r4Proposal, `"expected_revision":"0"`, `"expected_revision":"9223372036854775806"`, 1)
	max = strings.Replace(max, `"retained_quantity":"1"`, `"retained_quantity":"9223372036854775807"`, 1)
	if in, err := r4Decode(max, true); err != nil || in.RetainedQuantity != math.MaxInt64 || in.ExpectedRevision != math.MaxInt64-1 {
		t.Fatal("bigint bounds rejected")
	}
	for _, reason := range []string{"\t", "\u00a0", strings.Repeat("☃", 2000)} {
		b, _ := json.Marshal(reason)
		body := strings.Replace(r4Proposal, `"  retained ☃  "`, string(b), 1)
		if in, err := r4Decode(body, true); err != nil || in.Reason != reason {
			t.Fatal("reason validation broadened")
		}
	}
}

func r4Wire(t *testing.T, v any) map[string]json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal("DTO marshal")
	}
	var out map[string]json.RawMessage
	if json.Unmarshal(b, &out) != nil {
		t.Fatal("DTO object")
	}
	return out
}
func TestR4RestitutionDTOExactWire(t *testing.T) {
	n := int64(math.MaxInt64)
	yes := true
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 123456789, time.FixedZone("offset", 3600))
	op := transfers.RestitutionOperation{OperationKey: "restitution-wire-001", RequestID: n, VariantID: 2147483647, ActorLocationID: 1, Action: "accept", ExpectedRevision: n - 1, RetainedQuantity: &n, RetainedAtOrigin: &yes, Reason: "literal", Revision: n, SourceExistingBefore: &n, SourceExistingAfter: &n, RecordedAt: stamp}
	got := r4Wire(t, restitutionOperationRecord(op))
	want := map[string]string{"operation_key": `"restitution-wire-001"`, "request_id": `"9223372036854775807"`, "variant_id": `2147483647`, "actor_location_id": `1`, "action": `"accept"`, "expected_revision": `"9223372036854775806"`, "retained_quantity": `"9223372036854775807"`, "retained_at_origin": `true`, "reason": `"literal"`, "revision": `"9223372036854775807"`, "source_existing_before": `"9223372036854775807"`, "source_existing_after": `"9223372036854775807"`, "recorded_at": `"2026-01-02T02:04:05.123456789Z"`}
	if len(got) != len(want) {
		t.Fatal("operation must expose exactly all 13 persisted fields")
	}
	for k, v := range want {
		if string(got[k]) != v {
			t.Fatalf("operation %s wire", k)
		}
	}
	op.RetainedQuantity = nil
	op.RetainedAtOrigin = nil
	op.SourceExistingBefore = nil
	op.SourceExistingAfter = nil
	got = r4Wire(t, restitutionOperationRecord(op))
	for _, k := range []string{"retained_quantity", "retained_at_origin", "source_existing_before", "source_existing_after"} {
		if string(got[k]) != "null" {
			t.Fatal("nullable operation evidence omitted")
		}
	}
	root := r4Wire(t, restitutionSnapshotRecord(transfers.Restitutions{RequestID: n}))
	if len(root) != 3 || string(root["lines"]) != "[]" || string(root["operations"]) != "[]" || string(root["request_id"]) != `"9223372036854775807"` {
		t.Fatal("root empty arrays or bigint wire")
	}
	p := transfers.RestitutionProposal{Revision: n, OperationKey: "p", InitiatorLocationID: 1, RetainedQuantity: n, RetainedAtOrigin: true, BaseRevision: n - 1, CountGeneration: n, CountAppliedRevision: n - 1, BaseCredit: n, BaseRestitution: n, BaseDispatch: n, Reason: "  evidence  ", RecordedAt: stamp, State: "applied", Decision: &transfers.RestitutionDecision{OperationKey: "d", ActorLocationID: 2, Accepted: true, Reason: "confirmed", RecordedAt: stamp}, Application: &transfers.RestitutionApplication{OperationKey: "d", OriginLocationID: 1, Quantity: n, RecordedAt: stamp}}
	line := transfers.RestitutionLineState{VariantID: 1, ExpectedQuantity: n, OriginalCredit: n, WorkflowRevision: n, AppliedRevision: n, CountGeneration: n, CountAppliedRevision: n, EffectiveCredit: n, EffectiveDispatch: n, ReconciliationRevision: n, AppliedRetainedQuantity: n, Proposals: []transfers.RestitutionProposal{p}}
	root = r4Wire(t, restitutionSnapshotRecord(transfers.Restitutions{RequestID: n, Lines: []transfers.RestitutionLineState{line}, Operations: []transfers.RestitutionOperation{op}}))
	var lines []map[string]json.RawMessage
	if json.Unmarshal(root["lines"], &lines) != nil || len(lines) != 1 || len(lines[0]) != 12 {
		t.Fatal("complete line contract")
	}
	for k, v := range lines[0] {
		if k != "variant_id" && k != "proposals" && string(v) != `"9223372036854775807"` {
			t.Fatalf("line %s bigint", k)
		}
	}
	var ps []map[string]json.RawMessage
	if json.Unmarshal(lines[0]["proposals"], &ps) != nil || len(ps[0]) != 16 {
		t.Fatal("complete proposal contract")
	}
	for _, k := range []string{"base_revision", "count_applied_revision"} {
		if string(ps[0][k]) != `"9223372036854775806"` {
			t.Fatal("predecessor pins")
		}
	}
	for _, k := range []string{"revision", "retained_quantity", "count_generation", "base_credit", "base_restitution", "base_dispatch"} {
		if string(ps[0][k]) != `"9223372036854775807"` {
			t.Fatal("proposal bigint")
		}
	}
	if string(ps[0]["retained_at_origin"]) != "true" || string(ps[0]["reason"]) != `"  evidence  "` || string(ps[0]["recorded_at"]) != `"2026-01-02T02:04:05.123456789Z"` {
		t.Fatal("proposal literal evidence")
	}
	var decision map[string]json.RawMessage
	if json.Unmarshal(ps[0]["decision"], &decision) != nil || len(decision) != 5 || string(decision["operation_key"]) != `"d"` || string(decision["actor_location_id"]) != "2" || string(decision["accepted"]) != "true" || string(decision["reason"]) != `"confirmed"` || string(decision["recorded_at"]) != `"2026-01-02T02:04:05.123456789Z"` {
		t.Fatal("decision complete exact wire")
	}
	var app map[string]json.RawMessage
	if json.Unmarshal(ps[0]["application"], &app) != nil || len(app) != 4 || string(app["quantity"]) != `"9223372036854775807"` {
		t.Fatal("application complete wire")
	}
	if string(app["operation_key"]) != `"d"` || string(app["origin_location_id"]) != "1" || string(app["recorded_at"]) != `"2026-01-02T02:04:05.123456789Z"` {
		t.Fatal("application exact wire")
	}
	empty := r4Wire(t, restitutionSnapshotRecord(transfers.Restitutions{Lines: []transfers.RestitutionLineState{{VariantID: 1}}}))
	var emptyLines []map[string]json.RawMessage
	if json.Unmarshal(empty["lines"], &emptyLines) != nil || string(emptyLines[0]["proposals"]) != "[]" {
		t.Fatal("line proposals must never be null")
	}
	p.Decision = nil
	p.Application = nil
	line.Proposals = []transfers.RestitutionProposal{p}
	one := restitutionSnapshotRecord(transfers.Restitutions{Lines: []transfers.RestitutionLineState{line}})
	two := restitutionSnapshotRecord(transfers.Restitutions{Lines: []transfers.RestitutionLineState{line}})
	if !reflect.DeepEqual(one, two) {
		t.Fatal("unstable wire")
	}
	b, _ := json.Marshal(one)
	if !strings.Contains(string(b), `"decision":null`) || !strings.Contains(string(b), `"application":null`) {
		t.Fatal("proposal null evidence")
	}
}
