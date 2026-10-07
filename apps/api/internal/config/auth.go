package config

import (
	"errors"
	"net"
	"net/url"
	"strconv"
)

type Auth struct {
	Origin, Listen, TLSCert, TLSKey string
	Secure                          bool
}

func loopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// ParseAuth permits insecure HTTP only on explicit trial loopback endpoints.
// Production also loads the actual certificate/key before opening its listener.
func ParseAuth(profile Profile, origin, listen, cert, key string) (Auth, error) {
	fail := func() (Auth, error) {
		return Auth{}, errors.New("invalid authentication origin, listener or TLS configuration")
	}
	if profile != Production && profile != LocalTrial {
		return fail()
	}
	u, err := url.Parse(origin)
	if err != nil || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" || (u.Scheme != "http" && u.Scheme != "https") {
		return fail()
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return fail()
		}
	}
	host, port, err := net.SplitHostPort(listen)
	if err != nil || host == "" {
		return fail()
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return fail()
	}
	if u.Scheme == "http" {
		if profile != LocalTrial || !loopback(u.Hostname()) || !loopback(host) || cert != "" || key != "" {
			return fail()
		}
	} else if cert == "" || key == "" {
		return fail()
	}
	return Auth{Origin: origin, Listen: listen, TLSCert: cert, TLSKey: key, Secure: u.Scheme == "https"}, nil
}
