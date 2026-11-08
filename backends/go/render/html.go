// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

package render

import (
	"fmt"
	"strings"

	"github.com/Super-Solution/super-editor/backends/go/validation"
)

// HTMLOptions configure ToHTML.
type HTMLOptions struct {
	NoTitle    bool
	Standalone bool
	ChartRows  int // 0 means the default, 100
}

// EscapeHTML escapes text for HTML content and attribute values.
func EscapeHTML(text string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;", "'", "&#39;").Replace(text)
}

const htmlStyle = `body{font:16px/1.6 system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;color:#1f2328}table{border-collapse:collapse;margin:1rem 0}th,td{border:1px solid #d0d7de;padding:.3rem .6rem}blockquote{margin:1rem 0;padding-left:1rem;border-left:4px solid #d0d7de;color:#57606a}pre{background:#f6f8fa;padding:1rem;overflow:auto}aside.callout{border-left:4px solid #0969da;background:#f6f8fa;padding:.5rem 1rem;margin:1rem 0}img{max-width:100%}.page-break{break-after:page}.sources{font-size:.9em}figure{margin:1rem 0}`

type htmlTable struct {
	caption      string
	align        []string
	headerColumn bool
	omitted      int
}

// ToHTML renders static, escaped HTML: no scripts, no inline event handlers, no iframes (embeds become links).
// Links and images are re-checked with SafeURL.
func ToHTML(doc record, o HTMLOptions) string {
	t := newTree(doc)
	rows := chartRows(o.ChartRows, 100)
	link := func(url, label string) string {
		if safe, ok := validation.SafeURL(url, false); ok {
			return `<a href="` + EscapeHTML(safe) + `" rel="noopener noreferrer">` + label + `</a>`
		}
		return label
	}
	marker := func(id string) string {
		label := EscapeHTML(id)
		if n, ok := t.numbers[id]; ok {
			label = fmt.Sprint(n)
		}
		return `<sup class="citation"><a href="#cite-` + EscapeHTML(id) + `">[` + label + `]</a></sup>`
	}
	text := func(v string) string {
		escaped := EscapeHTML(v)
		escaped = strings.ReplaceAll(escaped, "\r\n", "<br>")
		return strings.ReplaceAll(escaped, "\n", "<br>")
	}
	runsHTML := func(runs []Run) string {
		var out strings.Builder
		for _, r := range runs {
			h := text(r.Text)
			if r.Code {
				h = "<code>" + h + "</code>"
			}
			if r.Italic {
				h = "<em>" + h + "</em>"
			}
			if r.Bold {
				h = "<strong>" + h + "</strong>"
			}
			if r.Strike {
				h = "<s>" + h + "</s>"
			}
			if r.Underline {
				h = "<u>" + h + "</u>"
			}
			if r.Highlight != "" {
				h = `<mark data-highlight="` + r.Highlight + `">` + h + "</mark>"
			}
			if r.Href != "" {
				h = link(r.Href, h)
			}
			out.WriteString(h)
			if r.HasCitation {
				out.WriteString(marker(r.CitationID))
			}
		}
		return out.String()
	}
	table := func(head []string, body [][]string, x htmlTable) string {
		style := func(col int) string {
			if col < len(x.align) && x.align[col] != "" && x.align[col] != "left" {
				return ` style="text-align:` + x.align[col] + `"`
			}
			return ""
		}
		var b strings.Builder
		b.WriteString("<table>")
		if x.caption != "" {
			b.WriteString("<caption>" + text(x.caption) + "</caption>")
		}
		b.WriteString("<thead><tr>")
		for col, cell := range head {
			b.WriteString(`<th scope="col"` + style(col) + ">" + text(cell) + "</th>")
		}
		b.WriteString("</tr></thead><tbody>")
		for _, row := range body {
			b.WriteString("<tr>")
			for col, cell := range row {
				if col == 0 && x.headerColumn {
					b.WriteString(`<th scope="row"` + style(col) + ">" + text(cell) + "</th>")
				} else {
					b.WriteString("<td" + style(col) + ">" + text(cell) + "</td>")
				}
			}
			b.WriteString("</tr>")
		}
		if x.omitted > 0 {
			b.WriteString(fmt.Sprintf(`<tr><td colspan="%d">… %d more rows omitted</td></tr>`, len(head), x.omitted))
		}
		b.WriteString("</tbody></table>")
		return b.String()
	}
	listHTML := func(c record) string {
		tag := "ul"
		if isOrdered(c) {
			tag = "ol"
		}
		todo := str(c, "style") == "todo"
		var b strings.Builder
		b.WriteString("<" + tag)
		if todo {
			b.WriteString(` class="todo-list"`)
		}
		b.WriteString(">")
		previous := 0
		for i, item := range strList(c["items"]) {
			level := indentAt(c, i)
			if i > 0 {
				if level > previous {
					b.WriteString(strings.Repeat("<"+tag+">", level-previous))
				} else {
					b.WriteString("</li>" + strings.Repeat("</"+tag+"></li>", previous-level))
				}
			}
			b.WriteString("<li>")
			if todo {
				b.WriteString(`<input type="checkbox" disabled`)
				if checkedAt(c, i) {
					b.WriteString(" checked")
				}
				b.WriteString("> ")
			}
			b.WriteString(text(item))
			previous = level
		}
		b.WriteString("</li>" + strings.Repeat("</"+tag+"></li>", previous) + "</" + tag + ">")
		return b.String()
	}
	var outline func(items []*OutlineItem) string
	outline = func(items []*OutlineItem) string {
		if len(items) == 0 {
			return ""
		}
		var b strings.Builder
		b.WriteString("<ol>")
		for _, item := range items {
			b.WriteString(`<li><a href="#` + EscapeHTML(item.ID) + `">` + text(item.Title) + "</a>" + outline(item.Children) + "</li>")
		}
		b.WriteString("</ol>")
		return b.String()
	}
	var render func(b record) string
	render = func(b record) string {
		c := contentOf(b)
		id := ` id="` + EscapeHTML(idOf(b)) + `"`
		var kids strings.Builder
		for _, child := range t.children[idOf(b)] {
			kids.WriteString(render(child))
		}
		var h string
		withID := func(s, tag string) string { return strings.Replace(s, "<"+tag, "<"+tag+id, 1) }
		switch c["type"] {
		case "section":
			h = "<section" + id + "><h2>" + text(str(c, "title")) + "</h2>" + kids.String() + "</section>"
		case "toggle":
			open := ""
			if open2, _ := c["open"].(bool); open2 {
				open = " open"
			}
			h = "<details" + id + open + "><summary>" + text(str(c, "title")) + "</summary>" + kids.String() + "</details>"
		case "heading":
			level := num(c["level"])
			h = "<h" + level + id + ">" + text(str(c, "text")) + "</h" + level + ">"
		case "paragraph":
			h = "<p" + id + ">" + runsHTML(RunsOf(c)) + "</p>"
		case "list":
			s := listHTML(c)
			if strings.HasPrefix(s, "<ol") {
				h = withID(s, "ol")
			} else {
				h = withID(s, "ul")
			}
		case "table":
			x := htmlTable{caption: str(c, "caption"), align: strList(c["align"])}
			x.headerColumn, _ = c["headerColumn"].(bool)
			h = withID(table(strList(c["columns"]), tableRows(c), x), "table")
		case "chart":
			spec := rec(c["spec"])
			data := ChartData(spec, rows)
			var notes strings.Builder
			for _, extra := range []string{annotationLine(spec), str(spec, "caption"), sourceLine(spec)} {
				if extra != "" {
					notes.WriteString(`<p class="chart-note">` + text(extra) + "</p>")
				}
			}
			h = "<figure" + id + ` class="chart" data-kind="` + EscapeHTML(str(spec, "kind")) + `"><figcaption>` + text(str(spec, "title")) + " <small>(" + text(chartDescriptor(spec)) + ")</small></figcaption>" +
				table(data.Head, data.Rows, htmlTable{omitted: data.Omitted}) + notes.String() + "</figure>"
		case "embed":
			h = "<p" + id + ` class="embed">` + link(str(c, "url"), text(str(c, "title"))) + "</p>"
		case "timestamp":
			h = "<p" + id + `><time datetime="` + EscapeHTML(str(c, "at")) + `">` + text(str(c, "label")) + ": " + EscapeHTML(str(c, "at")) + "</time></p>"
		case "quote":
			footer := ""
			if a := str(c, "attribution"); a != "" {
				footer = "<footer>— " + text(a) + "</footer>"
			}
			h = "<blockquote" + id + ">" + runsHTML(RunsOf(c)) + footer + "</blockquote>"
		case "callout":
			title := ""
			if s := str(c, "title"); s != "" {
				title = "<strong>" + text(s) + "</strong>"
			}
			h = "<aside" + id + ` class="callout" data-tone="` + str(c, "tone") + `" role="note">` + title + "<p>" + runsHTML(RunsOf(c)) + "</p></aside>"
		case "code":
			class := ""
			if l := str(c, "language"); l != "" {
				class = ` class="language-` + EscapeHTML(l) + `"`
			}
			h = "<pre" + id + "><code" + class + ">" + EscapeHTML(str(c, "text")) + "</code></pre>"
		case "divider":
			h = "<hr" + id + ">"
		case "pageBreak":
			h = "<hr" + id + ` class="page-break">`
		case "image":
			width := str(c, "width")
			if width == "" {
				width = "normal"
			}
			inner := text(str(c, "alt"))
			if safe, ok := validation.SafeURL(str(c, "url"), true); ok {
				inner = `<img src="` + EscapeHTML(safe) + `" alt="` + EscapeHTML(str(c, "alt")) + `" loading="lazy" referrerpolicy="no-referrer">`
			}
			caption := ""
			if s := str(c, "caption"); s != "" {
				caption = "<figcaption>" + text(s) + "</figcaption>"
			}
			h = "<figure" + id + ` class="image width-` + width + `">` + inner + caption + "</figure>"
		case "metrics":
			var items strings.Builder
			for _, it := range list(c["items"]) {
				m := rec(it)
				tone := ""
				if s := str(m, "tone"); s != "" {
					tone = ` data-tone="` + s + `"`
				}
				change := ""
				if has(m, "change") {
					change = ` <span class="change">` + EscapeHTML(percent(m["change"])) + "</span>"
				}
				hint := ""
				if s := str(m, "hint"); s != "" {
					hint = `<dd class="hint">` + text(s) + "</dd>"
				}
				items.WriteString(`<div class="metric"` + tone + "><dt>" + text(str(m, "label")) + "</dt><dd>" + text(str(m, "value")) + change + "</dd>" + hint + "</div>")
			}
			h = "<dl" + id + ` class="metrics">` + items.String() + "</dl>"
		case "toc":
			h = "<nav" + id + ` class="toc" aria-label="Table of contents">` + outline(Outline(doc)) + "</nav>"
		}
		if sources := blockSources(b); len(sources) > 0 {
			refs := make([]string, len(sources))
			for i, s := range sources {
				refs[i] = marker(s)
			}
			h += `<small class="block-sources">Sources: ` + strings.Join(refs, " ") + "</small>"
		}
		return h
	}
	var bodyParts []string
	for _, b := range t.children[""] {
		bodyParts = append(bodyParts, render(b))
	}
	body := strings.Join(bodyParts, "\n")
	sources := ""
	if citations := list(doc["citations"]); len(citations) > 0 {
		var b strings.Builder
		b.WriteString("\n<section class=\"sources\" aria-label=\"Sources\"><h2>Sources</h2><ol>")
		for _, ci := range citations {
			c := rec(ci)
			b.WriteString(`<li id="cite-` + EscapeHTML(str(c, "id")) + `">` + link(str(c, "url"), text(str(c, "title"))) + ` <small>Accessed <time datetime="` + EscapeHTML(str(c, "accessedAt")) + `">` + EscapeHTML(sliceChars(str(c, "accessedAt"), 10)) + "</time>")
			if p := str(c, "publishedAt"); p != "" {
				b.WriteString(` · Published <time datetime="` + EscapeHTML(p) + `">` + EscapeHTML(sliceChars(p, 10)) + "</time>")
			}
			b.WriteString("</small></li>")
		}
		b.WriteString("</ol></section>")
		sources = b.String()
	}
	title := ""
	if !o.NoTitle {
		title = "\n<h1>" + text(str(doc, "title")) + "</h1>"
	}
	article := `<article class="se-document" data-document-id="` + EscapeHTML(str(doc, "id")) + `">` + title + "\n" + body + sources + "\n</article>"
	if o.Standalone {
		return "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>" + EscapeHTML(str(doc, "title")) + "</title><style>" + htmlStyle + "</style></head><body>\n" + article + "\n</body></html>\n"
	}
	return article + "\n"
}
