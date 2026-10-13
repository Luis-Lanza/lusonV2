package transfers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestR3RestitutionValidation(t *testing.T) {
	q, yes, no := int64(1), true, false
	key := "r3-valid-operation"
	for _, action := range []string{"accept", "reject"} {
		if !validRestitutionInput(1, key, action, 1, nil, nil, " reason ") {
			t.Fatal("valid nullable decision rejected")
		}
	}
	if !validRestitutionInput(1, key, "propose", 0, &q, &yes, " reason ") {
		t.Fatal("valid explicit proposal rejected")
	}
	cases := []struct {
		name        string
		variant     int64
		key, action string
		revision    int64
		q           *int64
		att         *bool
		reason      string
	}{
		{"variant zero", 0, key, "propose", 0, &q, &yes, "r"},
		{"variant overflow", math.MaxInt32 + 1, key, "propose", 0, &q, &yes, "r"},
		{"short key", 1, "short", "propose", 0, &q, &yes, "r"},
		{"long key", 1, strings.Repeat("x", 129), "propose", 0, &q, &yes, "r"},
		{"key whitespace", 1, key + " ", "propose", 0, &q, &yes, "r"},
		{"negative revision", 1, key, "propose", -1, &q, &yes, "r"},
		{"revision overflow", 1, key, "propose", math.MaxInt64, &q, &yes, "r"},
		{"unknown action", 1, key, "apply", 0, &q, &yes, "r"},
		{"missing quantity", 1, key, "propose", 0, nil, &yes, "r"},
		{"missing attestation", 1, key, "propose", 0, &q, nil, "r"},
		{"false attestation", 1, key, "propose", 0, &q, &no, "r"},
		{"decision quantity", 1, key, "accept", 1, &q, nil, "r"},
		{"decision attestation", 1, key, "reject", 1, nil, &yes, "r"},
		{"empty reason", 1, key, "propose", 0, &q, &yes, "   "},
		{"nul reason", 1, key, "propose", 0, &q, &yes, "a\x00b"},
		{"invalid utf8", 1, key, "propose", 0, &q, &yes, string([]byte{255})},
		{"long reason", 1, key, "propose", 0, &q, &yes, strings.Repeat("é", 2001)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if validRestitutionInput(c.variant, c.key, c.action, c.revision, c.q, c.att, c.reason) {
				t.Fatal("invalid payload admitted")
			}
		})
	}
	for _, n := range []int64{0, -1, math.MinInt64} {
		if validRestitutionInput(1, key, "propose", 0, &n, &yes, "r") {
			t.Fatal("nonpositive admitted")
		}
	}
	for _, reason := range []string{"\t", "\n", "\u00a0", "  " + strings.Repeat("é", 2000) + "  "} {
		if !validRestitutionInput(1, key, "propose", 0, &q, &yes, reason) {
			t.Fatal("ASCII trim/rune contract changed")
		}
	}
	q = math.MaxInt64
	if !validRestitutionInput(math.MaxInt32, strings.Repeat("_", 128), "propose", math.MaxInt64-1, &q, &yes, "r") {
		t.Fatal("valid bounds rejected")
	}
}

func TestR3RestitutionHistoryValidation(t *testing.T) {
	stamp := time.Date(2026, 10, 12, 8, 0, 0, 0, time.FixedZone("offset", 3600))
	q, yes, before, after := int64(1), true, int64(5), int64(6)
	proposal := RestitutionProposal{Revision: 1, OperationKey: "r3-history-proposal", InitiatorLocationID: 1, RetainedQuantity: 1, RetainedAtOrigin: true, BaseCredit: 4, Reason: "verified", RecordedAt: stamp, State: "applied", Decision: &RestitutionDecision{OperationKey: "r3-history-accept-key", ActorLocationID: 2, Accepted: true, Reason: "accepted", RecordedAt: stamp.Add(time.Second)}, Application: &RestitutionApplication{OperationKey: "r3-history-accept-key", OriginLocationID: 1, Quantity: 1, RecordedAt: stamp.Add(time.Second)}}
	lines := []RestitutionLineState{{VariantID: 1, ExpectedQuantity: 5, OriginalCredit: 4, EffectiveCredit: 4, WorkflowRevision: 1, AppliedRevision: 1, AppliedRetainedQuantity: 1, Proposals: []RestitutionProposal{proposal}}}
	ops := []RestitutionOperation{{OperationKey: proposal.OperationKey, RequestID: 7, VariantID: 1, ActorLocationID: 1, Action: "propose", RetainedQuantity: &q, RetainedAtOrigin: &yes, Reason: "verified", Revision: 1, RecordedAt: stamp}, {OperationKey: "r3-history-accept-key", RequestID: 7, VariantID: 1, ActorLocationID: 2, Action: "accept", ExpectedRevision: 1, Reason: "accepted", Revision: 1, SourceExistingBefore: &before, SourceExistingAfter: &after, RecordedAt: stamp.Add(time.Second)}}
	lb, _ := json.Marshal(lines)
	ob, _ := json.Marshal(ops)
	got, err := decodeRestitutionHistory(7, 1, 2, lb, ob)
	if err != nil {
		t.Fatal("valid committed snapshot", err)
	}
	if got.Operations[0].RecordedAt.Location() != time.UTC || got.Lines[0].Proposals[0].RecordedAt.Location() != time.UTC || got.Lines[0].Proposals[0].Decision.RecordedAt.Location() != time.UTC || got.Lines[0].Proposals[0].Application.RecordedAt.Location() != time.UTC {
		t.Fatal("history UTC normalization")
	}
	t.Run("proposal after application", func(t *testing.T) {
		// SQL owns the one-application rule; recovery must still fail closed if a
		// damaged snapshot claims a later proposal exists after successful credit.
		corruptLines := append([]RestitutionLineState(nil), lines...)
		later := proposal
		later.Revision = 2
		later.BaseRevision = 1
		later.OperationKey = "r3-impossible-later-proposal"
		later.State = "pending"
		later.Decision = nil
		later.Application = nil
		corruptLines[0].WorkflowRevision = 2
		corruptLines[0].Proposals = append(append([]RestitutionProposal(nil), lines[0].Proposals...), later)
		corruptOps := append([]RestitutionOperation(nil), ops...)
		extra := ops[0]
		extra.OperationKey = later.OperationKey
		extra.ExpectedRevision = 1
		extra.Revision = 2
		corruptOps = append(corruptOps, extra)
		l, _ := json.Marshal(corruptLines)
		o, _ := json.Marshal(corruptOps)
		if _, e := decodeRestitutionHistory(7, 1, 2, l, o); !errors.Is(e, ErrReadUnavailable) {
			t.Fatal("post-application proposal did not fail closed")
		}
	})
	empty := []RestitutionLineState{{VariantID: 1, ExpectedQuantity: 5, OriginalCredit: 4, EffectiveCredit: 4, Proposals: []RestitutionProposal{}}}
	eb, _ := json.Marshal(empty)
	if _, e := decodeRestitutionHistory(7, 1, 2, eb, []byte("[]")); e != nil {
		t.Fatal("nonnull empty arrays", e)
	}
	for _, c := range []struct {
		name       string
		lines, ops []byte
	}{
		{"malformed", []byte("{"), ob}, {"null lines", []byte("null"), ob}, {"null operations", lb, []byte("null")}, {"empty lines", []byte("[]"), ob},
		{"null proposal array", []byte(strings.Replace(string(eb), "\"proposals\":[]", "\"proposals\":null", 1)), []byte("[]")},
		{"missing zero pin", []byte(strings.Replace(string(lb), "\"count_generation\":0,", "", 1)), ob},
		{"unknown field", []byte(strings.Replace(string(lb), "\"base_credit\":4", "\"unknown\":4", 1)), ob},
		{"wrong state", []byte(strings.Replace(string(lb), "\"state\":\"applied\"", "\"state\":\"pending\"", 1)), ob},
		{"fabricated retention", []byte(strings.Replace(string(lb), "\"retained_at_origin\":true", "\"retained_at_origin\":false", 1)), ob},
		{"wrong credit", []byte(strings.Replace(string(lb), "\"effective_credit\":4", "\"effective_credit\":5", 1)), ob},
		{"wrong origin", []byte(strings.Replace(string(lb), "\"origin_location_id\":1", "\"origin_location_id\":2", 1)), ob},
		{"wrong delta", lb, []byte(strings.Replace(string(ob), "\"source_existing_after\":6", "\"source_existing_after\":7", 1))},
		{"wrong request", lb, []byte(strings.Replace(string(ob), "\"request_id\":7", "\"request_id\":8", 1))},
		{"missing operations", lb, []byte("[]")},
		{"duplicate operation", lb, []byte(string(ob[:len(ob)-1]) + "," + string(ob[1:]))},
		{"bad timestamp", lb, []byte(strings.Replace(string(ob), stamp.Format(time.RFC3339), "bad", 1))},
	} {
		t.Run(c.name, func(t *testing.T) {
			out, e := decodeRestitutionHistory(7, 1, 2, c.lines, c.ops)
			if !errors.Is(e, ErrReadUnavailable) || out.RequestID != 0 || out.Lines != nil || out.Operations != nil {
				t.Fatal("malformed snapshot did not fail closed", e)
			}
		})
	}
}

func TestR3RestitutionHistoryValidationCountPins(t *testing.T) {
	stamp := time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC)
	quantity, attested := int64(1), true
	decode := func(t *testing.T, line RestitutionLineState, ops []RestitutionOperation) (Restitutions, error) {
		t.Helper()
		linesJSON, err := json.Marshal([]RestitutionLineState{line})
		if err != nil {
			t.Fatal(err)
		}
		opsJSON, err := json.Marshal(ops)
		if err != nil {
			t.Fatal(err)
		}
		return decodeRestitutionHistory(7, 1, 2, linesJSON, opsJSON)
	}
	for _, tc := range []struct {
		name                                            string
		generation, applied, credit                     int64
		proposal                                        bool
		proposalGeneration, proposalApplied, baseCredit int64
		corrupt                                         string
	}{
		{name: "zero applied pin rejects changed credit", credit: 4, corrupt: "effective credit"},
		{name: "historical proposal rejects future applied pin", generation: 2, credit: 4, proposal: true, proposalGeneration: 2, baseCredit: 4, corrupt: "proposal applied pin"},
		{name: "zero applied unchanged credit", credit: 4},
		{name: "generation gap without application", generation: 3, credit: 4, proposal: true, proposalGeneration: 3, baseCredit: 4},
		{name: "changed credit with positive applied pin and older proposal", generation: 4, applied: 2, credit: 3, proposal: true, proposalGeneration: 2, proposalApplied: 1, baseCredit: 4},
		{name: "proposal applied pin equals current pin", generation: 3, applied: 1, credit: 3, proposal: true, proposalGeneration: 2, proposalApplied: 1, baseCredit: 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			line := RestitutionLineState{VariantID: 1, ExpectedQuantity: 5, OriginalCredit: 4, EffectiveCredit: tc.credit, CountGeneration: tc.generation, CountAppliedRevision: tc.applied, Proposals: []RestitutionProposal{}}
			ops := []RestitutionOperation{}
			if tc.proposal {
				line.WorkflowRevision = 1
				line.Proposals = []RestitutionProposal{{Revision: 1, OperationKey: "r3-count-pin-proposal", InitiatorLocationID: 1, RetainedQuantity: quantity, RetainedAtOrigin: attested, CountGeneration: tc.proposalGeneration, CountAppliedRevision: tc.proposalApplied, BaseCredit: tc.baseCredit, Reason: " retained verified ", RecordedAt: stamp, State: "pending"}}
				ops = []RestitutionOperation{{OperationKey: "r3-count-pin-proposal", RequestID: 7, VariantID: 1, ActorLocationID: 1, Action: "propose", RetainedQuantity: &quantity, RetainedAtOrigin: &attested, Reason: " retained verified ", Revision: 1, RecordedAt: stamp}}
			}
			// The unmodified sibling proves admission and evidence coherence before
			// each single-field corruption exercises its specific missing check.
			out, err := decode(t, line, ops)
			if err != nil || out.RequestID != 7 || out.Lines[0].EffectiveCredit != tc.credit || out.Lines[0].CountAppliedRevision != tc.applied {
				t.Fatal("coherent count-pin control rejected", err)
			}
			switch tc.corrupt {
			case "effective credit":
				line.EffectiveCredit = 3
			case "proposal applied pin":
				line.Proposals[0].CountAppliedRevision = 1
			default:
				return
			}
			out, err = decode(t, line, ops)
			if !errors.Is(err, ErrReadUnavailable) || out.RequestID != 0 || out.Lines != nil || out.Operations != nil {
				t.Fatal("inconsistent count-pin snapshot did not fail closed", err)
			}
		})
	}
}

func TestR3RestitutionError(t *testing.T) {
	groups := []struct {
		code     string
		messages []string
		want     error
	}{
		{"42501", []string{"Restitution endpoint unauthorized", "Restitution requires a physical endpoint of a received transfer", "Only origin may attest retained stock", "Only exact destination may decide restitution"}, ErrForbidden},
		{"23505", []string{"Restitution operation identity conflicts"}, ErrRetryConflict},
		{"23514", []string{"Restitution requires an expected received line", "Restitution requires explicit positive retention attestation", "Invalid restitution action"}, ErrInvalid},
		{"23514", []string{"Stale restitution revision", "Restitution blocked by pending count proposal", "Restitution already applied", "Restitution exceeds outstanding debit", "Restitution decision is terminal or payload invalid", "Restitution predecessor changed"}, ErrDecisionConflict},
		{"23514", []string{"Restitution requires covered nonoverflowing origin stock"}, ErrInsufficientStock},
		{"23514", []string{"Restitution evidence is operation owned", "Restitution application requires operation credit and accepted attestation", "transfer_restitution_operations_check", "unknown"}, ErrUnavailable},
		{"23505", []string{"Use restitution entrypoint for durable replay", "unknown"}, ErrUnavailable},
		{"42501", []string{"unknown"}, ErrUnavailable},
		{"25000", []string{"Restitutions require READ COMMITTED"}, ErrUnavailable},
	}
	for _, g := range groups {
		for _, message := range g.messages {
			t.Run(message, func(t *testing.T) {
				e := fmt.Errorf("wrapped: %w", &pgconn.PgError{Code: g.code, Message: message})
				if got := restitutionError(context.Background(), e); !errors.Is(got, g.want) {
					t.Fatalf("got %v want %v", got, g.want)
				}
				if got := restitutionError(context.Background(), &pgconn.PgError{Code: "XX000", Message: message}); !errors.Is(got, ErrUnavailable) {
					t.Fatal("unknown code mapped")
				}
			})
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if !errors.Is(restitutionError(ctx, errors.New("private driver detail")), context.Canceled) {
		t.Fatal("cancellation lost")
	}
	if !errors.Is(restitutionError(context.Background(), errors.New("private driver detail")), ErrUnavailable) {
		t.Fatal("driver error leaked")
	}
	if !errors.Is(countError(context.Background(), &pgconn.PgError{Code: "23514", Message: "Correction exceeds debit after restitution"}), ErrDecisionConflict) {
		t.Fatal("conservation mapping missing")
	}
}
