package config

import "testing"

func TestAuthConfiguration(t *testing.T) {
	for _, c := range []struct {
		profile                   Profile
		origin, listen, cert, key string
		valid                     bool
	}{
		{LocalTrial, "http://localhost:8080", "127.0.0.1:8080", "", "", true},
		{LocalTrial, "http://127.0.0.1:8080", "127.0.0.1:8080", "", "", true},
		{LocalTrial, "http://[::1]:8080", "[::1]:8080", "", "", true},
		{LocalTrial, "http://192.168.1.2:8080", "0.0.0.0:8080", "", "", false},
		{LocalTrial, "http://localhost:8080", "0.0.0.0:8080", "", "", false},
		{Production, "http://localhost:8080", "127.0.0.1:8080", "", "", false},
		{Production, "https://example.test", "0.0.0.0:8443", "", "", false},
		{Production, "https://example.test", "0.0.0.0:8443", "cert", "key", true},
		{Production, "https://example.test/path", "0.0.0.0:8443", "cert", "key", false},
		{Production, "https://user@example.test", "0.0.0.0:8443", "cert", "key", false},
	} {
		_, err := ParseAuth(c.profile, c.origin, c.listen, c.cert, c.key)
		if (err == nil) != c.valid {
			t.Fatalf("configuration acceptance mismatch for %s", c.origin)
		}
	}
}
