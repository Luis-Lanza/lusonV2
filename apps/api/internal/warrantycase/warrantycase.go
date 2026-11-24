// Package warrantycase owns the warranty-claim door of the battery case: the document a
// battery gets when a client brings it back under the warranty of a sale, the used battery
// that is lent while the claim is reviewed, the journey of the reported battery and the
// resolution the warehouse and the factory reach.
//
// A claim is judged against the sale and never against a fresh reading of the term (S2, S3):
// the serial the client brings resolves the sold unit and its sale, the database refuses a
// serial nobody sold (LW002), a unit sold without a term (LW003) and a term that has already
// run out (LW004), and the term always counts from the sale's own date. Nothing here writes
// `sale_units` or `sales`, so a factory replacement never restarts the promise.
//
// A loan names a model code and a quantity and never a serial as an identity (S5). The serial
// of a used battery is optional free text, two loans of the same model and quantity are two
// independent rows, and a case holds as many loans as it needs because a failed used battery
// is marked and replaced on the same case (S7). The source location is recorded and nothing
// moves: a loan writes no transfer, no balance and no used-battery stock (S6, S18).
//
// The journey is the append-only history of the case (S9). Every tramo carries its actor,
// its instant and its note, the phase is the phase of the last tramo, a transition outside
// the frozen order is refused with nothing written, the factory shipment carries the file
// number the warehouse transcribes by hand, and the warehouse can refuse before the factory
// with its own verdict and a mandatory motive (S10).
//
// A claim resolution states the verdict and where the reported battery and the lent battery
// end (S11). The stock destination is never stated by a claim, because a claim never had
// branch stock in play. The frozen vocabulary of S23 is the only one this package accepts; the
// database refuses it too.
//
// Three facts of a case are not phases of its journey (S13, S14, S19): the notice the branch
// registers for the client, the release the warehouse authorises and the delivery that closes the
// case. They are tramos of the same append-only history with a kind of their own, so a notice never
// reads as a step of the journey and S23's six phases stay frozen. The branch that owns the case
// registers the notice and delivers the exchange; the warehouse authorises the release and never does
// either, because the warehouse moves the battery and answers to no client. The release is the one
// stock write of the claim door and the exact mirror of the finding's write-off (067): the units the
// case holds in custody become sellable stock of the case's own branch, once.
package warrantycase

import (
	"errors"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	"luson/api/internal/purchases"
	"luson/api/internal/sales"
)

var (
	// ErrInvalid is the refusal of a shape this contract could not have written: an
	// unknown vocabulary value, an empty declaration, a loan without a model or a quantity
	// outside the frozen bounds.
	ErrInvalid = errors.New("invalid warranty case")
	// ErrForbidden is the refusal of an actor outside the branch that owns the case, of the
	// warehouse opening or lending, and of a session that still must change its password.
	ErrForbidden = errors.New("warranty case forbidden")
	// ErrNotFound is the refusal of an unknown case or loan.
	ErrNotFound = errors.New("warranty case not found")
	// ErrUnavailable is the failure of the store itself, never a client's mistake.
	ErrUnavailable = errors.New("warranty case store unavailable")

	// The three refusals of the claim door, each mapped from its own LW code (S2).
	ErrSerialNotSold   = errors.New("the claimed serial number was never sold")
	ErrNoWarranty      = errors.New("the claimed unit was sold without a warranty term")
	ErrWarrantyExpired = errors.New("the warranty term of the claimed unit has expired")

	// ErrClaimOnly is the refusal of a resolution on the stock-defect door, which this
	// package does not handle: the branch's shelf is another slice's document.
	ErrClaimOnly = errors.New("only a warranty claim is resolved here")

	// ErrTransition is the refusal of a phase outside the frozen order (S9).
	ErrTransition = errors.New("the phase transition is not allowed")
	// ErrResolutionRequired says a case reaches `resolved` through its resolution and
	// never through a bare transition, because the verdict and the destinations are the
	// facts that make it resolved.
	ErrResolutionRequired = errors.New("the case reaches resolved through its resolution")
	// ErrResolutionFinal says a case is resolved once and the decision is not rewritten.
	ErrResolutionFinal = errors.New("the resolution of a case is final")
	// ErrFactoryFileRequired says the factory shipment carries its file number.
	ErrFactoryFileRequired = errors.New("the factory shipment requires its file number")
	// ErrFactoryFileOnlyOnShipment says the file number belongs to the factory shipment and
	// to no other tramo (S9, S10).
	ErrFactoryFileOnlyOnShipment = errors.New("the factory file number belongs only to the factory shipment")
	// ErrWarehouseVerdict says the warehouse refuses before the factory and only with
	// `refused_at_warehouse`; the factory verdicts belong to the factory tramo (S10).
	ErrWarehouseVerdict = errors.New("the warehouse refuses before the factory with its own verdict")
	// ErrNoteRequired says the warehouse refusal carries its motive.
	ErrNoteRequired = errors.New("the warehouse refusal requires its motive")

	// ErrLoanFateFinal says a decided loan fate is final: a failed loan is replaced by
	// another loan of the same case (S7).
	ErrLoanFateFinal = errors.New("a decided loan fate is final")
	// ErrLoanFateOpen says only a decided fate is recorded: the loan is born open.
	ErrLoanFateOpen = errors.New("a loan is born open and its fate is decided afterwards")
	// ErrNoStock is the refusal of a finding the branch does not have on its shelf (LW016): a
	// write-off never invents a balance and never leaves negative stock.
	ErrNoStock = errors.New("the branch does not have that many batteries in stock")
	// ErrReservedStock is the refusal of a write-off that would leave the balance below the stock the
	// branch already promised (LW017).
	ErrReservedStock = errors.New("the write-off would take stock the branch already reserved")

	// The facts of S13, S14 and S19 that are not phases. A case registers its notice and its release
	// once each, the release requires the notice, and neither is stated before the factory answered.
	ErrAlreadyReleased   = errors.New("a case registers one notice and one release")
	ErrNoticeRequired    = errors.New("a release requires a registered notice")
	ErrResolutionPending = errors.New("the factory has not answered the case yet")
	// ErrReleaseUnavailable is the refusal of a release of a unit that never came back to the branch:
	// a battery the factory kept, scrapped or sent to the used pool is not the branch's sellable stock.
	ErrReleaseUnavailable = errors.New("the case holds no unit to release")

	// ErrMatrix says the destinations do not match the verdict the factory reached. The
	// named usages check accepts only the combinations S11 states; a claim never states a
	// stock destination, and `not_covered` leaves the loan with the client.
	ErrMatrix = errors.New("the resolution destinations do not match the verdict")
)

// PhaseRefusal names the two phases of a refused transition, so a caller can point at the
// exact tramo instead of only reporting that the journey did not move.
type PhaseRefusal struct {
	From Phase
	To   Phase
}

func (e *PhaseRefusal) Error() string {
	return "the case cannot move from " + string(e.From) + " to " + string(e.To)
}

// Unwrap keeps errors.Is(err, ErrTransition) true.
func (e *PhaseRefusal) Unwrap() error { return ErrTransition }

// Origin is the door the case came through (S1, S23). This package handles the claim.
type Origin string

const (
	OriginWarrantyClaim Origin = "warranty_claim"
	OriginStockDefect   Origin = "stock_defect"
)

// Valid reports whether the origin is one of the frozen two.
func (o Origin) Valid() bool { return o == OriginWarrantyClaim || o == OriginStockDefect }

// Phase is one tramo of the journey (S9, S23).
type Phase string

const (
	PhaseReceived    Phase = "received"
	PhaseInTransit   Phase = "in_transit"
	PhaseAtWarehouse Phase = "at_warehouse"
	PhaseAtFactory   Phase = "at_factory"
	PhaseResolved    Phase = "resolved"
	PhaseClosed      Phase = "closed"
)

// Valid reports whether the phase is one of the frozen six.
func (p Phase) Valid() bool {
	switch p {
	case PhaseReceived, PhaseInTransit, PhaseAtWarehouse, PhaseAtFactory, PhaseResolved, PhaseClosed:
		return true
	}
	return false
}

// EventKind is what one tramo of the history states: a step of the journey, the notice the branch
// registers for the client, or the release the warehouse authorises. A notice and a release carry the
// phase the case already holds, because neither of them moves it.
type EventKind string

const (
	// KindPhase is a tramo of the journey: it enters a phase the case was not in (S9).
	KindPhase EventKind = "phase"
	// KindNotice is the notice the branch registers for the client of the case (S14).
	KindNotice EventKind = "notice"
	// KindRelease is the release the warehouse authorises: custody becomes sellable stock (S14).
	KindRelease EventKind = "release"
)

// Valid reports whether the kind is one of the frozen three.
func (k EventKind) Valid() bool {
	return k == KindPhase || k == KindNotice || k == KindRelease
}

// Verdict is the decision the warehouse or the factory reached (S11, S23).
type Verdict string

const (
	VerdictRepaired           Verdict = "repaired"
	VerdictReplaced           Verdict = "replaced"
	VerdictUnrepairable       Verdict = "unrepairable"
	VerdictNotCovered         Verdict = "not_covered"
	VerdictLost               Verdict = "lost"
	VerdictRefusedAtWarehouse Verdict = "refused_at_warehouse"
)

// Valid reports whether the verdict is one of the frozen six.
func (v Verdict) Valid() bool {
	switch v {
	case VerdictRepaired, VerdictReplaced, VerdictUnrepairable, VerdictNotCovered,
		VerdictLost, VerdictRefusedAtWarehouse:
		return true
	}
	return false
}

// Destination is where one unit of the case ends (S11, S23).
type Destination string

const (
	DestinationCustomer          Destination = "customer"
	DestinationStock             Destination = "stock"
	DestinationScrap             Destination = "scrap"
	DestinationRetainedByFactory Destination = "retained_by_factory"
)

// Valid reports whether the destination is one of the frozen four.
func (d Destination) Valid() bool {
	switch d {
	case DestinationCustomer, DestinationStock, DestinationScrap, DestinationRetainedByFactory:
		return true
	}
	return false
}

// LoanFate is what became of a lent used battery (S7, S23).
type LoanFate string

const (
	LoanOpen           LoanFate = "open"
	LoanReturned       LoanFate = "returned"
	LoanKeptByCustomer LoanFate = "kept_by_customer"
	LoanFailed         LoanFate = "failed"
	LoanLost           LoanFate = "lost"
)

// Valid reports whether the fate is one of the frozen five.
func (f LoanFate) Valid() bool {
	switch f {
	case LoanOpen, LoanReturned, LoanKeptByCustomer, LoanFailed, LoanLost:
		return true
	}
	return false
}

// Decided reports whether the fate leaves `open`, which is the only fate a caller states.
func (f LoanFate) Decided() bool {
	return f.Valid() && f != LoanOpen
}

// Case is one persisted battery case. The verdict and the three destinations are null until
// the case is resolved; the stock destination is always null on a claim, because a claim never
// had branch stock in play.
type Case struct {
	ID                  int64
	BranchLocationID    int
	BranchSequence      int64
	CaseNumber          string
	Origin              Origin
	Phase               Phase
	Verdict             *Verdict
	ReportedDestination *Destination
	LoanDestination     *Destination
	StockDestination    *Destination
	SaleID              *int64
	// WarrantyNumber is the printed number of the claimed sale, which is what the receipt of the loan
	// prints beside the case number (S8) and null on a finding, which was never sold.
	WarrantyNumber  *string
	VariantID       int64
	SerialNumber    *string
	Quantity        *int64
	DeclaredFailure string
	// Reason is the motive of the write-off of a finding on the shelf (S16) and null on a claim.
	Reason             *string
	CreatedByAccountID int64
	CreatedAt          time.Time
	// Loans and Events are filled by every read and by every write that answers a case, so one contract
	// shape is one answer: the case a caller receives carries the loans and the history it just wrote.
	Loans  []Loan
	Events []Event
}

// Loan is one used battery handed to the client of a case. It identifies a model and a
// quantity and never a physical battery; the serial is optional text and keys nothing.
type Loan struct {
	CaseID           int64
	Ordinal          int
	Model            string
	Quantity         int64
	SerialNumber     string
	SourceLocationID int
	GivenAt          time.Time
	Fate             LoanFate
	FateDecidedAt    *time.Time
	GivenByAccountID int64
}

// Event is one append-only tramo of the journey: the phase it entered, who did it, when,
// why and, on the factory shipment, the file number transcribed by hand.
type Event struct {
	CaseID            int64
	Ordinal           int
	Kind              EventKind
	Phase             Phase
	FactoryCaseNumber string
	ActorAccountID    int64
	RecordedAt        time.Time
	Note              string
}

// OpenClaimInput is the claim door: the serial the client brings and what failed in the
// client's own words. The branch, the sale, the variant and the case number are not the
// caller's to state.
type OpenClaimInput struct {
	SerialNumber    string
	DeclaredFailure string
}

// LoanInput is one used battery handed over: its model code and quantity, the optional
// serial somebody may have written down, and where the battery was taken from.
type LoanInput struct {
	Model            string
	Quantity         int64
	SerialNumber     string
	SourceLocationID int
}

// StockDefectInput is the shelf door: the variant the branch found failed, how many batteries of it,
// what failed in the branch's own words and the motive of the write-off (S1, S16). The branch, the
// case number and the balance are not the caller's to state.
type StockDefectInput struct {
	VariantID       int64
	Quantity        int64
	DeclaredFailure string
	Reason          string
}

// ListFilter is the read of a tray: the phase and the origin of the frozen vocabulary (S23), each
// absent when the caller states none.
type ListFilter struct {
	Phase  Phase
	Origin Origin
}

// DeliveryInput is the delivery of the exchange to the client: what became of the lent battery and
// the words of the counter. The delivery closes the case and writes no stock (S13, S19).
type DeliveryInput struct {
	LoanFate LoanFate
	Note     string
}

// AdvanceInput is one tramo of the journey. The factory file number is stated on the
// shipment to the factory and on nothing else; the note is the reason of the tramo.
type AdvanceInput struct {
	Phase             Phase
	FactoryCaseNumber string
	Note              string
}

// ResolutionInput is the decision the warehouse or the factory reached: the verdict and
// where the reported battery and the lent battery end. A claim states no stock destination.
type ResolutionInput struct {
	Verdict             Verdict
	ReportedDestination Destination
	LoanDestination     Destination
	Note                string
}

const (
	// warehouseLocationID is the Almacén; branches start at 2.
	warehouseLocationID = 1
	maxBranchLocationID = math.MaxInt16
	// maxDeclaredFailure is the bound of the failure the counter writes down.
	maxDeclaredFailure = 500
	// maxFactoryCaseNumber is the bound of the factory file number.
	maxFactoryCaseNumber = 200
	// maxNote is the bound of a tramo's reason.
	maxNote = 500
	// maxReason is the bound of the motive of a write-off, in the shape 022 states for an adjustment.
	maxReason = 500
	// MaxVariantID is the catalogue variant bound, restated so an impossible id never reaches the
	// store.
	MaxVariantID int64 = math.MaxInt32
	// MaxQuantity is the bound of a finding on the shelf: whole batteries, never zero.
	MaxQuantity int64 = 1_000_000
	// MaxListed is how many cases one tray read publishes: the newest of them, because the tray is a
	// work queue and never a history to page through.
	MaxListed = 200
	// MinLoanQuantity and MaxLoanQuantity are the frozen bounds of one loan.
	MinLoanQuantity int64 = 1
	MaxLoanQuantity int64 = 10000
	// maxLoanSerial is the bound of the optional serial of a used battery.
	maxLoanSerial = 64
)

// CanonicalClaimSerial trims the serial the client brought and refuses a value outside the
// sold-unit contract. The serial is what a claim is recognised by; the sale and the variant
// are the database's reading of it, never the caller's.
func CanonicalClaimSerial(serial string) (string, bool) {
	canonical, ok := sales.CanonicalSerial(sales.SerialNumber(serial))
	if !ok {
		return "", false
	}
	return string(canonical), true
}

// canonicalDeclaration trims the words of the counter and refuses an empty or oversized one.
func canonicalDeclaration(text string) (string, bool) {
	trimmed := strings.TrimSpace(text)
	return trimmed, boundedText(trimmed, 1, maxDeclaredFailure)
}

// canonicalNote trims the reason of a tramo and keeps it inside the database's bound.
func canonicalNote(text string) (string, bool) {
	trimmed := strings.TrimSpace(text)
	return trimmed, boundedText(trimmed, 0, maxNote)
}

// canonicalFactoryNumber trims the file number the warehouse transcribes by hand.
func canonicalFactoryNumber(text string) (string, bool) {
	trimmed := strings.TrimSpace(text)
	return trimmed, boundedText(trimmed, 0, maxFactoryCaseNumber)
}

// canonicalReason trims the motive of a write-off and refuses an empty or oversized one.
func canonicalReason(text string) (string, bool) {
	trimmed := strings.TrimSpace(text)
	return trimmed, boundedText(trimmed, 1, maxReason)
}

// canonicalLoanSerial trims the optional free serial of a used battery. It is never an
// identity and never a key, so an empty text is admitted exactly like a written one.
func canonicalLoanSerial(text string) (string, bool) {
	trimmed := strings.TrimSpace(text)
	return trimmed, boundedText(trimmed, 0, maxLoanSerial)
}

// canonicalLoanModel reuses the model contract of the used battery: trimmed, upper-cased
// and inside the frozen pattern a purchase line already stores (032, 033, 045, 066).
func canonicalLoanModel(model string) (string, bool) {
	return purchases.CanonicalModel(model)
}

// validSourceLocation admits the case's branch, the Almacén and any other branch, which is
// every provisioned location. Whether the row exists is the database's own foreign key.
func validSourceLocation(id int) bool { return id > 0 && id <= maxBranchLocationID }

// boundedText keeps a text inside the database's character bounds.
func boundedText(text string, minimum, maximum int) bool {
	if !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
		return false
	}
	length := utf8.RuneCountInString(text)
	return length >= minimum && length <= maximum
}
