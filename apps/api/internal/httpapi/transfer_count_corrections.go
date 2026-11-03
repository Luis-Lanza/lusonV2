package httpapi

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"luson/api/internal/transfers"
)

var countOperationKey = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

func countDecimal(d *json.Decoder, max int64) (int64, error) {
	value, err := transferString(d)
	if err != nil {
		return 0, err
	}
	if value == "0" {
		return 0, nil
	}
	return canonicalTransferInteger(value, max)
}

// The subtree is a denial route, never a trailing-slash or extra-path alias.
func countCorrectionNotFound(w http.ResponseWriter, r *http.Request) {
	failure(w, 404, "not_found")
}

// Explicit DTOs keep every bigint lossless and every nullable evidence member
// present. Store structs are internal SQL representations, not wire contracts.
type countOperationDTO struct {
	OperationKey     string  `json:"operation_key"`
	RequestID        string  `json:"request_id"`
	VariantID        int64   `json:"variant_id"`
	ActorLocationID  int     `json:"actor_location_id"`
	Action           string  `json:"action"`
	ExpectedRevision string  `json:"expected_revision"`
	Actual           *string `json:"actual_quantity"`
	Reason           string  `json:"reason"`
	Revision         string  `json:"revision"`
	RecordedAt       string  `json:"recorded_at"`
}
type countDecisionDTO struct {
	OperationKey    string `json:"operation_key"`
	ActorLocationID int    `json:"actor_location_id"`
	Accepted        bool   `json:"accepted"`
	Reason          string `json:"reason"`
	RecordedAt      string `json:"recorded_at"`
}
type countApplicationDTO struct {
	EffectiveCredit string `json:"effective_credit"`
	Delta           string `json:"delta"`
	RecordedAt      string `json:"recorded_at"`
}
type countProposalDTO struct {
	Revision            string               `json:"revision"`
	OperationKey        string               `json:"operation_key"`
	InitiatorLocationID int                  `json:"initiator_location_id"`
	Actual              string               `json:"actual_quantity"`
	BaseRevision        string               `json:"base_revision"`
	BaseCredit          string               `json:"base_credit"`
	Reason              string               `json:"reason"`
	RecordedAt          string               `json:"recorded_at"`
	State               string               `json:"state"`
	Decision            *countDecisionDTO    `json:"decision"`
	Application         *countApplicationDTO `json:"application"`
}
type countLineDTO struct {
	EffectiveDispatch      string             `json:"effective_dispatch"`
	ReconciliationRevision string             `json:"reconciliation_revision"`
	VariantID              int64              `json:"variant_id"`
	ExpectedQuantity       string             `json:"expected_quantity"`
	OriginalActual         string             `json:"actual_quantity"`
	OriginalCredit         string             `json:"available_quantity"`
	WorkflowRevision       string             `json:"workflow_revision"`
	AppliedRevision        string             `json:"applied_revision"`
	EffectiveActual        string             `json:"effective_actual"`
	EffectiveCredit        string             `json:"effective_credit"`
	Proposals              []countProposalDTO `json:"proposals"`
}
type countSnapshotDTO struct {
	RequestID  string              `json:"request_id"`
	Lines      []countLineDTO      `json:"lines"`
	Operations []countOperationDTO `json:"operations"`
}

func countInt(n int64) string       { return strconv.FormatInt(n, 10) }
func countStamp(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }
func countOperationRecord(op transfers.CountOperation) countOperationDTO {
	var actual *string
	if op.Actual != nil {
		value := countInt(*op.Actual)
		actual = &value
	}
	return countOperationDTO{op.OperationKey, countInt(op.RequestID), op.VariantID, op.ActorLocationID, op.Action, countInt(op.ExpectedRevision), actual, op.Reason, countInt(op.Revision), countStamp(op.RecordedAt)}
}
func countSnapshotRecord(snapshot transfers.CountCorrections) countSnapshotDTO {
	out := countSnapshotDTO{RequestID: countInt(snapshot.RequestID), Lines: []countLineDTO{}, Operations: []countOperationDTO{}}
	for _, op := range snapshot.Operations {
		out.Operations = append(out.Operations, countOperationRecord(op))
	}
	for _, line := range snapshot.Lines {
		dto := countLineDTO{countInt(line.EffectiveDispatch), countInt(line.ReconciliationRevision), line.VariantID, countInt(line.ExpectedQuantity), countInt(line.OriginalActual), countInt(line.OriginalCredit), countInt(line.WorkflowRevision), countInt(line.AppliedRevision), countInt(line.EffectiveActual), countInt(line.EffectiveCredit), []countProposalDTO{}}
		for _, p := range line.Proposals {
			proposal := countProposalDTO{Revision: countInt(p.Revision), OperationKey: p.OperationKey, InitiatorLocationID: p.InitiatorLocationID, Actual: countInt(p.Actual), BaseRevision: countInt(p.BaseRevision), BaseCredit: countInt(p.BaseCredit), Reason: p.Reason, RecordedAt: countStamp(p.RecordedAt), State: p.State}
			if p.Decision != nil {
				d := p.Decision
				proposal.Decision = &countDecisionDTO{d.OperationKey, d.ActorLocationID, d.Accepted, d.Reason, countStamp(d.RecordedAt)}
			}
			if p.Application != nil {
				ap := p.Application
				proposal.Application = &countApplicationDTO{countInt(ap.EffectiveCredit), countInt(ap.Delta), countStamp(ap.RecordedAt)}
			}
			dto.Proposals = append(dto.Proposals, proposal)
		}
		out.Lines = append(out.Lines, dto)
	}
	return out
}
