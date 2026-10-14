package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"mime"
	"net/http"
	"strings"
	"unicode/utf8"

	"luson/api/internal/auth"
	"luson/api/internal/transfers"
)

type restitutionMutation struct {
	VariantID        int64
	OperationKey     string
	ExpectedRevision int64
	RetainedQuantity int64
	RetainedAtOrigin bool
	Reason           string
}

// This seam starts after production authentication and mutation guards. It does
// not replace the concrete auth service or confer action-specific authority.
type restitutionStore interface {
	CheckRestitutionAccess(context.Context, auth.Identity, int64) error
	ProposeRestitution(context.Context, auth.Identity, int64, transfers.RestitutionProposalInput) (transfers.RestitutionOperation, error)
	DecideRestitution(context.Context, auth.Identity, int64, transfers.RestitutionDecisionInput) (transfers.RestitutionOperation, error)
	GetRestitutions(context.Context, auth.Identity, int64) (transfers.Restitutions, error)
}

func decodeRestitutionMutation(r *http.Request, propose bool) (restitutionMutation, error) {
	invalid := func() (restitutionMutation, error) { return restitutionMutation{}, transfers.ErrInvalid }
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
	var in restitutionMutation
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
		case "retained_quantity":
			if !propose {
				return invalid()
			}
			in.RetainedQuantity, err = countDecimal(d, math.MaxInt64)
		case "retained_at_origin":
			if !propose {
				return invalid()
			}
			var token json.Token
			token, err = d.Token()
			value, ok := token.(bool)
			if !ok || !value {
				return invalid()
			}
			in.RetainedAtOrigin = value
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
		required = 6
	}
	if len(seen) != required || !transferDelimiter(d, '}') {
		return invalid()
	}
	if _, err = d.Token(); err != io.EOF {
		return invalid()
	}
	length := utf8.RuneCountInString(strings.Trim(in.Reason, " "))
	if !countOperationKey.MatchString(in.OperationKey) || strings.ContainsRune(in.Reason, 0) || length < 1 || length > 2000 || (propose && (in.RetainedQuantity < 1 || !in.RetainedAtOrigin)) {
		return invalid()
	}
	// Evidence bytes are also operation identity. Never normalize accepted text.
	return in, nil
}

func restitutionNotFound(w http.ResponseWriter, r *http.Request) { failure(w, 404, "not_found") }
func (a *API) transferRestitutions(store *transfers.Store, action string) http.HandlerFunc {
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
		dispatchRestitution(w, r, actor, store, action)
	}
}

func dispatchRestitution(w http.ResponseWriter, r *http.Request, actor auth.Identity, store restitutionStore, action string) {
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
		snapshot, err := store.GetRestitutions(r.Context(), actor, id)
		if err != nil {
			transferFailure(w, err)
			return
		}
		respond(w, 200, restitutionSnapshotRecord(snapshot))
		return
	}
	// Header-only privacy fence precedes even malformed body decoding. Full
	// history is deliberately not a dependency of durable mutation replay.
	if err = store.CheckRestitutionAccess(r.Context(), actor, id); err != nil {
		transferFailure(w, err)
		return
	}
	in, err := decodeRestitutionMutation(r, action == "propose")
	if err != nil {
		transferFailure(w, err)
		return
	}
	var op transfers.RestitutionOperation
	if action == "propose" {
		op, err = store.ProposeRestitution(r.Context(), actor, id, transfers.RestitutionProposalInput{VariantID: in.VariantID, OperationKey: in.OperationKey, ExpectedRevision: in.ExpectedRevision, RetainedQuantity: in.RetainedQuantity, RetainedAtOrigin: in.RetainedAtOrigin, Reason: in.Reason})
	} else {
		op, err = store.DecideRestitution(r.Context(), actor, id, transfers.RestitutionDecisionInput{VariantID: in.VariantID, OperationKey: in.OperationKey, ExpectedRevision: in.ExpectedRevision, Accept: action == "accept", Reason: in.Reason})
	}
	if err != nil {
		transferFailure(w, err)
		return
	}
	respond(w, 200, restitutionOperationRecord(op))
}

// Explicit wire DTOs keep bigint evidence lossless, nulls present and internal
// SQL representations separate from transport. All dates are canonical UTC.
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
