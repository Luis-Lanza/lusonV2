package transfers

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"luson/api/internal/auth"
)

// Count inputs never contain an actor or client-computed credit. OperationKey is
// a global durable identity: retain the entire input for uncertain-write retries.
type CountProposalInput struct {
	VariantID        int64
	OperationKey     string
	ExpectedRevision int64
	Actual           int64
	Reason           string
}
type CountDecisionInput struct {
	VariantID        int64
	OperationKey     string
	ExpectedRevision int64
	Accept           bool
	Reason           string
}
type CountOperation struct {
	OperationKey     string    `json:"operation_key"`
	RequestID        int64     `json:"request_id"`
	VariantID        int64     `json:"variant_id"`
	ActorLocationID  int       `json:"actor_location_id"`
	Action           string    `json:"action"`
	ExpectedRevision int64     `json:"expected_revision"`
	Actual           *int64    `json:"actual_quantity"`
	Reason           string    `json:"reason"`
	Revision         int64     `json:"revision"`
	RecordedAt       time.Time `json:"recorded_at"`
}
type CountDecision struct {
	OperationKey    string    `json:"operation_key"`
	ActorLocationID int       `json:"actor_location_id"`
	Accepted        bool      `json:"accepted"`
	Reason          string    `json:"reason"`
	RecordedAt      time.Time `json:"recorded_at"`
}
type CountApplication struct {
	EffectiveCredit int64     `json:"effective_credit"`
	Delta           int64     `json:"delta"`
	RecordedAt      time.Time `json:"recorded_at"`
}
type CountProposal struct {
	Revision            int64     `json:"revision"`
	OperationKey        string    `json:"operation_key"`
	InitiatorLocationID int       `json:"initiator_location_id"`
	Actual              int64     `json:"actual_quantity"`
	BaseRevision        int64     `json:"base_revision"`
	BaseCredit          int64     `json:"base_credit"`
	Reason              string    `json:"reason"`
	RecordedAt          time.Time `json:"recorded_at"`
	// State distinguishes supersession and rejection from applied agreement.
	State       string            `json:"state"`
	Decision    *CountDecision    `json:"decision"`
	Application *CountApplication `json:"application"`
}
type CountLineState struct {
	EffectiveDispatch      int64           `json:"effective_dispatch"`
	ReconciliationRevision int64           `json:"reconciliation_revision"`
	VariantID              int64           `json:"variant_id"`
	ExpectedQuantity       int64           `json:"expected_quantity"`
	OriginalActual         int64           `json:"actual_quantity"`
	OriginalCredit         int64           `json:"available_quantity"`
	WorkflowRevision       int64           `json:"workflow_revision"`
	AppliedRevision        int64           `json:"applied_revision"`
	EffectiveActual        int64           `json:"effective_actual"`
	EffectiveCredit        int64           `json:"effective_credit"`
	Proposals              []CountProposal `json:"proposals"`
}
type CountCorrections struct {
	RequestID  int64
	Lines      []CountLineState
	Operations []CountOperation
}

func (s *Store) ProposeCount(ctx context.Context, actor auth.Identity, id int64, in CountProposalInput) (CountOperation, error) {
	actual := in.Actual // Copy caller input; do not trim accepted reason semantics.
	return s.correctCount(ctx, actor, id, in.VariantID, in.OperationKey, "propose", in.ExpectedRevision, &actual, in.Reason)
}
func (s *Store) DecideCount(ctx context.Context, actor auth.Identity, id int64, in CountDecisionInput) (CountOperation, error) {
	action := "reject"
	if in.Accept {
		action = "accept"
	}
	return s.correctCount(ctx, actor, id, in.VariantID, in.OperationKey, action, in.ExpectedRevision, nil, in.Reason)
}

func validCountInput(variant int64, key string, revision int64, actual *int64, reason string) bool {
	return variant > 0 && variant <= math.MaxInt32 && retryKeyPattern.MatchString(key) &&
		revision >= 0 && revision < math.MaxInt64 && (actual == nil || *actual >= 0) &&
		utf8.ValidString(reason) && !strings.ContainsRune(reason, 0) &&
		utf8.RuneCountInString(strings.Trim(reason, " ")) >= 1 && utf8.RuneCountInString(strings.Trim(reason, " ")) <= 2000
}

func (s *Store) correctCount(ctx context.Context, actor auth.Identity, id, variant int64, key, action string, revision int64, actual *int64, reason string) (CountOperation, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return CountOperation{}, ErrUnavailable
	}
	if !assigned(actor) {
		return CountOperation{}, ErrForbidden
	}
	if id < 1 {
		return CountOperation{}, ErrNotFound
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := checkAssignment(ctx, s.pool, actor); err != nil {
		return CountOperation{}, err
	}
	tx, err := s.beginPersonal(ctx, actor)
	if err != nil {
		return CountOperation{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	// Authorize physical participation before even validating retry identity.
	// The SQL entrypoint repeats authorization under its shared lock, owns all
	// effects, and keeps database owners' administrative authority explicit.
	var status string
	err = tx.QueryRow(ctx, `SELECT status FROM transfer_requests WHERE id=$1 AND $2 IN (origin_location_id,destination_location_id)`, id, actor.Location.ID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return CountOperation{}, ErrNotFound
	}
	if err != nil {
		return CountOperation{}, fail(ctx)
	}
	if status != "received" {
		return CountOperation{}, ErrDecisionConflict
	}
	if !validCountInput(variant, key, revision, actual, reason) {
		return CountOperation{}, ErrInvalid
	}
	var op CountOperation
	err = tx.QueryRow(ctx, `SELECT operation_key,request_id,variant_id,actor_location_id,action,expected_revision,actual_quantity,reason,revision,recorded_at
 FROM transfer_count_correct($1,$2::integer,$3::smallint,$4,$5,$6,$7,$8)`, id, variant, actor.Location.ID, key, action, revision, actual, reason).Scan(
		&op.OperationKey, &op.RequestID, &op.VariantID, &op.ActorLocationID, &op.Action, &op.ExpectedRevision, &op.Actual, &op.Reason, &op.Revision, &op.RecordedAt)
	if err != nil {
		return CountOperation{}, countError(ctx, err)
	}
	if err = tx.Commit(ctx); err != nil {
		return CountOperation{}, fail(ctx)
	}
	op.RecordedAt = op.RecordedAt.UTC()
	return op, nil
}

// Only known correction failures become domain conflicts. Unknown constraints,
// isolation mistakes (25000), and operational failures remain unavailable; no
// SQL text, private reason, or driver details cross the Store boundary.
func countError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var p *pgconn.PgError
	if !errors.As(err, &p) {
		return fail(ctx)
	}
	switch p.Code {
	case "42501":
		if p.Message == "Correction endpoint unauthorized" || p.Message == "Correction requires a physical endpoint of a received transfer" || p.Message == "Only initiator may replace a pending proposal" || p.Message == "Only exact counterparty may decide" {
			return ErrForbidden
		}
	case "23505":
		if p.Message == "Correction operation identity conflicts" {
			return ErrRetryConflict
		}
	case "23514":
		switch p.Message {
		case "Correction requires persisted receipt membership", "Corrected count must be nonnegative", "Invalid correction action":
			return ErrInvalid
		case "Stale correction revision", "Decision revision is terminal or payload invalid", "Correction predecessor changed", "Correction exceeds debit after restitution":
			return ErrDecisionConflict
		case "Correction requires covered nonoverflowing destination stock":
			return ErrInsufficientStock
		}
	case "25000":
		return ErrUnavailable
	}
	return fail(ctx)
}

// GetCountCorrections uses one statement snapshot, not several READ COMMITTED
// reads that could combine an old workflow head with a new applied revision.
// Original receipt columns stay separate from effective and workflow state.
func (s *Store) GetCountCorrections(ctx context.Context, actor auth.Identity, id int64) (CountCorrections, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return CountCorrections{}, ErrUnavailable
	}
	if !assigned(actor) {
		return CountCorrections{}, ErrForbidden
	}
	if id < 1 {
		return CountCorrections{}, ErrNotFound
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := checkAssignment(ctx, s.pool, actor); err != nil {
		return CountCorrections{}, err
	}
	var lines, operations []byte
	var status string
	err := s.pool.QueryRow(ctx, countSnapshotSQL, id, actor.Location.ID).Scan(&status, &lines, &operations)
	if errors.Is(err, pgx.ErrNoRows) {
		return CountCorrections{}, ErrNotFound
	}
	if err != nil {
		return CountCorrections{}, fail(ctx)
	}
	if status != "received" {
		return CountCorrections{}, ErrDecisionConflict
	}
	out := CountCorrections{RequestID: id}
	if json.Unmarshal(lines, &out.Lines) != nil || json.Unmarshal(operations, &out.Operations) != nil {
		return CountCorrections{}, ErrUnavailable
	}
	for i := range out.Operations {
		out.Operations[i].RecordedAt = out.Operations[i].RecordedAt.UTC()
	}
	for i := range out.Lines {
		for j := range out.Lines[i].Proposals {
			p := &out.Lines[i].Proposals[j]
			p.RecordedAt = p.RecordedAt.UTC()
			if p.Decision != nil {
				p.Decision.RecordedAt = p.Decision.RecordedAt.UTC()
			}
			if p.Application != nil {
				p.Application.RecordedAt = p.Application.RecordedAt.UTC()
			}
		}
	}
	return out, nil
}

const countSnapshotSQL = `SELECT h.status,
 COALESCE((SELECT jsonb_agg(to_jsonb(line) ORDER BY variant_id) FROM (
 SELECT r.*, COALESCE(latest.revision,0) AS workflow_revision,
 COALESCE(applied.revision,0) AS applied_revision,
 COALESCE(effective.actual_quantity,r.actual_quantity) AS effective_actual,
 state.credit AS effective_credit, state.dispatch AS effective_dispatch,
 state.reconciliation_revision AS reconciliation_revision,
 COALESCE((SELECT jsonb_agg(to_jsonb(history) ORDER BY revision) FROM (
   SELECT p.*, to_jsonb(d) AS decision, to_jsonb(a) AS application,
   CASE WHEN d.accepted THEN 'applied' WHEN d.accepted=false THEN 'rejected'
        WHEN p.revision=latest.revision THEN 'pending' ELSE 'superseded' END AS state
   FROM transfer_count_proposals p
   LEFT JOIN transfer_count_decisions d USING(request_id,variant_id,revision)
   LEFT JOIN transfer_count_applications a USING(request_id,variant_id,revision)
   WHERE p.request_id=r.request_id AND p.variant_id=r.variant_id
 ) history),'[]'::jsonb) AS proposals
 FROM transfer_receipt_lines r
 CROSS JOIN LATERAL transfer_effective_line(r.request_id,r.variant_id) state
 LEFT JOIN LATERAL (SELECT revision FROM transfer_count_proposals p WHERE p.request_id=r.request_id AND p.variant_id=r.variant_id ORDER BY revision DESC LIMIT 1) latest ON true
 LEFT JOIN LATERAL (SELECT a.* FROM transfer_count_applications a WHERE a.request_id=r.request_id AND a.variant_id=r.variant_id ORDER BY revision DESC LIMIT 1) applied ON true
 LEFT JOIN transfer_count_proposals effective ON (effective.request_id,effective.variant_id,effective.revision)=(applied.request_id,applied.variant_id,applied.revision)
 WHERE r.request_id=h.id
 ) line),'[]'::jsonb),
 COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY revision,variant_id,recorded_at,operation_key) FROM transfer_count_operations o WHERE o.request_id=h.id),'[]'::jsonb)
 FROM transfer_requests h WHERE h.id=$1 AND $2 IN(h.origin_location_id,h.destination_location_id)`
