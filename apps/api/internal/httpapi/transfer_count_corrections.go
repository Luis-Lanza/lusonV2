package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"mime"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"luson/api/internal/transfers"
)

// Count mutations have a closed token-level schema: no coercion, duplicate
// members, actor authority, or client-computed state crosses this boundary.
type countMutation struct {
	VariantID        int64
	OperationKey     string
	ExpectedRevision int64
	Actual           int64
	Reason           string
}

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

func decodeCountMutation(r *http.Request, propose bool) (countMutation, error) {
	invalid := func() (countMutation, error) { return countMutation{}, transfers.ErrInvalid }
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
	var in countMutation
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
		case "actual_quantity":
			if !propose {
				return invalid()
			}
			in.Actual, err = countDecimal(d, math.MaxInt64)
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
	reasonLength := utf8.RuneCountInString(strings.Trim(in.Reason, " "))
	if !countOperationKey.MatchString(in.OperationKey) || strings.ContainsRune(in.Reason, 0) || reasonLength < 1 || reasonLength > 2000 {
		return invalid()
	}
	// Accepted reason is evidence and retry identity, not presentation text.
	return in, nil
}

// The subtree is a denial route, never a trailing-slash or extra-path alias.
func countCorrectionNotFound(w http.ResponseWriter, r *http.Request) {
	failure(w, 404, "not_found")
}

func (a *API) transferCountCorrections(store *transfers.Store, action string) http.HandlerFunc {
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
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			failure(w, 400, "invalid_request")
			return
		}
		id, err := canonicalTransferInteger(r.PathValue("id"), math.MaxInt64)
		if err != nil {
			transferFailure(w, err)
			return
		}
		if action == "" {
			snapshot, err := store.GetCountCorrections(r.Context(), actor, id)
			if err != nil {
				transferFailure(w, err)
				return
			}
			respond(w, 200, countSnapshotRecord(snapshot))
			return
		}
		in, err := decodeCountMutation(r, action == "propose")
		if err != nil {
			transferFailure(w, err)
			return
		}
		var op transfers.CountOperation
		if action == "propose" {
			op, err = store.ProposeCount(r.Context(), actor, id, transfers.CountProposalInput{VariantID: in.VariantID, OperationKey: in.OperationKey, ExpectedRevision: in.ExpectedRevision, Actual: in.Actual, Reason: in.Reason})
		} else {
			op, err = store.DecideCount(r.Context(), actor, id, transfers.CountDecisionInput{VariantID: in.VariantID, OperationKey: in.OperationKey, ExpectedRevision: in.ExpectedRevision, Accept: action == "accept", Reason: in.Reason})
		}
		if err != nil {
			transferFailure(w, err)
			return
		}
		// Return the persisted operation, including on historical replay. Never
		// substitute a freshly loaded workflow head for uncertain-write recovery.
		respond(w, 200, countOperationRecord(op))
	}
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
	VariantID        int64              `json:"variant_id"`
	ExpectedQuantity string             `json:"expected_quantity"`
	OriginalActual   string             `json:"actual_quantity"`
	OriginalCredit   string             `json:"available_quantity"`
	WorkflowRevision string             `json:"workflow_revision"`
	AppliedRevision  string             `json:"applied_revision"`
	EffectiveActual  string             `json:"effective_actual"`
	EffectiveCredit  string             `json:"effective_credit"`
	Proposals        []countProposalDTO `json:"proposals"`
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
		dto := countLineDTO{line.VariantID, countInt(line.ExpectedQuantity), countInt(line.OriginalActual), countInt(line.OriginalCredit), countInt(line.WorkflowRevision), countInt(line.AppliedRevision), countInt(line.EffectiveActual), countInt(line.EffectiveCredit), []countProposalDTO{}}
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
