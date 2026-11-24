package httpapi

import (
	"net/http"
	"strconv"

	"luson/api/internal/warrantycase"
)

// This file serves the loan receipt of a battery case (S8): the one-page paper the client
// leaves with when the branch hands over a used battery in exchange for the claim. It is the
// sibling of the warranty of a sale, and it carries the same guards: one method, the session
// identity, no query string, and a stable file name built from the number the database wrote.
//
// The document itself is composed from persisted data only (internal/warrantycase), so this
// file decides neither a value nor a date: it asks the store for the persisted receipt, names
// the download after the case and writes the bytes the renderer produced. A case without a
// loan to print, a case of another branch and a finding on the shelf are refused with the
// code the store's own decision names.

const (
	// warrantyReceiptPath is the printable loan receipt of one case, a literal suffix of the
	// {id} pattern so the case id is still one segment.
	warrantyReceiptPath = "/receipt.pdf"
	// warrantyReceiptMaxFilenameName is the bound of the case number a download may be named
	// after, exactly like the bound of the warranty's file name.
	warrantyReceiptMaxFilenameName = 32
)

// warrantyReceiptFilename is the stable download name of one receipt: the number the database
// allocated, ASCII only, so a client saves the document it is looking at and two cases never
// share a file name. A number that is not the frozen format -- the letter form of the mockup
// included -- cannot name a file, so it fails closed.
func warrantyReceiptFilename(number string) (string, bool) {
	if number == "" || len(number) > warrantyReceiptMaxFilenameName {
		return "", false
	}
	for i := 0; i < len(number); i++ {
		if ch := number[i]; (ch < '0' || ch > '9') && ch != '-' && ch != 'C' {
			return "", false
		}
	}
	// The name is the case number's own, so it must be the case's number and not any
	// dash-and-digit text: the shape is the one the database writes (S20).
	if !warrantyCaseNumberPattern.MatchString(number) {
		return "", false
	}
	return "comprobante-" + number + ".pdf", true
}

// warrantyCaseReceipt serves the printable loan receipt of one case as a download. It carries
// the guards of the case read -- the method, the session identity, no query string, the same
// rules for a segment that is not a case id and for a case of another branch -- and answers
// the document itself with the stable file name and the headers a download needs. A render
// failure is service_unavailable: a receipt is either the whole paper or nothing.
func (a *API) warrantyCaseReceipt(store *warrantycase.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodGet) {
			return
		}
		actor, ok := a.warrantyActorOf(w, r)
		if !ok {
			return
		}
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			failure(w, 400, "invalid_request")
			return
		}
		id, err := warrantyCasePathID(r.PathValue("id"), warrantyCaseMaxID)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		receipt, err := store.Receipt(r.Context(), actor, id)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		filename, ok := warrantyReceiptFilename(receipt.CaseNumber)
		if !ok {
			failure(w, 503, "service_unavailable")
			return
		}
		pdf, err := warrantycase.RenderReceipt(receipt)
		if err != nil {
			failure(w, 503, "service_unavailable")
			return
		}
		w.Header().Set("Content-Type", "application/pdf")
		w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
		w.Header().Set("Content-Length", strconv.Itoa(len(pdf)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(pdf)
	}
}
