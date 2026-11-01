package transfers

import (
	"context"
	"encoding/json"
	"errors"
	"math/big"
	"reflect"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"luson/api/internal/auth"
)

func (s *Store) ProposeUnifiedReconciliation(ctx context.Context, actor auth.Identity, id int64, in UnifiedReconciliationProposalInput) (UnifiedReconciliationOperation, error) {
	d, a, r := in.DispatchQuantity, in.ArrivalQuantity, in.RetainedQuantity
	return s.reconcileUnified(ctx, actor, id, in.VariantID, in.OperationKey, "propose", in.ExpectedRevision, &d, &a, &r, in.RetainedAtOrigin, in.Reason)
}
func (s *Store) DecideUnifiedReconciliation(ctx context.Context, actor auth.Identity, id int64, in UnifiedReconciliationDecisionInput) (UnifiedReconciliationOperation, error) {
	action := "reject"
	if in.Accept {
		action = "accept"
	}
	return s.reconcileUnified(ctx, actor, id, in.VariantID, in.OperationKey, action, in.ExpectedRevision, nil, nil, nil, in.RetainedAtOrigin, in.Reason)
}
func (s *Store) reconcileUnified(ctx context.Context, actor auth.Identity, id, variant int64, key, action string, revision int64, dispatch, arrival, retained *int64, attested bool, reason string) (UnifiedReconciliationOperation, error) {
	if err := s.CheckRestitutionAccess(ctx, actor, id); err != nil {
		return UnifiedReconciliationOperation{}, err
	}
	if !validCountInput(variant, key, revision, dispatch, reason) || (arrival != nil && *arrival < 0) || (retained != nil && *retained < 0) {
		return UnifiedReconciliationOperation{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.beginPersonal(ctx, actor)
	if err != nil {
		return UnifiedReconciliationOperation{}, fail(ctx)
	}
	defer rollbackUnified(tx)
	var raw []byte
	err = tx.QueryRow(ctx, `SELECT to_jsonb(o) FROM transfer_unified_reconcile($1,$2::integer,$3::smallint,$4,$5,$6,$7,$8,$9,$10,$11) o`, id, variant, actor.Location.ID, key, action, revision, dispatch, arrival, retained, attested, reason).Scan(&raw)
	if err != nil {
		return UnifiedReconciliationOperation{}, unifiedError(ctx, err)
	}
	var op UnifiedReconciliationOperation
	if !decodeUnifiedJSON(raw, &op) {
		return UnifiedReconciliationOperation{}, ErrUnavailable
	}
	if tx.Commit(ctx) != nil {
		return UnifiedReconciliationOperation{}, fail(ctx)
	}
	op.RecordedAt = op.RecordedAt.UTC()
	return op, nil
}
func rollbackUnified(tx pgx.Tx) {
	cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
	defer done()
	_ = tx.Rollback(cleanup)
}
func unifiedError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if activeLocationRequired(err) {
		return ErrDecisionConflict
	}
	var p *pgconn.PgError
	if !errors.As(err, &p) {
		return fail(ctx)
	}
	switch p.Code {
	case "42501":
		switch p.Message {
		case "Unified endpoint unauthorized", "Only unified origin may attest", "Only unified initiator may replace", "Only unified counterparty may decide":
			return ErrForbidden
		}
	case "23505":
		if p.Message == "Unified operation identity conflicts" {
			return ErrRetryConflict
		}
	case "23514":
		switch p.Message {
		case "Invalid unified quantities", "Unified requires originally expected variant", "Invalid unified action":
			return ErrInvalid
		case "Stale unified revision", "Unified predecessor changed", "Unified decision terminal or invalid", "Unified retention requires origin attestation":
			return ErrDecisionConflict
		case "Unified requires covered endpoint stock", "Unified requires both endpoint balances":
			return ErrInsufficientStock
		}
	}
	return fail(ctx)
}
func decodeUnifiedJSON(raw []byte, dst any) bool {
	return completeRestitutionJSON(raw, reflect.TypeOf(dst).Elem()) && json.Unmarshal(raw, dst) == nil
}

// All historical readers run inside THIS authenticated repeatable-read snapshot.
// No public legacy getter is bypassed or independently committed. The legacy SQL
// expressions and restitution decoder are the same ones used by those getters.
func (s *Store) GetUnifiedReconciliations(ctx context.Context, actor auth.Identity, id int64) (UnifiedReconciliations, error) {
	if err := s.CheckRestitutionAccess(ctx, actor, id); err != nil {
		return UnifiedReconciliations{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return UnifiedReconciliations{}, fail(ctx)
	}
	defer rollbackUnified(tx)
	out := UnifiedReconciliations{Schema: "luson.transfer-reconciliation/v2", RequestID: id}
	var status string
	var original, current, lines, operations []byte
	err = tx.QueryRow(ctx, unifiedSnapshotSQL, id, actor.Location.ID).Scan(&status, &out.OriginLocationID, &out.DestinationLocationID, &out.ReceivedAt, &original, &current, &lines, &operations)
	if errors.Is(err, pgx.ErrNoRows) {
		return UnifiedReconciliations{}, ErrNotFound
	}
	if err != nil {
		return UnifiedReconciliations{}, fail(ctx)
	}
	if status != "received" {
		return UnifiedReconciliations{}, ErrDecisionConflict
	}
	if !decodeUnifiedJSON(original, &out.Original) || !decodeUnifiedJSON(current, &out.Current) || !decodeUnifiedJSON(lines, &out.Lines) || !decodeUnifiedJSON(operations, &out.Operations) {
		return UnifiedReconciliations{}, ErrUnavailable
	}
	var owned bool
	var rawLines, rawOps, pins []byte
	var origin, destination int
	err = tx.QueryRow(ctx, countSnapshotSQL, id, actor.Location.ID).Scan(&status, &owned, &rawLines, &rawOps)
	out.Legacy.Count.RequestID = id
	if err != nil || !decodeUnifiedJSON(rawLines, &out.Legacy.Count.Lines) || !decodeUnifiedJSON(rawOps, &out.Legacy.Count.Operations) {
		return UnifiedReconciliations{}, fail(ctx)
	}
	err = tx.QueryRow(ctx, restitutionSnapshotSQL, id, actor.Location.ID).Scan(&status, &owned, &origin, &destination, &rawLines, &rawOps, &pins)
	if err != nil {
		return UnifiedReconciliations{}, fail(ctx)
	}
	out.Legacy.Restitution, err = decodeRestitutionHistory(id, origin, destination, rawLines, rawOps, pins)
	if err != nil {
		return UnifiedReconciliations{}, err
	}
	err = tx.QueryRow(ctx, dispatchReconciliationSnapshotSQL, id, actor.Location.ID).Scan(&status, &owned, &rawLines, &rawOps)
	out.Legacy.Dispatch.RequestID = id
	if err != nil || !decodeUnifiedJSON(rawLines, &out.Legacy.Dispatch.Lines) || !decodeUnifiedJSON(rawOps, &out.Legacy.Dispatch.Operations) {
		return UnifiedReconciliations{}, fail(ctx)
	}
	normalizeCountSnapshot(&out.Legacy.Count)
	normalizeDispatchSnapshot(&out.Legacy.Dispatch)
	if !validateUnifiedSnapshot(&out) {
		return UnifiedReconciliations{}, ErrUnavailable
	}
	if tx.Commit(ctx) != nil {
		return UnifiedReconciliations{}, fail(ctx)
	}
	out.ReceivedAt = out.ReceivedAt.UTC()
	return out, nil
}

// Recompute effects with wide intermediates, independently of the SQL ledger
// reader. Inventory balances are immutable per-operation audit, never chained
// across operations (unrelated inventory activity may intervene).
func validateUnifiedSnapshot(out *UnifiedReconciliations) bool {
	if len(out.Original) == 0 || len(out.Current) != len(out.Original) || len(out.Legacy.Count.Lines) != len(out.Original) || out.OriginLocationID == out.DestinationLocationID || out.ReceivedAt.IsZero() {
		return false
	}
	ops := make(map[string]UnifiedReconciliationOperation, len(out.Operations))
	used := map[string]bool{}
	for i := range out.Operations {
		o := &out.Operations[i]
		if o.RequestID != out.RequestID || (o.ActorLocationID != out.OriginLocationID && o.ActorLocationID != out.DestinationLocationID) || o.RecordedAt.IsZero() || !validCountInput(o.VariantID, o.OperationKey, o.ExpectedRevision, o.DispatchQuantity, o.Reason) {
			return false
		}
		if _, exists := ops[o.OperationKey]; exists {
			return false
		}
		o.RecordedAt = o.RecordedAt.UTC()
		ops[o.OperationKey] = *o
	}
	hi := 0
	var previous int64
	for i, r := range out.Original {
		c := out.Current[i]
		legacy := out.Legacy.Count.Lines[i]
		if r.VariantID <= previous || r.ExpectedQuantity < 0 || r.ActualQuantity < 0 || r.AvailableQuantity != min(r.ExpectedQuantity, r.ActualQuantity) || c.VariantID != r.VariantID || legacy.VariantID != r.VariantID || legacy.ExpectedQuantity != r.ExpectedQuantity || legacy.OriginalActual != r.ActualQuantity || legacy.OriginalCredit != r.AvailableQuantity {
			return false
		}
		previous = r.VariantID
		source, destination := big.NewInt(r.ExpectedQuantity), big.NewInt(r.AvailableQuantity)
		for _, p := range legacy.Proposals {
			if p.Application != nil {
				destination.Add(destination, big.NewInt(p.Application.Delta))
			}
		}
		var countGen, restGen, dispatchGen int64
		for _, o := range out.Legacy.Count.Operations {
			if o.VariantID == r.VariantID {
				countGen++
			}
		}
		for _, o := range out.Legacy.Restitution.Operations {
			if o.VariantID == r.VariantID {
				restGen++
			}
		}
		for _, o := range out.Legacy.Dispatch.Operations {
			if o.VariantID == r.VariantID {
				dispatchGen++
			}
		}
		for _, l := range out.Legacy.Restitution.Lines {
			if l.VariantID == r.VariantID {
				for _, p := range l.Proposals {
					if p.Application != nil {
						source.Sub(source, big.NewInt(p.Application.Quantity))
					}
				}
			}
		}
		for _, l := range out.Legacy.Dispatch.Lines {
			if l.VariantID == r.VariantID {
				for _, p := range l.Proposals {
					if p.Application != nil {
						source.Sub(source, big.NewInt(p.Application.SourceDelta))
						destination.Add(destination, big.NewInt(p.Application.DestinationDelta))
					}
				}
			}
		}
		if !source.IsInt64() || source.Sign() < 0 || !destination.IsInt64() || destination.Sign() < 0 || destination.Int64() != legacy.EffectiveCredit {
			return false
		}
		if c.Version.Count != countGen || c.Version.Restitution != restGen || c.Version.Dispatch != dispatchGen {
			return false
		}
		owner := "legacy"
		applied := int64(0)
		generation := int64(0)
		dispatch, actual := legacy.EffectiveDispatch, legacy.EffectiveActual
		var acceptance *string
		var last *UnifiedReconciliationProposal
		if r.ExpectedQuantity > 0 {
			if hi >= len(out.Lines) {
				return false
			}
			l := &out.Lines[hi]
			hi++
			if l.VariantID != r.VariantID || l.ExpectedQuantity != r.ExpectedQuantity || l.OriginalActual != r.ActualQuantity || l.OriginalCredit != r.AvailableQuantity || l.WorkflowRevision != int64(len(l.Proposals)) {
				return false
			}
			if len(l.Proposals) > 0 {
				owner = "unified"
			}
			for j := range l.Proposals {
				p := &l.Proposals[j]
				o, exists := ops[p.OperationKey]
				if !exists || used[p.OperationKey] || o.Action != "propose" || o.VariantID != r.VariantID ||
					p.Revision != int64(j+1) || o.ExpectedRevision != p.Revision-1 || o.Revision != p.Revision ||
					o.ActorLocationID != p.InitiatorLocationID || o.DispatchQuantity == nil ||
					o.ArrivalQuantity == nil || o.RetainedQuantity == nil ||
					*o.DispatchQuantity != p.DispatchQuantity || *o.ArrivalQuantity != p.ArrivalQuantity ||
					*o.RetainedQuantity != p.RetainedQuantity || o.RetainedAtOrigin != p.RetainedAtOrigin ||
					o.Reason != p.Reason || !o.RecordedAt.Equal(p.RecordedAt) ||
					o.SourceExistingBefore != nil || o.SourceExistingAfter != nil ||
					o.DestinationExistingBefore != nil || o.DestinationExistingAfter != nil {
					return false
				}
				if p.UnifiedGeneration != generation || p.CountGeneration < 0 || p.CountGeneration > countGen || p.RestitutionGeneration < 0 || p.RestitutionGeneration > restGen || p.ReconciliationGeneration < 0 || p.ReconciliationGeneration > dispatchGen || p.BaseSourceDebit != source.Int64() || p.BaseDestinationCredit != destination.Int64() {
					return false
				}
				if j > 0 {
					prev := l.Proposals[j-1]
					if p.CountGeneration < prev.CountGeneration || p.RestitutionGeneration < prev.RestitutionGeneration || p.ReconciliationGeneration < prev.ReconciliationGeneration || (prev.Decision == nil && prev.InitiatorLocationID != p.InitiatorLocationID) {
						return false
					}
				}
				if p.RetainedAtOrigin && p.InitiatorLocationID != out.OriginLocationID || p.RetainedQuantity > 0 && p.InitiatorLocationID == out.OriginLocationID && !p.RetainedAtOrigin {
					return false
				}
				plan, e := CalculateUnifiedAccounting(UnifiedAccountingInput{OriginalDebit: r.ExpectedQuantity, Dispatch: p.DispatchQuantity, Arrival: p.ArrivalQuantity, Retained: p.RetainedQuantity, SourceDebit: p.BaseSourceDebit, DestinationCredit: p.BaseDestinationCredit})
				if e != nil {
					return false
				}
				used[p.OperationKey] = true
				generation++
				state := "superseded"
				if j == len(l.Proposals)-1 {
					state = "pending"
				}
				p.RecordedAt = p.RecordedAt.UTC()
				if p.Decision != nil {
					d := p.Decision
					dop, ok := ops[d.OperationKey]
					action := "reject"
					state = "rejected"
					if d.Accepted {
						action = "accept"
						state = "applied"
					}
					if !ok || used[d.OperationKey] || dop.Action != action || dop.VariantID != r.VariantID ||
						dop.Revision != p.Revision || dop.ExpectedRevision != p.Revision ||
						dop.ActorLocationID != d.ActorLocationID || d.ActorLocationID == p.InitiatorLocationID ||
						dop.RetainedAtOrigin != d.RetainedAtOrigin || dop.Reason != d.Reason ||
						!dop.RecordedAt.Equal(d.RecordedAt) || dop.DispatchQuantity != nil ||
						dop.ArrivalQuantity != nil || dop.RetainedQuantity != nil || d.RecordedAt.Before(p.RecordedAt) {
						return false
					}
					if d.RetainedAtOrigin && (!d.Accepted || d.ActorLocationID != out.OriginLocationID) {
						return false
					}
					used[d.OperationKey] = true
					generation++
					d.RecordedAt = d.RecordedAt.UTC()
					if d.Accepted {
						a := p.Application
						if a == nil || a.OperationKey != d.OperationKey || a.SourceDelta != plan.SourceDelta ||
							a.DestinationDelta != plan.DestinationDelta || dop.SourceExistingBefore == nil ||
							dop.SourceExistingAfter == nil || dop.DestinationExistingBefore == nil ||
							dop.DestinationExistingAfter == nil || *dop.SourceExistingBefore < 0 ||
							*dop.SourceExistingAfter < 0 || *dop.DestinationExistingBefore < 0 ||
							*dop.DestinationExistingAfter < 0 ||
							*dop.SourceExistingAfter-*dop.SourceExistingBefore != a.SourceDelta ||
							*dop.DestinationExistingAfter-*dop.DestinationExistingBefore != a.DestinationDelta ||
							p.RetainedQuantity > 0 && !(p.InitiatorLocationID == out.OriginLocationID && p.RetainedAtOrigin ||
								d.ActorLocationID == out.OriginLocationID && d.RetainedAtOrigin) {
							return false
						}
						source.Sub(source, big.NewInt(a.SourceDelta))
						destination.Add(destination, big.NewInt(a.DestinationDelta))
						applied = p.Revision
						dispatch = p.DispatchQuantity
						actual = p.ArrivalQuantity
						acceptance = &d.OperationKey
						last = p
					} else if p.Application != nil || dop.SourceExistingBefore != nil || dop.SourceExistingAfter != nil || dop.DestinationExistingBefore != nil || dop.DestinationExistingAfter != nil {
						return false
					}
				} else if p.Application != nil {
					return false
				}
				if p.State != state {
					return false
				}
			}
			if l.AppliedRevision != applied || l.UnifiedGeneration != generation {
				return false
			}
		}
		if !source.IsInt64() || !destination.IsInt64() || c.SourceDebit != source.Int64() || c.EffectiveCredit != destination.Int64() || c.Owner != owner || c.AppliedRevision != applied || c.Version.Unified != generation || c.EffectiveDispatch != dispatch || c.EffectiveActual != actual {
			return false
		}
		if applied == 0 {
			if c.Source != "legacy" || c.ApplicationOperationKey != nil || c.RetainedQuantity != nil || c.OriginUnknown != nil || c.TransitUnknown != nil || c.Excess != nil {
				return false
			}
		} else {
			if c.Source != "unified" || c.ApplicationOperationKey == nil || *c.ApplicationOperationKey != *acceptance || c.RetainedQuantity == nil || c.OriginUnknown == nil || c.TransitUnknown == nil || c.Excess == nil || *c.RetainedQuantity != last.RetainedQuantity {
				return false
			}
			plan, e := CalculateUnifiedAccounting(UnifiedAccountingInput{OriginalDebit: r.ExpectedQuantity, Dispatch: dispatch, Arrival: actual, Retained: *c.RetainedQuantity, SourceDebit: c.SourceDebit, DestinationCredit: c.EffectiveCredit})
			if e != nil || plan.SourceDelta != 0 || plan.DestinationDelta != 0 || *c.OriginUnknown != plan.OriginUnknown || *c.TransitUnknown != plan.TransitUnknown || *c.Excess != plan.Excess {
				return false
			}
		}
	}
	return hi == len(out.Lines) && len(used) == len(ops)
}

const unifiedSnapshotSQL = `SELECT h.status,h.origin_location_id,h.destination_location_id,h.received_at,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('variant_id',r.variant_id,'expected_quantity',r.expected_quantity,'actual_quantity',r.actual_quantity,'available_quantity',r.available_quantity) ORDER BY r.variant_id) FROM transfer_receipt_lines r WHERE r.request_id=h.id),'[]'::jsonb),
 COALESCE((SELECT jsonb_agg(to_jsonb(live) ORDER BY variant_id) FROM (
 SELECT r.variant_id,CASE WHEN EXISTS(SELECT 1 FROM transfer_unified_proposals p WHERE p.request_id=r.request_id AND p.variant_id=r.variant_id) THEN 'unified' ELSE 'legacy' END AS owner,
 CASE WHEN u.applied_revision>0 THEN 'unified' ELSE 'legacy' END AS source,
 a.operation_key AS application_operation_key,u.applied_revision,
 jsonb_build_object('count',l.count_generation,'restitution',l.restitution_generation,'dispatch',l.reconciliation_generation,'unified',u.unified_generation) AS version,
 u.dispatch AS effective_dispatch,u.actual AS effective_actual,u.credit AS effective_credit,u.source_debit,
 CASE WHEN u.applied_revision>0 THEN u.retained END AS retained_quantity,
 CASE WHEN u.applied_revision>0 THEN u.origin_unknown END AS origin_unknown,
 CASE WHEN u.applied_revision>0 THEN u.transit_unknown END AS transit_unknown,
 CASE WHEN u.applied_revision>0 THEN u.excess END AS excess
 FROM transfer_receipt_lines r CROSS JOIN LATERAL transfer_unified_line(r.request_id,r.variant_id) u
 CROSS JOIN LATERAL transfer_effective_line(r.request_id,r.variant_id) l
 LEFT JOIN transfer_unified_applications a ON (a.request_id,a.variant_id,a.revision)=(r.request_id,r.variant_id,u.applied_revision)
 WHERE r.request_id=h.id) live),'[]'::jsonb),
 COALESCE((SELECT jsonb_agg(to_jsonb(line) ORDER BY variant_id) FROM (
 SELECT r.variant_id,r.expected_quantity,r.actual_quantity,r.available_quantity,u.applied_revision,u.unified_generation,
 COALESCE(head.revision,0) AS workflow_revision,
 COALESCE((SELECT jsonb_agg(to_jsonb(history) ORDER BY revision) FROM (
 SELECT p.*,to_jsonb(d) AS decision,to_jsonb(a) AS application,
 CASE WHEN d.accepted THEN 'applied' WHEN d.accepted=false THEN 'rejected' WHEN p.revision=head.revision THEN 'pending' ELSE 'superseded' END AS state
 FROM transfer_unified_proposals p LEFT JOIN transfer_unified_decisions d USING(request_id,variant_id,revision)
 LEFT JOIN transfer_unified_applications a USING(request_id,variant_id,revision)
 WHERE p.request_id=r.request_id AND p.variant_id=r.variant_id) history),'[]'::jsonb) AS proposals
 FROM transfer_receipt_lines r CROSS JOIN LATERAL transfer_unified_line(r.request_id,r.variant_id) u
 LEFT JOIN LATERAL(SELECT revision FROM transfer_unified_proposals p WHERE p.request_id=r.request_id AND p.variant_id=r.variant_id ORDER BY revision DESC LIMIT 1) head ON true
 WHERE r.request_id=h.id AND r.expected_quantity>0) line),'[]'::jsonb),
 COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY revision,variant_id,recorded_at,operation_key) FROM transfer_unified_operations o WHERE o.request_id=h.id),'[]'::jsonb)
 FROM transfer_requests h WHERE h.id=$1 AND $2 IN(h.origin_location_id,h.destination_location_id)`
