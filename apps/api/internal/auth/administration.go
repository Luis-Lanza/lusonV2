package auth

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var (
	ErrAdminForbidden = errors.New("administration forbidden")
	ErrAdminInvalid   = errors.New("invalid administration input")
	ErrAdminNotFound  = errors.New("account unavailable")
	ErrAdminConflict  = errors.New("administration conflict")
	ErrBranchStock    = errors.New("branch has stock")
	ErrBranchUsers    = errors.New("branch has users")
	ErrBranchPending  = errors.New("branch has pending operations")
	// ErrBranchFrozen is the refusal of an act on a branch the warehouse is counting: it has a
	// live account settlement, and its till is frozen until that settlement is decided and
	// closed. Money stated into a till being counted would break the count (S5).
	ErrBranchFrozen = errors.New("branch has a live account settlement")
)

// Account is directory data only. Credentials and session secrets never enter
// administration DTOs. Decimal strings preserve bigint identities in clients.
type Account struct {
	ID                 string `json:"id"`
	Username           string `json:"username"`
	DisplayName        string `json:"display_name"`
	LocationID         int    `json:"location_id"`
	Enabled            bool   `json:"enabled"`
	MustChangePassword bool   `json:"must_change_password"`
}

type NewOperator struct {
	Username          string
	DisplayName       string
	LocationID        int
	TemporaryPassword string
}

type OperatorUpdate struct {
	DisplayName *string
	LocationID  *int
	Enabled     *bool
}

func administrationName(value string) bool {
	return utf8.ValidString(value) && len(value) <= 128 && strings.TrimSpace(value) != "" && !strings.ContainsRune(value, 0)
}
func branchLocation(id int) bool { return id > 1 && id <= 32767 }

// administrationAmountPattern is the house money contract at a branch's founding
// (S13): canonical decimal text with exactly two decimals and at most the ten
// integral digits numeric(12,2) holds. The text the caller states is the amount,
// never an approximation of it, so a padded, signed, comma or over-precision
// spelling is refused instead of quietly rounded.
var administrationAmountPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,9})\.[0-9]{2}$`)

// administrationAmount admits the canonical amount of the founding. Unlike a
// price it admits zero: 0,00 is the explicit answer of a branch that starts
// without money (S3).
func administrationAmount(value string) bool { return administrationAmountPattern.MatchString(value) }

// Administrator is a passive pre-body gate, never a client role assertion.
// Every operation rechecks it under locks in its own transaction.
func (s *Service) Administrator(ctx context.Context, token string) error {
	session, _, err := s.Peek(ctx, token)
	if err != nil {
		return err
	}
	if session.Identity.MustChangePassword {
		return ErrAdminForbidden
	}
	if session.Identity.AccountID != 1 || session.Identity.Location.ID != 1 {
		return ErrAdminForbidden
	}
	return nil
}

// administrationTx locks all existing accounts before any session. This also
// prevents inversion with Login(previous), which may retire another account's
// session, and with ChangePassword. The protected account serializes admin
// writers; concurrent target edits always read the latest locked state.
func (s *Service) administrationTx(ctx context.Context, token string, target int64) (pgx.Tx, error) {
	if err := s.Administrator(ctx, token); err != nil {
		return nil, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	valid := false
	defer func() {
		if !valid {
			_ = tx.Rollback(context.WithoutCancel(ctx))
		}
	}()
	rows, err := tx.Query(ctx, `SELECT id FROM auth_accounts WHERE id=1 OR id=$1 ORDER BY id FOR UPDATE`, target)
	if err != nil {
		return nil, err
	}
	found := target == 0
	for rows.Next() {
		var id int64
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		if id == target {
			found = true
		}
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	var live bool
	err = tx.QueryRow(ctx, `SELECT true FROM auth_accounts a JOIN auth_sessions s ON s.account_id=a.id
 WHERE a.id=1 AND a.location_id=1 AND a.enabled AND NOT a.must_change_password
 AND s.token_hash=$1 AND s.authority_version=a.authority_version AND s.revoked_at IS NULL
 AND s.absolute_deadline>$2 AND s.idle_deadline>$2 FOR UPDATE OF s`, tokenHash(token), s.now().UTC()).Scan(&live)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrSession
	}
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, ErrAdminNotFound
	}
	valid = true
	return tx, nil
}

func administrationError(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "23505":
			return ErrAdminConflict
		case "23503", "23514", "22003":
			return ErrAdminInvalid
		}
	}
	return err
}

func (s *Service) ListAccounts(ctx context.Context, token string) ([]Account, error) {
	tx, err := s.administrationTx(ctx, token, 0)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	result := []Account{}
	rows, err := tx.Query(ctx, `SELECT id::text,username,display_name,location_id,enabled,must_change_password FROM auth_accounts WHERE deleted_at IS NULL ORDER BY id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var a Account
		if err = rows.Scan(&a.ID, &a.Username, &a.DisplayName, &a.LocationID, &a.Enabled, &a.MustChangePassword); err != nil {
			rows.Close()
			return nil, err
		}
		result = append(result, a)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return result, tx.Commit(ctx)
}

// BranchBooks is the money of one branch exactly as the administration reads it from the books:
// what the branch's last closed settlement left in its drawer, the cash its sales collected after
// that cut, the signed effect of every movement of its own book after the same cut, the signed sum
// of `purchase_fund_ledger`, and whether a live settlement has the branch frozen (S7, S8).
//
// The drawer's expectation is deliberately NOT computed here. `closings.DrawerExpected` is the one
// rule of the drawer -- the one the book, the metrics card and the settlement itself use -- and this
// package cannot reach it (it is the package that imports this one), so the terms are read here and
// the HTTP layer applies that rule instead of stating a second one.
type BranchBooks struct {
	BranchID      int
	OpeningCash   string
	CashSales     string
	CashEffective string
	FundBalance   string
	Frozen        bool
}

// ListBranchBooks reads the two balances of every live branch, by branch, for the administration
// panel (S7, S8). It is a read of the books and of nothing else: the drawer's terms come from the
// branch's own ledger view, its sales and the amount its last closed settlement left behind -- the
// same window the branch's own book reads, so the panel and the branch cannot describe two different
// periods -- and the fund is `sum(effective)` of `purchase_fund_ledger`, the one arithmetic of the
// fund. The warehouse is not a branch: it owns no drawer and no fund, so it is not published here.
// `frozen` states the live settlement that makes the drawer's number the one about to change.
func (s *Service) ListBranchBooks(ctx context.Context, token string) ([]BranchBooks, error) {
	tx, err := s.administrationTx(ctx, token, 0)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	result := []BranchBooks{}
	// The cut of the last closed settlement and the cash it left in the drawer are one row of one
	// branch, the same row the opener of the next settlement inherits its opening from and the same
	// one the branch's own book reads; a branch that never closed a settlement starts at zero and its
	// window is everything it ever did.
	rows, err := tx.Query(ctx, `WITH settled AS (
    SELECT DISTINCT ON (closing.branch_location_id)
           closing.branch_location_id, closing.cut_at, closing.closing_cash
      FROM branch_closings closing
     WHERE closing.status='closed'
     ORDER BY closing.branch_location_id, closing.cut_at DESC, closing.id DESC
)
SELECT branch.id,
  coalesce(settled.closing_cash,0)::numeric(12,2)::text,
  coalesce((SELECT sum(sale.cash_amount) FROM sales sale
     WHERE sale.branch_location_id=branch.id
       AND (settled.cut_at IS NULL OR sale.created_at >= settled.cut_at)),0)::numeric(12,2)::text,
  coalesce((SELECT sum(ledger.effective) FROM branch_cash_ledger ledger
     WHERE ledger.branch_location_id=branch.id AND ledger.closing_id IS NULL
       AND (settled.cut_at IS NULL OR ledger.occurred_at >= settled.cut_at)),0)::numeric(12,2)::text,
  coalesce((SELECT sum(ledger.effective) FROM purchase_fund_ledger ledger
     WHERE ledger.branch_location_id=branch.id),0)::numeric(12,2)::text,
  branch_closure_blocker(branch.id)
 FROM locations branch LEFT JOIN settled ON settled.branch_location_id=branch.id
 WHERE branch.deleted_at IS NULL AND branch.id > 1
 ORDER BY branch.id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var book BranchBooks
		if err = rows.Scan(&book.BranchID, &book.OpeningCash, &book.CashSales, &book.CashEffective,
			&book.FundBalance, &book.Frozen); err != nil {
			rows.Close()
			return nil, err
		}
		result = append(result, book)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return result, tx.Commit(ctx)
}

func (s *Service) ListBranches(ctx context.Context, token string) ([]Location, error) {
	tx, err := s.administrationTx(ctx, token, 0)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	result := []Location{}
	rows, err := tx.Query(ctx, `SELECT id,name FROM locations WHERE deleted_at IS NULL ORDER BY id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var l Location
		if err = rows.Scan(&l.ID, &l.Name); err != nil {
			rows.Close()
			return nil, err
		}
		result = append(result, l)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return result, tx.Commit(ctx)
}

// administrationHash shares Login/ChangePassword's process-local admission.
func (s *Service) administrationHash(password string) (string, error) {
	select {
	case s.hashing <- struct{}{}:
		defer func() { <-s.hashing }()
	default:
		return "", ErrLimited
	}
	return HashPassword(password)
}

func (s *Service) CreateOperator(ctx context.Context, token string, input NewOperator) (Account, error) {
	if err := s.Administrator(ctx, token); err != nil {
		return Account{}, err
	}
	if !ValidCredentials(input.Username, input.TemporaryPassword) || !administrationName(input.DisplayName) || !branchLocation(input.LocationID) {
		return Account{}, ErrAdminInvalid
	}
	replacement, err := s.administrationHash(input.TemporaryPassword)
	if err != nil {
		return Account{}, err
	}
	tx, err := s.administrationTx(ctx, token, 0)
	if err != nil {
		return Account{}, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	// The existing trigger alone allocates account IDs. Assignment is independent.
	var a Account
	err = tx.QueryRow(ctx, `INSERT INTO auth_accounts(username,display_name,location_id,password_hash,must_change_password,enabled)
 VALUES($1,$2,$3,$4,true,true) RETURNING id::text,username,display_name,location_id,enabled,must_change_password`, input.Username, input.DisplayName, input.LocationID, replacement).Scan(&a.ID, &a.Username, &a.DisplayName, &a.LocationID, &a.Enabled, &a.MustChangePassword)
	if err != nil {
		return Account{}, administrationError(err)
	}
	return a, tx.Commit(ctx)
}

func (s *Service) UpdateOperator(ctx context.Context, token string, id int64, input OperatorUpdate) error {
	if err := s.Administrator(ctx, token); err != nil {
		return err
	}
	if id == 1 && (input.LocationID != nil || input.Enabled != nil) {
		return ErrAdminForbidden
	}
	if id < 1 || (input.DisplayName == nil && input.LocationID == nil && input.Enabled == nil) || (input.DisplayName != nil && !administrationName(*input.DisplayName)) || (input.LocationID != nil && !branchLocation(*input.LocationID)) {
		return ErrAdminInvalid
	}
	tx, err := s.administrationTx(ctx, token, id)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	var location int
	var enabled bool
	var display string
	if err = tx.QueryRow(ctx, `SELECT location_id,enabled,display_name FROM auth_accounts WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&location, &enabled, &display); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrAdminNotFound
		}
		return err
	}
	retire := false
	if input.LocationID != nil {
		retire = location != *input.LocationID
		location = *input.LocationID
	}
	if input.Enabled != nil {
		retire = retire || enabled != *input.Enabled
		enabled = *input.Enabled
	}
	if input.DisplayName != nil {
		display = *input.DisplayName
	}
	if _, err = tx.Exec(ctx, `UPDATE auth_accounts SET location_id=$2,enabled=$3,display_name=$4,authority_version=authority_version+$5 WHERE id=$1`, id, location, enabled, display, boolIncrement(retire)); err != nil {
		return administrationError(err)
	}
	if retire {
		if err = retireAccountSessions(ctx, tx, id, s.now().UTC()); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
func boolIncrement(value bool) int {
	if value {
		return 1
	}
	return 0
}

func (s *Service) ResetOperatorPassword(ctx context.Context, token string, id int64, password string) error {
	if err := s.Administrator(ctx, token); err != nil {
		return err
	}
	if id == 1 {
		return ErrAdminForbidden
	}
	if id < 1 || !ValidCredentials("valid", password) {
		return ErrAdminInvalid
	}
	tx, err := s.administrationTx(ctx, token, id)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	var active bool
	if err = tx.QueryRow(ctx, `SELECT deleted_at IS NULL FROM auth_accounts WHERE id=$1`, id).Scan(&active); err != nil {
		return err
	}
	if !active {
		return ErrAdminNotFound
	}
	replacement, err := s.administrationHash(password)
	if err != nil {
		return err
	}
	if err = resetAccountCredential(ctx, tx, id, replacement, s.now().UTC()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RetireOperator retains identity/history and retires all authority atomically.
func (s *Service) RetireOperator(ctx context.Context, token string, id int64) error {
	if err := s.Administrator(ctx, token); err != nil {
		return err
	}
	if id == 1 {
		return ErrAdminForbidden
	}
	if id < 1 {
		return ErrAdminInvalid
	}
	tx, err := s.administrationTx(ctx, token, id)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	var active bool
	if err = tx.QueryRow(ctx, `SELECT deleted_at IS NULL FROM auth_accounts WHERE id=$1`, id).Scan(&active); err != nil {
		return err
	}
	// Do not UPDATE an archived marker or retire its sessions a second time.
	if !active {
		return tx.Commit(ctx)
	}
	// Ordered account/admin-session locks precede the statement trigger's global
	// fence. PostgreSQL's transaction timestamp is stable for the marker.
	if _, err = tx.Exec(ctx, `UPDATE auth_accounts SET enabled=false,deleted_at=CURRENT_TIMESTAMP,authority_version=authority_version+1 WHERE id=$1 AND deleted_at IS NULL`, id); err != nil {
		return administrationError(err)
	}
	if err = retireAccountSessions(ctx, tx, id, s.now().UTC()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RetireBranch retains the complete catalog, balances, audiences and history.
func (s *Service) RetireBranch(ctx context.Context, token string, id int64) error {
	if err := s.Administrator(ctx, token); err != nil {
		return err
	}
	if id == 1 {
		return ErrAdminForbidden
	}
	if id < 1 || id > 32767 {
		return ErrAdminInvalid
	}
	tx, err := s.administrationTx(ctx, token, 0)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	// Ordered admin account/session locks precede the common fence. Keep this
	// separate from reads so READ COMMITTED sees the winner after any wait.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(714025,1)`); err != nil {
		return err
	}
	var active bool
	if err = tx.QueryRow(ctx, `SELECT deleted_at IS NULL FROM locations WHERE id=$1`, int16(id)).Scan(&active); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrAdminNotFound
		}
		return err
	}
	if !active {
		return tx.Commit(ctx)
	}
	var blocker *string
	if err = tx.QueryRow(ctx, `SELECT branch_retirement_blocker($1::smallint)`, int16(id)).Scan(&blocker); err != nil {
		return err
	}
	if blocker != nil {
		switch *blocker {
		case "stock":
			return ErrBranchStock
		case "users":
			return ErrBranchUsers
		case "operations":
			return ErrBranchPending
		default:
			return ErrAdminConflict
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE locations SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1`, int16(id)); err != nil {
		return administrationError(err)
	}
	return tx.Commit(ctx)
}

// loadFundsError publishes the decisions the load's own guards take: an act that states nothing
// valid is invalid input, a branch that does not exist -- retired included, and the warehouse, which
// is not a branch -- is not found, and a branch the warehouse is counting is the freeze of its
// settlement, with the code that settlement states (S4, S5).
func loadFundsError(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "LG001":
			return ErrAdminInvalid
		case "LG002":
			return ErrAdminNotFound
		case "LC001":
			return ErrBranchFrozen
		}
	}
	return administrationError(err)
}

// LoadBranchFunds loads the two funds of a branch that already exists (S1-S4, S9): the warehouse
// states the drawer's operating cash and the purchase fund, and the database writes them as the two
// `aporte` rows of the two books, signed by the administering account. Both amounts are mandatory and
// canonical decimal text, exactly as at a founding, and `0,00` is a valid and explicit answer that
// writes nothing at all (S9). The branch must be alive and not frozen: a live settlement refuses the
// load with the settlement's own code, because money in the till being counted would break the count
// (S5). A load never freezes anything (S6): it opens no settlement and writes no row of one.
func (s *Service) LoadBranchFunds(ctx context.Context, token string, branchID int, openingCash, purchaseFund string) error {
	if err := s.Administrator(ctx, token); err != nil {
		return err
	}
	if !branchLocation(branchID) || !administrationAmount(openingCash) || !administrationAmount(purchaseFund) {
		return ErrAdminInvalid
	}
	tx, err := s.administrationTx(ctx, token, 0)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	// load_branch_funds states the act and writes its two movements in one transaction: the
	// warehouse as the actor -- 1 is the single administering identity Administrator resolved -- and
	// the freeze through the guard of 035, which also takes the per-branch lock the files of that
	// branch share.
	if _, err = tx.Exec(ctx, `SELECT load_branch_funds($1::smallint,$2::numeric,$3::numeric,$4::integer)`,
		int16(branchID), openingCash, purchaseFund, 1); err != nil {
		return loadFundsError(err)
	}
	return tx.Commit(ctx)
}

// CreateBranch founds a branch with the two amounts the administration states:
// the drawer's opening cash and its purchase fund (S1, S2). Both are mandatory and
// both are canonical decimal text; 0,00 is a valid and explicit answer that the
// branch starts without money (S3). The founding is one transaction (S12): the
// branch and its two opening movements are written together or not at all.
func (s *Service) CreateBranch(ctx context.Context, token, name, openingCash, purchaseFund string) (Location, error) {
	if err := s.Administrator(ctx, token); err != nil {
		return Location{}, err
	}
	if !administrationName(name) || strings.TrimSpace(name) == "Almacén" ||
		!administrationAmount(openingCash) || !administrationAmount(purchaseFund) {
		return Location{}, ErrAdminInvalid
	}
	tx, err := s.administrationTx(ctx, token, 0)
	if err != nil {
		return Location{}, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	location := Location{Name: name}
	// create_branch_funded reuses the initialized-catalog allocation lock,
	// zero-stock and audience triggers of the allocation itself and writes the two
	// openings of the branch in the same transaction. The creator is the
	// administering identity Administrator already resolved -- the single warehouse
	// account, 1 -- which is the actor the two openings are signed by (S4).
	// No bootstrap import (bootstrap already depends on auth).
	if err = tx.QueryRow(ctx, `SELECT create_branch_funded($1,$2::numeric,$3::numeric,$4::integer)`,
		name, openingCash, purchaseFund, 1).Scan(&location.ID); err != nil {
		return Location{}, administrationError(err)
	}
	return location, tx.Commit(ctx)
}
