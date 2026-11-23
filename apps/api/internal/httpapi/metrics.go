package httpapi

import (
	"errors"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"

	"luson/api/internal/auth"
	"luson/api/internal/catalog"
	"luson/api/internal/closings"
	"luson/api/internal/config"
	"luson/api/internal/purchases"
)

// metricsCollectionPath is the metrics read of one branch. There is no per-branch parameter: an
// account reads the branch it belongs to, exactly like its settlements and its sales, so the route
// cannot be asked for someone else's numbers.
const metricsCollectionPath = "/api/metrics"

// The computed period this read publishes first: the window from the cut of the last closed
// settlement of the branch to the instant of the read (S3, S4). Its kind and its token are the same
// word, and it is this contract's own period -- never a fourth kind of the Compras selector, which
// keeps its three exactly as they are (S9).
const (
	metricsCurrentKind  purchases.PeriodKind = "current"
	metricsCurrentToken                      = "current"
	// metricsCurrentLabel is the exact words the selector and the chosen period state for it (S4).
	metricsCurrentLabel = "Desde el último corte"
)

// metricsMoneyPattern and metricsSignedPattern admit the canonical money and difference text this
// contract publishes: exactly two decimals for an amount, with an optional sign only where a
// difference states one. Anything else is a shape this server never wrote.
var (
	metricsMoneyPattern  = regexp.MustCompile(`^\d{1,12}\.\d{2}$`)
	metricsSignedPattern = regexp.MustCompile(`^-?\d{1,12}\.\d{2}$`)
)

// metricsTodayMovements is the bound of the ledger list the drawer of today publishes: the read keeps
// the newest rows, so a long history can never flood the answer.
const metricsTodayMovements = 50

// NewWithMetrics mounts the metrics read beside the purchase and settlement contracts. It is a
// wrapper on purpose, exactly like the other contracts: the route is added without changing any
// existing constructor, and every other request is forwarded unchanged.
func NewWithMetrics(base http.Handler, service *auth.Service, cfg config.Auth,
	purchaseStore *purchases.Store, store *closings.Store) (http.Handler, error) {
	if base == nil || service == nil || purchaseStore == nil || store == nil {
		return nil, closings.ErrUnavailable
	}
	parsed, err := config.ParseAuth(config.LocalTrial, cfg.Origin, cfg.Listen, cfg.TLSCert, cfg.TLSKey)
	if err != nil || parsed != cfg {
		return nil, closings.ErrUnavailable
	}
	api := &API{service, cfg}
	mux := http.NewServeMux()
	mux.HandleFunc(metricsCollectionPath, api.metrics(purchaseStore, store))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.URL.Path == metricsCollectionPath {
			mux.ServeHTTP(w, r)
			return
		}
		base.ServeHTTP(w, r)
	}), nil
}

// metrics serves the metrics of one period of the actor's own branch. The selector is the one the
// Compras contract publishes, so the two screens offer the same periods in the same order; the
// pending balance is not a period and is not offered here.
func (a *API) metrics(purchaseStore *purchases.Store, store *closings.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodGet) {
			return
		}
		actor, ok := a.inventoryIdentity(w, r)
		if !ok {
			return
		}
		selection, err := metricsPeriodQuery(r.URL.RawQuery)
		if err != nil {
			metricsFailure(w, err)
			return
		}
		// The computed window is this contract's own period and names no settlement, so it is resolved
		// before the Compras selector is asked (S3): the selector is read for the list the branch already
		// has and the window is placed in front of it.
		window := selection.Kind == metricsCurrentKind
		if window {
			selection = purchases.PeriodSelection{Kind: purchases.PeriodAll}
		}
		periods, period, err := purchaseStore.ResolvePeriod(r.Context(), actor, selection)
		if err != nil {
			metricsFailure(w, err)
			return
		}
		// A pending balance is material bought and not yet taken to the warehouse: it is not a
		// stretch of time, so it has no sales, no drawer and no envelope to state.
		if period.Kind == purchases.PeriodPending {
			failure(w, 400, "invalid_request")
			return
		}
		chosen := closings.MetricsPeriod{ClosingID: period.ClosingID,
			History: period.Kind == purchases.PeriodAll}
		if window {
			periods, period, err = metricsCurrentPeriod(periods)
			if err != nil {
				metricsFailure(w, err)
				return
			}
			chosen = closings.MetricsPeriod{Window: true}
		}
		result, err := store.Metrics(r.Context(), actor, chosen)
		if err != nil {
			metricsFailure(w, err)
			return
		}
		record, err := metricsRecord(periods, period, result)
		if err != nil {
			metricsFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// metricsPeriodQuery reads the period of the wire: the same tokens the Compras contract reads plus the
// one computed window of this read, with nothing else admitted. A bare separator is an ambiguous
// framing, never the default period, a query without a period reads the whole history, and every part
// of the query is judged -- a repeated or foreign key is a rejection, never the first one that happens
// to be a period.
func metricsPeriodQuery(raw string) (purchases.PeriodSelection, error) {
	selection := purchases.PeriodSelection{Kind: purchases.PeriodAll}
	if raw == "" {
		return selection, nil
	}
	if len(raw) > 512 {
		return purchases.PeriodSelection{}, purchases.ErrInvalid
	}
	seen := false
	for _, part := range strings.Split(raw, "&") {
		key, value, ok := strings.Cut(part, "=")
		if !ok || key != "period" || value == "" || seen {
			return purchases.PeriodSelection{}, purchases.ErrInvalid
		}
		read, err := metricsPeriodToken(value)
		if err != nil {
			return purchases.PeriodSelection{}, err
		}
		selection, seen = read, true
	}
	if !seen {
		return purchases.PeriodSelection{}, purchases.ErrInvalid
	}
	return selection, nil
}

// metricsPeriodToken reads one period token: the computed window is this contract's own and every
// other token is judged by the Compras contract's own parser, so the two selectors can never admit a
// different set of settlements.
func metricsPeriodToken(value string) (purchases.PeriodSelection, error) {
	if value == metricsCurrentToken {
		return purchases.PeriodSelection{Kind: metricsCurrentKind}, nil
	}
	return purchasePeriodQuery(value)
}

// metricsCurrentPeriod places the computed window in front of the selector the branch already has and
// returns it as the chosen period (S4). The window is published only when the branch has a closed
// settlement to start from and no live one: a live settlement already covers that same stretch of time
// as «En curso», and offering both would be the same number twice. Otherwise it is not published at all
// and asking for it is a period the branch does not have (S4, S7).
func metricsCurrentPeriod(periods []purchases.Period) ([]purchases.Period, purchases.Period, error) {
	var cut *time.Time
	for _, period := range periods {
		switch {
		case period.Kind == purchases.PeriodOpen:
			return nil, purchases.Period{}, closings.ErrNotFound
		case period.Kind == purchases.PeriodSettlement && cut == nil:
			// The selector is newest first, so the first closed settlement is the last one of the branch
			// and its cut is where the window starts.
			cut = period.To
		}
	}
	if cut == nil || cut.IsZero() {
		return nil, purchases.Period{}, closings.ErrNotFound
	}
	from := *cut
	window := purchases.Period{Kind: metricsCurrentKind, From: &from, Label: metricsCurrentLabel}
	return append([]purchases.Period{window}, periods...), window, nil
}

// metricsFailure publishes the domain's own decision: an invalid request names the request, a
// foreign branch is forbidden, a settlement of another branch is not found, and anything unexpected
// fails closed instead of leaking a driver decision.
func metricsFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, purchases.ErrInvalid):
		failure(w, 400, "invalid_request")
	case errors.Is(err, purchases.ErrForbidden), errors.Is(err, closings.ErrForbidden):
		failure(w, 403, "forbidden")
	case errors.Is(err, purchases.ErrNotFound), errors.Is(err, closings.ErrNotFound):
		failure(w, 404, "not_found")
	default:
		failure(w, 503, "service_unavailable")
	}
}

// metricsDTO is the whole answer of one period: the selector, the period that was chosen, where
// its numbers came from, and the accounts themselves. A null account is a period that has none,
// never a zero: the history states no drawer, and a period whose successor was not opened states
// no replacement.
type metricsDTO struct {
	Periods   []purchasePeriodDTO  `json:"periods"`
	Period    purchasePeriodDTO    `json:"period"`
	Source    string               `json:"source"`
	Sales     metricsSalesDTO      `json:"sales"`
	Cash      *metricsCashDTO      `json:"cash"`
	Fund      *metricsFundDTO      `json:"fund"`
	Materials *metricsMaterialsDTO `json:"materials"`
	Top       []metricsModelDTO    `json:"top_models"`
	Stock     metricsStockDTO      `json:"stock"`
	// Today is never null: the drawer of the branch today exists whether or not the period on
	// screen has one (S12). Neither is FundToday, the second money box of the branch, which has no
	// other screen to be read from (S15).
	Today     metricsTodayDTO     `json:"today"`
	FundToday metricsFundTodayDTO `json:"fund_today"`
}

// metricsMovementDTO is one row of the branch's cash ledger after the last cut: the kind the ledger
// writes, the amount it states, the effect signed the way the drawer moves and the instant it happened.
// Effective is the very term the expectation of the window sums, so a screen can state a correction as
// money coming back instead of as a second expense (S4, S13).
type metricsMovementDTO struct {
	Kind   string `json:"kind"`
	Amount string `json:"amount"`
	// Effective is positive into the drawer and negative out of it; a correction carries the opposite
	// direction of the movement it answers (S6).
	Effective  string `json:"effective"`
	OccurredAt string `json:"occurred_at"`
}

// metricsTodayDTO is the drawer of today: the cut it starts from -- null for a branch that never
// closed a settlement -- the three terms of the drawer's own identity, the expectation they produce and
// the ledger rows of the window with their signed effect (S4, S12-S13).
type metricsTodayDTO struct {
	Since    *string `json:"since"`
	Opening  string  `json:"opening"`
	Sales    string  `json:"sales"`
	Expenses string  `json:"expenses"`
	// Effective is the signed sum of every movement of the window that belongs to no settlement: the
	// third term of the identity, opening + sales + effective = expected (S4, S13).
	Effective string `json:"effective"`
	Expected  string `json:"expected"`
	// The rate is null for a branch the warehouse never configured: the absence of a rate is a state
	// of its own and never a zero percentage (S20). Sold is the base the commission was computed on,
	// and Commission is what the branch is earning -- not what it holds: the amount is settled when
	// the settlement is proposed and until then it is a projection, pinned by the identity that
	// produces it (S18, S19).
	Rate       *string              `json:"rate"`
	Sold       string               `json:"sold"`
	Commission string               `json:"commission"`
	Movements  []metricsMovementDTO `json:"movements"`
}

// metricsFundTodayDTO is the purchase envelope of today: the cut its window starts from -- null for a
// branch that never closed a settlement -- what the last closure left in it, the cash the branch spent
// on purchases after that cut, the signed effect of the movements of that same window, the balance the
// book holds and the volume those documents bought (S15-S17). The balance and the window's effect are
// signed; the counts are not. `balance` is the book's own sum and `effective` the term that, added to
// `opening`, produces it: `purchases` is the cash of the window's documents, a volume and not the second
// term of the balance.
type metricsFundTodayDTO struct {
	Since      *string `json:"since"`
	Opening    string  `json:"opening"`
	Purchases  string  `json:"purchases"`
	Effective  string  `json:"effective"`
	Balance    string  `json:"balance"`
	Documents  int64   `json:"documents"`
	UsedUnits  int64   `json:"used_units"`
	ScrapMilli int64   `json:"scrap_milli"`
}

type metricsSalesDTO struct {
	Total      string `json:"total"`
	Cash       string `json:"cash"`
	Card       string `json:"card"`
	Transfer   string `json:"transfer"`
	QR         string `json:"qr"`
	Commission string `json:"commission"`
	Sales      int64  `json:"sales"`
	Units      int64  `json:"units"`
}

type metricsCashDTO struct {
	Opening    string  `json:"opening"`
	Sales      string  `json:"sales"`
	Expenses   string  `json:"expenses"`
	Expected   string  `json:"expected"`
	Counted    *string `json:"counted"`
	Difference *string `json:"difference"`
}

type metricsFundDTO struct {
	Opening     string  `json:"opening"`
	Purchases   string  `json:"purchases"`
	Expected    string  `json:"expected"`
	Counted     *string `json:"counted"`
	Difference  *string `json:"difference"`
	Replacement *string `json:"replacement"`
}

type metricsMaterialDTO struct {
	MaterialID int64  `json:"material_id"`
	Material   string `json:"material"`
	Bought     int64  `json:"bought_milli"`
	Delivered  *int64 `json:"delivered_milli"`
}

type metricsMaterialsDTO struct {
	Used           int64                `json:"used_units"`
	UsedDelivered  *int64               `json:"used_delivered_units"`
	Scrap          int64                `json:"scrap_milli"`
	ScrapDelivered *int64               `json:"scrap_delivered_milli"`
	Materials      []metricsMaterialDTO `json:"materials"`
}

// metricsModelDTO is one row of the ranking, discriminated by its own shape and never by a tag beside
// it: a battery carries the six keys it always published -- its catalogue entry, its brand, its model,
// its capacity, its units and its money -- and an other product carries its free name where the battery
// carries its identity, with no battery key at all. A product never publishes a capacity, because it
// has none and a number nobody stored would read as if the catalogue had one; the row's own volume is
// the same for both kinds (S6).
type metricsModelDTO struct {
	CatalogEntryID int64   `json:"catalog_entry_id"`
	Brand          *string `json:"brand,omitempty"`
	Model          *string `json:"model,omitempty"`
	Capacity       *string `json:"capacity_ah,omitempty"`
	Name           *string `json:"name,omitempty"`
	Units          int64   `json:"units"`
	Money          string  `json:"money"`
}

type metricsStockDTO struct {
	Units int64 `json:"units"`
}

// metricsRecord admits the read and renders it. The selector is published without the pending
// balance, in its frozen order, and the chosen period must be one of the entries published, so the
// screen can never say it is showing a period the selector does not offer.
func metricsRecord(periods []purchases.Period, chosen purchases.Period,
	metrics closings.Metrics) (metricsDTO, error) {
	selector, err := metricsPeriodsRecord(periods)
	if err != nil {
		return metricsDTO{}, err
	}
	period, err := metricsPeriodEntry(chosen)
	if err != nil {
		return metricsDTO{}, err
	}
	offered := false
	for _, entry := range selector {
		if entry.key() == period.key() {
			offered = true
			break
		}
	}
	if !offered || !metricsSourceValid(metrics.Source) {
		return metricsDTO{}, closings.ErrUnavailable
	}
	// The computed window is a period without an acta and it is never a frozen one: its origin is the
	// live read, the three accounts a closure states are null, and the money it publishes is the total
	// the same answer says the branch sold since the last cut, so the screen cannot contradict itself
	// (S5, S6).
	if chosen.Kind == metricsCurrentKind && (metrics.Source != "live" || metrics.Cash != nil ||
		metrics.Fund != nil || metrics.Materials != nil || metrics.Sales.Total != metrics.Today.Sold) {
		return metricsDTO{}, closings.ErrUnavailable
	}
	sales, err := metricsSalesRecord(metrics.Sales)
	if err != nil {
		return metricsDTO{}, err
	}
	today, err := metricsTodayRecord(metrics.Today)
	if err != nil {
		return metricsDTO{}, err
	}
	fundToday, err := metricsFundTodayRecord(metrics.FundToday)
	if err != nil {
		return metricsDTO{}, err
	}
	record := metricsDTO{Periods: selector, Period: period, Source: metrics.Source,
		Sales: sales, Top: make([]metricsModelDTO, 0, len(metrics.Top)),
		Stock: metricsStockDTO{Units: metrics.Stock.Units}, Today: today, FundToday: fundToday}
	if record.Stock.Units < 0 {
		return metricsDTO{}, closings.ErrUnavailable
	}
	if metrics.Cash != nil {
		cash, err := metricsCashRecord(*metrics.Cash)
		if err != nil {
			return metricsDTO{}, err
		}
		record.Cash = &cash
	}
	if metrics.Fund != nil {
		fund, err := metricsFundRecord(*metrics.Fund)
		if err != nil {
			return metricsDTO{}, err
		}
		record.Fund = &fund
	}
	if metrics.Materials != nil {
		materials, err := metricsMaterialsRecord(*metrics.Materials)
		if err != nil {
			return metricsDTO{}, err
		}
		record.Materials = &materials
	}
	for _, model := range metrics.Top {
		entry, err := metricsModelRecord(model)
		if err != nil {
			return metricsDTO{}, err
		}
		record.Top = append(record.Top, entry)
	}
	return record, nil
}

// metricsPeriodsRecord publishes the selector of the metrics read: the computed window when the branch
// can publish it, then every closed settlement newest first, then the live one, then the whole history.
// The pending balance is left out because it is not a period, and a list that repeats an entry is not a
// selector this domain wrote. The frozen order is checked here and not assumed: the window is published
// first and only beside a closed settlement with no live one covering it (S4), the settlements descend
// strictly by their own id, the live period comes after every settlement and at most once, and the whole
// history closes the list, so a screen can never offer a period beside the one it is showing.
func metricsPeriodsRecord(periods []purchases.Period) ([]purchasePeriodDTO, error) {
	unavailable := func() ([]purchasePeriodDTO, error) { return nil, purchases.ErrUnavailable }
	published := make([]purchasePeriodDTO, 0, len(periods))
	seen := make(map[purchasePeriodKey]bool, len(periods))
	previousSettlement := int64(math.MaxInt64)
	open, windowed, settled := false, false, false
	for i, period := range periods {
		if period.Kind == purchases.PeriodPending {
			continue
		}
		record, err := metricsPeriodEntry(period)
		if err != nil {
			return unavailable()
		}
		switch period.Kind {
		case metricsCurrentKind:
			// The computed window is the first entry of the selector and it is published once: nothing
			// is offered before it, because it is the window the branch is living (S4).
			if windowed || len(published) != 0 {
				return unavailable()
			}
			windowed = true
		case purchases.PeriodSettlement:
			// The selector is ordered by the cut, which is also the order of the ids: a
			// settlement that does not descend is not a history this domain wrote, and neither
			// is a closed one after the live period, because the live one is the newest.
			if open || *record.ClosingID >= previousSettlement {
				return unavailable()
			}
			previousSettlement, settled = *record.ClosingID, true
		case purchases.PeriodOpen:
			// The branch is inside one settlement at a time, so a second live period is not a
			// state this domain wrote.
			if open {
				return unavailable()
			}
			open = true
		case purchases.PeriodAll:
			// The whole history is what closes the selector: nothing is offered after it.
			if i != len(periods)-1 {
				return unavailable()
			}
		}
		if key := record.key(); seen[key] {
			return unavailable()
		} else {
			seen[key] = true
		}
		published = append(published, record)
	}
	if len(published) == 0 || published[len(published)-1].Kind != string(purchases.PeriodAll) {
		return unavailable()
	}
	// The window is offered only when it exists: a branch with no closed settlement has no cut to start
	// from, and a live settlement already covers that same window as «En curso» (S4).
	if windowed && (open || !settled) {
		return unavailable()
	}
	return published, nil
}

// metricsPeriodEntry admits one period of the selector and renders it: the computed window is this
// read's own kind and every settlement is the Compras contract's, judged by its own record.
func metricsPeriodEntry(period purchases.Period) (purchasePeriodDTO, error) {
	if period.Kind == metricsCurrentKind {
		return metricsCurrentPeriodRecord(period)
	}
	return purchasePeriodRecord(period)
}

// metricsCurrentPeriodRecord publishes the computed window (S4): the exact words the selector states for
// it, where it starts -- the cut of the last closed settlement -- and no end, because it ends at the
// instant of the read. It names no settlement, so it states no closing id and no `to`; a window that
// names a document is a period this read never offered.
func metricsCurrentPeriodRecord(period purchases.Period) (purchasePeriodDTO, error) {
	unavailable := func() (purchasePeriodDTO, error) {
		return purchasePeriodDTO{}, purchases.ErrUnavailable
	}
	if period.Label != metricsCurrentLabel || period.ClosingID != nil || period.From == nil ||
		period.To != nil || period.From.IsZero() {
		return unavailable()
	}
	from, ok := purchaseMoment(*period.From)
	if !ok {
		return unavailable()
	}
	return purchasePeriodDTO{Kind: string(metricsCurrentKind), From: &from, Label: period.Label}, nil
}

// metricsSourceValid admits the three origins the read can state.
func metricsSourceValid(source string) bool {
	return source == "settlement" || source == "live" || source == "history"
}

// metricsSalesRecord renders the money and the volume of a period, admitting only canonical text
// and non-negative counts.
func metricsSalesRecord(sales closings.MetricsSales) (metricsSalesDTO, error) {
	amounts := []closings.Money{sales.Total, sales.Cash, sales.Card, sales.Transfer, sales.QR,
		sales.Commission}
	for _, amount := range amounts {
		if !metricsMoneyPattern.MatchString(string(amount)) {
			return metricsSalesDTO{}, closings.ErrUnavailable
		}
	}
	if sales.Sales < 0 || sales.Units < 0 {
		return metricsSalesDTO{}, closings.ErrUnavailable
	}
	return metricsSalesDTO{Total: string(sales.Total), Cash: string(sales.Cash),
		Card: string(sales.Card), Transfer: string(sales.Transfer), QR: string(sales.QR),
		Commission: string(sales.Commission), Sales: sales.Sales, Units: sales.Units}, nil
}

func metricsCashRecord(cash closings.MetricsCash) (metricsCashDTO, error) {
	for _, amount := range []closings.Money{cash.Opening, cash.Sales, cash.Expenses} {
		if !metricsMoneyPattern.MatchString(string(amount)) {
			return metricsCashDTO{}, closings.ErrUnavailable
		}
	}
	if !metricsSignedPattern.MatchString(string(cash.Expected)) {
		return metricsCashDTO{}, closings.ErrUnavailable
	}
	record := metricsCashDTO{Opening: string(cash.Opening), Sales: string(cash.Sales),
		Expenses: string(cash.Expenses), Expected: string(cash.Expected)}
	if cash.Counted != nil {
		if !metricsMoneyPattern.MatchString(string(*cash.Counted)) {
			return metricsCashDTO{}, closings.ErrUnavailable
		}
		counted := string(*cash.Counted)
		record.Counted = &counted
	}
	if cash.Difference != nil {
		if !metricsSignedPattern.MatchString(string(*cash.Difference)) {
			return metricsCashDTO{}, closings.ErrUnavailable
		}
		difference := string(*cash.Difference)
		record.Difference = &difference
	}
	return record, nil
}

// metricsTodayRecord renders the drawer of today and admits every value of it: the cut is an
// RFC3339 instant or null, the amounts and the signed effect are canonical money, the expectation is
// exactly opening + sales + effective, and every movement is one of the four kinds the ledger writes
// with a positive amount, the effect its kind states and a real moment. The list is bounded and ordered
// oldest first, because a list the server never wrote is another answer (S4, S13).
func metricsTodayRecord(today closings.MetricsToday) (metricsTodayDTO, error) {
	unavailable := func() (metricsTodayDTO, error) { return metricsTodayDTO{}, closings.ErrUnavailable }
	record := metricsTodayDTO{Opening: string(today.Opening), Sales: string(today.Sales),
		Expenses: string(today.Expenses), Effective: string(today.Effective),
		Expected:  string(today.Expected),
		Movements: make([]metricsMovementDTO, 0, len(today.Movements))}
	for _, amount := range []closings.Money{today.Opening, today.Sales, today.Expenses} {
		if !metricsMoneyPattern.MatchString(string(amount)) {
			return unavailable()
		}
	}
	if !metricsSignedPattern.MatchString(string(today.Effective)) ||
		!metricsSignedPattern.MatchString(string(today.Expected)) {
		return unavailable()
	}
	// The expectation is the drawer's ONE rule over every term of the window -- the opening it inherited,
	// the cash its sales collected and the signed effect of its movements -- applied by the store's own
	// function: a drawer whose terms do not produce it is a number this read could not have written (S4,
	// S13).
	judged, err := closings.DrawerExpected(today.Opening, today.Sales, today.Effective)
	if err != nil || judged != today.Expected {
		return unavailable()
	}
	// The commission is the settlement's own rule applied to the window the branch is living: its
	// configured rate times the total it sold there, rounded once. A branch the warehouse never gave a
	// rate to earns nothing and states a null rate, never a zero percentage that would read as a rate
	// (S20); a rate that produces a different commission, or a commission with no rate behind it, is a
	// number this read could not have written (S18).
	if !metricsMoneyPattern.MatchString(string(today.Sold)) {
		return unavailable()
	}
	record.Sold = string(today.Sold)
	record.Commission = "0.00"
	if today.Rate != nil {
		rate, err := closings.ParsePercent(string(*today.Rate))
		if err != nil {
			return unavailable()
		}
		commission, err := closings.Commission(today.Sold, rate)
		if err != nil || string(commission) != string(today.Commission) {
			return unavailable()
		}
		configured := string(rate)
		record.Rate, record.Commission = &configured, string(commission)
	} else if string(today.Commission) != "0.00" {
		return unavailable()
	}
	if today.Since != nil {
		if today.Since.IsZero() {
			return unavailable()
		}
		since := today.Since.UTC().Format(time.RFC3339)
		if _, err := time.Parse(time.RFC3339, since); err != nil {
			return unavailable()
		}
		record.Since = &since
	}
	if len(today.Movements) > metricsTodayMovements {
		return unavailable()
	}
	previous := time.Time{}
	for _, movement := range today.Movements {
		if !metricsMovementKindPublished(movement.Kind) {
			return unavailable()
		}
		// The ledger writes a positive amount: a movement exists because money moved.
		amount := string(movement.Amount)
		cents, ok := metricsSignedCents(closings.Signed(amount))
		if !metricsMoneyPattern.MatchString(amount) || !ok || cents < 1 {
			return unavailable()
		}
		// The signed effect is the term the expectation reads, so it is judged as the row's own amount in
		// the direction its kind states: anything else is money this ledger never derived (S4, S13).
		effect := string(movement.Effective)
		effectCents, okEffect := metricsSignedCents(movement.Effective)
		if !metricsSignedPattern.MatchString(effect) || !okEffect ||
			(effectCents != cents && effectCents != -cents) ||
			!metricsMovementDirection(movement.Kind, effectCents) {
			return unavailable()
		}
		if movement.OccurredAt.IsZero() {
			return unavailable()
		}
		moment := movement.OccurredAt.UTC().Format(time.RFC3339)
		if _, err := time.Parse(time.RFC3339, moment); err != nil {
			return unavailable()
		}
		// The list is one moment after the other from the cut on: an order nobody read is not the
		// ledger this server publishes.
		if !previous.IsZero() && movement.OccurredAt.Before(previous) {
			return unavailable()
		}
		previous = movement.OccurredAt
		record.Movements = append(record.Movements,
			metricsMovementDTO{Kind: movement.Kind, Amount: amount, Effective: effect,
				OccurredAt: moment})
	}
	return record, nil
}

// metricsFundTodayRecord renders the purchase envelope of today and admits every value of it: the cut
// is an RFC3339 instant or null, the opening is canonical money, the purchases, the window's effect and
// the balance are signed readings, the balance is exactly opening + effective and the counts are
// non-negative (S15-S17). A branch without a previous closure states no cut and inherits nothing, which
// is the one pair this contract publishes: a null cut beside an opening somebody wrote is not a state
// the read produces.
func metricsFundTodayRecord(fund closings.MetricsFundToday) (metricsFundTodayDTO, error) {
	unavailable := func() (metricsFundTodayDTO, error) { return metricsFundTodayDTO{}, closings.ErrUnavailable }
	record := metricsFundTodayDTO{Opening: string(fund.Opening), Purchases: string(fund.Purchases),
		Effective: string(fund.Effective), Balance: string(fund.Balance), Documents: fund.Documents,
		UsedUnits: fund.UsedUnits, ScrapMilli: fund.ScrapMilli}
	// What the last closure left in the envelope is money the branch holds, never a signed reading.
	if !metricsMoneyPattern.MatchString(record.Opening) {
		return unavailable()
	}
	// A window's cash, its signed effect and the book's balance are net figures: a counter-document can
	// leave the cash negative and a correction can move the balance in either direction.
	if !metricsSignedPattern.MatchString(record.Purchases) ||
		!metricsSignedPattern.MatchString(record.Effective) ||
		!metricsSignedPattern.MatchString(record.Balance) {
		return unavailable()
	}
	opening, okOpening := metricsSignedCents(closings.Signed(record.Opening))
	_, okPurchases := metricsSignedCents(closings.Signed(record.Purchases))
	effect, okEffect := metricsSignedCents(closings.Signed(record.Effective))
	balance, okBalance := metricsSignedCents(closings.Signed(record.Balance))
	// The breakdown the card states is the book's: the amount the closure left plus the signed effect of
	// the movements of the window. A balance its terms do not produce, with the numbers on screen, is a
	// number this read could not have written. `purchases` is the cash of the same window's documents --
	// the volume they paid, not a term of the balance -- so it is admitted without entering the identity.
	if !okOpening || !okPurchases || !okEffect || !okBalance || balance != opening+effect {
		return unavailable()
	}
	// The documents are a count; the units and the kilograms are the NET of those documents, and a
	// counter-document that reversed a purchase of an earlier period can leave them below zero. Signing
	// them is the honest reading: refusing them would answer 503 for a branch that did nothing wrong.
	if record.Documents < 0 {
		return unavailable()
	}
	if fund.Since != nil {
		if fund.Since.IsZero() {
			return unavailable()
		}
		since := fund.Since.UTC().Format(time.RFC3339)
		if _, err := time.Parse(time.RFC3339, since); err != nil {
			return unavailable()
		}
		record.Since = &since
	} else if opening != 0 {
		// A branch that never closed a settlement inherits nothing: an opening nobody could have left is
		// not the answer of this read.
		return unavailable()
	}
	return record, nil
}

// metricsMovementKindValid admits the three kinds the branch records of its own period and nothing
// else: the expense it pays out, the contribution it receives and the collection it gives up. A
// correction is not one of them -- it answers another movement instead of stating a direction of its
// own -- so the write that records a movement of the period refuses it here (S6).
func metricsMovementKindValid(kind string) bool {
	return kind == "gasto" || kind == "recaudacion" || kind == "aporte"
}

// metricsMovementKindPublished admits the four kinds a row of the ledger can be when the drawer of
// today lists it: the three the branch records of its own period and the correction that answers one
// of them (S4, S6, S13). It is the read's admission and never the write's: nothing is recorded as a
// correction through the path above.
func metricsMovementKindPublished(kind string) bool {
	return metricsMovementKindValid(kind) || kind == "correccion"
}

// metricsMovementDirection reports whether one signed effect is the direction the ledger states for a row
// of that kind: an aporte puts money into the drawer, a gasto or a recaudacion take it out, and a
// correction states the opposite direction of the movement it answers, so either sign is a reading and
// the zero is not one (S6, S13).
func metricsMovementDirection(kind string, cents int64) bool {
	switch kind {
	case "aporte":
		return cents > 0
	case "gasto", "recaudacion":
		return cents < 0
	default:
		return cents != 0
	}
}

// metricsSignedCents reads one canonical amount of the answer as exact integer cents, so every
// identity of the contract is checked with whole cents and never with a float.
func metricsSignedCents(amount closings.Signed) (int64, bool) { return amount.Cents() }

func metricsFundRecord(fund closings.MetricsFund) (metricsFundDTO, error) {
	if !metricsMoneyPattern.MatchString(string(fund.Opening)) {
		return metricsFundDTO{}, closings.ErrUnavailable
	}
	// The net of the period's purchases is a difference and not a collection: a counter-document
	// that reversed a purchase of an earlier period leaves it negative, and the envelope still
	// closes -- expected = opening − purchases -- with the sign it states.
	if !metricsSignedPattern.MatchString(string(fund.Purchases)) {
		return metricsFundDTO{}, closings.ErrUnavailable
	}
	if !metricsSignedPattern.MatchString(string(fund.Expected)) {
		return metricsFundDTO{}, closings.ErrUnavailable
	}
	record := metricsFundDTO{Opening: string(fund.Opening), Purchases: string(fund.Purchases),
		Expected: string(fund.Expected)}
	if fund.Counted != nil {
		if !metricsMoneyPattern.MatchString(string(*fund.Counted)) {
			return metricsFundDTO{}, closings.ErrUnavailable
		}
		counted := string(*fund.Counted)
		record.Counted = &counted
	}
	if fund.Difference != nil {
		if !metricsSignedPattern.MatchString(string(*fund.Difference)) {
			return metricsFundDTO{}, closings.ErrUnavailable
		}
		difference := string(*fund.Difference)
		record.Difference = &difference
	}
	if fund.Replacement != nil {
		if !metricsMoneyPattern.MatchString(string(*fund.Replacement)) {
			return metricsFundDTO{}, closings.ErrUnavailable
		}
		replacement := string(*fund.Replacement)
		record.Replacement = &replacement
	}
	return record, nil
}

func metricsMaterialsRecord(materials closings.MetricsMaterials) (metricsMaterialsDTO, error) {
	if materials.Used < 0 || materials.Scrap < 0 {
		return metricsMaterialsDTO{}, closings.ErrUnavailable
	}
	record := metricsMaterialsDTO{Used: materials.Used, Scrap: materials.Scrap,
		Materials: make([]metricsMaterialDTO, 0, len(materials.Materials))}
	if materials.UsedDelivered != nil {
		// The delivered units are the counted ones: a count above the bought quantity is
		// informed and blocks nothing, exactly like the cash difference of a drawer.
		if *materials.UsedDelivered < 0 {
			return metricsMaterialsDTO{}, closings.ErrUnavailable
		}
		delivered := *materials.UsedDelivered
		record.UsedDelivered = &delivered
	}
	if materials.ScrapDelivered != nil {
		delivered := *materials.ScrapDelivered
		record.ScrapDelivered = &delivered
	}
	total := int64(0)
	for _, material := range materials.Materials {
		if material.MaterialID < 1 || material.Material == "" || material.Bought < 1 {
			return metricsMaterialsDTO{}, closings.ErrUnavailable
		}
		entry := metricsMaterialDTO{MaterialID: material.MaterialID, Material: material.Material,
			Bought: material.Bought}
		if material.Delivered != nil {
			if *material.Delivered < 0 {
				return metricsMaterialsDTO{}, closings.ErrUnavailable
			}
			delivered := *material.Delivered
			entry.Delivered = &delivered
		}
		total += material.Bought
		record.Materials = append(record.Materials, entry)
	}
	if total != materials.Scrap {
		return metricsMaterialsDTO{}, closings.ErrUnavailable
	}
	return record, nil
}

// metricsModelRecord publishes one row of the ranking. Each kind is judged against its own shape and
// against the absence of the other's: a battery still needs its brand, its model and a canonical
// capacity -- an empty brand or a capacity that is not the stored one is refused exactly as before
// (S6) -- and an other product states its name and no battery attribute, so the read is never relaxed
// into accepting a malformed battery.
func metricsModelRecord(model closings.MetricsModel) (metricsModelDTO, error) {
	record := metricsModelDTO{CatalogEntryID: model.CatalogEntryID, Units: model.Units,
		Money: string(model.Money)}
	if model.CatalogEntryID < 1 || model.Units < 1 ||
		!metricsMoneyPattern.MatchString(record.Money) {
		return metricsModelDTO{}, closings.ErrUnavailable
	}
	switch model.Kind {
	case catalog.BatteryKind:
		if model.Brand == "" || model.Model == "" || model.Name != "" ||
			!metricsCapacityPattern.MatchString(model.Capacity) {
			return metricsModelDTO{}, closings.ErrUnavailable
		}
		brand, modelName, capacity := model.Brand, model.Model, model.Capacity
		record.Brand, record.Model, record.Capacity = &brand, &modelName, &capacity
	case catalog.OtherKind:
		if model.Name == "" || model.Brand != "" || model.Model != "" || model.Capacity != "" {
			return metricsModelDTO{}, closings.ErrUnavailable
		}
		name := model.Name
		record.Name = &name
	default:
		return metricsModelDTO{}, closings.ErrUnavailable
	}
	return record, nil
}

// metricsCapacityPattern admits the rendered capacity of a model: whole or fractional ampere-hours
// without a padded fraction or a sign.
var metricsCapacityPattern = regexp.MustCompile(`^\d{1,9}(\.\d{1,6})?$`)
