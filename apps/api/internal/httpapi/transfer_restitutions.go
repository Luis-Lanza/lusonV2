package httpapi

import "luson/api/internal/transfers"

// Explicit wire DTOs keep bigint evidence lossless, nulls present and internal
// SQL representations separate from transport. All dates are canonical UTC.
// The restitution write flow is retired; these DTOs survive because the unified
// reconciliation snapshot embeds its historical evidence.
type restitutionOperationDTO struct {
	OperationKey         string  `json:"operation_key"`
	RequestID            string  `json:"request_id"`
	VariantID            int64   `json:"variant_id"`
	ActorLocationID      int     `json:"actor_location_id"`
	Action               string  `json:"action"`
	ExpectedRevision     string  `json:"expected_revision"`
	RetainedQuantity     *string `json:"retained_quantity"`
	RetainedAtOrigin     *bool   `json:"retained_at_origin"`
	Reason               string  `json:"reason"`
	Revision             string  `json:"revision"`
	SourceExistingBefore *string `json:"source_existing_before"`
	SourceExistingAfter  *string `json:"source_existing_after"`
	RecordedAt           string  `json:"recorded_at"`
}
type restitutionDecisionDTO struct {
	OperationKey    string `json:"operation_key"`
	ActorLocationID int    `json:"actor_location_id"`
	Accepted        bool   `json:"accepted"`
	Reason          string `json:"reason"`
	RecordedAt      string `json:"recorded_at"`
}
type restitutionApplicationDTO struct {
	OperationKey     string `json:"operation_key"`
	OriginLocationID int    `json:"origin_location_id"`
	Quantity         string `json:"quantity"`
	RecordedAt       string `json:"recorded_at"`
}
type restitutionProposalDTO struct {
	BaseDispatch         string                     `json:"base_dispatch"`
	Revision             string                     `json:"revision"`
	OperationKey         string                     `json:"operation_key"`
	InitiatorLocationID  int                        `json:"initiator_location_id"`
	RetainedQuantity     string                     `json:"retained_quantity"`
	RetainedAtOrigin     bool                       `json:"retained_at_origin"`
	BaseRevision         string                     `json:"base_revision"`
	CountGeneration      string                     `json:"count_generation"`
	CountAppliedRevision string                     `json:"count_applied_revision"`
	BaseCredit           string                     `json:"base_credit"`
	BaseRestitution      string                     `json:"base_restitution"`
	Reason               string                     `json:"reason"`
	RecordedAt           string                     `json:"recorded_at"`
	State                string                     `json:"state"`
	Decision             *restitutionDecisionDTO    `json:"decision"`
	Application          *restitutionApplicationDTO `json:"application"`
}
type restitutionLineDTO struct {
	EffectiveDispatch       string                   `json:"effective_dispatch"`
	ReconciliationRevision  string                   `json:"reconciliation_revision"`
	VariantID               int64                    `json:"variant_id"`
	ExpectedQuantity        string                   `json:"expected_quantity"`
	OriginalCredit          string                   `json:"original_credit"`
	WorkflowRevision        string                   `json:"workflow_revision"`
	AppliedRevision         string                   `json:"applied_revision"`
	CountGeneration         string                   `json:"count_generation"`
	CountAppliedRevision    string                   `json:"count_applied_revision"`
	EffectiveCredit         string                   `json:"effective_credit"`
	AppliedRetainedQuantity string                   `json:"applied_retained_quantity"`
	Proposals               []restitutionProposalDTO `json:"proposals"`
}
type restitutionSnapshotDTO struct {
	RequestID  string                    `json:"request_id"`
	Lines      []restitutionLineDTO      `json:"lines"`
	Operations []restitutionOperationDTO `json:"operations"`
}

func restitutionNullable(n *int64) *string {
	if n == nil {
		return nil
	}
	value := countInt(*n)
	return &value
}
func restitutionOperationRecord(op transfers.RestitutionOperation) restitutionOperationDTO {
	return restitutionOperationDTO{
		OperationKey:         op.OperationKey,
		RequestID:            countInt(op.RequestID),
		VariantID:            op.VariantID,
		ActorLocationID:      op.ActorLocationID,
		Action:               op.Action,
		ExpectedRevision:     countInt(op.ExpectedRevision),
		RetainedQuantity:     restitutionNullable(op.RetainedQuantity),
		RetainedAtOrigin:     op.RetainedAtOrigin,
		Reason:               op.Reason,
		Revision:             countInt(op.Revision),
		SourceExistingBefore: restitutionNullable(op.SourceExistingBefore),
		SourceExistingAfter:  restitutionNullable(op.SourceExistingAfter),
		RecordedAt:           countStamp(op.RecordedAt),
	}
}
func restitutionSnapshotRecord(snapshot transfers.Restitutions) restitutionSnapshotDTO {
	out := restitutionSnapshotDTO{RequestID: countInt(snapshot.RequestID), Lines: []restitutionLineDTO{}, Operations: []restitutionOperationDTO{}}
	for _, op := range snapshot.Operations {
		out.Operations = append(out.Operations, restitutionOperationRecord(op))
	}
	for _, line := range snapshot.Lines {
		dto := restitutionLineDTO{
			EffectiveDispatch:       countInt(line.EffectiveDispatch),
			ReconciliationRevision:  countInt(line.ReconciliationRevision),
			VariantID:               line.VariantID,
			ExpectedQuantity:        countInt(line.ExpectedQuantity),
			OriginalCredit:          countInt(line.OriginalCredit),
			WorkflowRevision:        countInt(line.WorkflowRevision),
			AppliedRevision:         countInt(line.AppliedRevision),
			CountGeneration:         countInt(line.CountGeneration),
			CountAppliedRevision:    countInt(line.CountAppliedRevision),
			EffectiveCredit:         countInt(line.EffectiveCredit),
			AppliedRetainedQuantity: countInt(line.AppliedRetainedQuantity),
			Proposals:               []restitutionProposalDTO{},
		}
		for _, p := range line.Proposals {
			proposal := restitutionProposalDTO{
				BaseDispatch:         countInt(p.BaseDispatch),
				Revision:             countInt(p.Revision),
				OperationKey:         p.OperationKey,
				InitiatorLocationID:  p.InitiatorLocationID,
				RetainedQuantity:     countInt(p.RetainedQuantity),
				RetainedAtOrigin:     p.RetainedAtOrigin,
				BaseRevision:         countInt(p.BaseRevision),
				CountGeneration:      countInt(p.CountGeneration),
				CountAppliedRevision: countInt(p.CountAppliedRevision),
				BaseCredit:           countInt(p.BaseCredit),
				BaseRestitution:      countInt(p.BaseRestitution),
				Reason:               p.Reason,
				RecordedAt:           countStamp(p.RecordedAt),
				State:                p.State,
			}
			if d := p.Decision; d != nil {
				proposal.Decision = &restitutionDecisionDTO{OperationKey: d.OperationKey, ActorLocationID: d.ActorLocationID, Accepted: d.Accepted, Reason: d.Reason, RecordedAt: countStamp(d.RecordedAt)}
			}
			if ap := p.Application; ap != nil {
				proposal.Application = &restitutionApplicationDTO{OperationKey: ap.OperationKey, OriginLocationID: ap.OriginLocationID, Quantity: countInt(ap.Quantity), RecordedAt: countStamp(ap.RecordedAt)}
			}
			dto.Proposals = append(dto.Proposals, proposal)
		}
		out.Lines = append(out.Lines, dto)
	}
	return out
}
