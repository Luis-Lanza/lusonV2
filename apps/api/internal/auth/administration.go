package auth

import (
	"context"
	"errors"
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
	rows, err := tx.Query(ctx, `SELECT id::text,username,display_name,location_id,enabled,must_change_password FROM auth_accounts ORDER BY id`)
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

func (s *Service) ListBranches(ctx context.Context, token string) ([]Location, error) {
	tx, err := s.administrationTx(ctx, token, 0)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	result := []Location{}
	rows, err := tx.Query(ctx, `SELECT id,name FROM locations ORDER BY id`)
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
	if err = tx.QueryRow(ctx, `SELECT location_id,enabled,display_name FROM auth_accounts WHERE id=$1`, id).Scan(&location, &enabled, &display); err != nil {
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
	replacement, err := s.administrationHash(password)
	if err != nil {
		return err
	}
	tx, err := s.administrationTx(ctx, token, id)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if err = resetAccountCredential(ctx, tx, id, replacement, s.now().UTC()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) CreateBranch(ctx context.Context, token, name string) (Location, error) {
	if err := s.Administrator(ctx, token); err != nil {
		return Location{}, err
	}
	if !administrationName(name) || strings.TrimSpace(name) == "Almacén" {
		return Location{}, ErrAdminInvalid
	}
	tx, err := s.administrationTx(ctx, token, 0)
	if err != nil {
		return Location{}, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	location := Location{Name: name}
	// Reuse the initialized-catalog allocation lock, zero-stock and audience
	// triggers. No bootstrap import (bootstrap already depends on auth).
	if err = tx.QueryRow(ctx, `SELECT create_branch($1)`, name).Scan(&location.ID); err != nil {
		return Location{}, administrationError(err)
	}
	return location, tx.Commit(ctx)
}
