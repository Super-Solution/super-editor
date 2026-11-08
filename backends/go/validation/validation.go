// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

// Package validation validates Super Editor documents, transactions and actors.
//
// A port of packages/core/src/validation.ts. Input is decoded JSON (see Decode); every function returns a Result
// holding the normalized value, or the first issue found (the reference stops at the first failure) with its
// message, path and hint. conformance/validation.v1.json is the shared test data.
//
// Known differences from the reference, all in the safe direction (a value the reference accepts may be refused,
// never the other way round): SafeURL refuses IPv6 hosts, non-ASCII (IDN) hosts, xn-- labels, userinfo other
// than empty and IPv4 hosts that are not canonical dotted decimal; and the serialized-size budgets measure Go's
// compact JSON, which can differ from JavaScript's by a few characters at the exact boundary.
package validation

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Issue is one validation problem. An empty Path or Hint means the field is absent.
type Issue struct {
	Code    string
	Message string
	Path    string
	Hint    string
}

// Result is a verdict: the normalized value, or the first issue.
type Result struct {
	OK     bool
	Value  any
	Issues []Issue
}

type invalid struct{ issue Issue }

func fail(message, path, hint string) {
	panic(invalid{Issue{Code: "validation", Message: message, Path: path, Hint: hint}})
}

// Limits are the explicit budgets of the reference.
const (
	limitBlocks             = 5_000
	limitDepth              = 64
	limitOperations         = 256
	limitCitations          = 2_000
	limitText               = 100_000
	limitChartPoints        = 20_000
	limitChartMagnitude     = 1e15
	limitJSON               = 8_000_000
	limitBlocksPerOperation = 500
	limitRuns               = 1_000
	limitListItems          = 2_000
	limitListItemText       = 10_000
	limitListIndent         = 3
	limitTableColumns       = 100
	limitTableRows          = 2_000
	limitTableCells         = 20_000
	limitTableCellText      = 10_000
	limitTitle              = 1_000
	limitCaption            = 2_000
	limitSeries             = 100
	limitAnnotations        = 100
	limitOHLC               = 5_000
	limitHeatmapDimension   = 200
	limitHeatmapCells       = 20_000
	limitMetrics            = 50
	limitEmbedHeightMin     = 200
	limitEmbedHeightMax     = 1_200
	limitCodeLanguage       = 40
	limitSearchText         = 1_000
	maxSafe                 = 9_007_199_254_740_991
)

var (
	blockTypes     = []string{"section", "heading", "paragraph", "list", "table", "chart", "embed", "timestamp", "quote", "callout", "code", "divider", "image", "toggle", "metrics", "toc", "pageBreak"}
	operationTypes = []string{"insertBlock", "updateBlock", "moveBlock", "deleteBlock", "setTitle", "setFormat", "addCitation", "insertBlocks", "duplicateBlock", "replaceText", "deleteBlocks", "moveBlocks", "updateCitation", "removeCitation"}
	highlights     = []string{"yellow", "green", "blue", "pink", "gray"}
	calloutTones   = []string{"info", "success", "warning", "danger", "note"}
	imageWidths    = []string{"narrow", "normal", "wide", "full"}
	listStyles     = []string{"bullet", "number", "todo"}
	tableAligns    = []string{"left", "center", "right"}
	metricTones    = []string{"up", "down", "neutral"}
	axisFormats    = []string{"number", "percent", "currency", "compact"}
	knownKinds     = []string{"pie", "donut", "bar", "trend", "line", "area", "scatter", "histogram", "candlestick", "heatmap", "waterfall"}
	categoryKinds  = []string{"bar", "trend", "line", "area", "histogram", "candlestick", "waterfall"}
)

type record = map[string]any

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// JSLength is the length JavaScript reports for a string: UTF-16 code units.
func JSLength(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

var indexKey = regexp.MustCompile(`^(?:0|[1-9][0-9]{0,9})$`)

// jsKeyOrder is the own-property order of a JavaScript object: array-index keys ascending, then the rest.
func jsKeyOrder(keys []string) []string {
	var index, rest []string
	for _, k := range keys {
		if n, err := strconv.ParseUint(k, 10, 64); err == nil && indexKey.MatchString(k) && n < 1<<32-1 {
			index = append(index, k)
		} else {
			rest = append(rest, k)
		}
	}
	sort.Slice(index, func(i, j int) bool {
		a, _ := strconv.ParseUint(index[i], 10, 64)
		b, _ := strconv.ParseUint(index[j], 10, 64)
		return a < b
	})
	return append(index, rest...)
}

func asObject(v any) (*Object, bool) {
	switch t := v.(type) {
	case *Object:
		return t, true
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		return &Object{Keys: keys, Values: t}, true
	}
	return nil, false
}

func object(value any, path string, required []string, optional ...string) *Object {
	o, ok := asObject(value)
	if !ok {
		hint := ""
		if len(required) > 0 {
			more := ""
			if len(optional) > 0 {
				more = " (optional: " + strings.Join(optional, ", ") + ")"
			}
			hint = "Provide an object with: " + strings.Join(required, ", ") + more + "."
		}
		fail("Expected a plain object.", path, hint)
	}
	allowed := append(append([]string{}, required...), optional...)
	for _, key := range jsKeyOrder(o.Keys) {
		if !contains(allowed, key) {
			fail("Unknown property.", path+"."+key, "Remove it. Allowed properties here: "+strings.Join(allowed, ", ")+".")
		}
	}
	for _, key := range required {
		if _, ok := o.Values[key]; !ok {
			fail("Required property is missing.", path+"."+key, `Add "`+key+`".`)
		}
	}
	return o
}

func num(f float64) string {
	if f == math.Floor(f) && math.Abs(f) < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}

func str(value any, path string, max int, allowEmpty bool) string {
	s, ok := value.(string)
	if !ok || JSLength(s) > max || (!allowEmpty && len(s) == 0) {
		a := "a"
		if !allowEmpty {
			a = "a nonempty"
		}
		fail(fmt.Sprintf("Expected %s string of at most %d characters.", a, max), path, "")
	}
	return s
}

func text(value any, path string) string { return str(value, path, limitText, true) }

var idPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]*$`)

func id(value any, path string) string {
	s := str(value, path, 128, false)
	if !idPattern.MatchString(s) {
		fail("ID must use ASCII letters, numbers, dots, underscores, colons or hyphens.", path, `Start with a letter or digit, for example "sec-1" or "macro.summary".`)
	}
	return s
}

func integer(value any, path string, min, max int) int {
	f, ok := value.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f != math.Floor(f) || math.Abs(f) > maxSafe || f < float64(min) || f > float64(max) {
		fail(fmt.Sprintf("Expected an integer between %d and %d.", min, max), path, "")
	}
	return int(f)
}

func finite(value any, path string, min, max float64) float64 {
	f, ok := value.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f < min || f > max {
		fail("Expected a finite number in the supported range.", path, "")
	}
	return f
}

func magnitude(value any, path string) float64 {
	return finite(value, path, -limitChartMagnitude, limitChartMagnitude)
}

func boolean(value any, path string) bool {
	b, ok := value.(bool)
	if !ok {
		fail("Expected a boolean.", path, "")
	}
	return b
}

func enumeration(value any, path string, values []string) string {
	s, ok := value.(string)
	if !ok || !contains(values, s) {
		fail("Expected one of: "+strings.Join(values, ", ")+".", path, "")
	}
	return s
}

func array(value any, path string, max int, parse func(any, string) any) []any {
	a, ok := value.([]any)
	if !ok || len(a) > max {
		fail(fmt.Sprintf("Expected an array with at most %d entries.", max), path, "")
	}
	out := make([]any, 0, len(a))
	for i, e := range a {
		out = append(out, parse(e, fmt.Sprintf("%s[%d]", path, i)))
	}
	return out
}

func strings_(list []any) []string {
	out := make([]string, len(list))
	for i, e := range list {
		out[i] = e.(string)
	}
	return out
}

func unique(values []string, path, hint string) {
	seen := make(map[string]struct{}, len(values))
	for _, v := range values {
		seen[v] = struct{}{}
	}
	if len(seen) != len(values) {
		fail("IDs must be unique.", path, hint)
	}
}

func idParser(v any, p string) any   { return id(v, p) }
func boolParser(v any, p string) any { return boolean(v, p) }
func magParser(v any, p string) any  { return magnitude(v, p) }

// ---- timestamps and actors ------------------------------------------------------------------------------------

var timestampPattern = regexp.MustCompile(`^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?Z$`)

func daysInMonth(year, month int) int {
	switch month {
	case 2:
		if year%4 == 0 && (year%100 != 0 || year%400 == 0) {
			return 29
		}
		return 28
	case 4, 6, 9, 11:
		return 30
	}
	return 31
}

func timestamp(value any, path string) string {
	s := str(value, path, 30, false)
	m := timestampPattern.FindStringSubmatch(s)
	if m == nil {
		fail("Expected an ISO UTC timestamp.", path, "Use a form like 2026-10-05T12:00:00Z (UTC, trailing Z).")
	}
	n := func(i int) int { v, _ := strconv.Atoi(m[i]); return v }
	year, month, day, hour, minute, second := n(1), n(2), n(3), n(4), n(5), n(6)
	if month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59 {
		fail("Timestamp contains an invalid calendar date or time.", path, "")
	}
	return s
}

// TimestampMillis is the number of milliseconds since the epoch of a validated timestamp.
func TimestampMillis(s string) int64 {
	m := timestampPattern.FindStringSubmatch(s)
	if m == nil {
		return 0
	}
	n := func(i int) int64 { v, _ := strconv.Atoi(m[i]); return int64(v) }
	year, month, day := n(1), n(2), n(3)
	frac := m[7]
	for len(frac) < 3 {
		frac += "0"
	}
	millis, _ := strconv.Atoi(frac)
	y := year
	if month <= 2 {
		y--
	}
	era := y / 400
	if y < 0 && y%400 != 0 {
		era--
	}
	yoe := y - era*400
	mp := month - 3
	if month <= 2 {
		mp = month + 9
	}
	doy := (153*mp+2)/5 + day - 1
	doe := yoe*365 + yoe/4 - yoe/100 + doy
	days := era*146097 + doe - 719468
	return ((days*24+n(4))*60+n(5))*60_000 + n(6)*1000 + int64(millis)
}

func parent(value any, path string) any {
	if value == nil {
		return nil
	}
	return id(value, path)
}

func readActor(value any, path string) record {
	v := object(value, path, []string{"id", "kind"})
	return record{"id": id(v.Values["id"], path+".id"), "kind": enumeration(v.Values["kind"], path+".kind", []string{"human", "agent", "system"})}
}

func has(o *Object, key string) bool { _, ok := o.Values[key]; return ok }

// ---- charts ---------------------------------------------------------------------------------------------------

var (
	colorPattern    = regexp.MustCompile(`^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[A-Za-z]{3,30}|var\(--[A-Za-z0-9_-]{1,60}\))$`)
	currencyPattern = regexp.MustCompile(`^[A-Z]{3}$`)
)

func color(value any, path string) string {
	s := str(value, path, 64, false)
	if !colorPattern.MatchString(s) {
		fail("Expected a hex color (#rgb, #rrggbb), a CSS color keyword or var(--token).", path, `Use for example "#2f6fed" or "var(--se-series-1)". Functions such as url() are not accepted.`)
	}
	return s
}

func floats(list []any) []float64 {
	out := make([]float64, len(list))
	for i, e := range list {
		out[i] = e.(float64)
	}
	return out
}

func chart(value any, path string) record {
	v := object(value, path, []string{"kind", "title", "labels", "series"}, "unit", "asOf", "stacked", "horizontal", "yAxis", "xLabel", "caption", "source", "annotations", "points", "ohlc", "matrix")
	textLength := 0
	labelsAny := array(v.Values["labels"], path+".labels", limitChartPoints, func(e any, p string) any {
		label := str(e, p, 1_000, true)
		textLength += JSLength(label)
		if textLength > limitJSON {
			fail("Chart labels exceed the supported text size.", path, "")
		}
		return label
	})
	labels := strings_(labelsAny)
	if len(labels) == 0 {
		fail("A chart requires at least one label.", path+".labels", "Every kind needs labels and series; scatter, candlestick and heatmap also carry a labels/series fallback table next to points, ohlc or matrix.")
	}
	series := array(v.Values["series"], path+".series", limitSeries, func(e any, p string) any {
		item := object(e, p, []string{"name", "values"}, "color")
		values := array(item.Values["values"], p+".values", limitChartPoints, magParser)
		if len(values) != len(labels) {
			fail("Series length must match chart labels.", p+".values", fmt.Sprintf("Provide exactly %d values, one per label.", len(labels)))
		}
		out := record{"name": str(item.Values["name"], p+".name", 1_000, true), "values": values}
		if has(item, "color") {
			out["color"] = color(item.Values["color"], p+".color")
		}
		return out
	})
	if len(series) == 0 || len(labels)*len(series) > limitChartPoints {
		fail("Chart must contain 1 to 20,000 numeric points.", path, "")
	}
	kind := id(v.Values["kind"], path+".kind")
	known := contains(knownKinds, kind)
	seriesValues := func(i int) []float64 { return floats(series[i].(record)["values"].([]any)) }
	if kind == "pie" || kind == "donut" {
		first := seriesValues(0)
		total, anyPositive, anyNegative := 0.0, false, false
		for _, x := range first {
			total += x
			anyPositive = anyPositive || x > 0
			anyNegative = anyNegative || x < 0
		}
		if len(series) != 1 || anyNegative || !anyPositive || math.IsInf(total, 0) || math.IsNaN(total) {
			name := "Pie"
			if kind == "donut" {
				name = "Donut"
			}
			fail(name+" charts require one nonnegative series with a finite positive total.", path, "Use a single series of nonnegative values, or switch to a bar chart.")
		}
	}
	if kind == "histogram" {
		negative := false
		for _, x := range seriesValues(0) {
			negative = negative || x < 0
		}
		if len(series) != 1 || negative {
			fail("Histogram charts require one series of nonnegative counts.", path, "Put bin labels in labels and one count per bin in a single series.")
		}
	}
	if kind == "waterfall" && len(series) != 1 {
		fail("Waterfall charts require exactly one series of signed deltas.", path, "Put step names in labels and one signed change per step in a single series.")
	}
	var points, ohlc []any
	var matrix record
	if has(v, "points") {
		points = array(v.Values["points"], path+".points", limitChartPoints, func(e any, p string) any {
			pt := object(e, p, []string{"series", "x", "y"})
			return record{"series": str(pt.Values["series"], p+".series", 1_000, true), "x": magnitude(pt.Values["x"], p+".x"), "y": magnitude(pt.Values["y"], p+".y")}
		})
	}
	if has(v, "ohlc") {
		ohlc = array(v.Values["ohlc"], path+".ohlc", limitOHLC, func(e any, p string) any {
			c := object(e, p, []string{"t", "o", "h", "l", "c"}, "v")
			o, h := magnitude(c.Values["o"], p+".o"), magnitude(c.Values["h"], p+".h")
			l, cl := magnitude(c.Values["l"], p+".l"), magnitude(c.Values["c"], p+".c")
			if l > math.Min(o, cl) || h < math.Max(o, cl) {
				fail("A candle needs low <= open/close <= high.", p, "Check the o/h/l/c order of this candle; h must be the highest and l the lowest price.")
			}
			out := record{"t": str(c.Values["t"], p+".t", 1_000, false), "o": o, "h": h, "l": l, "c": cl}
			if has(c, "v") {
				out["v"] = finite(c.Values["v"], p+".v", 0, limitChartMagnitude)
			}
			return out
		})
	}
	if has(v, "matrix") {
		m := object(v.Values["matrix"], path+".matrix", []string{"rows", "columns", "values"})
		rows := array(m.Values["rows"], path+".matrix.rows", limitHeatmapDimension, func(e any, p string) any { return str(e, p, 1_000, true) })
		columns := array(m.Values["columns"], path+".matrix.columns", limitHeatmapDimension, func(e any, p string) any { return str(e, p, 1_000, true) })
		if len(rows) == 0 || len(columns) == 0 || len(rows)*len(columns) > limitHeatmapCells {
			fail(fmt.Sprintf("A heatmap needs at least one row and column and at most %d cells.", limitHeatmapCells), path+".matrix", "")
		}
		cells := array(m.Values["values"], path+".matrix.values", len(rows), func(row any, rp string) any {
			return array(row, rp, len(columns), magParser)
		})
		bad := len(cells) != len(rows)
		for _, row := range cells {
			bad = bad || len(row.([]any)) != len(columns)
		}
		if bad {
			fail("Heatmap values must have one row per rows entry and one cell per column.", path+".matrix.values", fmt.Sprintf("Provide %d rows of %d numbers.", len(rows), len(columns)))
		}
		matrix = record{"rows": rows, "columns": columns, "values": cells}
	}
	if known {
		if points != nil && kind != "scatter" {
			fail("points are only valid for scatter charts.", path+".points", `Remove points or set kind to "scatter".`)
		}
		if ohlc != nil && kind != "candlestick" {
			fail("ohlc is only valid for candlestick charts.", path+".ohlc", `Remove ohlc or set kind to "candlestick".`)
		}
		if matrix != nil && kind != "heatmap" {
			fail("matrix is only valid for heatmap charts.", path+".matrix", `Remove matrix or set kind to "heatmap".`)
		}
	}
	if kind == "scatter" && len(points) == 0 {
		fail("Scatter charts require points.", path+".points", "Provide points: [{series, x, y}, ...] next to the labels/series fallback table.")
	}
	if kind == "candlestick" && len(ohlc) == 0 {
		fail("Candlestick charts require ohlc candles.", path+".ohlc", "Provide ohlc: [{t, o, h, l, c, v?}, ...] next to the labels/series close-price fallback.")
	}
	if kind == "heatmap" && matrix == nil {
		fail("Heatmap charts require a matrix.", path+".matrix", "Provide matrix: {rows, columns, values} next to the labels/series fallback table.")
	}
	var yAxis record
	if has(v, "yAxis") {
		axis := object(v.Values["yAxis"], path+".yAxis", nil, "label", "format", "min", "max", "currency")
		var lo, hi *float64
		if has(axis, "min") {
			x := magnitude(axis.Values["min"], path+".yAxis.min")
			lo = &x
		}
		if has(axis, "max") {
			x := magnitude(axis.Values["max"], path+".yAxis.max")
			hi = &x
		}
		if lo != nil && hi != nil && *lo >= *hi {
			fail("yAxis.min must be less than yAxis.max.", path+".yAxis", "")
		}
		currency := ""
		hasCurrency := has(axis, "currency")
		if hasCurrency {
			currency = str(axis.Values["currency"], path+".yAxis.currency", 3, false)
			if !currencyPattern.MatchString(currency) {
				fail("Expected a three-letter ISO 4217 currency code.", path+".yAxis.currency", `Use for example "USD".`)
			}
		}
		yAxis = record{}
		if has(axis, "label") {
			yAxis["label"] = str(axis.Values["label"], path+".yAxis.label", limitTitle, true)
		}
		if has(axis, "format") {
			yAxis["format"] = enumeration(axis.Values["format"], path+".yAxis.format", axisFormats)
		}
		if lo != nil {
			yAxis["min"] = *lo
		}
		if hi != nil {
			yAxis["max"] = *hi
		}
		if hasCurrency {
			yAxis["currency"] = currency
		}
	}
	var annotations []any
	if has(v, "annotations") {
		annotations = array(v.Values["annotations"], path+".annotations", limitAnnotations, func(e any, p string) any {
			note := object(e, p, []string{"label", "at"}, "value")
			at := str(note.Values["at"], p+".at", 1_000, false)
			if contains(categoryKinds, kind) && !contains(labels, at) {
				head := labels
				if len(head) > 8 {
					head = head[:8]
				}
				more := ""
				if len(labels) > 8 {
					more = ", ..."
				}
				fail(`Annotation "at" must be one of the chart labels.`, p+".at", "Use one of: "+strings.Join(head, ", ")+more+".")
			}
			out := record{"label": str(note.Values["label"], p+".label", 1_000, false), "at": at}
			if has(note, "value") {
				out["value"] = magnitude(note.Values["value"], p+".value")
			}
			return out
		})
	}
	result := record{"kind": kind, "title": str(v.Values["title"], path+".title", 1_000, true), "labels": labelsAny, "series": series}
	if has(v, "unit") {
		result["unit"] = str(v.Values["unit"], path+".unit", 100, true)
	}
	if has(v, "asOf") {
		result["asOf"] = timestamp(v.Values["asOf"], path+".asOf")
	}
	if has(v, "stacked") {
		result["stacked"] = boolean(v.Values["stacked"], path+".stacked")
	}
	if has(v, "horizontal") {
		result["horizontal"] = boolean(v.Values["horizontal"], path+".horizontal")
	}
	if yAxis != nil {
		result["yAxis"] = yAxis
	}
	if has(v, "xLabel") {
		result["xLabel"] = str(v.Values["xLabel"], path+".xLabel", limitTitle, true)
	}
	if has(v, "caption") {
		result["caption"] = str(v.Values["caption"], path+".caption", limitCaption, true)
	}
	if has(v, "source") {
		result["source"] = str(v.Values["source"], path+".source", limitTitle, true)
	}
	if annotations != nil {
		result["annotations"] = annotations
	}
	if points != nil {
		result["points"] = points
	}
	if ohlc != nil {
		result["ohlc"] = ohlc
	}
	if matrix != nil {
		result["matrix"] = matrix
	}
	return result
}

// ---- blocks ---------------------------------------------------------------------------------------------------

func runs(value any, path string) []any {
	parsed := array(value, path, limitRuns, func(e any, p string) any {
		run := object(e, p, []string{"text"}, "bold", "italic", "code", "href", "strike", "underline", "highlight", "citationId")
		out := record{"text": text(run.Values["text"], p+".text")}
		for _, flag := range []string{"bold", "italic", "code"} {
			if has(run, flag) {
				out[flag] = boolean(run.Values[flag], p+"."+flag)
			}
		}
		if has(run, "href") {
			out["href"] = urlValue(run.Values["href"], p+".href", false)
		}
		for _, flag := range []string{"strike", "underline"} {
			if has(run, flag) {
				out[flag] = boolean(run.Values[flag], p+"."+flag)
			}
		}
		if has(run, "highlight") {
			out["highlight"] = enumeration(run.Values["highlight"], p+".highlight", highlights)
		}
		if has(run, "citationId") {
			out["citationId"] = id(run.Values["citationId"], p+".citationId")
		}
		return out
	})
	total := 0
	for _, r := range parsed {
		total += JSLength(r.(record)["text"].(string))
	}
	if total > limitText {
		fail("Text exceeds the supported size.", path, "")
	}
	return parsed
}

func typesHint() string { return "Use one of: " + strings.Join(blockTypes, ", ") + "." }

var languagePattern = regexp.MustCompile(`^[A-Za-z0-9+#._-]*$`)

func content(value any, path string) record {
	o, ok := asObject(value)
	if !ok {
		fail("Expected block content.", path, `Provide an object such as {"type":"paragraph","runs":[{"text":"..."}]}. Block types: `+strings.Join(blockTypes, ", ")+".")
	}
	kindAny, ok := o.Values["type"]
	if !ok {
		fail("Block content type is required.", path+".type", typesHint())
	}
	kind, _ := kindAny.(string)
	switch kind {
	case "section":
		v := object(value, path, []string{"type", "title"})
		return record{"type": "section", "title": str(v.Values["title"], path+".title", limitTitle, true)}
	case "heading":
		v := object(value, path, []string{"type", "level", "text"})
		return record{"type": "heading", "level": float64(integer(v.Values["level"], path+".level", 1, 3)), "text": text(v.Values["text"], path+".text")}
	case "paragraph":
		v := object(value, path, []string{"type", "runs"})
		return record{"type": "paragraph", "runs": runs(v.Values["runs"], path+".runs")}
	case "list":
		return listContent(value, path)
	case "table":
		return tableContent(value, path)
	case "chart":
		v := object(value, path, []string{"type", "spec"})
		return record{"type": "chart", "spec": chart(v.Values["spec"], path+".spec")}
	case "embed":
		v := object(value, path, []string{"type", "provider", "url", "title"}, "height")
		out := record{"type": "embed", "provider": enumeration(v.Values["provider"], path+".provider", []string{"superchart"}),
			"url": urlValue(v.Values["url"], path+".url", true), "title": str(v.Values["title"], path+".title", limitTitle, true)}
		if has(v, "height") {
			out["height"] = float64(integer(v.Values["height"], path+".height", limitEmbedHeightMin, limitEmbedHeightMax))
		}
		return out
	case "timestamp":
		v := object(value, path, []string{"type", "at", "label"})
		return record{"type": "timestamp", "at": timestamp(v.Values["at"], path+".at"), "label": str(v.Values["label"], path+".label", limitTitle, true)}
	case "quote":
		v := object(value, path, []string{"type", "runs"}, "attribution")
		out := record{"type": "quote", "runs": runs(v.Values["runs"], path+".runs")}
		if has(v, "attribution") {
			out["attribution"] = str(v.Values["attribution"], path+".attribution", limitTitle, true)
		}
		return out
	case "callout":
		v := object(value, path, []string{"type", "tone", "runs"}, "title")
		out := record{"type": "callout", "tone": enumeration(v.Values["tone"], path+".tone", calloutTones)}
		if has(v, "title") {
			out["title"] = str(v.Values["title"], path+".title", limitTitle, true)
		}
		out["runs"] = runs(v.Values["runs"], path+".runs")
		return out
	case "code":
		v := object(value, path, []string{"type", "language", "text"})
		language := str(v.Values["language"], path+".language", limitCodeLanguage, true)
		if !languagePattern.MatchString(language) {
			fail("Language must use letters, digits and + # . _ - only.", path+".language", `Use a short name such as "ts", "python" or "sql", or "" for plain text.`)
		}
		return record{"type": "code", "language": language, "text": text(v.Values["text"], path+".text")}
	case "divider", "toc", "pageBreak":
		object(value, path, []string{"type"})
		return record{"type": kind}
	case "image":
		v := object(value, path, []string{"type", "url", "alt"}, "caption", "width")
		out := record{"type": "image", "url": urlValue(v.Values["url"], path+".url", true), "alt": str(v.Values["alt"], path+".alt", limitTitle, true)}
		if has(v, "caption") {
			out["caption"] = str(v.Values["caption"], path+".caption", limitCaption, true)
		}
		if has(v, "width") {
			out["width"] = enumeration(v.Values["width"], path+".width", imageWidths)
		}
		return out
	case "toggle":
		v := object(value, path, []string{"type", "title", "open"})
		return record{"type": "toggle", "title": str(v.Values["title"], path+".title", limitTitle, true), "open": boolean(v.Values["open"], path+".open")}
	case "metrics":
		v := object(value, path, []string{"type", "items"})
		items := array(v.Values["items"], path+".items", limitMetrics, func(e any, p string) any {
			item := object(e, p, []string{"label", "value"}, "change", "tone", "hint")
			out := record{"label": str(item.Values["label"], p+".label", limitTitle, true), "value": str(item.Values["value"], p+".value", limitTitle, true)}
			if has(item, "change") {
				out["change"] = magnitude(item.Values["change"], p+".change")
			}
			if has(item, "tone") {
				out["tone"] = enumeration(item.Values["tone"], p+".tone", metricTones)
			}
			if has(item, "hint") {
				out["hint"] = str(item.Values["hint"], p+".hint", limitTitle, true)
			}
			return out
		})
		if len(items) == 0 {
			fail("A metrics block requires at least one item.", path+".items", "Provide items: [{label, value, change?, tone?, hint?}, ...].")
		}
		return record{"type": "metrics", "items": items}
	}
	fail("Unsupported block content type. Raw HTML is not supported.", path+".type", typesHint())
	return nil
}

func listContent(value any, path string) record {
	v := object(value, path, []string{"type", "ordered", "items"}, "style", "checked", "indent")
	textLength := 0
	ordered := boolean(v.Values["ordered"], path+".ordered")
	items := array(v.Values["items"], path+".items", limitListItems, func(e any, p string) any {
		item := str(e, p, limitListItemText, true)
		textLength += JSLength(item)
		if textLength > limitJSON {
			fail("List exceeds the supported text size.", path, "")
		}
		return item
	})
	style := ""
	if has(v, "style") {
		style = enumeration(v.Values["style"], path+".style", listStyles)
	}
	if style == "number" && !ordered {
		fail(`A "number" list must set ordered: true.`, path+".ordered", `Set ordered: true, or use style "bullet".`)
	}
	if (style == "bullet" || style == "todo") && ordered {
		fail(`A "`+style+`" list must set ordered: false.`, path+".ordered", `Set ordered: false, or use style "number".`)
	}
	var checked, indent []any
	if has(v, "checked") {
		checked = array(v.Values["checked"], path+".checked", limitListItems, boolParser)
		if style != "todo" {
			fail(`checked is only valid on a "todo" list.`, path+".checked", `Set style: "todo" (with ordered: false) or remove checked.`)
		}
		if len(checked) != len(items) {
			fail("checked must have one entry per list item.", path+".checked", fmt.Sprintf("Provide %d booleans.", len(items)))
		}
	}
	if has(v, "indent") {
		indent = array(v.Values["indent"], path+".indent", limitListItems, func(e any, p string) any { return float64(integer(e, p, 0, limitListIndent)) })
		if len(indent) != len(items) {
			fail("indent must have one entry per list item.", path+".indent", fmt.Sprintf("Provide %d integers from 0 to %d.", len(items), limitListIndent))
		}
	}
	out := record{"type": "list", "ordered": ordered, "items": items}
	if style != "" {
		out["style"] = style
	}
	if checked != nil {
		out["checked"] = checked
	}
	if indent != nil {
		out["indent"] = indent
	}
	return out
}

func tableContent(value any, path string) record {
	v := object(value, path, []string{"type", "columns", "rows"}, "align", "caption", "headerColumn")
	columns := array(v.Values["columns"], path+".columns", limitTableColumns, func(e any, p string) any { return str(e, p, limitTitle, true) })
	if len(columns) == 0 {
		fail("Table requires at least one column.", path+".columns", "")
	}
	textLen := 0
	for _, c := range columns {
		textLen += JSLength(c.(string))
	}
	maxRows := limitTableRows
	if limitTableCells/len(columns) < maxRows {
		maxRows = limitTableCells / len(columns)
	}
	rows := array(v.Values["rows"], path+".rows", maxRows, func(e any, p string) any {
		row := array(e, p, len(columns), func(cell any, cp string) any {
			item := str(cell, cp, limitTableCellText, true)
			textLen += JSLength(item)
			if textLen > limitJSON {
				fail("Table exceeds the supported text size.", path, "")
			}
			return item
		})
		if len(row) != len(columns) {
			fail("Table row width must match its columns.", p, fmt.Sprintf("Each row needs exactly %d cells.", len(columns)))
		}
		return row
	})
	if len(columns)*len(rows) > limitTableCells {
		fail(fmt.Sprintf("Table exceeds %d cells.", limitTableCells), path, "")
	}
	var align []any
	if has(v, "align") {
		align = array(v.Values["align"], path+".align", limitTableColumns, func(e any, p string) any { return enumeration(e, p, tableAligns) })
		if len(align) != len(columns) {
			fail("align must have one entry per column.", path+".align", fmt.Sprintf("Provide %d entries of left, center or right.", len(columns)))
		}
	}
	out := record{"type": "table", "columns": columns, "rows": rows}
	if align != nil {
		out["align"] = align
	}
	if has(v, "caption") {
		out["caption"] = str(v.Values["caption"], path+".caption", limitCaption, true)
	}
	if has(v, "headerColumn") {
		out["headerColumn"] = boolean(v.Values["headerColumn"], path+".headerColumn")
	}
	return out
}

func blockInput(value any, path string, persisted bool) record {
	required := []string{"id", "parentId", "content", "citationIds"}
	if persisted {
		required = append(required, "version", "createdAt", "updatedAt")
	}
	v := object(value, path, required)
	citationIDs := array(v.Values["citationIds"], path+".citationIds", limitCitations, idParser)
	unique(strings_(citationIDs), path+".citationIds", "")
	out := record{"id": id(v.Values["id"], path+".id"), "parentId": parent(v.Values["parentId"], path+".parentId"),
		"content": content(v.Values["content"], path+".content"), "citationIds": citationIDs}
	if persisted {
		out["version"] = float64(integer(v.Values["version"], path+".version", 1, maxSafe))
		out["createdAt"] = timestamp(v.Values["createdAt"], path+".createdAt")
		out["updatedAt"] = timestamp(v.Values["updatedAt"], path+".updatedAt")
	}
	return out
}

func citation(value any, path string) record {
	v := object(value, path, []string{"id", "title", "url", "accessedAt"}, "publishedAt")
	out := record{"id": id(v.Values["id"], path+".id"), "title": str(v.Values["title"], path+".title", 1_000, true),
		"url": urlValue(v.Values["url"], path+".url", false), "accessedAt": timestamp(v.Values["accessedAt"], path+".accessedAt")}
	if has(v, "publishedAt") {
		out["publishedAt"] = timestamp(v.Values["publishedAt"], path+".publishedAt")
	}
	return out
}

func format(value any, path string) record {
	v := object(value, path, []string{"page", "font", "fontSize", "lineHeight"})
	return record{"page": enumeration(v.Values["page"], path+".page", []string{"screen", "A4", "letter"}),
		"font":     enumeration(v.Values["font"], path+".font", []string{"sans", "serif", "mono"}),
		"fontSize": finite(v.Values["fontSize"], path+".fontSize", 8, 72), "lineHeight": finite(v.Values["lineHeight"], path+".lineHeight", 1, 3)}
}

func blockRefs(value any, path string) []any {
	refs := array(value, path, limitBlocksPerOperation, func(e any, p string) any {
		ref := object(e, p, []string{"blockId", "expectedVersion"})
		return record{"blockId": id(ref.Values["blockId"], p+".blockId"), "expectedVersion": float64(integer(ref.Values["expectedVersion"], p+".expectedVersion", 1, maxSafe))}
	})
	if len(refs) == 0 {
		fail("At least one block is required.", path, "")
	}
	ids := make([]string, len(refs))
	for i, r := range refs {
		ids[i] = r.(record)["blockId"].(string)
	}
	unique(ids, path, "List each block once.")
	return refs
}

func idMap(value any, path string) record {
	o, ok := asObject(value)
	if !ok {
		fail("Expected an object mapping old block IDs to new block IDs.", path, `Example: {"intro":"intro-copy"}. Include the block and every descendant.`)
	}
	keys := jsKeyOrder(o.Keys)
	if len(keys) == 0 || len(keys) > limitBlocksPerOperation {
		fail(fmt.Sprintf("Expected between 1 and %d ID mappings.", limitBlocksPerOperation), path, "")
	}
	result := record{}
	var values []string
	for _, key := range keys {
		k := id(key, path+"."+key)
		v := id(o.Values[key], path+"."+key)
		result[k] = v
		values = append(values, v)
	}
	unique(values, path, "Every new ID must be different.")
	return result
}

func operation(value any, path string) record {
	o, ok := asObject(value)
	if !ok {
		fail("Expected an operation.", path, `Provide an object such as {"type":"setTitle","title":"..."}. Operation types: `+strings.Join(operationTypes, ", ")+".")
	}
	kindAny, ok := o.Values["type"]
	if !ok {
		fail("Operation type is required.", path+".type", "Use one of: "+strings.Join(operationTypes, ", ")+".")
	}
	kind, _ := kindAny.(string)
	after := func(v *Object) record {
		if has(v, "afterId") {
			return record{"afterId": parent(v.Values["afterId"], path+".afterId")}
		}
		return record{}
	}
	guard := func(v *Object) (string, float64) {
		return id(v.Values["blockId"], path+".blockId"), float64(integer(v.Values["expectedVersion"], path+".expectedVersion", 1, maxSafe))
	}
	merge := func(base record, extra record) record {
		for k, val := range extra {
			base[k] = val
		}
		return base
	}
	switch kind {
	case "insertBlock":
		v := object(value, path, []string{"type", "block"}, "afterId")
		return merge(record{"type": kind, "block": blockInput(v.Values["block"], path+".block", false)}, after(v))
	case "updateBlock":
		v := object(value, path, []string{"type", "blockId", "expectedVersion", "content"}, "citationIds")
		var citationIDs []any
		if has(v, "citationIds") {
			citationIDs = array(v.Values["citationIds"], path+".citationIds", limitCitations, idParser)
			unique(strings_(citationIDs), path+".citationIds", "")
		}
		blockID, version := guard(v)
		out := record{"type": kind, "blockId": blockID, "expectedVersion": version, "content": content(v.Values["content"], path+".content")}
		if citationIDs != nil {
			out["citationIds"] = citationIDs
		}
		return out
	case "moveBlock":
		v := object(value, path, []string{"type", "blockId", "expectedVersion", "parentId"}, "afterId")
		blockID, version := guard(v)
		return merge(record{"type": kind, "blockId": blockID, "expectedVersion": version, "parentId": parent(v.Values["parentId"], path+".parentId")}, after(v))
	case "deleteBlock":
		v := object(value, path, []string{"type", "blockId", "expectedVersion"})
		blockID, version := guard(v)
		return record{"type": kind, "blockId": blockID, "expectedVersion": version}
	case "setTitle":
		v := object(value, path, []string{"type", "title"})
		return record{"type": kind, "title": str(v.Values["title"], path+".title", 1_000, true)}
	case "setFormat":
		v := object(value, path, []string{"type", "format"})
		return record{"type": kind, "format": format(v.Values["format"], path+".format")}
	case "addCitation", "updateCitation":
		v := object(value, path, []string{"type", "citation"})
		return record{"type": kind, "citation": citation(v.Values["citation"], path+".citation")}
	case "insertBlocks":
		v := object(value, path, []string{"type", "blocks"}, "afterId")
		blocks := array(v.Values["blocks"], path+".blocks", limitBlocksPerOperation, func(e any, p string) any { return blockInput(e, p, false) })
		if len(blocks) == 0 {
			fail("insertBlocks requires at least one block.", path+".blocks", "")
		}
		ids := make([]string, len(blocks))
		for i, b := range blocks {
			ids[i] = b.(record)["id"].(string)
		}
		unique(ids, path+".blocks", "Each inserted block needs its own new ID.")
		return merge(record{"type": kind, "blocks": blocks}, after(v))
	case "duplicateBlock":
		v := object(value, path, []string{"type", "blockId", "expectedVersion", "newIds"}, "afterId")
		blockID := id(v.Values["blockId"], path+".blockId")
		newIDs := idMap(v.Values["newIds"], path+".newIds")
		if _, ok := newIDs[blockID]; !ok {
			fail("newIds must include the duplicated block itself.", path+".newIds", `Add "`+blockID+`": "<new id>".`)
		}
		return merge(record{"type": kind, "blockId": blockID, "expectedVersion": float64(integer(v.Values["expectedVersion"], path+".expectedVersion", 1, maxSafe)), "newIds": newIDs}, after(v))
	case "replaceText":
		v := object(value, path, []string{"type", "blockId", "expectedVersion", "find", "replace"}, "all", "caseSensitive")
		blockID, version := guard(v)
		out := record{"type": kind, "blockId": blockID, "expectedVersion": version,
			"find": str(v.Values["find"], path+".find", limitSearchText, false), "replace": text(v.Values["replace"], path+".replace")}
		if has(v, "all") {
			out["all"] = boolean(v.Values["all"], path+".all")
		}
		if has(v, "caseSensitive") {
			out["caseSensitive"] = boolean(v.Values["caseSensitive"], path+".caseSensitive")
		}
		return out
	case "deleteBlocks":
		v := object(value, path, []string{"type", "blocks"})
		return record{"type": kind, "blocks": blockRefs(v.Values["blocks"], path+".blocks")}
	case "moveBlocks":
		v := object(value, path, []string{"type", "blocks", "parentId"}, "afterId")
		return merge(record{"type": kind, "blocks": blockRefs(v.Values["blocks"], path+".blocks"), "parentId": parent(v.Values["parentId"], path+".parentId")}, after(v))
	case "removeCitation":
		v := object(value, path, []string{"type", "citationId"})
		return record{"type": kind, "citationId": id(v.Values["citationId"], path+".citationId")}
	}
	fail("Unsupported operation type.", path+".type", "Use one of: "+strings.Join(operationTypes, ", ")+".")
	return nil
}

func jsonLength(v any) int {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return 0
	}
	return JSLength(strings.TrimSuffix(buf.String(), "\n"))
}

func run(read func() any) (result Result) {
	defer func() {
		if r := recover(); r != nil {
			if inv, ok := r.(invalid); ok {
				result = Result{Issues: []Issue{inv.issue}}
				return
			}
			result = Result{Issues: []Issue{{Code: "validation", Message: "Input could not be safely read."}}}
		}
	}()
	return Result{OK: true, Value: read()}
}

// ReadActor validates an actor.
func ReadActor(value any) Result { return run(func() any { return readActor(value, "actor") }) }

// Timestamp validates a UTC ISO timestamp.
func Timestamp(value any) Result {
	return run(func() any { return timestamp(value, "timestamp") })
}

// ValidateTransaction validates a transaction.
func ValidateTransaction(value any) Result {
	return run(func() any {
		v := object(value, "transaction", []string{"id", "actor", "baseRevision", "operations"}, "conflictPolicy")
		size := 0
		operations := array(v.Values["operations"], "transaction.operations", limitOperations, func(e any, p string) any {
			parsed := operation(e, p)
			size += jsonLength(parsed)
			if size > limitJSON {
				fail("Transaction exceeds the supported serialized size.", "transaction", "")
			}
			return parsed
		})
		if len(operations) == 0 {
			fail("A transaction requires at least one operation.", "transaction.operations", `Add at least one operation, for example {"type":"setTitle","title":"..."}.`)
		}
		transactionID := id(v.Values["id"], "transaction.id")
		if strings.HasPrefix(transactionID, "history:") {
			fail("The history: transaction namespace is reserved.", "transaction.id", `Choose a transaction ID that does not start with "history:".`)
		}
		out := record{"id": transactionID, "actor": readActor(v.Values["actor"], "transaction.actor"),
			"baseRevision": float64(integer(v.Values["baseRevision"], "transaction.baseRevision", 0, maxSafe)), "operations": operations}
		if has(v, "conflictPolicy") {
			out["conflictPolicy"] = enumeration(v.Values["conflictPolicy"], "transaction.conflictPolicy", []string{"reject", "rebase-safe"})
		}
		return out
	})
}

// ValidateHistoryRequest validates the arguments of undo and redo.
func ValidateHistoryRequest(actor, expectedRevision any) Result {
	return run(func() any {
		return record{"actor": readActor(actor, "actor"), "expectedRevision": float64(integer(expectedRevision, "expectedRevision", 0, maxSafe))}
	})
}

func runsOf(c record) []any {
	switch c["type"] {
	case "paragraph", "quote", "callout":
		return c["runs"].([]any)
	}
	return nil
}

// ValidateDocument validates a whole document.
func ValidateDocument(value any) Result {
	return run(func() any {
		v := object(value, "document", []string{"schemaVersion", "id", "title", "revision", "createdAt", "updatedAt", "format", "blocks", "citations", "retiredBlockIds"})
		integer(v.Values["schemaVersion"], "document.schemaVersion", 1, 1)
		size := 0
		blocks := array(v.Values["blocks"], "document.blocks", limitBlocks, func(e any, p string) any {
			parsed := blockInput(e, p, true)
			size += jsonLength(parsed)
			if size > limitJSON {
				fail("Document exceeds the supported serialized size.", "document", "")
			}
			return parsed
		})
		citations := array(v.Values["citations"], "document.citations", limitCitations, func(x any, p string) any { return citation(x, p) })
		retired := array(v.Values["retiredBlockIds"], "document.retiredBlockIds", 100_000, idParser)
		blockIDs := make([]string, len(blocks))
		byID := make(map[string]record, len(blocks))
		for i, b := range blocks {
			blockIDs[i] = b.(record)["id"].(string)
		}
		unique(blockIDs, "document.blocks", "")
		citationIDList := make([]string, len(citations))
		citationIDs := make(map[string]bool, len(citations))
		for i, c := range citations {
			citationIDList[i] = c.(record)["id"].(string)
			citationIDs[citationIDList[i]] = true
		}
		unique(citationIDList, "document.citations", "")
		unique(strings_(retired), "document.retiredBlockIds", "")
		for _, b := range blocks {
			byID[b.(record)["id"].(string)] = b.(record)
		}
		depth := map[string]int{}
		for _, bAny := range blocks {
			block := bAny.(record)
			blockID := block["id"].(string)
			for _, ref := range block["citationIds"].([]any) {
				if !citationIDs[ref.(string)] {
					fail("Citation reference does not exist.", "document.blocks."+blockID+".citationIds", `Add citation "`+ref.(string)+`" with addCitation (the same transaction is fine) or remove the reference.`)
				}
			}
			for index, rAny := range runsOf(block["content"].(record)) {
				run := rAny.(record)
				if cid, ok := run["citationId"].(string); ok && !citationIDs[cid] {
					fail("Inline citation reference does not exist.", fmt.Sprintf("document.blocks.%s.content.runs[%d].citationId", blockID, index), `Add citation "`+cid+`" with addCitation (the same transaction is fine) or remove citationId from the run.`)
				}
			}
			var chain []string
			inChain := map[string]bool{}
			cursor := block
			for cursor != nil {
				cursorID := cursor["id"].(string)
				if _, known := depth[cursorID]; known {
					break
				}
				if inChain[cursorID] {
					fail("Section ancestry contains a cycle.", "document.blocks."+blockID+".parentId", "")
				}
				inChain[cursorID] = true
				chain = append(chain, cursorID)
				if len(chain) > limitDepth {
					fail(fmt.Sprintf("Document nesting exceeds %d levels.", limitDepth), "document.blocks."+blockID+".parentId", "")
				}
				parentID, isString := cursor["parentId"].(string)
				if !isString {
					cursor = nil
					break
				}
				ancestor, ok := byID[parentID]
				if !ok || (ancestor["content"].(record)["type"] != "section" && ancestor["content"].(record)["type"] != "toggle") {
					fail("Parent must reference an existing section or toggle.", "document.blocks."+cursorID+".parentId", "Only section and toggle blocks can contain other blocks. Insert the container first (earlier in the same batch is fine) or use parentId: null.")
				}
				cursor = ancestor
			}
			parentDepth := 0
			if cursor != nil {
				parentDepth = depth[cursor["id"].(string)]
			}
			for i := len(chain) - 1; i >= 0; i-- {
				parentDepth++
				if parentDepth > limitDepth {
					fail(fmt.Sprintf("Document nesting exceeds %d levels.", limitDepth), "document.blocks."+blockID+".parentId", "")
				}
				depth[chain[i]] = parentDepth
			}
		}
		result := record{"schemaVersion": 1.0, "id": id(v.Values["id"], "document.id"), "title": str(v.Values["title"], "document.title", 1_000, true),
			"revision": float64(integer(v.Values["revision"], "document.revision", 0, maxSafe)), "createdAt": timestamp(v.Values["createdAt"], "document.createdAt"),
			"updatedAt": timestamp(v.Values["updatedAt"], "document.updatedAt"), "format": format(v.Values["format"], "document.format"),
			"blocks": blocks, "citations": citations, "retiredBlockIds": retired}
		if TimestampMillis(result["createdAt"].(string)) > TimestampMillis(result["updatedAt"].(string)) {
			fail("Document update timestamp precedes creation.", "document.updatedAt", "")
		}
		documentUpdated := TimestampMillis(result["updatedAt"].(string))
		for _, bAny := range blocks {
			block := bAny.(record)
			created, updated := TimestampMillis(block["createdAt"].(string)), TimestampMillis(block["updatedAt"].(string))
			if created > updated || updated > documentUpdated {
				fail("Block timestamps must follow creation and not exceed the document update timestamp.", "document.blocks."+block["id"].(string)+".updatedAt", "")
			}
		}
		if jsonLength(result) > limitJSON {
			fail("Document exceeds the supported serialized size.", "document", "")
		}
		return result
	})
}
