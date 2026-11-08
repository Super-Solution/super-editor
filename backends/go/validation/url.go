package validation

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// A restricted WHATWG URL normalizer: http and https only, no credentials, no IPv6, no IDN. It accepts a
// subset of what `new URL()` accepts and for everything it accepts returns the same href, so a URL the
// TypeScript validator stores is the URL the Go validator stores. Everything else is refused, which is the
// safe direction; the conformance data flags those cases `portRejects`.

var (
	schemeRE   = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9+.\-]*):`)
	digitsRE   = regexp.MustCompile(`^[0-9]+$`)
	hexLabelRE = regexp.MustCompile(`^0x[0-9a-f]*$`)
	octetRE    = regexp.MustCompile(`^(?:0|[1-9][0-9]{0,2})$`)
)

const (
	pathSet     = ` "#<>?` + "`" + `{}`
	querySet    = ` "#<>'`
	fragmentSet = ` "<>` + "`"
	// forbiddenHost: forbidden host code points besides C0 controls and DEL.
	forbiddenHost = "\x00\t\n\r #/:<>?@[\\]^|%"
)

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', 0x0b, 0x0c, '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func encodeSet(text, special string) string {
	var out strings.Builder
	for _, r := range text {
		if r <= 0x20 || r >= 0x7f || strings.ContainsRune(special, r) {
			for _, b := range []byte(string(r)) {
				fmt.Fprintf(&out, "%%%02X", b)
			}
		} else {
			out.WriteRune(r)
		}
	}
	return out.String()
}

func isHex(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'f') || (b >= 'A' && b <= 'F')
}

func percentDecode(text string) []byte {
	raw := []byte(text)
	out := make([]byte, 0, len(raw))
	for i := 0; i < len(raw); {
		if raw[i] == '%' && i+2 < len(raw) && isHex(raw[i+1]) && isHex(raw[i+2]) {
			n, _ := strconv.ParseUint(string(raw[i+1:i+3]), 16, 8)
			out = append(out, byte(n))
			i += 3
		} else {
			out = append(out, raw[i])
			i++
		}
	}
	return out
}

func parseHost(host string) (string, bool) {
	if strings.HasPrefix(host, "[") {
		return "", false
	}
	decoded := percentDecode(host)
	if len(decoded) == 0 {
		return "", false
	}
	for _, b := range decoded {
		if b >= 0x80 {
			return "", false
		}
	}
	text := strings.ToLower(string(decoded))
	for _, r := range text {
		if r <= 0x1f || r == 0x7f || strings.ContainsRune(forbiddenHost, r) {
			return "", false
		}
	}
	labels := strings.Split(text, ".")
	for _, label := range labels {
		if strings.HasPrefix(label, "xn--") {
			return "", false
		}
	}
	checked := labels
	if len(labels) > 1 && labels[len(labels)-1] == "" {
		checked = labels[:len(labels)-1]
	}
	last := checked[len(checked)-1]
	if digitsRE.MatchString(last) || hexLabelRE.MatchString(last) {
		if len(labels) != 4 {
			return "", false
		}
		for _, part := range labels {
			if !octetRE.MatchString(part) {
				return "", false
			}
			if n, _ := strconv.Atoi(part); n > 255 {
				return "", false
			}
		}
	}
	return text, true
}

func normalizePath(path string) string {
	if path == "" {
		return "/"
	}
	segments := strings.Split(path, "/")[1:]
	out := make([]string, 0, len(segments))
	for index, segment := range segments {
		last := index == len(segments)-1
		encoded := encodeSet(segment, pathSet)
		switch strings.ToLower(encoded) {
		case "..", ".%2e", "%2e.", "%2e%2e":
			if len(out) > 0 {
				out = out[:len(out)-1]
			}
			if last {
				out = append(out, "")
			}
		case ".", "%2e":
			if last {
				out = append(out, "")
			}
		default:
			out = append(out, encoded)
		}
	}
	return "/" + strings.Join(out, "/")
}

func parseURL(value string) (scheme, href string, ok bool) {
	match := schemeRE.FindStringSubmatch(value)
	if match == nil {
		return "", "", false
	}
	scheme = strings.ToLower(match[1])
	defaultPort := map[string]int{"http": 80, "https": 443}
	def, known := defaultPort[scheme]
	if !known {
		return "", "", false
	}
	rest := strings.TrimLeft(value[len(match[0]):], "/")
	var fragment, query *string
	if i := strings.Index(rest, "#"); i >= 0 {
		f := rest[i+1:]
		fragment, rest = &f, rest[:i]
	}
	if i := strings.Index(rest, "?"); i >= 0 {
		q := rest[i+1:]
		query, rest = &q, rest[:i]
	}
	authority, path := rest, ""
	if i := strings.Index(rest, "/"); i >= 0 {
		authority, path = rest[:i], rest[i:]
	}
	if i := strings.LastIndex(authority, "@"); i >= 0 {
		credentials := authority[:i]
		authority = authority[i+1:]
		if credentials != "" && credentials != ":" {
			return "", "", false
		}
	}
	port := -1
	if i := strings.LastIndex(authority, ":"); i >= 0 {
		portText := authority[i+1:]
		authority = authority[:i]
		if portText != "" {
			if !digitsRE.MatchString(portText) {
				return "", "", false
			}
			n, err := strconv.Atoi(strings.TrimLeft(portText, "0"))
			if strings.TrimLeft(portText, "0") == "" {
				n, err = 0, nil
			}
			if err != nil || n > 65535 {
				return "", "", false
			}
			port = n
		}
	}
	host, ok := parseHost(authority)
	if !ok {
		return "", "", false
	}
	href = scheme + "://" + host
	if port >= 0 && port != def {
		href += ":" + strconv.Itoa(port)
	}
	href += normalizePath(path)
	if query != nil {
		href += "?" + encodeSet(*query, querySet)
	}
	if fragment != nil {
		href += "#" + encodeSet(*fragment, fragmentSet)
	}
	return scheme, href, true
}

// SafeURL is the normalized URL, or ok=false when it is not an absolute HTTP(S) URL without credentials.
func SafeURL(value any, httpsOnly bool) (string, bool) {
	s, isString := value.(string)
	if !isString || JSLength(s) > 4096 {
		return "", false
	}
	for _, r := range s {
		if isJSSpace(r) || r == '\\' || r <= 0x1f || r == 0x7f {
			return "", false
		}
	}
	scheme, href, ok := parseURL(s)
	if !ok || (httpsOnly && scheme != "https") {
		return "", false
	}
	return href, true
}

func urlValue(value any, path string, httpsOnly bool) string {
	if href, ok := SafeURL(value, httpsOnly); ok && href != "" {
		return href
	}
	kind, example := "HTTP or HTTPS", "http(s)://"
	if httpsOnly {
		kind, example = "HTTPS", "https://"
	}
	fail(fmt.Sprintf("Expected an absolute %s URL without credentials.", kind), path,
		fmt.Sprintf("Use a full %s URL such as https://example.com/page, with no spaces and no user:password.", example))
	return ""
}
