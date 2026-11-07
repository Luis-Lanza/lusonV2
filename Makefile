# Local entry points. Database-backed Go tests need the ephemeral audited
# PostgreSQL fixture; see apps/api/docs/testing.md and scripts/README.md.
#
# The `go-postgresql` job in .github/workflows/verify.yml runs this same target
# on every pull request and every push to master, as a real uid-1000 identity:
# the admission pins uid 1000 and /home/luis/.local/share, so the job creates
# that identity instead of relaxing apps/api/internal/testpg.
TEST_PG := ./scripts/test-pg-fixture.sh
GO_TEST := go -C apps/api test -count=1
# The one package that must not share the fixture with the parallel suite.
ADMISSION := luson/api/internal/testpg

.PHONY: test-pg test-pg-up test-pg-down test-pg-status

# One command: fixture up, whole Go suite, fixture down even on failure. The
# test cache is disabled: the fixture is external state, not a build input.
#
# Two `go test` invocations inside that one fixture cycle, on purpose.
# TestR01AdmissionPostgres ends by polling the fixture catalog until every
# isolated database is gone (postgres_test.go:429-443: 150 attempts, 100ms
# apart). `go test ./...` runs package binaries concurrently and every package
# calling testpg.Open holds its own `luson_test_<32 hex>` for the length of a
# test, so under load the catalog can stay busy for the whole 15 seconds and
# the admission fails a suite that is actually healthy. The assertion is not
# relaxed: the admission runs in its own invocation, where "no other package is
# creating databases at the same time" is a property of the command instead of
# a scheduling coincidence, and every other package still runs concurrently in
# the second one.
#
# Both invocations live inside a single `run`, so this is still one fixture
# cycle and the fixture is still torn down on any outcome. `sh -e` stops at the
# first failing command, so a failure in either invocation fails the target.
test-pg:
	$(TEST_PG) run -- sh -euc 'pkgs=$$(go -C apps/api list ./... | grep -vx $(ADMISSION)) && test -n "$$pkgs" && $(GO_TEST) ./internal/testpg && $(GO_TEST) $$pkgs'

test-pg-up:
	$(TEST_PG) up

test-pg-down:
	$(TEST_PG) down

test-pg-status:
	$(TEST_PG) status
