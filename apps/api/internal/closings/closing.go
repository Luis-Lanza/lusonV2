// Package closings owns the branch account settlement ("rendición de cuentas"): the
// warehouse visits a branch, freezes its period, counts the stock and the cash, settles
// a commission on what the branch sold and leaves the fund the next period starts with.
//
// The database is the authority of the whole vertical (migration 034). It decides the
// period start, the cut instant, the inherited fund and the expected stock snapshot; it
// admits one live settlement per branch; it decides when the count sheet and the fields of
// the drawer may be drafted; it reads and freezes the commission rate when the warehouse
// proposes; it keeps the proposal rounds immutable; and when the branch accepts it
// applies the counted stock and writes the cash ledger itself, in one transaction. This
// package never restates those rules: it sends the request, maps the database's own
// SQLSTATE into a domain error and reads back what the database decided.
//
// Two things this package does own: the canonical money of the vertical (two decimals,
// never a binary float, reusing the price list's amount type) and the commission, which
// is the one number the database cannot derive for itself because it is the product of a
// frozen rate and a frozen period total, rounded exactly once (S6, S20). The commission
// is reported, never subtracted from the cash of the drawer and never a cash movement
// (S9).
package closings

import (
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"luson/api/internal/auth"
	"luson/api/internal/catalog"
)

var (
	ErrInvalid     = errors.New("invalid branch settlement")
	ErrForbidden   = errors.New("branch settlement forbidden")
	ErrNotFound    = errors.New("branch settlement not found")
	ErrUnavailable = errors.New("branch settlement store unavailable")
	// ErrLiveConflict is the refusal of a second live settlement for a branch: open,
	// proposed and rejected all keep the branch frozen, so only one of them may exist.
	ErrLiveConflict = errors.New("the branch already has a live account settlement")
	// ErrCountFrozen is the refusal of a count write while the branch is deciding or
	// after the closure: the sheet belongs to the warehouse only while it holds the
	// settlement (LC004).
	ErrCountFrozen = errors.New("count lines are written while the warehouse holds the settlement")
	// ErrStateConflict is the refusal of an operation the settlement's own state does not
	// admit: drafting a proposed settlement, deciding one that is not proposed, or
	// touching a closed one (LC005, LC008).
	ErrStateConflict = errors.New("the settlement is not in the state this operation requires")
	// ErrNoCommissionRate is the refusal of a proposal for a branch without a configured
	// commission rate (LC003, S6).
	ErrNoCommissionRate = errors.New("the branch has no commission rate configured")
	// ErrClosureRefused is the generic refusal of the database's closure money rule
	// (LC006). The reachable cases are raised as the typed errors below.
	ErrClosureRefused = errors.New("the settlement cash does not satisfy the closure rule")
	// ErrReservedStock is the refusal of a closure while a variant of the branch still holds an
	// open reservation (LC007): the branch already promised that stock, so settling it under
	// the count would promise it twice. ReservedStock names the variant in conflict.
	ErrReservedStock = errors.New("the variant still holds reserved stock")
	// ErrStockMoved is the refusal of a closure whose count sheet no longer matches the live
	// stock of the branch (LC018): a variant moved during the settlement, so applying the
	// photographed count would resurrect sold stock or discard received stock. StockMoved names
	// the variant; the warehouse answers it by recounting, never by reporting an outage.
	ErrStockMoved = errors.New("the variant moved during the settlement")
	// ErrProposalStale is the refusal of a proposal whose count sheet stopped being complete
	// between the store's own check and the database's transition (LC019). StaleProposal names
	// the variant that lost its counted quantity; the operator re-reads the settlement and
	// proposes again.
	ErrProposalStale = errors.New("the count sheet changed while the settlement was being proposed")
	// ErrRoundNotAccepted is the refusal of a closure whose latest proposal round was not
	// accepted (LC016): nothing is applied by an offer the branch has not accepted.
	ErrRoundNotAccepted = errors.New("the settlement has no accepted proposal round")
	// ErrBranchFrozen is the refusal of a branch operation while a settlement holds the branch
	// (LC001): the branch cannot trade, receive stock, transfer, reconcile or load an expense
	// until the settlement is closed.
	ErrBranchFrozen = errors.New("the branch has an open account settlement and cannot operate")
	// ErrNotBranchExpense is the refusal of a cash movement that is not the branch's own
	// (LC011): the till an expense comes out of belongs to the branch that records it, so the
	// warehouse never records one on its behalf.
	ErrNotBranchExpense = errors.New("only the branch records its own expenses")
	// ErrCorrectionNotClosed is the refusal of a correction of a settlement that is not closed
	// (LC012). A live settlement is corrected by its own proposal rounds, which the branch has
	// not decided yet; only a closed one is corrected after the fact (S16).
	ErrCorrectionNotClosed = errors.New("only a closed settlement is corrected")
	// ErrCorrectionDecided is the refusal of a decision on a correction that already has one
	// (LC013): a correction is decided once, by the branch, and a decided one is final.
	ErrCorrectionDecided = errors.New("the correction is already decided")
	// ErrCorrectionPending is the refusal of a second correction while the branch still holds
	// one pending: the warehouse waits for its decision, one correction at a time (034).
	ErrCorrectionPending = errors.New("the settlement already has a correction waiting for the branch")
	// ErrCorrectionPayload is the refusal of a correction this domain does not apply (LC021):
	// one of its four values, each as the shape that value is, and a variant the closed
	// settlement actually counted.
	ErrCorrectionPayload = errors.New("the correction is not one this domain applies")
	// ErrCorrectionFundStarted is the refusal of a fund correction once a later settlement
	// exists (LC022): that period already inherited its opening cash from the recorded fund, so
	// there is no coherent place left to apply the delta.
	ErrCorrectionFundStarted = errors.New("the fund of a settlement is corrected before the next period starts")
	// ErrCorrectionJournal is the refusal of the journal of applied deltas (LC023): an effect
	// exists because the branch accepted its own correction, and for no other reason.
	ErrCorrectionJournal = errors.New("a correction effect is written when its correction is accepted")
	// ErrCategoryRequired is the refusal of an expense that names no motive (LC033, S3): what the
	// money paid for is the motive, and the note beside it is the optional clarification.
	ErrCategoryRequired = errors.New("an expense states a motive of the drawer")
	// ErrCategoryUnknown is the refusal of an expense whose motive the closed list does not offer: an
	// unknown id and an archived motive are the same answer, because neither is an option of the
	// screen (LC033, S3, S8).
	ErrCategoryUnknown = errors.New("the motive of this expense is unknown or archived")
	// ErrCategoryNotApplicable is the refusal of a motive on a kind that does not state one (LC033,
	// S3): only an expense is recorded with a motive, so a contribution, a collection and a
	// correction name none.
	ErrCategoryNotApplicable = errors.New("only an expense states a motive of the drawer")
)

// RetiredBranch is the refusal of a settlement or a setting for a branch the warehouse
// retired. The branch id is part of the error so the surface can name the exact row.
type RetiredBranch struct{ BranchID int64 }

func (e *RetiredBranch) Error() string {
	return "retired branch " + digits(e.BranchID)
}

// Unwrap keeps errors.Is(err, ErrInvalid) true for a retired branch.
func (e *RetiredBranch) Unwrap() error { return ErrInvalid }

// FundExceedsDrawer is the refusal of a fund larger than the drawer held: the cash
// counted plus the contribution the warehouse made (S10, L13). The excess is reported so
// the admin can correct the exact number instead of guessing.
type FundExceedsDrawer struct{ Excess Money }

func (e *FundExceedsDrawer) Error() string {
	return "the fund exceeds the cash counted plus the contribution by " + string(e.Excess)
}

// Unwrap keeps errors.Is(err, ErrClosureRefused) true.
func (e *FundExceedsDrawer) Unwrap() error { return ErrClosureRefused }

// CountPending is the refusal of a proposal or a closure while a variant of the count
// sheet has no counted quantity. The variant is named, because the admin has to know
// which line is missing (S4). No writer of this version can leave a line pending — the
// opener seeds the counted quantity with the expected one (S1) — so this is the safety net
// of a sheet written before that seeding, or of a line emptied out of band, kept instead of
// removed (S3).
type CountPending struct{ VariantID int64 }

func (e *CountPending) Error() string {
	return "variant " + digits(e.VariantID) + " has no counted quantity"
}

// Unwrap keeps errors.Is(err, ErrClosureRefused) true.
func (e *CountPending) Unwrap() error { return ErrClosureRefused }

// ReservedStock is the refusal of a closure by an open reservation of the branch, naming the
// variant it still owes to a transfer (LC007). Which variant blocks is the database's own fact:
// the closure reads it back from the balances instead of parsing the message of the trigger.
type ReservedStock struct{ VariantID int64 }

func (e *ReservedStock) Error() string {
	return "variant " + digits(e.VariantID) + " still has reserved stock"
}

// Unwrap keeps errors.Is(err, ErrReservedStock) true.
func (e *ReservedStock) Unwrap() error { return ErrReservedStock }

// StockMoved is the refusal of a closure by a variant of the branch whose stock is no longer the
// quantity the count sheet photographed, naming it so the warehouse knows which line is stale
// (LC018).
type StockMoved struct{ VariantID int64 }

func (e *StockMoved) Error() string {
	return "variant " + digits(e.VariantID) + " moved during the settlement"
}

// Unwrap keeps errors.Is(err, ErrStockMoved) true.
func (e *StockMoved) Unwrap() error { return ErrStockMoved }

// StaleProposal is the refusal of a proposal that raced the count sheet, naming the variant that
// lost its counted quantity between the store's own check and the database's transition (LC019).
type StaleProposal struct{ VariantID int64 }

func (e *StaleProposal) Error() string {
	return "variant " + digits(e.VariantID) + " lost its counted quantity before the proposal"
}

// Unwrap keeps errors.Is(err, ErrProposalStale) true.
func (e *StaleProposal) Unwrap() error { return ErrProposalStale }

// CorrectionNotClosed is the refusal of a correction of one named settlement that is not
// closed (LC012). The settlement is named because a correction always belongs to one, and the
// operator has to look at that document instead of proposing again (S16).
type CorrectionNotClosed struct{ ClosingID int64 }

func (e *CorrectionNotClosed) Error() string {
	return "settlement " + digits(e.ClosingID) + " is not closed and is not corrected"
}

// Unwrap keeps errors.Is(err, ErrCorrectionNotClosed) true.
func (e *CorrectionNotClosed) Unwrap() error { return ErrCorrectionNotClosed }

// CashNotStated is the refusal of a proposal or a closure that does not state the cash it
// counted and the fund it leaves behind, which the closure requires (LC006).
type CashNotStated struct{}

func (e *CashNotStated) Error() string {
	return "a settlement closes with the cash counted and the fund left behind"
}

// Unwrap keeps errors.Is(err, ErrClosureRefused) true.
func (e *CashNotStated) Unwrap() error { return ErrClosureRefused }

const (
	// Only the warehouse account (id 1) assigned to location 1 settles a branch, exactly
	// like stock ingress, adjustments, prices and purchases.
	warehouseAccountID  = 1
	warehouseLocationID = 1
	// The warehouse never settles itself: branches start at id 2.
	firstBranchID = 2
	// MaxBranchID is the range of the smallint branch column.
	MaxBranchID = math.MaxInt16
	// MaxCountLines, MaxCounted, MaxObservation and MaxReason are the database's own
	// bounds; every request is judged against them before the first statement runs.
	MaxCountLines  = 190
	MaxCounted     = 1_000_000
	MaxObservation = 1000
	MaxReason      = 1000
	// MaxMaterialLines is the bound of one material count, which is the bound the count sheet of
	// the stock admits (S8): the sheet of a period holds one line per model and per material it
	// bought, and a request states at most that many lines at once.
	MaxMaterialLines = 190
	// MaxDescription is the bound of the description of an expense, which is the database's
	// own: the ledger admits between 1 and 500 characters once trimmed (S12), and from 061 the
	// note of an expense may also be empty when the row names a motive (S3).
	MaxDescription = 500
	// MaxCategoryLabel is the bound of the label of a motive, which is the database's own bound for
	// the closed list an expense is recorded with (061, S2).
	MaxCategoryLabel = 500
)

// Status is the state of a settlement. A closed one is never reopened (S16): an error is
// corrected by an appended correction, which the branch itself approves.
type Status string

const (
	StatusOpen     Status = "open"
	StatusProposed Status = "proposed"
	StatusRejected Status = "rejected"
	StatusClosed   Status = "closed"
)

// Valid reports whether the status is one this vertical stores.
func (s Status) Valid() bool {
	return s == StatusOpen || s == StatusProposed || s == StatusRejected || s == StatusClosed
}

// Held reports whether the warehouse holds the settlement, which is the only window in
// which the count and the cash of the drawer are drafts.
func (s Status) Held() bool { return s == StatusOpen || s == StatusRejected }

// Decision is the branch's answer to one proposal round. The empty decision is a round
// that is still waiting for the branch.
type Decision string

const (
	DecisionPending  Decision = ""
	DecisionAccepted Decision = "accepted"
	DecisionRejected Decision = "rejected"
)

// Settings is the commission configuration of one branch: the percentage the settlement
// pays on the sales total of a period. The warehouse owns it.
type Settings struct {
	BranchID              int64   `json:"branch_location_id"`
	CommissionRatePercent Percent `json:"commission_rate_percent"`
}

// BranchCommission is the configured settlement commission of one branch, read the way the
// administration panel needs it: the rate, the account that fixed it and the moment it did.
// It is the audit of one money parameter, so a rate is never read without its author, and a
// branch the warehouse never configured is absent instead of reported with a zero rate.
type BranchCommission struct {
	BranchID  int64     `json:"branch_location_id"`
	Rate      Percent   `json:"commission_rate_percent"`
	UpdatedAt time.Time `json:"updated_at"`
	UpdatedBy string    `json:"updated_by"`
}

// Counted is one line the admin counted: the variant and what was actually found. It is
// the only quantity a caller supplies — the expected quantity is the database's own
// snapshot of the cut instant and the difference is never an input.
type Counted struct {
	VariantID int64 `json:"variant_id"`
	Quantity  int64 `json:"counted_quantity"`
}

// CountLine is one persisted line of the count sheet with the catalogue identity of its
// variant, so the sheet is legible without a second lookup. The identity is the catalogue's own
// (catalog.Identity): a battery states its brand, model, capacity and polarity and a product its
// name and detail, and neither carries an attribute of the other kind, because the sheet counts the
// whole catalogue (S2, S3). The opener seeds CountedQuantity with the ExpectedQuantity it
// photographs, so a live sheet never states a missing quantity (S1): the warehouse only edits the
// lines that disagree with the system. CountedQuantity is nil only on a sheet written before that
// seeding, which is the state the pending refusal still guards.
type CountLine struct {
	// VariantID is the key of the row: the variant this line counts, which is also the variant of the
	// Identity beside it. A line is never published with the two disagreeing.
	VariantID int64
	// Identity is the catalogue identity of that variant, composed by the catalogue's own rule.
	Identity         catalog.Identity
	CatalogEntryID   int64
	ExpectedQuantity int64
	CountedQuantity  *int64
}

// CashDraft is exactly what the admin reads off the drawer at the cut: what it counted, the
// contribution it made and the fund it leaves behind, plus its observation. The period's
// cash sales and cash expenses are deliberately absent: those are facts of the ledgers — the
// sales of the branch and the expenses the branch recorded as they happened (S12) — and the
// proposal reads them, so a draft can never state a number the ledger contradicts (S8).
// The expected cash, the difference and the transfer to the warehouse are not part of a
// draft either: they are derived from the facts on read. A nil CountedCash or ClosingCash
// means the admin has not counted the drawer yet, which is a legitimate draft and blocks
// the proposal; the period's numbers and the commission rate are not draftable at all.
//
// PurchaseFundCounted and PurchaseFundCash are the second envelope (S1): what the warehouse counted
// in the purchase fund and the amount it leaves in it for the next period. Both are optional — a
// draft that states neither leaves the envelope unstated, exactly like an uncounted drawer — and
// the new amount is deliberately not bounded by the counted one, because the warehouse brings money
// from outside the branch (S5, S6).
type CashDraft struct {
	CountedCash     *Money
	ContributedCash Money
	ClosingCash     *Money
	Observation     string
	// PurchaseFundCounted is the envelope the warehouse counted; PurchaseFundCash is the amount
	// that opens the next period. Both are drafts while the warehouse holds the settlement and both
	// are frozen by the proposal, exactly like the drawer (S5, S6).
	PurchaseFundCounted *Money
	PurchaseFundCash    *Money
}

// MaterialKind is the unit one row of the material sheet is counted in (S8): a used battery is
// counted in whole units per model and scrap in kilograms per material. The kind is also the key
// of the row, because it decides which of the two columns names it.
type MaterialKind string

const (
	MaterialKindUsed  MaterialKind = "used"
	MaterialKindScrap MaterialKind = "scrap"
)

// Valid reports whether the kind is one this vertical stores.
func (k MaterialKind) Valid() bool { return k == MaterialKindUsed || k == MaterialKindScrap }

// Unit is the unit the sheet publishes for the kind, which is the unit both of its quantities are
// counted in: a used battery is a whole thing and a material of the reference table is weighed in
// kilograms.
func (k MaterialKind) Unit() string {
	if k == MaterialKindScrap {
		return "kg"
	}
	return "unit"
}

// Quantity is the canonical quantity of one material line: the whole units of a used line, which
// is never a fraction, and the kilograms of a scrap line with exactly three decimals, which is the
// scale the weight of a purchase already stores. It is decimal text end to end, so no binary float
// ever touches a count, and the unit of the line is the only thing that decides its scale.
type Quantity string

// SignedQuantity is a difference of the material sheet with its sign: negative is less material
// than the period bought and positive is more. Like the cash difference it is informed and never
// blocks, which is why it is signed and why it is never written back (S8).
type SignedQuantity string

var (
	// unitsPattern is a whole quantity of the sheet: at most nine integral digits, which is the
	// whole range of numeric(12,3) without a fraction, never padded and never a fraction, because
	// a battery is not divisible.
	unitsPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,8})$`)
	// kilogramsPattern is a weight of the sheet: the same integral part with exactly three
	// decimals, so the text of a count is the text of the column it is stored in.
	kilogramsPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,8})\.[0-9]{3}$`)
	// materialModelPattern is the frozen model code of a used line: the same one a purchase line
	// stores, comma included, because the sheet counts the models the branch bought by that name.
	materialModelPattern = regexp.MustCompile(`^[A-Z0-9][A-Z0-9 .,_/-]{0,39}$`)
)

const (
	// MaxMaterialID is the range of the material id, which is the smallint of the reference table.
	MaxMaterialID = math.MaxInt16
	// maxMilli is the whole range of numeric(12,3) expressed in thousandths, which is the column of
	// both quantities of the sheet.
	maxMilli = int64(999_999_999_999)
)

// ParseQuantity admits the counted quantity of one line: a whole number of units for a used line
// and kilograms with exactly three decimals for a scrap line, each as the canonical text the
// sheet publishes. An uncounted quantity is the JSON null of this contract and never a zero, so a
// padded, fractional-unit or over-precision value is refused instead of normalized.
func ParseQuantity(kind MaterialKind, text string) (Quantity, error) {
	switch kind {
	case MaterialKindUsed:
		if !unitsPattern.MatchString(text) {
			return "", ErrInvalid
		}
	case MaterialKindScrap:
		if !kilogramsPattern.MatchString(text) {
			return "", ErrInvalid
		}
	default:
		return "", ErrInvalid
	}
	return Quantity(text), nil
}

// quantityMilli reads a canonical quantity as integer thousandths, the scale that holds units and
// kilograms exactly: a unit is a thousand thousandths and a kilogram is one. Text that is not
// canonical is refused, so nothing is approximated.
func quantityMilli(quantity Quantity) (int64, bool) {
	text := string(quantity)
	whole, fraction, _ := strings.Cut(text, ".")
	if len(whole) == 0 || len(whole) > 9 || (len(whole) > 1 && whole[0] == '0') || len(fraction) > 3 {
		return 0, false
	}
	var value int64
	for _, ch := range whole {
		if ch < '0' || ch > '9' {
			return 0, false
		}
		value = value*10 + int64(ch-'0')
	}
	for i := 0; i < 3; i++ {
		value *= 10
		if i < len(fraction) {
			ch := fraction[i]
			if ch < '0' || ch > '9' {
				return 0, false
			}
			value += int64(ch - '0')
		}
	}
	return value, true
}

// quantityFromMilli renders integer thousandths as the canonical quantity of one kind: the whole
// units of a used line and the three-decimal kilograms of a scrap line. A fraction of a unit is
// not a battery, so it is refused instead of rounded.
func quantityFromMilli(milli int64, kind MaterialKind) (Quantity, error) {
	if milli < 0 || milli > maxMilli || !kind.Valid() {
		return "", ErrInvalid
	}
	whole, fraction := milli/1000, milli%1000
	if kind == MaterialKindUsed {
		if fraction != 0 {
			return "", ErrInvalid
		}
		return ParseQuantity(kind, strconv.FormatInt(whole, 10))
	}
	text := strconv.FormatInt(whole, 10) + "." +
		string([]byte{byte('0' + fraction/100), byte('0' + fraction/10%10), byte('0' + fraction%10)})
	if quantity, err := ParseQuantity(kind, text); err != nil || string(quantity) != text {
		return "", ErrInvalid
	}
	return Quantity(text), nil
}

// signedQuantityFromMilli renders a signed quantity from integer thousandths, with the scale of
// its kind. A value outside the column renders as the empty text, which no caller stores.
func signedQuantityFromMilli(milli int64, kind MaterialKind) SignedQuantity {
	negative := milli < 0
	if negative {
		milli = -milli
	}
	quantity, err := quantityFromMilli(milli, kind)
	if err != nil {
		return ""
	}
	if negative {
		return SignedQuantity("-" + string(quantity))
	}
	return SignedQuantity(quantity)
}

// String renders the difference of one line, or the empty text when it is not canonical text of
// either scale. A difference of zero is never published with a sign: the arithmetic of the sheet
// renders it as the zero of its own kind.
func (s SignedQuantity) String() string {
	text := string(s)
	magnitude := strings.TrimPrefix(text, "-")
	if (!unitsPattern.MatchString(magnitude) && !kilogramsPattern.MatchString(magnitude)) ||
		(magnitude == "0" || magnitude == "0.000") && magnitude != text {
		return ""
	}
	if _, ok := quantityMilli(Quantity(magnitude)); !ok {
		return ""
	}
	return text
}

// MaterialDifference is what was counted against what the period bought, with its sign: negative
// is material missing from the shelf and positive is material the period did not buy. It is
// informed exactly like the cash difference and blocks nothing (S8), and it is null while the line
// is uncounted, because a difference of zero would be a count nobody made.
func MaterialDifference(counted *Quantity, expected Quantity, kind MaterialKind) (*SignedQuantity, error) {
	if counted == nil {
		return nil, nil
	}
	countedMilli, ok := quantityMilli(*counted)
	if !ok {
		return nil, ErrInvalid
	}
	expectedMilli, ok := quantityMilli(expected)
	if !ok {
		return nil, ErrInvalid
	}
	difference := signedQuantityFromMilli(countedMilli-expectedMilli, kind)
	if difference == "" {
		return nil, ErrInvalid
	}
	return &difference, nil
}

// MaterialDelivery is the quantity that goes to the warehouse at the closure: everything that was
// counted, because the previous closure already took everything and the shelf starts at zero by
// construction (S7, S9). There is no remnant field and no column: it is the counted quantity, and
// it is derived on read so it can never disagree with the count.
func MaterialDelivery(counted *Quantity) *Quantity {
	if counted == nil {
		return nil
	}
	delivered := *counted
	return &delivered
}

// ValidMaterialModel reports whether the model of a used line is one this vertical stores: the same
// frozen code a purchase line names, comma included, because the sheet counts the models the branch
// bought by that name.
func ValidMaterialModel(model string) bool { return materialModelPattern.MatchString(model) }

// MaterialCounted is one line the warehouse counted: the key of the row -- the model of a used
// battery or the material of a scrap line -- and what was found. The expected quantity is the
// database's own fact of the opening, so it is not part of this request at all (S7), and the
// difference and the delivery are derived from it on read.
type MaterialCounted struct {
	Kind       MaterialKind
	Model      string
	MaterialID int64
	Quantity   Quantity
}

// MaterialLine is one row of the material sheet (S8): what the period bought of one model or
// material and what the warehouse counted at the cut, with the difference between the two and the
// quantity that goes to the warehouse. A used line names its Model and a scrap line its
// MaterialID and Material -- exactly one of them, per kind -- and Unit is the unit both quantities
// are counted in. Expected is a fact of the opening, Counted is null while the line is uncounted,
// and Difference and Delivered are derived on every read, never written.
type MaterialLine struct {
	Kind       MaterialKind    `json:"kind"`
	Model      *string         `json:"model"`
	MaterialID *int64          `json:"material_id"`
	Material   *string         `json:"material"`
	Unit       string          `json:"unit"`
	Expected   Quantity        `json:"expected_quantity"`
	Counted    *Quantity       `json:"counted_quantity"`
	Difference *SignedQuantity `json:"difference"`
	Delivered  *Quantity       `json:"delivered_quantity"`
}

// canonicalMaterials admits the counted sheet of one request: one to MaxMaterialLines lines, each
// naming one row of the sheet once, with the key its kind names and the canonical quantity of its
// unit. The lines are copied in the caller's order; the caller's slice is never modified.
func canonicalMaterials(counted []MaterialCounted) ([]MaterialCounted, error) {
	if len(counted) < 1 || len(counted) > MaxMaterialLines {
		return nil, ErrInvalid
	}
	seen := make(map[string]bool, len(counted))
	lines := make([]MaterialCounted, 0, len(counted))
	for _, line := range counted {
		var key string
		switch line.Kind {
		case MaterialKindUsed:
			if line.MaterialID != 0 || !materialModelPattern.MatchString(line.Model) {
				return nil, ErrInvalid
			}
			key = string(line.Kind) + "/" + line.Model
		case MaterialKindScrap:
			if line.Model != "" || line.MaterialID < 1 || line.MaterialID > MaxMaterialID {
				return nil, ErrInvalid
			}
			key = string(line.Kind) + "/" + digits(line.MaterialID)
		default:
			return nil, ErrInvalid
		}
		quantity, err := ParseQuantity(line.Kind, string(line.Quantity))
		if err != nil || quantity != line.Quantity || seen[key] {
			return nil, ErrInvalid
		}
		seen[key] = true
		lines = append(lines, MaterialCounted{Kind: line.Kind, Model: line.Model,
			MaterialID: line.MaterialID, Quantity: quantity})
	}
	return lines, nil
}

// CorrectionStatus is the state of one correction of a closed settlement: the warehouse
// proposes it and only the branch decides it, exactly like a round of a live settlement (S16).
type CorrectionStatus string

const (
	CorrectionProposed CorrectionStatus = "proposed"
	CorrectionAccepted CorrectionStatus = "accepted"
	CorrectionRejected CorrectionStatus = "rejected"
)

// Valid reports whether the status is one this vertical stores.
func (s CorrectionStatus) Valid() bool {
	return s == CorrectionProposed || s == CorrectionAccepted || s == CorrectionRejected
}

// The kinds of delta an accepted correction journals. Each one is a fact of its own and the
// journal holds one row per fact, so a reader never has to parse a payload to know what moved;
// the drawer and the fund are money, the count sheet is a quantity, and the commission is money
// that moves nothing (036, 040).
const (
	CorrectionKindStock       = "stock"
	CorrectionKindCountedCash = "counted_cash"
	CorrectionKindCommission  = "commission"
	CorrectionKindFund        = "fund"
)

// CorrectionOffer is the whole payload of one correction: every value it corrects, all of them
// optional and at least one of them stated. The fields are the payload's own names, because the
// offer is stored verbatim as jsonb and judged by the database when the warehouse proposes it;
// a value a correction does not touch stays absent instead of being restated (S16, L6).
type CorrectionOffer struct {
	CountedQuantities []Counted `json:"counted_quantities,omitempty"`
	CountedCash       *Money    `json:"counted_cash,omitempty"`
	CommissionAmount  *Money    `json:"commission_amount,omitempty"`
	ClosingCash       *Money    `json:"closing_cash,omitempty"`
}

// Stated reports whether the offer corrects anything at all, which is the minimum the journal
// and its guard require: a correction that states no value would be a decision about nothing.
func (o CorrectionOffer) Stated() bool {
	return len(o.CountedQuantities) > 0 || o.CountedCash != nil ||
		o.CommissionAmount != nil || o.ClosingCash != nil
}

// CorrectionEffect is one delta an accepted correction applied: the unit it moves and the exact
// difference that was applied to it. Exactly one of the two deltas is set for each kind, so an
// effect is never read as the wrong quantity -- a count is never money and money is never a
// count (036). An amount delta is signed: a corrected drawer or fund is a difference against what
// the branch signed, and both directions are legitimate.
type CorrectionEffect struct {
	Kind          string  `json:"kind"`
	VariantID     *int64  `json:"variant_id"`
	QuantityDelta *int64  `json:"quantity_delta"`
	AmountDelta   *Signed `json:"amount_delta"`
}

// Correction is one correction of a closed settlement with the deltas it applied. The reason is
// the warehouse's and the decision is the branch's, so an accepted correction publishes its
// effects beside the reason it was accepted for: a corrected number is legible as the result of
// a correction instead of being an invisible rewrite (S16).
type Correction struct {
	ID                  int64              `json:"id"`
	ClosingID           int64              `json:"closing_id"`
	Status              CorrectionStatus   `json:"status"`
	Reason              string             `json:"reason"`
	Payload             CorrectionOffer    `json:"payload"`
	ProposedByAccountID int64              `json:"proposed_by_account_id"`
	ProposedAt          time.Time          `json:"proposed_at"`
	DecidedByAccountID  *int64             `json:"decided_by_account_id"`
	DecidedAt           *time.Time         `json:"decided_at"`
	DecisionReason      string             `json:"decision_reason"`
	Effects             []CorrectionEffect `json:"effects"`
}

// Expense is one small expense the branch paid out of its own till during its period (S12).
// It is the branch's own fact, recorded by the branch while it operates and with no previous
// approval; it is never attached to a settlement by the caller, because the settlement that
// covers it is the one whose window contains its instant. A recorded expense is immutable:
// a wrong one is corrected by its opposite movement, never edited or deleted.
//
// The list is the ledger the total was computed from, so it states the correction of an expense
// beside the expense it answers (S13): Kind is the kind the row states -- 'gasto' or the
// 'correccion' that answers one -- and CorrectsID is the movement a correction names, nil on the
// expense itself (S6). Amount stays the positive amount the ledger stores: the direction of a row
// is the ledger view's own reading and never a sign this document invents.
type Expense struct {
	ID                 int64     `json:"id"`
	BranchID           int64     `json:"branch_location_id"`
	Kind               string    `json:"kind"`
	Amount             Money     `json:"amount"`
	Description        string    `json:"description"`
	OccurredAt         time.Time `json:"occurred_at"`
	CreatedByAccountID int64     `json:"created_by_account_id"`
	CorrectsID         *int64    `json:"corrects_id"`
	// CategoryID is the motive the expense was recorded with and CategoryLabel the copy of its label
	// at that instant (061, S3, S8). Both are nil on every kind that names no motive, and the copy is
	// what the book, the acta and the report keep reading when the motive is renamed or archived.
	CategoryID    *int64  `json:"category_id"`
	CategoryLabel *string `json:"category_label"`
}

// CashCategory is one motive of the closed list an expense is recorded with (S2, S5): the identity the
// row states and the label the screen offers, in the order the list states. The catalogue is global to
// every branch, so it names no branch at all.
type CashCategory struct {
	ID    int64  `json:"id"`
	Label string `json:"label"`
}

// ProposalCountLine is one line of the count sheet as the branch reads it in the offer.
type ProposalCountLine struct {
	VariantID        int64 `json:"variant_id"`
	ExpectedQuantity int64 `json:"expected_quantity"`
	CountedQuantity  int64 `json:"counted_quantity"`
}

// ProposalPayload is the full offer of one round: the period, every number the closure
// will record, and the counted sheet the branch is accepting. It is stored verbatim in
// closing_proposals.proposed_payload, so the branch can always be shown exactly what it
// accepted (S14, S15). It carries no seller and no manager name: the commission of a
// period is one amount for the whole branch (S7).
type ProposalPayload struct {
	PeriodStart           time.Time `json:"period_start"`
	CutAt                 time.Time `json:"cut_at"`
	SalesTotal            Money     `json:"sales_total"`
	CommissionRatePercent Percent   `json:"commission_rate_percent"`
	CommissionAmount      Money     `json:"commission_amount"`
	CashSales             Money     `json:"cash_sales"`
	CashExpenses          Money     `json:"cash_expenses"`
	CardTotal             Money     `json:"card_total"`
	TransferTotal         Money     `json:"transfer_total"`
	QRTotal               Money     `json:"qr_total"`
	CountedCash           *Money    `json:"counted_cash"`
	ContributedCash       Money     `json:"contributed_cash"`
	ClosingCash           *Money    `json:"closing_cash"`
	Observation           string    `json:"observation"`
	// PurchaseFundCounted and PurchaseFundCash are the second envelope of the offer: what the
	// warehouse counted in the purchase fund and the amount it leaves there for the next period.
	// They are absent from an offer made before the envelope was stated, which is why they are
	// omitted instead of being invented as zero (S1, S5, S6).
	PurchaseFundCounted *Money              `json:"purchase_fund_counted,omitempty"`
	PurchaseFundCash    *Money              `json:"purchase_fund_cash,omitempty"`
	CountLines          []ProposalCountLine `json:"count_lines"`
}

// Round is one proposal of the warehouse with the branch's answer, if it has one. Rounds
// are immutable once decided and are numbered by the database, so a rejection hands the
// settlement back for correction and asks for a new round with no limit (S14, S15).
type Round struct {
	ID                  int64           `json:"id"`
	Round               int             `json:"round"`
	Payload             ProposalPayload `json:"payload"`
	ProposedByAccountID int64           `json:"proposed_by_account_id"`
	ProposedAt          time.Time       `json:"proposed_at"`
	Decision            Decision        `json:"decision"`
	DecisionReason      string          `json:"decision_reason"`
	DecidedByAccountID  *int64          `json:"decided_by_account_id"`
	DecidedAt           *time.Time      `json:"decided_at"`
}

// Closing is one persisted settlement exactly as this vertical reads it. The money of the
// period is the database's; the derived numbers are computed here on read and never written.
// SalesTotal, CommissionAmount, CardTotal, TransferTotal, QRTotal and CashExpenses are written
// by the proposal transition, which records the offer the branch is asked to accept, and the
// closure freezes them: a closed settlement can never state a period other than the one it was
// accepted on. Before that transition nothing has written them, so a settlement the warehouse
// still holds publishes the period derived from its own window instead of the insert zeros
// (S1): the number the warehouse counts against is the number the branch is asked to accept.
type Closing struct {
	ID                    int64      `json:"id"`
	BranchID              int64      `json:"branch_location_id"`
	BranchName            string     `json:"branch_name"`
	Status                Status     `json:"status"`
	PeriodStart           time.Time  `json:"period_start"`
	CutAt                 time.Time  `json:"cut_at"`
	ClosedAt              *time.Time `json:"closed_at"`
	CommissionRatePercent *Percent   `json:"commission_rate_percent"`
	OpeningCash           Money      `json:"opening_cash"`
	// CashSales and CashExpenses are the money of the period by source: the cash the branch
	// collected, read from its immutable sales, and the expenses it recorded as they
	// happened, read from the cash ledger over the same window. The proposal writes both and
	// the closure freezes them; before it, both are derived from that same window, so the
	// warehouse never counts against a zero (S8, S12).
	CashSales    Money `json:"cash_sales"`
	CashExpenses Money `json:"cash_expenses"`
	// CashEffective is the signed effect of every movement the branch wrote inside this window -- its
	// aportes, its recaudaciones, its gastos and the corrections of them -- read from the same ledger
	// view the book reads (S4, S13). It is derived on read and never stored: the window of a settled
	// period is immutable, so the number a closure settled with is also the number every later read
	// states. It is the third term of the expectation and it is not published by the document's DTO in
	// so many words for the acta (the DTO publishes `cash_effective`); it is what lets the HTTP
	// revalidation call the one rule instead of a second arithmetic of the expenses.
	CashEffective     Signed `json:"-"`
	SalesTotal        Money  `json:"sales_total"`
	CommissionAmount  Money  `json:"commission_amount"`
	CardTotal         Money  `json:"card_total"`
	TransferTotal     Money  `json:"transfer_total"`
	QRTotal           Money  `json:"qr_total"`
	CountedCash       *Money `json:"counted_cash"`
	ContributedCash   Money  `json:"contributed_cash"`
	ClosingCash       *Money `json:"closing_cash"`
	Observation       string `json:"observation"`
	OpenedByAccountID int64  `json:"opened_by_account_id"`
	// ExpectedCash is the drawer's one rule over the window: opening cash plus the cash sales of the
	// period plus the signed effect of the movements the branch wrote in it; CashDifference is the
	// counted cash against it, and TakenCash is what the warehouse takes from the drawer: counted plus
	// contributed minus the fund left behind (S8, S10). They are derived on read, so they can never
	// disagree with the facts that produce them, and the acta's net `CashExpenses` is already one term
	// of the effect and is never subtracted a second time (S4, S13).
	ExpectedCash   Signed      `json:"expected_cash"`
	CashDifference *Signed     `json:"cash_difference"`
	TakenCash      *Signed     `json:"taken_cash"`
	CountLines     []CountLine `json:"count_lines"`
	// MaterialLines is the third account of the document: what the period bought of every model and
	// material and what the warehouse counted of it, with the difference and the quantity that goes
	// to the warehouse (S7, S8, S9). The expected quantity is seeded when the settlement opens, from
	// the purchases of its own window, and the counted one is the warehouse's draft; the difference
	// and the delivery are derived on read, so neither can disagree with the facts that produce
	// them, and a line still uncounted states no difference and no delivery at all. It is published
	// by every read of this package, the single document and each row of the history alike.
	MaterialLines []MaterialLine `json:"material_lines"`
	// The purchase fund is the branch's second envelope of physical money, counted and settled
	// apart from the drawer (S1). PurchaseFundOpening is the amount the previous closure left in it,
	// PurchasesTotal and PurchasesCash are the sums of the purchases of the window — the only money
	// reading of this document that comes from the purchases and not from the cash ledger — and
	// PurchaseFundExpected is opening minus that cash, net of the counter-documents that return
	// money (S3, S11). PurchaseFundCounted is what the warehouse counted, and PurchaseFundDifference
	// is that count against the expectation: it is informational and blocks nothing, exactly like the
	// cash difference, and is null while the envelope is uncounted. PurchaseFundCash is the amount
	// the warehouse leaves in it, which opens the next period (S5, S6). Opening, purchases and
	// expectation are derived on read; the counted amount and the new amount are the database's
	// columns, drafted through CashDraft and frozen by the proposal.
	PurchaseFundOpening    Money   `json:"purchase_fund_opening"`
	PurchasesTotal         Money   `json:"purchases_total"`
	PurchasesCash          Money   `json:"purchases_cash"`
	PurchaseFundExpected   Signed  `json:"purchase_fund_expected"`
	PurchaseFundCounted    *Money  `json:"purchase_fund_counted"`
	PurchaseFundDifference *Signed `json:"purchase_fund_difference"`
	PurchaseFundCash       *Money  `json:"purchase_fund_cash"`
	// Corrections are the corrections of the closed settlement, oldest first, each one with the reason
	// the warehouse stated, its status and -- once the branch accepted it -- the deltas it applied. The
	// row above keeps the numbers it was signed with; the derived numbers of this document are
	// computed from the signed values plus the accepted deltas, so a corrected drawer reads as
	// corrected and a client can always tell which correction produced which number (S16). The
	// pending one is published with its status, because it is what awaits the branch's decision; a
	// rejected one applied nothing and is not published. A settlement that is still live has none: it
	// is corrected by its own rounds, not after the fact.
	Corrections []Correction `json:"corrections"`
	// Expenses are the small expenses the branch paid out of its till inside the window this
	// settlement covers, read from its ledger in the order they were recorded. They are
	// published beside the total, so the warehouse sees what it is subtracting and the branch
	// what it is being charged for (S12). A closed settlement's window never grows, so its
	// list is fixed; while the warehouse still holds the settlement the list is the ledger and
	// CashExpenses is derived from that same ledger, so the two cannot disagree.
	Expenses []Expense `json:"expenses"`
	Rounds   []Round   `json:"rounds"`
}

// LatestRound is the round the branch is deciding or decided last, or nil when the
// warehouse has not proposed anything yet.
func (c Closing) LatestRound() *Round {
	if len(c.Rounds) == 0 {
		return nil
	}
	round := c.Rounds[len(c.Rounds)-1]
	return &round
}

// warehouseAdmin admits only the completed warehouse administrator identity.
func warehouseAdmin(actor auth.Identity) bool {
	return actor.AccountID == warehouseAccountID && actor.Location.ID == warehouseLocationID &&
		!actor.MustChangePassword
}

// CanonicalReason admits the mandatory motive of a rejection and returns the exact text
// that is persisted: valid UTF-8, no NUL, at most 1000 characters, and never blank once
// trimmed (S14).
func CanonicalReason(reason string) (string, bool) {
	if !validText(reason, MaxReason) {
		return "", false
	}
	trimmed := strings.TrimSpace(reason)
	if trimmed == "" {
		return "", false
	}
	return trimmed, true
}

// ValidObservation admits the optional observation of the settlement, persisted verbatim.
func ValidObservation(observation string) bool { return validText(observation, MaxObservation) }

// CanonicalDescription admits the mandatory description of an expense and returns the exact
// text that is persisted: valid UTF-8, no NUL, at most 500 characters, and never blank once
// trimmed (S12).
func CanonicalDescription(description string) (string, bool) {
	if !validText(description, MaxDescription) {
		return "", false
	}
	trimmed := strings.TrimSpace(description)
	if trimmed == "" {
		return "", false
	}
	return trimmed, true
}

// CanonicalNote admits the optional note of an expense (S3) and returns the exact text that is
// persisted: valid UTF-8, no NUL, at most 500 characters, and the empty string when the branch states
// no note at all. What the note pays for is the motive, so a note that says nothing is a row that
// says everything through the motive beside it.
func CanonicalNote(note string) (string, bool) {
	if !validText(note, MaxDescription) {
		return "", false
	}
	return strings.TrimSpace(note), true
}

// CanonicalLabel admits the label of one motive of the closed list and returns the exact text the
// database stores: valid UTF-8, no NUL, at most 500 characters, and never blank once trimmed (061,
// S2).
func CanonicalLabel(label string) (string, bool) {
	if !validText(label, MaxCategoryLabel) {
		return "", false
	}
	trimmed := strings.TrimSpace(label)
	if trimmed == "" {
		return "", false
	}
	return trimmed, true
}

// validText is the house text bound: valid UTF-8, no NUL and at most maximum characters.
func validText(text string, maximum int) bool {
	if !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
		return false
	}
	return utf8.RuneCountInString(text) <= maximum
}

// digits renders a non-negative integer without a float.
func digits(value int64) string {
	if value == 0 {
		return "0"
	}
	var buffer [20]byte
	index := len(buffer)
	for value > 0 {
		index--
		buffer[index] = byte('0' + value%10)
		value /= 10
	}
	return string(buffer[index:])
}

// canonicalCorrection admits the payload of one correction before the database sees it: at
// least one of the four values it can correct, canonical money for the three amounts, and a
// counted sheet inside the database's own bounds. It returns the payload exactly as it is
// stored, so what the warehouse proposed is what the branch decides and what the journal
// applies (S16, S20).
func canonicalCorrection(offer CorrectionOffer) (CorrectionOffer, error) {
	canonical := CorrectionOffer{}
	if len(offer.CountedQuantities) > 0 {
		lines, err := canonicalCount(offer.CountedQuantities)
		if err != nil {
			return CorrectionOffer{}, err
		}
		canonical.CountedQuantities = lines
	}
	countedCash, err := canonicalOptionalAmount(offer.CountedCash)
	if err != nil {
		return CorrectionOffer{}, err
	}
	commission, err := canonicalOptionalAmount(offer.CommissionAmount)
	if err != nil {
		return CorrectionOffer{}, err
	}
	fund, err := canonicalOptionalAmount(offer.ClosingCash)
	if err != nil {
		return CorrectionOffer{}, err
	}
	canonical.CountedCash, canonical.CommissionAmount, canonical.ClosingCash =
		countedCash, commission, fund
	if !canonical.Stated() {
		// A correction that states nothing is not a correction, and the database refuses the
		// same empty payload (LC021).
		return CorrectionOffer{}, ErrInvalid
	}
	return canonical, nil
}

// canonicalOptionalAmount canonicalizes one optional amount of a correction: an absent value
// stays absent, because a correction never restates a value it does not touch.
func canonicalOptionalAmount(amount *Money) (*Money, error) {
	if amount == nil {
		return nil, nil
	}
	canonical, err := ParseAmount(string(*amount))
	if err != nil {
		return nil, ErrInvalid
	}
	return &canonical, nil
}

// correctedAmount applies one journalled delta to an amount of the settlement. A settlement
// without the amount carries no delta -- a live one is never corrected (LC012) -- and the drawer
// chain never holds a negative amount, so a journal that would take one there is a shape this
// domain never wrote.
func correctedAmount(amount *Money, delta Signed) (*Money, error) {
	cents, ok := delta.Cents()
	if !ok {
		return nil, ErrInvalid
	}
	if amount == nil {
		if cents != 0 {
			return nil, ErrInvalid
		}
		return nil, nil
	}
	base, ok := amountCents(*amount)
	if !ok {
		return nil, ErrInvalid
	}
	value, err := amountFromCents(base + cents)
	if err != nil {
		return nil, ErrInvalid
	}
	return &value, nil
}

// canonicalCount admits the counted sheet of one request: one to MaxCountLines lines, each
// naming a variant of the catalogue once, with a count inside the database's bound. The
// lines are copied in the caller's order; the caller's slice is never modified.
func canonicalCount(counted []Counted) ([]Counted, error) {
	if len(counted) < 1 || len(counted) > MaxCountLines {
		return nil, ErrInvalid
	}
	seen := make(map[int64]bool, len(counted))
	lines := make([]Counted, 0, len(counted))
	for _, line := range counted {
		if line.VariantID < 1 || line.VariantID > math.MaxInt32 || seen[line.VariantID] ||
			line.Quantity < 0 || line.Quantity > MaxCounted {
			return nil, ErrInvalid
		}
		seen[line.VariantID] = true
		lines = append(lines, line)
	}
	return lines, nil
}

// canonicalCash admits the cash draft: canonical amounts, the database's observation
// bound, and the fund bound the closure enforces (S10, L13). The fund is compared against
// the drawer only when both sides are known, because a draft may still be missing the
// count.
//
// The purchase envelope is canonicalized the same way and bounded by nothing but its own column
// check: it is a second envelope of physical money, so its new amount is not compared against what
// was counted — the warehouse brings money from outside the branch — and it enters the drawer's
// identities in no way (S1, S5, S12).
func canonicalCash(draft CashDraft) (CashDraft, error) {
	contributed, err := ParseAmount(string(draft.ContributedCash))
	if err != nil {
		return CashDraft{}, ErrInvalid
	}
	canonical := CashDraft{ContributedCash: contributed, Observation: draft.Observation}
	if !ValidObservation(draft.Observation) {
		return CashDraft{}, ErrInvalid
	}
	if draft.CountedCash != nil {
		counted, err := ParseAmount(string(*draft.CountedCash))
		if err != nil {
			return CashDraft{}, ErrInvalid
		}
		canonical.CountedCash = &counted
	}
	if draft.ClosingCash != nil {
		fund, err := ParseAmount(string(*draft.ClosingCash))
		if err != nil {
			return CashDraft{}, ErrInvalid
		}
		canonical.ClosingCash = &fund
	}
	if canonical.CountedCash != nil && canonical.ClosingCash != nil {
		if err := checkFund(*canonical.CountedCash, canonical.ContributedCash, *canonical.ClosingCash); err != nil {
			return CashDraft{}, err
		}
	}
	if canonical.PurchaseFundCounted, err = canonicalOptionalAmount(draft.PurchaseFundCounted); err != nil {
		return CashDraft{}, err
	}
	if canonical.PurchaseFundCash, err = canonicalOptionalAmount(draft.PurchaseFundCash); err != nil {
		return CashDraft{}, err
	}
	return canonical, nil
}

// checkFund applies the bound of S10/L13: the fund left behind never exceeds the drawer,
// which is the cash counted plus the contribution the warehouse made.
func checkFund(counted, contributed, fund Money) error {
	countedCents, ok := amountCents(counted)
	if !ok {
		return ErrInvalid
	}
	contributedCents, ok := amountCents(contributed)
	if !ok {
		return ErrInvalid
	}
	fundCents, ok := amountCents(fund)
	if !ok {
		return ErrInvalid
	}
	if excess := fundCents - countedCents - contributedCents; excess > 0 {
		amount, err := amountFromCents(excess)
		if err != nil {
			return ErrInvalid
		}
		return &FundExceedsDrawer{Excess: amount}
	}
	return nil
}
