package config

import (
	"strings"
	"testing"
)

func TestConfig(t *testing.T) {
	for _, p := range []string{"production", "local-trial"} {
		c, err := Parse("postgres://test:private@127.0.0.1/test", p)
		if err != nil || string(c.Profile) != p {
			t.Fatalf("profile %s: %v", p, err)
		}
	}
	for _, v := range [][2]string{{"", "production"}, {"postgres://test:private@localhost/test", ""}, {"postgres://test:private@localhost/test", "demo"}, {"https://test:private@localhost/test", "production"}, {"private", "production"}, {"postgres://test:private@localhost", "production"}} {
		_, err := Parse(v[0], v[1])
		if err == nil {
			t.Fatal("accepted invalid configuration")
		}
		if strings.Contains(err.Error(), "private") {
			t.Fatal("leaked secret")
		}
	}
}
