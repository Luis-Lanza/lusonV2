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
// which line is missing (S4).
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
	// MaxDescription is the bound of the description of an expense, which is the database's
	// own: the ledger admits between 1 and 500 characters once trimmed (S12).
	MaxDescription = 500
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

// Counted is one line the admin counted: the variant and what was actually found. It is
// the only quantity a caller supplies — the expected quantity is the database's own
// snapshot of the cut instant and the difference is never an input.
type Counted struct {
	VariantID int64 `json:"variant_id"`
	Quantity  int64 `json:"counted_quantity"`
}

// CountLine is one persisted line of the count sheet with the catalogue identity of its
// variant, so the sheet is legible without a second lookup. CountedQuantity is nil while
// the variant is still pending, which is what blocks the proposal and the closure.
type CountLine struct {
	VariantID        int64           `json:"variant_id"`
	CatalogEntryID   int64           `json:"catalog_entry_id"`
	Brand            string          `json:"brand"`
	Model            string          `json:"model"`
	Capacity         catalog.Decimal `json:"capacity_ah"`
	Polarity         string          `json:"polarity"`
	ExpectedQuantity int64           `json:"expected_quantity"`
	CountedQuantity  *int64          `json:"counted_quantity"`
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
type CashDraft struct {
	CountedCash     *Money
	ContributedCash Money
	ClosingCash     *Money
	Observation     string
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
type Expense struct {
	ID                 int64     `json:"id"`
	BranchID           int64     `json:"branch_location_id"`
	Amount             Money     `json:"amount"`
	Description        string    `json:"description"`
	OccurredAt         time.Time `json:"occurred_at"`
	CreatedByAccountID int64     `json:"created_by_account_id"`
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
	PeriodStart           time.Time           `json:"period_start"`
	CutAt                 time.Time           `json:"cut_at"`
	SalesTotal            Money               `json:"sales_total"`
	CommissionRatePercent Percent             `json:"commission_rate_percent"`
	CommissionAmount      Money               `json:"commission_amount"`
	CashSales             Money               `json:"cash_sales"`
	CashExpenses          Money               `json:"cash_expenses"`
	CardTotal             Money               `json:"card_total"`
	TransferTotal         Money               `json:"transfer_total"`
	QRTotal               Money               `json:"qr_total"`
	CountedCash           *Money              `json:"counted_cash"`
	ContributedCash       Money               `json:"contributed_cash"`
	ClosingCash           *Money              `json:"closing_cash"`
	Observation           string              `json:"observation"`
	CountLines            []ProposalCountLine `json:"count_lines"`
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
// period is the database's; the three derived numbers are computed here on read and never
// written. SalesTotal, CommissionAmount, CardTotal, TransferTotal and QRTotal are written
// by the closure: migration 034 only admits them on the transition to closed, so a
// proposed settlement reads them as zero and the offer lives in its latest round.
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
	// happened, read from the cash ledger over the same window. The proposal writes both, so
	// they are zero only before it (S8, S12).
	CashSales         Money  `json:"cash_sales"`
	CashExpenses      Money  `json:"cash_expenses"`
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
	// ExpectedCash is opening cash plus the cash sales of the period minus its cash
	// expenses; CashDifference is the counted cash against it, and TakenCash is what the
	// warehouse takes from the drawer: counted plus contributed minus the fund left
	// behind (S8, S10). They are derived on read, so they can never disagree with the
	// facts that produce them.
	ExpectedCash   Signed      `json:"expected_cash"`
	CashDifference *Signed     `json:"cash_difference"`
	TakenCash      *Signed     `json:"taken_cash"`
	CountLines     []CountLine `json:"count_lines"`
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
	// list is fixed; the list is the ledger and the total is the offer's, so while the
	// warehouse still holds the settlement the list is stated and CashExpenses is zero.
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
