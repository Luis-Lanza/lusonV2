-- Fixed accounts are provisioned together by the private CLI, never on startup.
CREATE TABLE auth_accounts (
    location_id smallint PRIMARY KEY REFERENCES locations(id),
    username text NOT NULL UNIQUE CHECK (username ~ '^[a-zA-Z0-9_.-]{3,64}$'),
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION protect_auth_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'fixed accounts cannot be overwritten';
END;
$$;
CREATE TRIGGER protect_auth_accounts
BEFORE UPDATE OR DELETE ON auth_accounts
FOR EACH ROW EXECUTE FUNCTION protect_auth_account();
CREATE TRIGGER protect_auth_accounts_truncate
BEFORE TRUNCATE ON auth_accounts
EXECUTE FUNCTION protect_auth_account();

CREATE TABLE auth_sessions (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash)=32),
    account_id smallint NOT NULL REFERENCES auth_accounts(location_id),
    created_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    absolute_deadline timestamptz NOT NULL,
    idle_deadline timestamptz NOT NULL,
    revoked_at timestamptz,
    CHECK (last_seen_at >= created_at AND absolute_deadline > created_at),
    CHECK (idle_deadline <= absolute_deadline)
);
CREATE INDEX auth_sessions_account ON auth_sessions(account_id);

-- Bounded conservative collision buckets: global plus 4096 IP and 4096 user.
CREATE TABLE auth_throttle (
    bucket integer PRIMARY KEY CHECK (bucket BETWEEN -1 AND 8191),
    window_start timestamptz NOT NULL,
    attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 60)
);
