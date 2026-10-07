// Package migrations embeds the versioned SQL owned by the data foundation.
package migrations

import "embed"

//go:embed *.sql
var Files embed.FS
