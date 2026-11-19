package httpapi_test

import (
	"testing"
)

// transferDocuments counts the transfer documents a fixture holds, so a refusal can be told apart
// from a refusal that still wrote its document.
func (f *t5Fixture) transferDocuments(t *testing.T) int {
	t.Helper()
	var documents int
	if err := f.p.QueryRow(f.ctx, `SELECT count(*) FROM transfer_requests`).Scan(&documents); err != nil {
		t.Fatalf("the transfer documents could not be counted: %v", err)
	}
	return documents
}

// TestTransfersHTTPRefusesATransferOfAFrozenBranch pins the refusal at the wire (S1, S2, S5): a
// branch held by an open account settlement is refused by PostgreSQL with LC001, and that refusal
// reaches the counter as 409 branch_frozen -- the code the administration already publishes for the
// same state -- instead of the 503 service_unavailable that told the operator to retry an outage that
// never happened. The document is refused whole, so the same request is admitted before the freeze
// and writes nothing during it.
func TestTransfersHTTPRefusesATransferOfAFrozenBranch(t *testing.T) {
	f := t5Setup(t)
	body := `{"kind":"request_stock","counterparty_location_id":1,"retry_key":"frozen-branch-request-001","items":[{"variant_id":1,"quantity":"1"}]}`
	if admitted := f.request(f.tokens[1], "POST", "/api/transfers", body); admitted.Code != 201 {
		t.Fatalf("the same request before the freeze must be admitted: %d %s", admitted.Code, admitted.Body.String())
	}
	f.freeze(2)
	before := f.transferDocuments(t)
	t5Error(t, f.request(f.tokens[1], "POST", "/api/transfers",
		`{"kind":"request_stock","counterparty_location_id":1,"retry_key":"frozen-branch-request-002","items":[{"variant_id":1,"quantity":"1"}]}`), 409, "branch_frozen")
	if after := f.transferDocuments(t); after != before {
		t.Fatalf("a refused transfer wrote a document: %d before, %d after", before, after)
	}
}
