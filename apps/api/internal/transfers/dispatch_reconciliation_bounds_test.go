package transfers_test

import (
	"math"
	"testing"

	"luson/api/internal/transfers"
)

func TestDR1NumericDeltaSums(t *testing.T) {
	ctx, p, s := fixture(t)
	a01Exec(t, ctx, p, `UPDATE inventory_balances SET existing=CASE WHEN location_id=1 THEN 9223372036854775807 ELSE 0 END WHERE variant_id=1 AND location_id IN (1,2)`)
	in := input()
	in.Items = []transfers.Line{{VariantID: 1, Quantity: 5}}
	r := receiptDispatch(t, ctx, s, in)
	var err error
	r, err = s.Receive(ctx, actor(2), r.ID, transfers.ReceiptInput{Items: []transfers.Line{{VariantID: 1, Quantity: math.MaxInt64}}})
	if err != nil {
		t.Fatal(err)
	}
	dr1Do(t, ctx, p, r, 1, "dr1-max-first-propose", "propose", 0, int64(math.MaxInt64))
	dr1Do(t, ctx, p, r, 2, "dr1-max-first-accept", "accept", 1, nil)
	dr1Balances(t, ctx, p, 0, math.MaxInt64)
	c2StorePropose(t, ctx, s, r, 1, 1, 0, 0, "dr1-max-zero-count-propose")
	c2StoreDecide(t, ctx, s, r, 2, 1, 1, true, "dr1-max-zero-count-accept")
	dr1Do(t, ctx, p, r, 2, "dr1-max-zero-propose", "propose", 1, 0)
	dr1Do(t, ctx, p, r, 1, "dr1-max-zero-accept", "accept", 2, nil)
	dr1Balances(t, ctx, p, math.MaxInt64, 0)
	c2StorePropose(t, ctx, s, r, 1, 1, 1, math.MaxInt64, "dr1-max-again-count-propose")
	c2StoreDecide(t, ctx, s, r, 2, 1, 2, true, "dr1-max-again-count-accept")
	dr1Do(t, ctx, p, r, 1, "dr1-max-again-propose", "propose", 2, int64(math.MaxInt64))
	dr1Do(t, ctx, p, r, 2, "dr1-max-again-accept", "accept", 3, nil)
	dr1Balances(t, ctx, p, 0, math.MaxInt64)
	// Reconciliation destination deltas alone now sum ABOVE bigint, but their
	// combination with original credit and all count deltas is exactly max.
	counts := c2StoreRead(t, ctx, s, r)
	if counts.Lines[0].EffectiveCredit != math.MaxInt64 || counts.Lines[0].ExpectedQuantity != 5 || counts.Lines[0].OriginalCredit != 5 {
		t.Fatal("cross-workflow numeric sum or immutable evidence changed")
	}
	if _, err := s.GetRestitutions(ctx, actor(2), r.ID); err != nil {
		t.Fatal("bigint-bound private history unreadable", err)
	}
}

func TestDR1NestedConsentEvidence(t *testing.T) {
	ctx, p, r := r2Receipt(t, 5, 7)
	dr1Do(t, ctx, p, r, 1, "dr1-consent-propose", "propose", 0, 7)
	dr1Do(t, ctx, p, r, 2, "dr1-consent-accept", "accept", 1, nil)
	// Matching trigger depth cannot turn an old decision operation into fresh
	// proposer consent. The FK alone permits this identity; durable validation
	// must reject it at commit and roll back the unrelated trigger too.
	a01Exec(t, ctx, p, `CREATE TABLE dr1_fake_consent(id bigint);
 CREATE FUNCTION dr1_fake_consent_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO transfer_dispatch_proposals SELECT request_id,variant_id,2,'dr1-consent-accept',2,7,5,7,5,0,0,2,'physical dispatch verified',recorded_at
 FROM transfer_dispatch_operations WHERE operation_key='dr1-consent-accept'; RETURN NEW; END $$;
 CREATE TRIGGER dr1_fake_consent_write AFTER INSERT ON dr1_fake_consent FOR EACH ROW EXECUTE FUNCTION dr1_fake_consent_write()`)
	dr1Refuse(t, ctx, p, r, "23514", `INSERT INTO dr1_fake_consent VALUES($1)`, r.ID)
}
