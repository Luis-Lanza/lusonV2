// Package auth owns password verification and PostgreSQL session authority.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"golang.org/x/crypto/argon2"
	"regexp"
	"strings"
	"unicode/utf8"
)

var usernamePattern = regexp.MustCompile(`^[a-zA-Z0-9_.-]{3,64}$`)

const passwordPrefix = "$argon2id$v=19$m=19456,t=2,p=1$"

func ValidCredentials(username, password string) bool {
	return usernamePattern.MatchString(username) && utf8.ValidString(password) && len(password) >= 12 && len(password) <= 128 && !strings.ContainsRune(password, 0)
}

func HashPassword(password string) (string, error) {
	if !ValidCredentials("valid", password) {
		return "", fmt.Errorf("password must contain 12–128 UTF-8 bytes without NUL")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, 2, 19456, 1, 32)
	return passwordPrefix + base64.RawStdEncoding.EncodeToString(salt) + "$" + base64.RawStdEncoding.EncodeToString(key), nil
}

// Fixed parameters reject corrupt or hostile stored encodings before allocation.
func VerifyPassword(encoded, password string) bool {
	if !strings.HasPrefix(encoded, passwordPrefix) || len(password) > 128 {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(encoded, passwordPrefix), "$")
	if len(parts) != 2 {
		return false
	}
	salt, e1 := base64.RawStdEncoding.Strict().DecodeString(parts[0])
	key, e2 := base64.RawStdEncoding.Strict().DecodeString(parts[1])
	if e1 != nil || e2 != nil || len(salt) != 16 || len(key) != 32 {
		return false
	}
	actual := argon2.IDKey([]byte(password), salt, 2, 19456, 1, 32)
	return subtle.ConstantTimeCompare(actual, key) == 1
}
