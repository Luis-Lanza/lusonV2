package httpapi

import (
	"io"
	"testing"
)

// The dispatch reconciliation routes are retired with their production-router
// registration cases. This unread-body probe stays because the surviving unified
// reconciliation guard tests use it to prove rejections never read the body.
type dr3UnreadBody struct{ t *testing.T }

func (b dr3UnreadBody) Read([]byte) (int, error) {
	b.t.Error("private/guard rejection read body")
	return 0, io.EOF
}
func (b dr3UnreadBody) Close() error { return nil }
