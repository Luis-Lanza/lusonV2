package transfers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"luson/api/internal/auth"
)

// ErrReadUnavailable shares the existing Store error identity; no database
// details or malformed private evidence escape through the read boundary.
var ErrReadUnavailable = ErrUnavailable

type RestitutionProposalInput struct {
	VariantID        int64
	OperationKey     string
	ExpectedRevision int64
	RetainedQuantity int64
	RetainedAtOrigin bool
	Reason           string
}
type RestitutionDecisionInput struct {
	VariantID        int64
	OperationKey     string
	ExpectedRevision int64
	Accept           bool
	Reason           string
}

// RestitutionOperation is the immutable committed retry result, including the
// original source stock snapshots (not today's inventory).
type RestitutionOperation struct {
	OperationKey         string    `json:"operation_key"`
	RequestID            int64     `json:"request_id"`
	VariantID            int64     `json:"variant_id"`
	ActorLocationID      int       `json:"actor_location_id"`
	Action               string    `json:"action"`
	ExpectedRevision     int64     `json:"expected_revision"`
	RetainedQuantity     *int64    `json:"retained_quantity"`
	RetainedAtOrigin     *bool     `json:"retained_at_origin"`
	Reason               string    `json:"reason"`
	Revision             int64     `json:"revision"`
	SourceExistingBefore *int64    `json:"source_existing_before"`
	SourceExistingAfter  *int64    `json:"source_existing_after"`
	RecordedAt           time.Time `json:"recorded_at"`
}
type RestitutionDecision struct {
	OperationKey    string    `json:"operation_key"`
	ActorLocationID int       `json:"actor_location_id"`
	Accepted        bool      `json:"accepted"`
	Reason          string    `json:"reason"`
	RecordedAt      time.Time `json:"recorded_at"`
}
type RestitutionApplication struct {
	OperationKey     string    `json:"operation_key"`
	OriginLocationID int       `json:"origin_location_id"`
	Quantity         int64     `json:"quantity"`
	RecordedAt       time.Time `json:"recorded_at"`
}
type RestitutionProposal struct {
	// Populated only from validated companion evidence, never the legacy JSON.
	BaseDispatch         int64                   `json:"-"`
	Revision             int64                   `json:"revision"`
	OperationKey         string                  `json:"operation_key"`
	InitiatorLocationID  int                     `json:"initiator_location_id"`
	RetainedQuantity     int64                   `json:"retained_quantity"`
	RetainedAtOrigin     bool                    `json:"retained_at_origin"`
	BaseRevision         int64                   `json:"base_revision"`
	CountGeneration      int64                   `json:"count_generation"`
	CountAppliedRevision int64                   `json:"count_applied_revision"`
	BaseCredit           int64                   `json:"base_credit"`
	BaseRestitution      int64                   `json:"base_restitution"`
	Reason               string                  `json:"reason"`
	RecordedAt           time.Time               `json:"recorded_at"`
	State                string                  `json:"state"`
	Decision             *RestitutionDecision    `json:"decision"`
	Application          *RestitutionApplication `json:"application"`
}
type RestitutionLineState struct {
	// Derived from the same statement's validated private dispatch evidence.
	EffectiveDispatch       int64                 `json:"-"`
	ReconciliationRevision  int64                 `json:"-"`
	VariantID               int64                 `json:"variant_id"`
	ExpectedQuantity        int64                 `json:"expected_quantity"`
	OriginalCredit          int64                 `json:"original_credit"`
	WorkflowRevision        int64                 `json:"workflow_revision"`
	AppliedRevision         int64                 `json:"applied_revision"`
	CountGeneration         int64                 `json:"count_generation"`
	CountAppliedRevision    int64                 `json:"count_applied_revision"`
	EffectiveCredit         int64                 `json:"effective_credit"`
	AppliedRetainedQuantity int64                 `json:"applied_retained_quantity"`
	Proposals               []RestitutionProposal `json:"proposals"`
}

// Restitutions is a separate participant-private history, never TransferDetail.
type Restitutions struct {
	RequestID  int64                  `json:"request_id"`
	Lines      []RestitutionLineState `json:"lines"`
	Operations []RestitutionOperation `json:"operations"`
}

func (s *Store) ProposeRestitution(ctx context.Context, actor auth.Identity, id int64, in RestitutionProposalInput) (RestitutionOperation, error) {
	q, att := in.RetainedQuantity, in.RetainedAtOrigin
	return s.restitute(ctx, actor, id, in.VariantID, in.OperationKey, "propose", in.ExpectedRevision, &q, &att, in.Reason)
}
func (s *Store) DecideRestitution(ctx context.Context, actor auth.Identity, id int64, in RestitutionDecisionInput) (RestitutionOperation, error) {
	action := "reject"
	if in.Accept {
		action = "accept"
	}
	return s.restitute(ctx, actor, id, in.VariantID, in.OperationKey, action, in.ExpectedRevision, nil, nil, in.Reason)
}
func validRestitutionInput(variant int64, key, action string, revision int64, quantity *int64, attested *bool, reason string) bool {
	if variant <= 0 || variant > math.MaxInt32 || !retryKeyPattern.MatchString(key) || revision < 0 || revision == math.MaxInt64 || !utf8.ValidString(reason) || strings.ContainsRune(reason, 0) {
		return false
	}
	n := utf8.RuneCountInString(strings.Trim(reason, " "))
	if n < 1 || n > 2000 {
		return false
	}
	switch action {
	case "propose":
		return quantity != nil && *quantity > 0 && attested != nil && *attested
	case "accept", "reject":
		return quantity == nil && attested == nil
	default:
		return false
	}
}
func (s *Store) restitute(ctx context.Context, actor auth.Identity, id, variant int64, key, action string, revision int64, quantity *int64, attested *bool, reason string) (RestitutionOperation, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return RestitutionOperation{}, ErrUnavailable
	}
	if !assigned(actor) {
		return RestitutionOperation{}, ErrForbidden
	}
	if id < 1 {
		return RestitutionOperation{}, ErrNotFound
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := checkAssignment(ctx, s.pool, actor); err != nil {
		return RestitutionOperation{}, err
	}
	tx, err := s.beginPersonal(ctx, actor)
	if err != nil {
		return RestitutionOperation{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	// Fence private membership before examining even malformed payloads. SQL
	// repeats authorization under its lock and owns all eligibility/effects.
	var status string
	err = tx.QueryRow(ctx, `SELECT status FROM transfer_requests WHERE id=$1 AND $2 IN(origin_location_id,destination_location_id)`, id, actor.Location.ID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return RestitutionOperation{}, ErrNotFound
	}
	if err != nil {
		return RestitutionOperation{}, fail(ctx)
	}
	if status != "received" {
		return RestitutionOperation{}, ErrDecisionConflict
	}
	if !validRestitutionInput(variant, key, action, revision, quantity, attested, reason) {
		return RestitutionOperation{}, ErrInvalid
	}
	var op RestitutionOperation
	err = tx.QueryRow(ctx, `SELECT operation_key,request_id,variant_id,actor_location_id,action,expected_revision,retained_quantity,retained_at_origin,reason,revision,source_existing_before,source_existing_after,recorded_at
 FROM transfer_restitute($1,$2::integer,$3::smallint,$4,$5,$6,$7,$8,$9)`, id, variant, actor.Location.ID, key, action, revision, quantity, attested, reason).Scan(&op.OperationKey, &op.RequestID, &op.VariantID, &op.ActorLocationID, &op.Action, &op.ExpectedRevision, &op.RetainedQuantity, &op.RetainedAtOrigin, &op.Reason, &op.Revision, &op.SourceExistingBefore, &op.SourceExistingAfter, &op.RecordedAt)
	if err != nil {
		return RestitutionOperation{}, restitutionError(ctx, err)
	}
	// A deferred constraint failure must never return an apparent operation.
	if err = tx.Commit(ctx); err != nil {
		return RestitutionOperation{}, fail(ctx)
	}
	op.RecordedAt = op.RecordedAt.UTC()
	return op, nil
}
func restitutionError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var p *pgconn.PgError
	if !errors.As(err, &p) {
		return fail(ctx)
	}
	switch p.Code {
	case "42501":
		switch p.Message {
		case "Restitution endpoint unauthorized", "Restitution requires a physical endpoint of a received transfer", "Only origin may attest retained stock", "Only exact destination may decide restitution":
			return ErrForbidden
		}
	case "23505":
		if p.Message == "Restitution operation identity conflicts" {
			return ErrRetryConflict
		}
	case "23514":
		switch p.Message {
		case "Restitution requires an expected received line", "Restitution requires explicit positive retention attestation", "Invalid restitution action":
			return ErrInvalid
		case "Stale restitution revision", "Restitution blocked by pending count proposal", "Restitution already applied", "Restitution exceeds outstanding debit", "Restitution decision is terminal or payload invalid", "Restitution predecessor changed":
			return ErrDecisionConflict
		case "Restitution requires covered nonoverflowing origin stock":
			return ErrInsufficientStock
		}
	}
	return fail(ctx)
}

// CheckRestitutionAccess is an HTTP privacy fence before payload decoding, not
// mutation authorization or freshness/replay authority. Both participants may
// pass; SQL rechecks action-specific roles and state under its advisory lock.
// Assignment and the participant-filtered header are read independently of
// private history decoding.
func (s *Store) CheckRestitutionAccess(ctx context.Context, actor auth.Identity, id int64) error {
	if ctx == nil || s == nil || s.pool == nil {
		return ErrUnavailable
	}
	if !assigned(actor) {
		return ErrForbidden
	}
	if id < 1 {
		return ErrNotFound
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := checkAssignment(ctx, s.pool, actor); err != nil {
		return err
	}
	var status string
	err := s.pool.QueryRow(ctx, `SELECT status FROM transfer_requests WHERE id=$1 AND $2 IN(origin_location_id,destination_location_id)`, id, actor.Location.ID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fail(ctx)
	}
	if status != "received" {
		return ErrDecisionConflict
	}
	return nil
}

func (s *Store) GetRestitutions(ctx context.Context, actor auth.Identity, id int64) (Restitutions, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Restitutions{}, ErrReadUnavailable
	}
	if !assigned(actor) {
		return Restitutions{}, ErrForbidden
	}
	if id < 1 {
		return Restitutions{}, ErrNotFound
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := checkAssignment(ctx, s.pool, actor); err != nil {
		return Restitutions{}, err
	}
	var status string
	var origin, destination int
	var lines, operations, dispatchEvidence []byte
	err := s.pool.QueryRow(ctx, restitutionSnapshotSQL, id, actor.Location.ID).Scan(&status, &origin, &destination, &lines, &operations, &dispatchEvidence)
	if errors.Is(err, pgx.ErrNoRows) {
		return Restitutions{}, ErrNotFound
	}
	if err != nil {
		return Restitutions{}, fail(ctx)
	}
	if status != "received" {
		return Restitutions{}, ErrDecisionConflict
	}
	return decodeRestitutionHistory(id, origin, destination, lines, operations, dispatchEvidence)
}

// Reject missing fields as well as malformed JSON. Zero-valued missing pins or
// attestations cannot silently turn damaged evidence into a recovery snapshot.
func completeRestitutionJSON(raw json.RawMessage, typ reflect.Type) bool {
	if typ == reflect.TypeOf(time.Time{}) {
		return string(raw) != "null"
	}
	if typ.Kind() == reflect.Pointer {
		return string(raw) == "null" || completeRestitutionJSON(raw, typ.Elem())
	}
	switch typ.Kind() {
	case reflect.Slice:
		var entries []json.RawMessage
		if json.Unmarshal(raw, &entries) != nil || entries == nil {
			return false
		}
		for _, e := range entries {
			if !completeRestitutionJSON(e, typ.Elem()) {
				return false
			}
		}
	case reflect.Struct:
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw, &fields) != nil || fields == nil {
			return false
		}
		for i := 0; i < typ.NumField(); i++ {
			f := typ.Field(i)
			if f.Tag.Get("json") == "-" {
				continue // Output-only evidence is validated separately.
			}
			v, ok := fields[f.Tag.Get("json")]
			if !ok || !completeRestitutionJSON(v, f.Type) {
				return false
			}
		}
	default:
		return string(raw) != "null"
	}
	return true
}
func decodeRestitutionHistory(id int64, origin, destination int, lines, operations []byte, dispatchEvidence ...[]byte) (Restitutions, error) {
	var effective map[int64]restitutionDispatchEvidence
	if len(dispatchEvidence) > 0 {
		var valid bool
		effective, valid = decodeRestitutionDispatchEvidence(dispatchEvidence[0])
		if len(dispatchEvidence) != 1 || !valid {
			return Restitutions{}, ErrReadUnavailable
		}
	}
	out := Restitutions{RequestID: id}
	for _, v := range []struct {
		raw []byte
		dst any
	}{{lines, &out.Lines}, {operations, &out.Operations}} {
		if !completeRestitutionJSON(v.raw, reflect.TypeOf(v.dst).Elem()) {
			return Restitutions{}, ErrReadUnavailable
		}
		d := json.NewDecoder(bytes.NewReader(v.raw))
		d.DisallowUnknownFields()
		if d.Decode(v.dst) != nil {
			return Restitutions{}, ErrReadUnavailable
		}
	}
	if id < 1 || origin < 1 || destination < 1 || origin == destination || len(out.Lines) == 0 {
		return Restitutions{}, ErrReadUnavailable
	}
	ops := make(map[string]RestitutionOperation, len(out.Operations))
	used := make(map[string]bool, len(out.Operations))
	for i := range out.Operations {
		o := &out.Operations[i]
		if !validRestitutionInput(o.VariantID, o.OperationKey, o.Action, o.ExpectedRevision, o.RetainedQuantity, o.RetainedAtOrigin, o.Reason) || o.RequestID != id || o.Revision <= 0 || o.RecordedAt.IsZero() {
			return Restitutions{}, ErrReadUnavailable
		}
		if _, exists := ops[o.OperationKey]; exists {
			return Restitutions{}, ErrReadUnavailable
		}
		if o.Action == "propose" {
			if o.ActorLocationID != origin || o.Revision != o.ExpectedRevision+1 {
				return Restitutions{}, ErrReadUnavailable
			}
		} else if o.ActorLocationID != destination || o.Revision != o.ExpectedRevision {
			return Restitutions{}, ErrReadUnavailable
		}
		if o.Action == "accept" {
			if o.SourceExistingBefore == nil || o.SourceExistingAfter == nil || *o.SourceExistingBefore < 0 || *o.SourceExistingAfter <= *o.SourceExistingBefore {
				return Restitutions{}, ErrReadUnavailable
			}
		} else if o.SourceExistingBefore != nil || o.SourceExistingAfter != nil {
			return Restitutions{}, ErrReadUnavailable
		}
		o.RecordedAt = o.RecordedAt.UTC()
		ops[o.OperationKey] = *o
	}
	var previousVariant int64
	for i := range out.Lines {
		l := &out.Lines[i]
		dispatch := l.ExpectedQuantity
		var reconciled int64
		if effective != nil {
			e, ok := effective[l.VariantID]
			if !ok || len(e.Proposals) != len(l.Proposals) || (e.ReconciliationRevision == 0 && e.Dispatch != l.ExpectedQuantity) {
				return Restitutions{}, ErrReadUnavailable
			}
			dispatch, reconciled = e.Dispatch, e.ReconciliationRevision
		}
		if l.VariantID <= previousVariant || l.VariantID > math.MaxInt32 || l.ExpectedQuantity <= 0 || l.OriginalCredit < 0 || l.OriginalCredit > l.ExpectedQuantity || l.EffectiveCredit < 0 || l.EffectiveCredit > dispatch || l.CountGeneration < 0 || l.CountAppliedRevision < 0 || l.CountAppliedRevision > l.CountGeneration || l.WorkflowRevision != int64(len(l.Proposals)) || l.AppliedRetainedQuantity < 0 || l.AppliedRetainedQuantity > dispatch-l.EffectiveCredit {
			return Restitutions{}, ErrReadUnavailable
		}
		// Only a line without either applied workflow must retain original credit.
		if l.CountAppliedRevision == 0 && reconciled == 0 && l.EffectiveCredit != l.OriginalCredit {
			return Restitutions{}, ErrReadUnavailable
		}
		l.EffectiveDispatch, l.ReconciliationRevision = dispatch, reconciled
		previousVariant = l.VariantID
		var applied, quantity int64
		for j := range l.Proposals {
			p := &l.Proposals[j]
			baseDispatch := l.ExpectedQuantity
			if effective != nil {
				baseDispatch = effective[l.VariantID].Proposals[j].Dispatch
			}
			if applied != 0 {
				return Restitutions{}, ErrReadUnavailable
			}
			if j > 0 {
				previous := l.Proposals[j-1]
				if p.CountGeneration < previous.CountGeneration || p.CountAppliedRevision < previous.CountAppliedRevision || p.RecordedAt.Before(previous.RecordedAt) {
					return Restitutions{}, ErrReadUnavailable
				}
			}
			o, ok := ops[p.OperationKey]
			if !ok || used[p.OperationKey] || o.Action != "propose" || o.VariantID != l.VariantID || p.Revision != int64(j+1) || o.Revision != p.Revision || p.BaseRevision != p.Revision-1 || p.InitiatorLocationID != origin || !p.RetainedAtOrigin || p.RetainedQuantity <= 0 || *o.RetainedQuantity != p.RetainedQuantity || p.Reason != o.Reason || !p.RecordedAt.Equal(o.RecordedAt) || p.CountGeneration < 0 || p.CountGeneration > l.CountGeneration || p.CountAppliedRevision < 0 || p.CountAppliedRevision > p.CountGeneration || p.BaseCredit < 0 || p.BaseCredit > baseDispatch || p.BaseRestitution != 0 || p.RetainedQuantity > baseDispatch-p.BaseCredit {
				return Restitutions{}, ErrReadUnavailable
			}
			// A historical proposal cannot pin a count application from the future.
			if p.CountAppliedRevision > l.CountAppliedRevision {
				return Restitutions{}, ErrReadUnavailable
			}
			p.BaseDispatch = baseDispatch
			used[p.OperationKey] = true
			p.RecordedAt = p.RecordedAt.UTC()
			state := "superseded"
			if p.Revision == l.WorkflowRevision {
				state = "pending"
			}
			if p.Decision != nil {
				d := p.Decision
				decision, ok := ops[d.OperationKey]
				action := "reject"
				state = "rejected"
				if d.Accepted {
					action = "accept"
					state = "applied"
				}
				if !ok || used[d.OperationKey] || decision.Action != action || decision.VariantID != l.VariantID || decision.Revision != p.Revision || d.ActorLocationID != destination || decision.Reason != d.Reason || !decision.RecordedAt.Equal(d.RecordedAt) || d.RecordedAt.Before(p.RecordedAt) {
					return Restitutions{}, ErrReadUnavailable
				}
				used[d.OperationKey] = true
				d.RecordedAt = d.RecordedAt.UTC()
				if d.Accepted {
					a := p.Application
					if applied != 0 || a == nil || a.OperationKey != d.OperationKey || a.OriginLocationID != origin || a.Quantity != p.RetainedQuantity || !a.RecordedAt.Equal(d.RecordedAt) || *decision.SourceExistingAfter-*decision.SourceExistingBefore != a.Quantity {
						return Restitutions{}, ErrReadUnavailable
					}
					applied = p.Revision
					quantity = a.Quantity
					a.RecordedAt = a.RecordedAt.UTC()
				} else if p.Application != nil {
					return Restitutions{}, ErrReadUnavailable
				}
			} else if p.Application != nil {
				return Restitutions{}, ErrReadUnavailable
			}
			if state != p.State {
				return Restitutions{}, ErrReadUnavailable
			}
		}
		if applied != l.AppliedRevision || quantity != l.AppliedRetainedQuantity {
			return Restitutions{}, ErrReadUnavailable
		}
	}
	if len(used) != len(ops) || (effective != nil && len(effective) != len(out.Lines)) {
		return Restitutions{}, ErrReadUnavailable
	}
	return out, nil
}

// One committed statement snapshot pins both workflows and every immutable
// recovery identity. Aggregates have deterministic order and never return NULL.
const restitutionSnapshotSQL = `SELECT h.status,h.origin_location_id,h.destination_location_id,
 COALESCE((SELECT jsonb_agg(to_jsonb(line) ORDER BY variant_id) FROM (
 SELECT r.variant_id,r.expected_quantity,r.available_quantity AS original_credit,
 COALESCE(head.revision,0) AS workflow_revision,COALESCE(applied.revision,0) AS applied_revision,
 (SELECT count(*) FROM transfer_count_operations c WHERE c.request_id=r.request_id AND c.variant_id=r.variant_id) AS count_generation,
 COALESCE(counted.revision,0) AS count_applied_revision,
 state.credit AS effective_credit,
 COALESCE(applied.quantity,0) AS applied_retained_quantity,
 COALESCE((SELECT jsonb_agg(to_jsonb(history) ORDER BY revision) FROM (
 SELECT p.revision,p.operation_key,p.initiator_location_id,p.retained_quantity,p.retained_at_origin,
 p.base_revision,p.count_generation,p.count_applied_revision,p.base_credit,p.base_restitution,p.reason,p.recorded_at,
 CASE WHEN d.accepted THEN 'applied' WHEN d.accepted=false THEN 'rejected'
 WHEN p.revision=head.revision THEN 'pending' ELSE 'superseded' END AS state,
 CASE WHEN d.operation_key IS NOT NULL THEN jsonb_build_object('operation_key',d.operation_key,'actor_location_id',d.actor_location_id,'accepted',d.accepted,'reason',d.reason,'recorded_at',d.recorded_at) ELSE NULL END AS decision,
 CASE WHEN a.operation_key IS NOT NULL THEN jsonb_build_object('operation_key',a.operation_key,'origin_location_id',a.origin_location_id,'quantity',a.quantity,'recorded_at',a.recorded_at) ELSE NULL END AS application
 FROM transfer_restitution_proposals p
 LEFT JOIN transfer_restitution_decisions d USING(request_id,variant_id,revision)
 LEFT JOIN transfer_restitution_applications a USING(request_id,variant_id,revision)
 WHERE p.request_id=r.request_id AND p.variant_id=r.variant_id
 ) history),'[]'::jsonb) AS proposals
 FROM transfer_receipt_lines r
 CROSS JOIN LATERAL transfer_effective_line(r.request_id,r.variant_id) state
 LEFT JOIN LATERAL (SELECT revision FROM transfer_restitution_proposals p WHERE p.request_id=r.request_id AND p.variant_id=r.variant_id ORDER BY revision DESC LIMIT 1) head ON true
 LEFT JOIN transfer_restitution_applications applied ON applied.request_id=r.request_id AND applied.variant_id=r.variant_id
 LEFT JOIN LATERAL (SELECT revision,effective_credit FROM transfer_count_applications c WHERE c.request_id=r.request_id AND c.variant_id=r.variant_id ORDER BY revision DESC LIMIT 1) counted ON true
 WHERE r.request_id=h.id AND r.expected_quantity>0
 ) line),'[]'::jsonb),
 COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY revision,variant_id,recorded_at,operation_key) FROM transfer_restitution_operations o WHERE o.request_id=h.id),'[]'::jsonb),
 COALESCE((SELECT jsonb_agg(jsonb_build_object('variant_id',r.variant_id,'dispatch',state.dispatch,
 'reconciliation_revision',state.reconciliation_revision,'proposals',
 COALESCE((SELECT jsonb_agg(jsonb_build_object('revision',p.revision,'dispatch',COALESCE(pin.effective_dispatch,r.expected_quantity)) ORDER BY p.revision)
 FROM transfer_restitution_proposals p LEFT JOIN transfer_restitution_reconciliation_pins pin USING(request_id,variant_id,revision)
 WHERE p.request_id=r.request_id AND p.variant_id=r.variant_id),'[]'::jsonb)) ORDER BY r.variant_id)
 FROM transfer_receipt_lines r CROSS JOIN LATERAL transfer_effective_line(r.request_id,r.variant_id) state
 WHERE r.request_id=h.id AND r.expected_quantity>0),'[]'::jsonb)
 FROM transfer_requests h WHERE h.id=$1 AND $2 IN(h.origin_location_id,h.destination_location_id)`
