package auth

import (
	"luson/api/internal/auth/testpg"
	"testing"
)

func TestAuthPasswords(t *testing.T) {
	if ValidCredentials("", "short") {
		t.Fatal("missing credentials accepted")
	}
	if ValidCredentials("bad name", "a sufficiently long password") {
		t.Fatal("invalid username accepted")
	}
	password := testpg.Random(t)
	a, err := HashPassword(password)
	if err != nil {
		t.Fatal("hash failed")
	}
	b, err := HashPassword(password)
	if err != nil {
		t.Fatal("hash failed")
	}
	if a == b {
		t.Fatal("salt reused")
	}
	if !VerifyPassword(a, password) || VerifyPassword(a, testpg.Random(t)) {
		t.Fatal("password verification failed")
	}
	for _, malformed := range []string{"", "$argon2id$v=19$m=999999999,t=2,p=1$c2FsdA$aGFzaA", a + "junk"} {
		if VerifyPassword(malformed, password) {
			t.Fatal("malformed hash accepted")
		}
	}
}
