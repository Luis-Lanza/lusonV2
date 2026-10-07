// Package fixtures contains the derived, read-only source catalog.
package fixtures

import _ "embed"

//go:embed catalog.json
var Catalog []byte
