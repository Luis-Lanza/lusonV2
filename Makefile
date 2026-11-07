# Local entry points. Database-backed Go tests need the ephemeral audited
# PostgreSQL fixture; see apps/api/docs/testing.md and scripts/README.md.
#
# The `go-postgresql` job in .github/workflows/verify.yml runs this same target
# on every pull request and every push to master, as a real uid-1000 identity:
# the admission pins uid 1000 and /home/luis/.local/share, so the job creates
# that identity instead of relaxing apps/api/internal/testpg.
TEST_PG := ./scripts/test-pg-fixture.sh

.PHONY: test-pg test-pg-up test-pg-down test-pg-status

# One command: fixture up, whole Go suite, fixture down even on failure. The
# test cache is disabled: the fixture is external state, not a build input.
test-pg:
	$(TEST_PG) run -- go -C apps/api test -count=1 ./...

test-pg-up:
	$(TEST_PG) up

test-pg-down:
	$(TEST_PG) down

test-pg-status:
	$(TEST_PG) status
