// Package config validates explicit database and initialization settings.
package config

import (
	"errors"
	"net/url"
)

type Profile string

const (
	Production Profile = "production"
	LocalTrial Profile = "local-trial"
)

type Config struct {
	DatabaseURL string
	Profile     Profile
}

func Parse(rawURL, profile string) (Config, error) {
	if profile != string(Production) && profile != string(LocalTrial) {
		return Config{}, errors.New("profile must be production or local-trial")
	}
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Hostname() == "" || u.Path == "" || u.Path == "/" || u.Fragment != "" {
		return Config{}, errors.New("a valid PostgreSQL database URL is required")
	}
	return Config{rawURL, Profile(profile)}, nil
}
