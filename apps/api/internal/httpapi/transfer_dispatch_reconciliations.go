package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"mime"
	"net/http"
	"strings"
	"unicode/utf8"

	"luson/api/internal/transfers"
)

type dispatchReconciliationMutation struct {
	VariantID        int64
	OperationKey     string
	ExpectedRevision int64
	DispatchQuantity int64
	Reason           string
}

func decodeDispatchReconciliationMutation(r *http.Request, propose bool) (dispatchReconciliationMutation, error) {
	invalid := func() (dispatchReconciliationMutation, error) {
		return dispatchReconciliationMutation{}, transfers.ErrInvalid
	}
	if r == nil || r.Body == nil || len(r.Header.Values("Content-Type")) != 1 {
		return invalid()
	}
	contentType := r.Header.Get("Content-Type")
	media, params, err := mime.ParseMediaType(contentType)
	if err != nil || media != "application/json" || len(params) > 1 || strings.Count(contentType, ";") != len(params) {
		return invalid()
	}
	for key, value := range params {
		if key != "charset" || !strings.EqualFold(value, "utf-8") {
			return invalid()
		}
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, (64<<10)+1))
	if err != nil || len(body) > 64<<10 || !utf8.Valid(body) {
		return invalid()
	}
	d := json.NewDecoder(bytes.NewReader(body))
	d.UseNumber()
	if !transferDelimiter(d, '{') {
		return invalid()
	}
	var in dispatchReconciliationMutation
	seen := map[string]bool{}
	for d.More() {
		key, err := transferString(d)
		if err != nil || seen[key] {
			return invalid()
		}
		seen[key] = true
		switch key {
		case "variant_id":
			in.VariantID, err = transferNumber(d, math.MaxInt32)
		case "operation_key":
			in.OperationKey, err = transferString(d)
		case "expected_revision":
			in.ExpectedRevision, err = countDecimal(d, math.MaxInt64-1)
		case "dispatch_quantity":
			if !propose {
				return invalid()
			}
			in.DispatchQuantity, err = countDecimal(d, math.MaxInt64)
		case "reason":
			in.Reason, err = transferString(d)
		default:
			return invalid()
		}
		if err != nil {
			return invalid()
		}
	}
	required := 4
	if propose {
		required++
	}
	if len(seen) != required || !transferDelimiter(d, '}') {
		return invalid()
	}
	if _, err = d.Token(); err != io.EOF {
		return invalid()
	}
	length := utf8.RuneCountInString(strings.Trim(in.Reason, " "))
	if !countOperationKey.MatchString(in.OperationKey) || strings.ContainsRune(in.Reason, 0) || length < 1 || length > 2000 {
		return invalid()
	}
	return in, nil
}

// registerTransfers exposes only the read (empty action); mutations stay prepared.
// Identity and CSRF use the same server guards as the served bilateral workflows.
func (a *API) transferDispatchReconciliations(store *transfers.Store, action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		verb := http.MethodPost
		if action == "" {
			verb = http.MethodGet
		}
		if !method(w, r, verb) {
			return
		}
		actor, ok := a.inventoryIdentity(w, r)
		if !ok {
			return
		}
		if action != "" {
			site := r.Header.Values("Sec-Fetch-Site")
			if len(site) > 1 || (len(site) == 1 && site[0] != "same-origin") {
				failure(w, 403, "forbidden")
				return
			}
			if !a.GuardMutation(w, r) {
				return
			}
		}
		switch action {
		case "", "propose", "accept", "reject":
		default:
			transferFailure(w, transfers.ErrInvalid)
			return
		}
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			transferFailure(w, transfers.ErrInvalid)
			return
		}
		id, err := canonicalTransferInteger(r.PathValue("id"), math.MaxInt64)
		if err != nil {
			transferFailure(w, err)
			return
		}
		if action == "" {
			snapshot, err := store.GetDispatchReconciliations(r.Context(), actor, id)
			if err != nil {
				transferFailure(w, err)
				return
			}
			respond(w, 200, dispatchReconciliationSnapshotRecord(snapshot))
			return
		}
		// A lightweight private header fence, not a history read or eligibility
		// check: historical operations must remain replayable after later revisions.
		if err = store.CheckDispatchReconciliationAccess(r.Context(), actor, id); err != nil {
			transferFailure(w, err)
			return
		}
		in, err := decodeDispatchReconciliationMutation(r, action == "propose")
		if err != nil {
			transferFailure(w, err)
			return
		}
		var op transfers.DispatchReconciliationOperation
		if action == "propose" {
			op, err = store.ProposeDispatchReconciliation(r.Context(), actor, id, transfers.DispatchReconciliationProposalInput{VariantID: in.VariantID, OperationKey: in.OperationKey, ExpectedRevision: in.ExpectedRevision, DispatchQuantity: in.DispatchQuantity, Reason: in.Reason})
		} else {
			op, err = store.DecideDispatchReconciliation(r.Context(), actor, id, transfers.DispatchReconciliationDecisionInput{VariantID: in.VariantID, OperationKey: in.OperationKey, ExpectedRevision: in.ExpectedRevision, Accept: action == "accept", Reason: in.Reason})
		}
		if err != nil {
			transferFailure(w, err)
			return
		}
		respond(w, 200, dispatchReconciliationOperationRecord(op))
	}
}

// All bigint evidence stays decimal text; only bounded IDs are JSON numbers.
// Nulls and empty arrays are explicit, never omitted or inferred from today.
type dispatchReconciliationOperationDTO struct {
	OperationKey              string  `json:"operation_key"`
	RequestID                 string  `json:"request_id"`
	VariantID                 int64   `json:"variant_id"`
	ActorLocationID           int     `json:"actor_location_id"`
	Action                    string  `json:"action"`
	ExpectedRevision          string  `json:"expected_revision"`
	DispatchQuantity          *string `json:"dispatch_quantity"`
	Reason                    string  `json:"reason"`
	Revision                  string  `json:"revision"`
	SourceExistingBefore      *string `json:"source_existing_before"`
	SourceExistingAfter       *string `json:"source_existing_after"`
	DestinationExistingBefore *string `json:"destination_existing_before"`
	DestinationExistingAfter  *string `json:"destination_existing_after"`
	RecordedAt                string  `json:"recorded_at"`
}
type dispatchReconciliationApplicationDTO struct {
	OperationKey      string `json:"operation_key"`
	EffectiveDispatch string `json:"effective_dispatch"`
	SourceDelta       string `json:"source_delta"`
	DestinationDelta  string `json:"destination_delta"`
	RecordedAt        string `json:"recorded_at"`
}
type dispatchReconciliationProposalDTO struct {
	Revision                 string                                `json:"revision"`
	OperationKey             string                                `json:"operation_key"`
	InitiatorLocationID      int                                   `json:"initiator_location_id"`
	DispatchQuantity         string                                `json:"dispatch_quantity"`
	BaseDispatch             string                                `json:"base_dispatch"`
	BaseActual               string                                `json:"base_actual"`
	BaseCredit               string                                `json:"base_credit"`
	CountGeneration          string                                `json:"count_generation"`
	RestitutionGeneration    string                                `json:"restitution_generation"`
	ReconciliationGeneration string                                `json:"reconciliation_generation"`
	Reason                   string                                `json:"reason"`
	RecordedAt               string                                `json:"recorded_at"`
	State                    string                                `json:"state"`
	Decision                 *countDecisionDTO                     `json:"decision"`
	Application              *dispatchReconciliationApplicationDTO `json:"application"`
}
type dispatchReconciliationLineDTO struct {
	VariantID                int64                               `json:"variant_id"`
	ExpectedQuantity         string                              `json:"expected_quantity"`
	OriginalActual           string                              `json:"actual_quantity"`
	OriginalCredit           string                              `json:"available_quantity"`
	EffectiveDispatch        string                              `json:"effective_dispatch"`
	EffectiveActual          string                              `json:"effective_actual"`
	EffectiveCredit          string                              `json:"effective_credit"`
	AppliedRetainedQuantity  string                              `json:"applied_retained_quantity"`
	WorkflowRevision         string                              `json:"workflow_revision"`
	AppliedRevision          string                              `json:"applied_revision"`
	CountGeneration          string                              `json:"count_generation"`
	CountAppliedRevision     string                              `json:"count_applied_revision"`
	RestitutionGeneration    string                              `json:"restitution_generation"`
	ReconciliationGeneration string                              `json:"reconciliation_generation"`
	Proposals                []dispatchReconciliationProposalDTO `json:"proposals"`
}
type dispatchReconciliationSnapshotDTO struct {
	RequestID  string                               `json:"request_id"`
	Lines      []dispatchReconciliationLineDTO      `json:"lines"`
	Operations []dispatchReconciliationOperationDTO `json:"operations"`
}

func dispatchReconciliationOperationRecord(op transfers.DispatchReconciliationOperation) dispatchReconciliationOperationDTO {
	return dispatchReconciliationOperationDTO{
		OperationKey: op.OperationKey, RequestID: countInt(op.RequestID), VariantID: op.VariantID, ActorLocationID: op.ActorLocationID, Action: op.Action,
		ExpectedRevision: countInt(op.ExpectedRevision), DispatchQuantity: restitutionNullable(op.DispatchQuantity), Reason: op.Reason, Revision: countInt(op.Revision),
		SourceExistingBefore: restitutionNullable(op.SourceExistingBefore), SourceExistingAfter: restitutionNullable(op.SourceExistingAfter),
		DestinationExistingBefore: restitutionNullable(op.DestinationExistingBefore), DestinationExistingAfter: restitutionNullable(op.DestinationExistingAfter), RecordedAt: countStamp(op.RecordedAt),
	}
}
func dispatchReconciliationSnapshotRecord(snapshot transfers.DispatchReconciliations) dispatchReconciliationSnapshotDTO {
	out := dispatchReconciliationSnapshotDTO{RequestID: countInt(snapshot.RequestID), Lines: []dispatchReconciliationLineDTO{}, Operations: []dispatchReconciliationOperationDTO{}}
	for _, op := range snapshot.Operations {
		out.Operations = append(out.Operations, dispatchReconciliationOperationRecord(op))
	}
	for _, line := range snapshot.Lines {
		dto := dispatchReconciliationLineDTO{
			VariantID: line.VariantID, ExpectedQuantity: countInt(line.ExpectedQuantity), OriginalActual: countInt(line.OriginalActual), OriginalCredit: countInt(line.OriginalCredit),
			EffectiveDispatch: countInt(line.EffectiveDispatch), EffectiveActual: countInt(line.EffectiveActual), EffectiveCredit: countInt(line.EffectiveCredit), AppliedRetainedQuantity: countInt(line.AppliedRetainedQuantity),
			WorkflowRevision: countInt(line.WorkflowRevision), AppliedRevision: countInt(line.AppliedRevision), CountGeneration: countInt(line.CountGeneration), CountAppliedRevision: countInt(line.CountAppliedRevision),
			RestitutionGeneration: countInt(line.RestitutionGeneration), ReconciliationGeneration: countInt(line.ReconciliationGeneration), Proposals: []dispatchReconciliationProposalDTO{},
		}
		for _, p := range line.Proposals {
			proposal := dispatchReconciliationProposalDTO{
				Revision: countInt(p.Revision), OperationKey: p.OperationKey, InitiatorLocationID: p.InitiatorLocationID, DispatchQuantity: countInt(p.DispatchQuantity),
				BaseDispatch: countInt(p.BaseDispatch), BaseActual: countInt(p.BaseActual), BaseCredit: countInt(p.BaseCredit), CountGeneration: countInt(p.CountGeneration),
				RestitutionGeneration: countInt(p.RestitutionGeneration), ReconciliationGeneration: countInt(p.ReconciliationGeneration), Reason: p.Reason, RecordedAt: countStamp(p.RecordedAt), State: p.State,
			}
			if d := p.Decision; d != nil {
				proposal.Decision = &countDecisionDTO{OperationKey: d.OperationKey, ActorLocationID: d.ActorLocationID, Accepted: d.Accepted, Reason: d.Reason, RecordedAt: countStamp(d.RecordedAt)}
			}
			if ap := p.Application; ap != nil {
				proposal.Application = &dispatchReconciliationApplicationDTO{OperationKey: ap.OperationKey, EffectiveDispatch: countInt(ap.EffectiveDispatch), SourceDelta: countInt(ap.SourceDelta), DestinationDelta: countInt(ap.DestinationDelta), RecordedAt: countStamp(ap.RecordedAt)}
			}
			dto.Proposals = append(dto.Proposals, proposal)
		}
		out.Lines = append(out.Lines, dto)
	}
	return out
}
