package httpapi

import (
	"errors"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"

	"luson/api/internal/auth"
	"luson/api/internal/closings"
	"luson/api/internal/config"
	"luson/api/internal/purchases"
)

// metricsCollectionPath is the metrics read of one branch. There is no per-branch parameter: an
// account reads the branch it belongs to, exactly like its settlements and its sales, so the route
// cannot be asked for someone else's numbers.
const metricsCollectionPath = "/api/metrics"

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
		result, err := store.Metrics(r.Context(), actor, closings.MetricsPeriod{
			ClosingID: period.ClosingID,
			History:   period.Kind == purchases.PeriodAll,
		})
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

// metricsPeriodQuery reads the period of the wire: the same tokens the Compras contract reads,
// with nothing else admitted. A bare separator is an ambiguous framing, never the default period,
// a query without a period reads the whole history, and every part of the query is judged -- a
// repeated or foreign key is a rejection, never the first one that happens to be a period.
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
		read, err := purchasePeriodQuery(value)
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
	// screen has one (S12).
	Today metricsTodayDTO `json:"today"`
}

// metricsMovementDTO is one row of the branch's cash ledger after the last cut: the kind the ledger
// writes, its amount and the instant it happened.
type metricsMovementDTO struct {
	Kind       string `json:"kind"`
	Amount     string `json:"amount"`
	OccurredAt string `json:"occurred_at"`
}

// metricsTodayDTO is the drawer of today: the cut it starts from -- null for a branch that never
// closed a settlement -- the three terms of the settlement's own identity, the expectation they
// produce and the ledger rows of the window as information (S12-S14).
type metricsTodayDTO struct {
	Since     *string              `json:"since"`
	Opening   string               `json:"opening"`
	Sales     string               `json:"sales"`
	Expenses  string               `json:"expenses"`
	Expected  string               `json:"expected"`
	Movements []metricsMovementDTO `json:"movements"`
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

type metricsModelDTO struct {
	CatalogEntryID int64  `json:"catalog_entry_id"`
	Brand          string `json:"brand"`
	Model          string `json:"model"`
	Capacity       string `json:"capacity_ah"`
	Units          int64  `json:"units"`
	Money          string `json:"money"`
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
	period, err := purchasePeriodRecord(chosen)
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
	sales, err := metricsSalesRecord(metrics.Sales)
	if err != nil {
		return metricsDTO{}, err
	}
	today, err := metricsTodayRecord(metrics.Today)
	if err != nil {
		return metricsDTO{}, err
	}
	record := metricsDTO{Periods: selector, Period: period, Source: metrics.Source,
		Sales: sales, Top: make([]metricsModelDTO, 0, len(metrics.Top)),
		Stock: metricsStockDTO{Units: metrics.Stock.Units}, Today: today}
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

// metricsPeriodsRecord publishes the selector of the metrics read: every closed settlement newest
// first, then the live one, then the whole history. The pending balance is left out because it is
// not a period, and a list that repeats an entry is not a selector this domain wrote. The frozen
// order is checked here and not assumed: the settlements descend strictly by their own id, the
// live period comes after every settlement and at most once, and the whole history closes the
// list, so a screen can never offer a period beside the one it is showing.
func metricsPeriodsRecord(periods []purchases.Period) ([]purchasePeriodDTO, error) {
	unavailable := func() ([]purchasePeriodDTO, error) { return nil, purchases.ErrUnavailable }
	published := make([]purchasePeriodDTO, 0, len(periods))
	seen := make(map[purchasePeriodKey]bool, len(periods))
	previousSettlement := int64(math.MaxInt64)
	open := false
	for i, period := range periods {
		if period.Kind == purchases.PeriodPending {
			continue
		}
		record, err := purchasePeriodRecord(period)
		if err != nil {
			return unavailable()
		}
		switch period.Kind {
		case purchases.PeriodSettlement:
			// The selector is ordered by the cut, which is also the order of the ids: a
			// settlement that does not descend is not a history this domain wrote, and neither
			// is a closed one after the live period, because the live one is the newest.
			if open || *record.ClosingID >= previousSettlement {
				return unavailable()
			}
			previousSettlement = *record.ClosingID
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
	return published, nil
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
// RFC3339 instant or null, the three terms and the expectation are canonical money, and every
// movement is one of the kinds the ledger writes with a positive amount and a real moment. The list
// is bounded and ordered oldest first, because a list the server never wrote is another answer.
func metricsTodayRecord(today closings.MetricsToday) (metricsTodayDTO, error) {
	unavailable := func() (metricsTodayDTO, error) { return metricsTodayDTO{}, closings.ErrUnavailable }
	record := metricsTodayDTO{Opening: string(today.Opening), Sales: string(today.Sales),
		Expenses: string(today.Expenses), Expected: string(today.Expected),
		Movements: make([]metricsMovementDTO, 0, len(today.Movements))}
	for _, amount := range []closings.Money{today.Opening, today.Sales, today.Expenses} {
		if !metricsMoneyPattern.MatchString(string(amount)) {
			return unavailable()
		}
	}
	if !metricsSignedPattern.MatchString(string(today.Expected)) {
		return unavailable()
	}
	// The expectation is the settlement's own identity: a drawer whose terms do not produce it is a
	// number this read could not have written.
	expected, ok := metricsSignedCents(today.Expected)
	if !ok {
		return unavailable()
	}
	opening, okOpening := metricsSignedCents(closings.Signed(today.Opening))
	sales, okSales := metricsSignedCents(closings.Signed(today.Sales))
	expenses, okExpenses := metricsSignedCents(closings.Signed(today.Expenses))
	if !okOpening || !okSales || !okExpenses || expected != opening+sales-expenses {
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
		if !metricsMovementKindValid(movement.Kind) {
			return unavailable()
		}
		// The ledger writes a positive amount: a movement exists because money moved.
		amount := string(movement.Amount)
		cents, ok := metricsSignedCents(closings.Signed(amount))
		if !metricsMoneyPattern.MatchString(amount) || !ok || cents < 1 {
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
			metricsMovementDTO{Kind: movement.Kind, Amount: amount, OccurredAt: moment})
	}
	return record, nil
}

// metricsMovementKindValid admits the three kinds the ledger writes and nothing else.
func metricsMovementKindValid(kind string) bool {
	return kind == "gasto" || kind == "recaudacion" || kind == "aporte"
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

func metricsModelRecord(model closings.MetricsModel) (metricsModelDTO, error) {
	if model.CatalogEntryID < 1 || model.Brand == "" || model.Model == "" ||
		!metricsCapacityPattern.MatchString(model.Capacity) || model.Units < 1 ||
		!metricsMoneyPattern.MatchString(string(model.Money)) {
		return metricsModelDTO{}, closings.ErrUnavailable
	}
	return metricsModelDTO{CatalogEntryID: model.CatalogEntryID, Brand: model.Brand, Model: model.Model,
		Capacity: model.Capacity, Units: model.Units, Money: string(model.Money)}, nil
}

// metricsCapacityPattern admits the rendered capacity of a model: whole or fractional ampere-hours
// without a padded fraction or a sign.
var metricsCapacityPattern = regexp.MustCompile(`^\d{1,9}(\.\d{1,6})?$`)
