package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"luson/api/internal/transfers"
)

// Receipt accepts exactly one items array. Token decoding preserves duplicate
// key detection, canonical decimal strings and existing numeric variant syntax.
func decodeTransferReceipt(r *http.Request) (transfers.ReceiptInput, error) {
	invalid := func() (transfers.ReceiptInput, error) { return transfers.ReceiptInput{}, transfers.ErrInvalid }
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
	// Framing limit comfortably admits the complete preloaded catalogue. There
	// is no smaller arbitrary line cap; unique membership is checked by the store.
	body, err := io.ReadAll(io.LimitReader(r.Body, (64<<10)+1))
	if err != nil || len(body) > 64<<10 || !utf8.Valid(body) {
		return invalid()
	}
	d := json.NewDecoder(bytes.NewReader(body))
	d.UseNumber()
	if !transferDelimiter(d, '{') {
		return invalid()
	}
	key, err := transferString(d)
	if err != nil || key != "items" || !transferDelimiter(d, '[') {
		return invalid()
	}
	in := transfers.ReceiptInput{Items: []transfers.Line{}}
	for d.More() {
		if !transferDelimiter(d, '{') {
			return invalid()
		}
		line := transfers.Line{}
		seen := map[string]bool{}
		for d.More() {
			key, err := transferString(d)
			if err != nil || seen[key] {
				return invalid()
			}
			seen[key] = true
			switch key {
			case "variant_id":
				line.VariantID, err = transferNumber(d, math.MaxInt32)
			case "actual_quantity":
				var value string
				value, err = transferString(d)
				if err == nil {
					if value == "0" {
						line.Quantity = 0
					} else {
						line.Quantity, err = canonicalTransferInteger(value, math.MaxInt64)
					}
				}
			default:
				return invalid()
			}
			if err != nil {
				return invalid()
			}
		}
		if len(seen) != 2 || !transferDelimiter(d, '}') {
			return invalid()
		}
		in.Items = append(in.Items, line)
	}
	if !transferDelimiter(d, ']') || !transferDelimiter(d, '}') {
		return invalid()
	}
	if _, err = d.Token(); err != io.EOF {
		return invalid()
	}
	return transfers.NormalizeReceipt(in)
}

func (a *API) transferReceive(store *transfers.Store) http.HandlerFunc {
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
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			failure(w, 400, "invalid_request")
			return
		}
		id, err := canonicalTransferInteger(r.PathValue("id"), math.MaxInt64)
		if err != nil {
			transferFailure(w, err)
			return
		}
		in, err := decodeTransferReceipt(r)
		if err != nil {
			transferFailure(w, err)
			return
		}
		result, err := store.Receive(r.Context(), actor, id, in)
		if err != nil {
			transferFailure(w, err)
			return
		}
		record, err := transferRecord(result)
		if err != nil {
			transferFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

type receiptLineDTO struct {
	VariantID         int64  `json:"variant_id"`
	ExpectedQuantity  string `json:"expected_quantity"`
	ActualQuantity    string `json:"actual_quantity"`
	AvailableQuantity string `json:"available_quantity"`
}
type receiptExceptionDTO struct {
	VariantID int64  `json:"variant_id"`
	Kind      string `json:"kind"`
	Quantity  string `json:"quantity"`
}
type receiptDTO struct {
	Items      []receiptLineDTO      `json:"items"`
	Exceptions []receiptExceptionDTO `json:"exceptions"`
}

func receiptRecord(r transfers.Request) (*receiptDTO, *string, error) {
	if r.Status != "received" {
		if r.Receipt != nil || r.ReceiptLocationID != nil || r.ReceivedAt != nil {
			return nil, nil, transfers.ErrUnavailable
		}
		return nil, nil, nil
	}
	if r.ReceiptLocationID == nil || *r.ReceiptLocationID != r.Destination.ID || r.ReceivedAt == nil || r.ReceivedAt.IsZero() || r.DispatchedAt == nil || r.ReceivedAt.Before(*r.DispatchedAt) {
		return nil, nil, transfers.ErrUnavailable
	}
	if err := transfers.CheckReceipt(r); err != nil {
		return nil, nil, err
	}
	receipt := &receiptDTO{Items: []receiptLineDTO{}, Exceptions: []receiptExceptionDTO{}}
	for _, line := range r.Receipt.Items {
		receipt.Items = append(receipt.Items, receiptLineDTO{line.VariantID, strconv.FormatInt(line.ExpectedQuantity, 10), strconv.FormatInt(line.ActualQuantity, 10), strconv.FormatInt(line.AvailableQuantity, 10)})
	}
	for _, exception := range r.Receipt.Exceptions {
		receipt.Exceptions = append(receipt.Exceptions, receiptExceptionDTO{exception.VariantID, exception.Kind, strconv.FormatInt(exception.Quantity, 10)})
	}
	stamp := r.ReceivedAt.UTC().Format(time.RFC3339Nano)
	return receipt, &stamp, nil
}
