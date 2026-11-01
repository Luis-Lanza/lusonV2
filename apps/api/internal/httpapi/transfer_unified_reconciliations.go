package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"luson/api/internal/transfers"
	"math"
	"mime"
	"net/http"
	"strings"
	"unicode/utf8"
)

// The body carries intent only. Actor, baselines and decision action are server-owned.
type unifiedReconciliationMutation struct {
	VariantID        int64
	OperationKey     string
	ExpectedRevision int64
	DispatchQuantity int64
	ArrivalQuantity  int64
	RetainedQuantity int64
	RetainedAtOrigin bool
	Reason           string
}

func decodeUnifiedReconciliationMutation(r *http.Request, propose bool) (unifiedReconciliationMutation, error) {
	invalid := func() (unifiedReconciliationMutation, error) {
		return unifiedReconciliationMutation{}, transfers.ErrInvalid
	}
	if r == nil || r.Body == nil || len(r.Header.Values("Content-Type")) != 1 {
		return invalid()
	}
	contentType := r.Header.Get("Content-Type")
	media, params, err := mime.ParseMediaType(contentType)
	if err != nil || media != "application/json" || len(params) > 1 || strings.Count(contentType, ";") != len(params) {
		return invalid()
	}
	for k, v := range params {
		if k != "charset" || !strings.EqualFold(v, "utf-8") {
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
	var in unifiedReconciliationMutation
	seen := map[string]bool{}
	for d.More() {
		key, e := transferString(d)
		if e != nil || seen[key] {
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
		case "reason":
			in.Reason, err = transferString(d)
		case "retained_at_origin":
			var token any
			token, err = d.Token()
			var ok bool
			in.RetainedAtOrigin, ok = token.(bool)
			if !ok {
				return invalid()
			}
		case "dispatch_quantity", "arrival_quantity", "retained_quantity":
			if !propose {
				return invalid()
			}
			var value int64
			value, err = countDecimal(d, math.MaxInt64)
			switch key {
			case "dispatch_quantity":
				in.DispatchQuantity = value
			case "arrival_quantity":
				in.ArrivalQuantity = value
			case "retained_quantity":
				in.RetainedQuantity = value
			}
		default:
			return invalid()
		}
		if err != nil {
			return invalid()
		}
	}
	required := 5
	if propose {
		required += 3
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

type UnifiedReconciliationOperationDTO struct {
	OperationKey              string  `json:"operation_key"`
	RequestID                 string  `json:"request_id"`
	VariantID                 int64   `json:"variant_id"`
	ActorLocationID           int     `json:"actor_location_id"`
	Action                    string  `json:"action"`
	ExpectedRevision          string  `json:"expected_revision"`
	DispatchQuantity          *string `json:"dispatch_quantity"`
	ArrivalQuantity           *string `json:"arrival_quantity"`
	RetainedQuantity          *string `json:"retained_quantity"`
	RetainedAtOrigin          bool    `json:"retained_at_origin"`
	Reason                    string  `json:"reason"`
	Revision                  string  `json:"revision"`
	SourceExistingBefore      *string `json:"source_existing_before"`
	SourceExistingAfter       *string `json:"source_existing_after"`
	DestinationExistingBefore *string `json:"destination_existing_before"`
	DestinationExistingAfter  *string `json:"destination_existing_after"`
	RecordedAt                string  `json:"recorded_at"`
}

func wireUnifiedReconciliationOperation(in transfers.UnifiedReconciliationOperation) UnifiedReconciliationOperationDTO {
	out := UnifiedReconciliationOperationDTO{}
	out.OperationKey = in.OperationKey
	out.RequestID = countInt(in.RequestID)
	out.VariantID = in.VariantID
	out.ActorLocationID = in.ActorLocationID
	out.Action = in.Action
	out.ExpectedRevision = countInt(in.ExpectedRevision)
	out.DispatchQuantity = restitutionNullable(in.DispatchQuantity)
	out.ArrivalQuantity = restitutionNullable(in.ArrivalQuantity)
	out.RetainedQuantity = restitutionNullable(in.RetainedQuantity)
	out.RetainedAtOrigin = in.RetainedAtOrigin
	out.Reason = in.Reason
	out.Revision = countInt(in.Revision)
	out.SourceExistingBefore = restitutionNullable(in.SourceExistingBefore)
	out.SourceExistingAfter = restitutionNullable(in.SourceExistingAfter)
	out.DestinationExistingBefore = restitutionNullable(in.DestinationExistingBefore)
	out.DestinationExistingAfter = restitutionNullable(in.DestinationExistingAfter)
	out.RecordedAt = countStamp(in.RecordedAt)
	return out
}

type UnifiedReconciliationApplicationDTO struct {
	OperationKey     string `json:"operation_key"`
	SourceDelta      string `json:"source_delta"`
	DestinationDelta string `json:"destination_delta"`
}

func wireUnifiedReconciliationApplication(in transfers.UnifiedReconciliationApplication) UnifiedReconciliationApplicationDTO {
	out := UnifiedReconciliationApplicationDTO{}
	out.OperationKey = in.OperationKey
	out.SourceDelta = countInt(in.SourceDelta)
	out.DestinationDelta = countInt(in.DestinationDelta)
	return out
}

type UnifiedReconciliationDecisionDTO struct {
	OperationKey     string `json:"operation_key"`
	ActorLocationID  int    `json:"actor_location_id"`
	Accepted         bool   `json:"accepted"`
	RetainedAtOrigin bool   `json:"retained_at_origin"`
	Reason           string `json:"reason"`
	RecordedAt       string `json:"recorded_at"`
}

func wireUnifiedReconciliationDecision(in transfers.UnifiedReconciliationDecision) UnifiedReconciliationDecisionDTO {
	out := UnifiedReconciliationDecisionDTO{}
	out.OperationKey = in.OperationKey
	out.ActorLocationID = in.ActorLocationID
	out.Accepted = in.Accepted
	out.RetainedAtOrigin = in.RetainedAtOrigin
	out.Reason = in.Reason
	out.RecordedAt = countStamp(in.RecordedAt)
	return out
}

type UnifiedReconciliationProposalDTO struct {
	Revision                 string                               `json:"revision"`
	OperationKey             string                               `json:"operation_key"`
	InitiatorLocationID      int                                  `json:"initiator_location_id"`
	DispatchQuantity         string                               `json:"dispatch_quantity"`
	ArrivalQuantity          string                               `json:"arrival_quantity"`
	RetainedQuantity         string                               `json:"retained_quantity"`
	RetainedAtOrigin         bool                                 `json:"retained_at_origin"`
	BaseSourceDebit          string                               `json:"base_source_debit"`
	BaseDestinationCredit    string                               `json:"base_destination_credit"`
	CountGeneration          string                               `json:"count_generation"`
	RestitutionGeneration    string                               `json:"restitution_generation"`
	ReconciliationGeneration string                               `json:"reconciliation_generation"`
	UnifiedGeneration        string                               `json:"unified_generation"`
	Reason                   string                               `json:"reason"`
	RecordedAt               string                               `json:"recorded_at"`
	State                    string                               `json:"state"`
	Decision                 *UnifiedReconciliationDecisionDTO    `json:"decision"`
	Application              *UnifiedReconciliationApplicationDTO `json:"application"`
}

func wireUnifiedReconciliationProposal(in transfers.UnifiedReconciliationProposal) UnifiedReconciliationProposalDTO {
	out := UnifiedReconciliationProposalDTO{}
	out.Revision = countInt(in.Revision)
	out.OperationKey = in.OperationKey
	out.InitiatorLocationID = in.InitiatorLocationID
	out.DispatchQuantity = countInt(in.DispatchQuantity)
	out.ArrivalQuantity = countInt(in.ArrivalQuantity)
	out.RetainedQuantity = countInt(in.RetainedQuantity)
	out.RetainedAtOrigin = in.RetainedAtOrigin
	out.BaseSourceDebit = countInt(in.BaseSourceDebit)
	out.BaseDestinationCredit = countInt(in.BaseDestinationCredit)
	out.CountGeneration = countInt(in.CountGeneration)
	out.RestitutionGeneration = countInt(in.RestitutionGeneration)
	out.ReconciliationGeneration = countInt(in.ReconciliationGeneration)
	out.UnifiedGeneration = countInt(in.UnifiedGeneration)
	out.Reason = in.Reason
	out.RecordedAt = countStamp(in.RecordedAt)
	out.State = in.State
	if in.Decision != nil {
		v := wireUnifiedReconciliationDecision(*in.Decision)
		out.Decision = &v
	}
	if in.Application != nil {
		v := wireUnifiedReconciliationApplication(*in.Application)
		out.Application = &v
	}
	return out
}

type UnifiedReconciliationLineStateDTO struct {
	VariantID         int64                              `json:"variant_id"`
	ExpectedQuantity  string                             `json:"expected_quantity"`
	OriginalActual    string                             `json:"actual_quantity"`
	OriginalCredit    string                             `json:"available_quantity"`
	WorkflowRevision  string                             `json:"workflow_revision"`
	AppliedRevision   string                             `json:"applied_revision"`
	UnifiedGeneration string                             `json:"unified_generation"`
	Proposals         []UnifiedReconciliationProposalDTO `json:"proposals"`
}

func wireUnifiedReconciliationLineState(in transfers.UnifiedReconciliationLineState) UnifiedReconciliationLineStateDTO {
	out := UnifiedReconciliationLineStateDTO{}
	out.VariantID = in.VariantID
	out.ExpectedQuantity = countInt(in.ExpectedQuantity)
	out.OriginalActual = countInt(in.OriginalActual)
	out.OriginalCredit = countInt(in.OriginalCredit)
	out.WorkflowRevision = countInt(in.WorkflowRevision)
	out.AppliedRevision = countInt(in.AppliedRevision)
	out.UnifiedGeneration = countInt(in.UnifiedGeneration)
	out.Proposals = []UnifiedReconciliationProposalDTO{}
	for _, v := range in.Proposals {
		out.Proposals = append(out.Proposals, wireUnifiedReconciliationProposal(v))
	}
	return out
}

type UnifiedGenerationsDTO struct {
	Count       string `json:"count"`
	Restitution string `json:"restitution"`
	Dispatch    string `json:"dispatch"`
	Unified     string `json:"unified"`
}

func wireUnifiedGenerations(in transfers.UnifiedGenerations) UnifiedGenerationsDTO {
	out := UnifiedGenerationsDTO{}
	out.Count = countInt(in.Count)
	out.Restitution = countInt(in.Restitution)
	out.Dispatch = countInt(in.Dispatch)
	out.Unified = countInt(in.Unified)
	return out
}

type UnifiedOriginalLineDTO struct {
	VariantID         int64  `json:"variant_id"`
	ExpectedQuantity  string `json:"expected_quantity"`
	ActualQuantity    string `json:"actual_quantity"`
	AvailableQuantity string `json:"available_quantity"`
}

func wireUnifiedOriginalLine(in transfers.UnifiedOriginalLine) UnifiedOriginalLineDTO {
	out := UnifiedOriginalLineDTO{}
	out.VariantID = in.VariantID
	out.ExpectedQuantity = countInt(in.ExpectedQuantity)
	out.ActualQuantity = countInt(in.ActualQuantity)
	out.AvailableQuantity = countInt(in.AvailableQuantity)
	return out
}

type UnifiedCurrentLineDTO struct {
	VariantID               int64                 `json:"variant_id"`
	Owner                   string                `json:"owner"`
	Source                  string                `json:"source"`
	ApplicationOperationKey *string               `json:"application_operation_key"`
	AppliedRevision         string                `json:"applied_revision"`
	Version                 UnifiedGenerationsDTO `json:"version"`
	EffectiveDispatch       string                `json:"effective_dispatch"`
	EffectiveActual         string                `json:"effective_actual"`
	EffectiveCredit         string                `json:"effective_credit"`
	SourceDebit             string                `json:"source_debit"`
	RetainedQuantity        *string               `json:"retained_quantity"`
	OriginUnknown           *string               `json:"origin_unknown"`
	TransitUnknown          *string               `json:"transit_unknown"`
	Excess                  *string               `json:"excess"`
}

func wireUnifiedCurrentLine(in transfers.UnifiedCurrentLine) UnifiedCurrentLineDTO {
	out := UnifiedCurrentLineDTO{}
	out.VariantID = in.VariantID
	out.Owner = in.Owner
	out.Source = in.Source
	out.ApplicationOperationKey = in.ApplicationOperationKey
	out.AppliedRevision = countInt(in.AppliedRevision)
	out.Version = wireUnifiedGenerations(in.Version)
	out.EffectiveDispatch = countInt(in.EffectiveDispatch)
	out.EffectiveActual = countInt(in.EffectiveActual)
	out.EffectiveCredit = countInt(in.EffectiveCredit)
	out.SourceDebit = countInt(in.SourceDebit)
	out.RetainedQuantity = restitutionNullable(in.RetainedQuantity)
	out.OriginUnknown = restitutionNullable(in.OriginUnknown)
	out.TransitUnknown = restitutionNullable(in.TransitUnknown)
	out.Excess = restitutionNullable(in.Excess)
	return out
}

type unifiedLegacyDTO struct {
	Count       countSnapshotDTO                  `json:"count"`
	Restitution restitutionSnapshotDTO            `json:"restitution"`
	Dispatch    dispatchReconciliationSnapshotDTO `json:"dispatch"`
}
type unifiedSnapshotDTO struct {
	Schema                string                              `json:"schema"`
	RequestID             string                              `json:"request_id"`
	OriginLocationID      int                                 `json:"origin_location_id"`
	DestinationLocationID int                                 `json:"destination_location_id"`
	ReceivedAt            string                              `json:"received_at"`
	Original              []UnifiedOriginalLineDTO            `json:"original"`
	Legacy                unifiedLegacyDTO                    `json:"legacy"`
	Current               []UnifiedCurrentLineDTO             `json:"current"`
	Lines                 []UnifiedReconciliationLineStateDTO `json:"lines"`
	Operations            []UnifiedReconciliationOperationDTO `json:"operations"`
}

func unifiedReconciliationSnapshotRecord(in transfers.UnifiedReconciliations) unifiedSnapshotDTO {
	out := unifiedSnapshotDTO{Schema: in.Schema, RequestID: countInt(in.RequestID), OriginLocationID: in.OriginLocationID, DestinationLocationID: in.DestinationLocationID, ReceivedAt: countStamp(in.ReceivedAt), Original: []UnifiedOriginalLineDTO{}, Current: []UnifiedCurrentLineDTO{}, Lines: []UnifiedReconciliationLineStateDTO{}, Operations: []UnifiedReconciliationOperationDTO{}, Legacy: unifiedLegacyDTO{countSnapshotRecord(in.Legacy.Count), restitutionSnapshotRecord(in.Legacy.Restitution), dispatchReconciliationSnapshotRecord(in.Legacy.Dispatch)}}
	for _, v := range in.Original {
		out.Original = append(out.Original, wireUnifiedOriginalLine(v))
	}
	for _, v := range in.Current {
		out.Current = append(out.Current, wireUnifiedCurrentLine(v))
	}
	for _, v := range in.Lines {
		out.Lines = append(out.Lines, wireUnifiedReconciliationLineState(v))
	}
	for _, v := range in.Operations {
		out.Operations = append(out.Operations, wireUnifiedReconciliationOperation(v))
	}
	return out
}

type unifiedOperationEnvelopeDTO struct {
	Schema    string                            `json:"schema"`
	Operation UnifiedReconciliationOperationDTO `json:"operation"`
}

func (a *API) transferUnifiedReconciliationMutation(store *transfers.Store, action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodPost) {
			return
		}
		actor, ok := a.inventoryIdentity(w, r)
		if !ok {
			return
		}
		site := r.Header.Values("Sec-Fetch-Site")
		if len(site) > 1 || (len(site) == 1 && site[0] != "same-origin") {
			failure(w, 403, "forbidden")
			return
		}
		if !a.GuardMutation(w, r) {
			return
		}
		if action != "propose" && action != "accept" && action != "reject" {
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
		// Private header admission only: never consult today's head before exact retry lookup.
		if err = store.CheckRestitutionAccess(r.Context(), actor, id); err != nil {
			transferFailure(w, err)
			return
		}
		in, err := decodeUnifiedReconciliationMutation(r, action == "propose")
		if err != nil {
			transferFailure(w, err)
			return
		}
		var op transfers.UnifiedReconciliationOperation
		if action == "propose" {
			op, err = store.ProposeUnifiedReconciliation(r.Context(), actor, id, transfers.UnifiedReconciliationProposalInput{
				VariantID: in.VariantID, OperationKey: in.OperationKey, ExpectedRevision: in.ExpectedRevision,
				DispatchQuantity: in.DispatchQuantity, ArrivalQuantity: in.ArrivalQuantity, RetainedQuantity: in.RetainedQuantity,
				RetainedAtOrigin: in.RetainedAtOrigin, Reason: in.Reason})
		} else {
			op, err = store.DecideUnifiedReconciliation(r.Context(), actor, id, transfers.UnifiedReconciliationDecisionInput{
				VariantID: in.VariantID, OperationKey: in.OperationKey, ExpectedRevision: in.ExpectedRevision,
				Accept: action == "accept", RetainedAtOrigin: in.RetainedAtOrigin, Reason: in.Reason})
		}
		if err != nil {
			transferFailure(w, err)
			return
		}
		respond(w, 200, unifiedOperationEnvelopeDTO{Schema: "luson.transfer-reconciliation-operation/v2", Operation: wireUnifiedReconciliationOperation(op)})
	}
}

func (a *API) transferUnifiedReconciliations(store *transfers.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodGet) {
			return
		}
		actor, ok := a.inventoryIdentity(w, r)
		if !ok {
			return
		}
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			failure(w, 400, "invalid_request")
			return
		}
		id, err := canonicalTransferInteger(r.PathValue("id"), math.MaxInt64)
		if err != nil {
			transferFailure(w, err)
			return
		}
		snapshot, err := store.GetUnifiedReconciliations(r.Context(), actor, id)
		if err != nil {
			transferFailure(w, err)
			return
		}
		respond(w, 200, unifiedReconciliationSnapshotRecord(snapshot))
	}
}
