// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

package server

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/Super-Solution/super-editor/backends/go/documents"
	"github.com/Super-Solution/super-editor/backends/go/editor"
	"github.com/Super-Solution/super-editor/backends/go/render"
	"github.com/Super-Solution/super-editor/backends/go/validation"
)

type record = map[string]any

// Context carries what an action needs besides its input.
type Context struct {
	// Actor is recorded on every revision the action creates. Default {id: "agent", kind: "agent"}.
	Actor map[string]any
	// Now is the clock for timestamps the action creates itself (citation accessedAt). Default: the system clock.
	Now func() string
}

type ctx struct {
	service Service
	actor   map[string]any
	now     func() string
	in      *validation.Object
	doc     record
	name    string
}

func (c *ctx) has(key string) bool { _, ok := c.in.Values[key]; return ok }

func (c *ctx) str(key string) (string, bool) { s, ok := c.in.Values[key].(string); return s, ok }

func (c *ctx) strOr(key string) string { s, _ := c.str(key); return s }

func (c *ctx) num(key string) (float64, bool) { f, ok := c.in.Values[key].(float64); return f, ok }

func (c *ctx) boolean(key string) (value, ok bool) { b, ok := c.in.Values[key].(bool); return b, ok }

func (c *ctx) list(key string) ([]any, bool) { l, ok := c.in.Values[key].([]any); return l, ok }

// position is `has(key) ? input[key] : fallback`: a string, nil (null) or the fallback.
func (c *ctx) nullable(key string) (any, bool) {
	v, ok := c.in.Values[key]
	return v, ok
}

func asRecord(v any) record { m, _ := v.(record); return m }

func asObject(v any) *validation.Object { o, _ := v.(*validation.Object); return o }

func recStr(m record, key string) string { s, _ := m[key].(string); return s }

func recNum(m record, key string) float64 { f, _ := m[key].(float64); return f }

func blocksOf(doc record) []record {
	list, _ := doc["blocks"].([]any)
	out := make([]record, len(list))
	for i, b := range list {
		out[i] = asRecord(b)
	}
	return out
}

func blockContent(b record) record { return asRecord(b["content"]) }

func blockType(b record) string { return recStr(blockContent(b), "type") }

func stringsOf(v any) []string {
	l, _ := v.([]any)
	out := make([]string, len(l))
	for i, s := range l {
		out[i], _ = s.(string)
	}
	return out
}

func anyOf(items []string) []any {
	out := make([]any, len(items))
	for i, s := range items {
		out[i] = s
	}
	return out
}

func need(doc record, id, label string) record {
	for _, b := range blocksOf(doc) {
		if recStr(b, "id") == id {
			return b
		}
	}
	reject("not-found", label+" "+dq(id)+" does not exist.", "Use get_outline or find_blocks to list current block IDs. Deleted IDs no longer exist.", editor.Issue{BlockID: id})
	return nil
}

// utf16Prefix returns the longest prefix that is at most n UTF-16 code units long without splitting a surrogate pair.
func utf16Prefix(s string, n int) string {
	units := 0
	for i, r := range s {
		w := 1
		if r >= 0x10000 {
			w = 2
		}
		if units+w > n {
			return s[:i]
		}
		units += w
	}
	return s
}

func preview(value string) string {
	flat := jsTrim(collapseSpace(value))
	if validation.JSLength(flat) > limit("textPreviewChars") {
		return utf16Prefix(flat, limit("textPreviewChars")-1) + "…"
	}
	return flat
}

func childCounts(doc record) map[string]int {
	counts := map[string]int{}
	for _, b := range blocksOf(doc) {
		if p, ok := b["parentId"].(string); ok {
			counts[p]++
		}
	}
	return counts
}

func brief(b record, counts map[string]int) record {
	out := record{"id": b["id"], "type": blockType(b), "version": b["version"], "parentId": b["parentId"], "text": preview(render.BlockText(b))}
	if ids, _ := b["citationIds"].([]any); len(ids) > 0 {
		out["citationIds"] = ids
	}
	if n := counts[recStr(b, "id")]; n > 0 {
		out["children"] = float64(n)
	}
	return out
}

func randomHex() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(buf)
}

func (c *ctx) transactionID() string {
	if s, ok := c.str("transactionId"); ok {
		return s
	}
	return c.name + "-" + randomHex()
}

var operationPath = regexp.MustCompile(`^transaction\.operations\[\d+\]`)

type commitOptions struct {
	conflictPolicy string
	path           func(string) string
	extra          record
	verb           string
}

func issueRecords(issues []editor.Issue) []editor.Issue { return editor.WithHints(issues) }

func failure(s Service, issues []editor.Issue) record {
	return record{"ok": false, "issues": issueRecords(issues), "currentRevision": revisionOf(s)}
}

func nums(f float64) float64 { return f }

// commit builds one Core transaction from operations, applies it and reports a compact result.
func commit(c *ctx, operations []any, o commitOptions) record {
	before := c.doc
	policy := o.conflictPolicy
	if policy == "" && c.in.Values["conflictPolicy"] == "rebase-safe" {
		policy = "rebase-safe"
	}
	base := recNum(before, "revision")
	if r, ok := c.num("expectedRevision"); ok {
		base = r
	}
	tx := record{"id": c.transactionID(), "actor": c.actor, "baseRevision": base, "operations": operations}
	if policy != "" {
		tx["conflictPolicy"] = policy
	}
	result := c.service.Apply(tx)
	if !result.OK {
		issues := make([]editor.Issue, len(result.Issues))
		for i, is := range result.Issues {
			if is.Path != "" {
				mapped := operationPath.ReplaceAllString(is.Path, "input")
				if o.path != nil {
					mapped = o.path(mapped)
				}
				is.Path = mapped
			}
			issues[i] = is
		}
		return record{"ok": false, "issues": issueRecords(issues), "currentRevision": result.CurrentRevision}
	}
	after := result.Document
	if result.Duplicate {
		out := record{"ok": true, "revision": recNum(after, "revision"), "summary": "Already applied (same transactionId); nothing changed.", "added": []any{}, "removed": []any{}, "changed": []any{}, "moved": []any{}, "blocks": []any{}, "duplicate": true}
		for k, v := range o.extra {
			out[k] = v
		}
		return out
	}
	diff := documents.DiffDocuments(before, after)
	touched := map[string]bool{}
	for _, id := range diff.Added {
		touched[id] = true
	}
	for _, id := range diff.Changed {
		touched[id] = true
	}
	for _, id := range diff.Moved {
		touched[id] = true
	}
	var blocks []any
	for _, b := range blocksOf(after) {
		if touched[recStr(b, "id")] {
			blocks = append(blocks, record{"id": b["id"], "type": blockType(b), "version": b["version"]})
		}
	}
	verb := o.verb
	if verb == "" {
		verb = "added"
	}
	var parts []string
	if len(diff.Added) > 0 {
		parts = append(parts, fmt.Sprintf("%s %d block(s)", verb, len(diff.Added)))
	}
	if len(diff.Changed) > 0 {
		parts = append(parts, fmt.Sprintf("changed %d", len(diff.Changed)))
	}
	if len(diff.Moved) > 0 {
		parts = append(parts, fmt.Sprintf("moved %d", len(diff.Moved)))
	}
	if len(diff.Removed) > 0 {
		parts = append(parts, fmt.Sprintf("removed %d", len(diff.Removed)))
	}
	if diff.TitleChanged {
		parts = append(parts, "renamed the document")
	}
	if len(diff.Citations.Added) > 0 {
		parts = append(parts, fmt.Sprintf("added %d citation(s)", len(diff.Citations.Added)))
	}
	if len(diff.Citations.Removed) > 0 {
		parts = append(parts, fmt.Sprintf("removed %d citation(s)", len(diff.Citations.Removed)))
	}
	summary := "Document metadata updated."
	if len(parts) > 0 {
		summary = strings.Join(parts, ", ") + "."
	}
	out := record{"ok": true, "revision": recNum(after, "revision"), "summary": summary,
		"added": anyOf(diff.Added), "removed": anyOf(diff.Removed), "changed": anyOf(diff.Changed), "moved": anyOf(diff.Moved)}
	if diff.TitleChanged {
		out["titleChanged"] = true
	}
	if len(diff.Citations.Added) > 0 || len(diff.Citations.Removed) > 0 || len(diff.Citations.Changed) > 0 {
		out["citations"] = record{"added": anyOf(diff.Citations.Added), "removed": anyOf(diff.Citations.Removed), "changed": anyOf(diff.Citations.Changed)}
	}
	if blocks == nil {
		blocks = []any{}
	}
	if len(blocks) > limit("resultBlocks") {
		out["blocks"] = blocks[:limit("resultBlocks")]
		out["truncated"] = true
	} else {
		out["blocks"] = blocks
	}
	for k, v := range o.extra {
		out[k] = v
	}
	return out
}

func insertOperations(blocks []any, afterID any, hasAfter bool) []any {
	var operations []any
	lastByParent := map[any]string{}
	per := limit("blocksPerCall")
	for start := 0; start < len(blocks); start += per {
		end := min(start+per, len(blocks))
		chunk := blocks[start:end]
		op := record{"type": "insertBlocks", "blocks": chunk}
		if start == 0 {
			if hasAfter {
				op["afterId"] = afterID
			}
		} else if id, ok := lastByParent[asRecord(chunk[0])["parentId"]]; ok {
			op["afterId"] = id
		}
		operations = append(operations, op)
		for _, b := range chunk {
			m := asRecord(b)
			lastByParent[m["parentId"]] = recStr(m, "id")
		}
	}
	return operations
}

func normalizeBlock(entry any) record {
	o := asObject(entry)
	parent := get(o, "parentId")
	ids := get(o, "citationIds")
	if ids == nil {
		ids = []any{}
	}
	return record{"id": get(o, "id"), "parentId": parent, "content": get(o, "content"), "citationIds": ids}
}

func reservedIDs(doc record) map[string]bool {
	out := map[string]bool{}
	for _, id := range stringsOf(doc["retiredBlockIds"]) {
		out[id] = true
	}
	for _, b := range blocksOf(doc) {
		out[recStr(b, "id")] = true
	}
	return out
}

func createBlockID(prefix string, taken map[string]bool) string {
	for i := 1; ; i++ {
		candidate := fmt.Sprintf("%s-%d", prefix, i)
		if !taken[candidate] {
			taken[candidate] = true
			return candidate
		}
	}
}

func markdownBlocks(c *ctx, markdown string, parentID any, idPrefix string, hasPrefix bool) []any {
	if n := validation.JSLength(markdown); n > limit("markdownChars") {
		reject("validation", fmt.Sprintf("Markdown is %d characters; the limit is %d.", n, limit("markdownChars")), "Split it into several calls.", editor.Issue{Path: "input.markdown"})
	}
	reserved := reservedIDs(c.doc)
	parent, _ := parentID.(string)
	revision := recNum(c.doc, "revision")
	for attempt := 0; attempt < 50; attempt++ {
		prefix := idPrefix
		if !hasPrefix {
			prefix = "i" + render.JSNumber(revision+1)
			if attempt > 0 {
				prefix += "x" + strconv.Itoa(attempt)
			}
		}
		blocks, err := render.FromMarkdown(markdown, render.FromMarkdownOptions{IDPrefix: prefix, ParentID: parent})
		if err != nil {
			panic(err)
		}
		if len(blocks) == 0 {
			reject("validation", "The markdown contains no blocks.", "Provide at least one paragraph, heading, list or table.", editor.Issue{Path: "input.markdown"})
		}
		clash := ""
		for _, b := range blocks {
			if reserved[recStr(b, "id")] {
				clash = recStr(b, "id")
				break
			}
		}
		if clash == "" {
			out := make([]any, len(blocks))
			for i, b := range blocks {
				out[i] = b
			}
			return out
		}
		if hasPrefix {
			reject("duplicate", "Block ID "+dq(clash)+" is already used or reserved.", "Choose a different idPrefix, or omit it to get a fresh one.", editor.Issue{Path: "input.idPrefix", BlockID: clash})
		}
	}
	reject("duplicate", "Could not find a free ID prefix for the imported blocks.", "Pass an explicit idPrefix.", editor.Issue{Path: "input.idPrefix"})
	return nil
}

var generatedBlock = regexp.MustCompile(`\.blocks\[(\d+)\].*$`)

func generatedPath(blocks []any) func(string) string {
	return func(path string) string {
		return generatedBlock.ReplaceAllStringFunc(path, func(match string) string {
			index := generatedBlock.FindStringSubmatch(match)[1]
			id := index
			if n, err := strconv.Atoi(index); err == nil && n < len(blocks) {
				id = recStr(asRecord(blocks[n]), "id")
			}
			return ".markdown (generated block " + dq(id) + ")"
		})
	}
}

func inlineRuns(value string, plain bool) []any {
	if value == "" {
		return []any{}
	}
	if plain {
		return []any{record{"text": value}}
	}
	return render.RunsToAny(render.ParseInline(value))
}

// listMarker strips a leading bullet, number and task checkbox from one line of a list rewrite.
func listItem(line string) string {
	rs := []rune(line)
	i := 0
	for i < len(rs) && isSpace(rs[i]) {
		i++
	}
	j := i
	switch {
	case j < len(rs) && (rs[j] == '-' || rs[j] == '*' || rs[j] == '+'):
		j++
	case j < len(rs) && rs[j] >= '0' && rs[j] <= '9':
		for j < len(rs) && rs[j] >= '0' && rs[j] <= '9' {
			j++
		}
		if j >= len(rs) || (rs[j] != '.' && rs[j] != ')') {
			return jsTrim(line)
		}
		j++
	default:
		return jsTrim(line)
	}
	k := j
	for k < len(rs) && isSpace(rs[k]) {
		k++
	}
	if k == j {
		return jsTrim(line)
	}
	if k+2 < len(rs) && rs[k] == '[' && (rs[k+1] == ' ' || rs[k+1] == 'x' || rs[k+1] == 'X') && rs[k+2] == ']' {
		m := k + 3
		for m < len(rs) && isSpace(rs[m]) {
			m++
		}
		if m > k+3 {
			k = m
		}
	}
	return jsTrim(string(rs[k:]))
}

func copyRecord(m record) record {
	out := make(record, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func rewriteText(b record, value string, plain bool) record {
	content := blockContent(b)
	switch recStr(content, "type") {
	case "paragraph":
		return record{"type": "paragraph", "runs": inlineRuns(value, plain)}
	case "quote", "callout":
		out := copyRecord(content)
		out["runs"] = inlineRuns(value, plain)
		return out
	case "heading":
		out := copyRecord(content)
		out["text"] = render.Line(value)
		return out
	case "code":
		out := copyRecord(content)
		out["text"] = value
		return out
	case "section", "toggle":
		out := copyRecord(content)
		out["title"] = render.Line(value)
		return out
	case "list":
		var items []any
		for _, line := range strings.Split(value, "\n") {
			if item := listItem(line); item != "" {
				items = append(items, item)
			}
		}
		if len(items) == 0 {
			reject("validation", "A list needs at least one non-empty line.", "Use delete_blocks to remove the list.", editor.Issue{Path: "input.text", BlockID: recStr(b, "id")})
		}
		out := copyRecord(content)
		out["items"] = items
		if checked, ok := content["checked"].([]any); ok {
			next := make([]any, len(items))
			for i := range items {
				next[i] = false
				if i < len(checked) {
					next[i] = checked[i]
				}
			}
			out["checked"] = next
		}
		if indent, ok := content["indent"].([]any); ok {
			next := make([]any, len(items))
			for i := range items {
				next[i] = float64(0)
				if i < len(indent) {
					next[i] = indent[i]
				}
			}
			out["indent"] = next
		}
		return out
	}
	reject("validation", fmt.Sprintf("A %s block has no single text to replace.", recStr(content, "type")),
		"update_block_text edits paragraph, heading, quote, callout, code, list, section and toggle blocks. Use replace_text to change a phrase (it also reaches captions, titles and table cells) or update_block to send the full content.",
		editor.Issue{Path: "input.blockId", BlockID: recStr(b, "id")})
	return nil
}

func hasText(b record, find string, caseSensitive bool) bool {
	body := render.BlockText(b)
	if caseSensitive {
		return strings.Contains(body, find)
	}
	return strings.Contains(render.JSLower(body), render.JSLower(find))
}

func isoNow() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

// scratchService is a throwaway editor for previews. Its clock never runs behind the document, so a host with a custom
// clock still previews correctly.
func scratchService(doc record) Service {
	floor := validation.TimestampMillis(recStr(doc, "updatedAt"))
	e, err := editor.New(doc, editor.Options{Now: func() string {
		now := time.Now().UnixMilli()
		return time.UnixMilli(max(now, floor)).UTC().Format("2006-01-02T15:04:05.000Z")
	}})
	if err != nil {
		panic(err)
	}
	return NewService(e)
}

func subDocument(doc record, blockID string, has bool) record {
	if !has {
		return doc
	}
	root := copyRecord(need(doc, blockID, "Block"))
	root["parentId"] = nil
	blocks := []any{root}
	for _, d := range render.DescendantsOf(doc, blockID) {
		blocks = append(blocks, d)
	}
	out := copyRecord(doc)
	out["blocks"] = blocks
	return out
}

func utf16Len(s string) float64 { return float64(len(utf16.Encode([]rune(s)))) }

type handler func(c *ctx) record

func findIntInput(c *ctx, key string, fallback int) int {
	if f, ok := c.num(key); ok {
		return int(f)
	}
	return fallback
}

func exportHandler(format string, render func(doc record, title, standalone bool) string) handler {
	return func(c *ctx) record {
		blockID, has := c.str("blockId")
		standalone, _ := c.boolean("standalone")
		body := render(subDocument(c.doc, blockID, has), !has, standalone)
		return record{"ok": true, "revision": recNum(c.doc, "revision"), "format": format, "characters": utf16Len(body), "text": body}
	}
}

func jsRevision(n float64) float64 { return n }

var handlers = map[string]handler{}

func init() {
	handlers["get_outline"] = func(c *ctx) record {
		maxDepth, hasMax := c.num("maxDepth")
		var trim func(nodes []*render.OutlineItem, depth int) []any
		trim = func(nodes []*render.OutlineItem, depth int) []any {
			out := make([]any, len(nodes))
			for i, n := range nodes {
				rec := record{"id": n.ID, "type": n.Type, "title": n.Title, "level": float64(n.Level)}
				if hasMax && float64(depth) >= maxDepth {
					rec["children"] = []any{}
				} else {
					rec["children"] = trim(n.Children, depth+1)
				}
				out[i] = rec
			}
			return out
		}
		return record{"ok": true, "revision": recNum(c.doc, "revision"), "title": recStr(c.doc, "title"), "blockCount": float64(len(blocksOf(c.doc))), "outline": trim(render.Outline(c.doc), 1)}
	}

	handlers["find_blocks"] = func(c *ctx) record {
		var s render.Selector
		if text, ok := c.str("text"); ok {
			s.Text = &text
		}
		if v, ok := c.nullable("parentId"); ok {
			p, _ := v.(string)
			s.ParentID = &p
		}
		if within, ok := c.str("within"); ok {
			need(c.doc, within, "Container")
			s.Within = &within
		}
		if ids, ok := c.list("ids"); ok {
			s.IDs = stringsOf(ids)
			if s.IDs == nil {
				s.IDs = []string{}
			}
		}
		if cid, ok := c.str("citationId"); ok {
			s.CitationID = &cid
		}
		if t, ok := c.in.Values["type"]; ok {
			var wanted []string
			if one, isStr := t.(string); isStr {
				wanted = []string{one}
			} else {
				wanted = stringsOf(t)
			}
			known := map[string]bool{}
			for _, k := range blockTypeNames() {
				known[k] = true
			}
			for _, w := range wanted {
				if !known[w] {
					reject("validation", "Unknown block type "+dq(w)+".", "Use one of: "+strings.Join(blockTypeNames(), ", ")+".", editor.Issue{Path: "input.type"})
				}
			}
			s.Types = wanted
		}
		all := render.FindBlocks(c.doc, s)
		lim := findIntInput(c, "limit", limit("findDefault"))
		offset := findIntInput(c, "offset", 0)
		start := min(offset, len(all))
		page := all[start:min(offset+lim, len(all))]
		counts := childCounts(c.doc)
		out := record{"ok": true, "revision": recNum(c.doc, "revision"), "total": float64(len(all)), "offset": float64(offset), "count": float64(len(page))}
		if offset+len(page) < len(all) {
			out["truncated"] = true
		}
		blocks := make([]any, len(page))
		for i, b := range page {
			if c.in.Values["include"] == "content" {
				blocks[i] = b
			} else {
				blocks[i] = brief(b, counts)
			}
		}
		out["blocks"] = blocks
		return out
	}

	handlers["get_block"] = func(c *ctx) record {
		block := need(c.doc, c.strOr("blockId"), "Block")
		id := recStr(block, "id")
		counts := childCounts(c.doc)
		// Ancestors, outermost first.
		byID := map[string]record{}
		for _, b := range blocksOf(c.doc) {
			byID[recStr(b, "id")] = b
		}
		var chain []any
		cursor := block
		for steps := 0; steps <= len(byID); steps++ {
			p, ok := cursor["parentId"].(string)
			if !ok {
				break
			}
			parent, found := byID[p]
			if !found {
				break
			}
			chain = append([]any{brief(parent, counts)}, chain...)
			cursor = parent
		}
		if chain == nil {
			chain = []any{}
		}
		children := []any{}
		for _, b := range blocksOf(c.doc) {
			if b["parentId"] == id {
				children = append(children, b["id"])
			}
		}
		if len(children) > limit("findMax") {
			children = children[:limit("findMax")]
		}
		return record{"ok": true, "revision": recNum(c.doc, "revision"), "block": block, "ancestors": chain, "children": children, "descendantCount": float64(len(render.DescendantsOf(c.doc, id)))}
	}

	handlers["document_stats"] = func(c *ctx) record {
		out := render.Stats(c.doc)
		out["ok"], out["revision"], out["title"], out["updatedAt"] = true, recNum(c.doc, "revision"), recStr(c.doc, "title"), recStr(c.doc, "updatedAt")
		return out
	}

	handlers["export_markdown"] = exportHandler("markdown", func(doc record, title, _ bool) string {
		return render.ToMarkdown(doc, render.MarkdownOptions{NoTitle: !title})
	})
	handlers["export_html"] = exportHandler("html", func(doc record, title, standalone bool) string {
		return render.ToHTML(doc, render.HTMLOptions{NoTitle: !title, Standalone: standalone})
	})
	handlers["export_text"] = exportHandler("text", func(doc record, title, _ bool) string {
		return render.ToPlainText(doc, render.TextOptions{NoTitle: !title})
	})

	handlers["list_revisions"] = func(c *ctx) record {
		revs := c.service.Revisions()
		all := make([]map[string]any, len(revs))
		for i, r := range revs {
			all[len(revs)-1-i] = r
		}
		offset := findIntInput(c, "offset", 0)
		lim := findIntInput(c, "limit", limit("revisionsDefault"))
		page := all[min(offset, len(all)):min(offset+lim, len(all))]
		items := make([]any, len(page))
		for i, r := range page {
			item := record{"number": r["number"], "at": r["at"], "actor": r["actor"], "kind": r["kind"], "transactionId": r["transactionId"], "summary": documents.SummarizeRevision(r)}
			if rb, ok := r["rebasedFrom"]; ok {
				item["rebasedFrom"] = rb
			}
			items[i] = item
		}
		return record{"ok": true, "revision": recNum(c.doc, "revision"), "total": float64(len(all)), "offset": float64(offset), "count": float64(len(page)), "revisions": items}
	}

	handlers["list_templates"] = func(c *ctx) record {
		return record{"ok": true, "revision": recNum(c.doc, "revision"), "templates": validation.Plain(spec().templateInfos)}
	}

	handlers["validate_transaction"] = func(c *ctx) record {
		parsed := validation.ValidateTransaction(c.in.Values["transaction"])
		if !parsed.OK {
			return record{"ok": false, "issues": issueRecords(fromValidation(parsed.Issues)), "currentRevision": recNum(c.doc, "revision")}
		}
		result := scratchService(c.doc).Apply(parsed.Value)
		if !result.OK {
			return record{"ok": false, "issues": issueRecords(result.Issues), "currentRevision": recNum(c.doc, "revision")}
		}
		diff := documents.DiffDocuments(c.doc, result.Document)
		return record{"ok": true, "valid": true, "revision": recNum(c.doc, "revision"), "revisionAfter": recNum(result.Document, "revision"),
			"added": anyOf(diff.Added), "removed": anyOf(diff.Removed), "changed": anyOf(diff.Changed), "moved": anyOf(diff.Moved)}
	}

	handlers["insert_blocks"] = func(c *ctx) record {
		markdown, hasMarkdown := c.str("markdown")
		given, hasGiven := c.list("blocks")
		if hasMarkdown == hasGiven {
			reject("validation", "Provide exactly one of markdown or blocks.", "Send either a markdown string or an array of blocks, not both.", editor.Issue{Path: "input"})
		}
		afterID, hasAfter := c.nullable("afterId")
		if hasMarkdown {
			parent, _ := c.nullable("parentId")
			prefix, hasPrefix := c.str("idPrefix")
			blocks := markdownBlocks(c, markdown, parent, prefix, hasPrefix)
			return commit(c, insertOperations(blocks, afterID, hasAfter), commitOptions{path: generatedPath(blocks), verb: "inserted"})
		}
		blocks := make([]any, len(given))
		for i, g := range given {
			blocks[i] = normalizeBlock(g)
		}
		return commit(c, insertOperations(blocks, afterID, hasAfter), commitOptions{verb: "inserted"})
	}

	handlers["update_block_text"] = func(c *ctx) record {
		block := need(c.doc, c.strOr("blockId"), "Block")
		content := rewriteText(block, c.strOr("text"), c.in.Values["format"] == "plain")
		version, _ := c.num("expectedVersion")
		return commit(c, []any{record{"type": "updateBlock", "blockId": block["id"], "expectedVersion": version, "content": content}}, commitOptions{path: func(string) string { return "input.text" }})
	}

	handlers["update_block"] = func(c *ctx) record {
		version, _ := c.num("expectedVersion")
		op := record{"type": "updateBlock", "blockId": c.strOr("blockId"), "expectedVersion": version, "content": c.in.Values["content"]}
		if ids, ok := c.list("citationIds"); ok {
			op["citationIds"] = ids
		}
		return commit(c, []any{op}, commitOptions{})
	}

	handlers["replace_text"] = func(c *ctx) record {
		find, replace := c.strOr("find"), c.strOr("replace")
		all := true
		if v, ok := c.boolean("all"); ok {
			all = v
		}
		caseSensitive, hasCase := c.boolean("caseSensitive")
		options := func(op record) record {
			op["all"] = all
			if hasCase {
				op["caseSensitive"] = caseSensitive
			}
			return op
		}
		if blockID, ok := c.str("blockId"); ok {
			version, hasVersion := c.num("expectedVersion")
			if !hasVersion {
				reject("validation", "expectedVersion is required when blockId is given.", "Read the block with get_block and send its version.", editor.Issue{Path: "input.expectedVersion", BlockID: blockID})
			}
			need(c.doc, blockID, "Block")
			return commit(c, []any{options(record{"type": "replaceText", "blockId": blockID, "expectedVersion": version, "find": find, "replace": replace})}, commitOptions{})
		}
		if c.has("expectedVersion") {
			reject("validation", "expectedVersion only applies together with blockId.", "Remove expectedVersion, or add blockId to edit a single block.", editor.Issue{Path: "input.expectedVersion"})
		}
		pool := blocksOf(c.doc)
		if within, ok := c.str("within"); ok {
			need(c.doc, within, "Container")
			pool = render.DescendantsOf(c.doc, within)
		}
		var candidates []record
		for _, b := range pool {
			if hasText(b, find, caseSensitive) {
				candidates = append(candidates, b)
			}
		}
		if len(candidates) == 0 {
			sense := "is not"
			if caseSensitive {
				sense = "is"
			}
			reject("not-found", "No block contains "+dq(preview(find))+".", fmt.Sprintf("Matching %s case-sensitive. Use find_blocks with text to locate the wording first.", sense), editor.Issue{Path: "input.find"})
		}
		if len(candidates) > limit("operations") {
			reject("validation", fmt.Sprintf("%d blocks match; one call can edit at most %d.", len(candidates), limit("operations")), "Narrow the search with within or blockId.", editor.Issue{Path: "input.find"})
		}
		ops := make([]any, len(candidates))
		for i, b := range candidates {
			ops[i] = options(record{"type": "replaceText", "blockId": b["id"], "expectedVersion": b["version"], "find": find, "replace": replace})
		}
		return commit(c, ops, commitOptions{extra: record{"matchedBlocks": float64(len(candidates))}})
	}

	handlers["move_blocks"] = func(c *ctx) record {
		op := record{"type": "moveBlocks", "blocks": c.in.Values["blocks"], "parentId": c.in.Values["parentId"]}
		if v, ok := c.nullable("afterId"); ok {
			op["afterId"] = v
		}
		return commit(c, []any{op}, commitOptions{})
	}

	handlers["delete_blocks"] = func(c *ctx) record {
		return commit(c, []any{record{"type": "deleteBlocks", "blocks": c.in.Values["blocks"]}}, commitOptions{})
	}

	handlers["add_chart"] = func(c *ctx) record {
		id, ok := c.str("id")
		if !ok {
			id = createBlockID("chart", reservedIDs(c.doc))
		}
		parent, _ := c.nullable("parentId")
		citationIDs := []any{}
		if l, ok := c.list("citationIds"); ok {
			citationIDs = l
		}
		block := record{"id": id, "parentId": parent, "content": record{"type": "chart", "spec": c.in.Values["spec"]}, "citationIds": citationIDs}
		afterID, hasAfter := c.nullable("afterId")
		return commit(c, insertOperations([]any{block}, afterID, hasAfter), commitOptions{verb: "inserted", extra: record{"blockId": id},
			path: func(p string) string { return strings.Replace(p, "input.blocks[0].content.spec", "input.spec", 1) }})
	}

	handlers["add_citation"] = func(c *ctx) record {
		id, ok := c.str("id")
		if !ok {
			taken := map[string]bool{}
			for _, ci := range anySlice(c.doc["citations"]) {
				taken[recStr(asRecord(ci), "id")] = true
			}
			id = createBlockID("src", taken)
		}
		accessed, ok := c.str("accessedAt")
		if !ok {
			accessed = c.now()
		}
		citation := record{"id": id, "title": c.strOr("title"), "url": c.strOr("url"), "accessedAt": accessed}
		if c.has("publishedAt") {
			citation["publishedAt"] = c.strOr("publishedAt")
		}
		operations := []any{record{"type": "addCitation", "citation": citation}}
		if blockID, ok := c.str("blockId"); ok {
			version, hasVersion := c.num("expectedVersion")
			if !hasVersion {
				reject("validation", "expectedVersion is required when blockId is given.", "Read the block with get_block and send its version.", editor.Issue{Path: "input.expectedVersion", BlockID: blockID})
			}
			block := need(c.doc, blockID, "Block")
			content := blockContent(block)
			if marker, _ := c.boolean("marker"); marker {
				kind := recStr(content, "type")
				if kind != "paragraph" && kind != "quote" && kind != "callout" {
					reject("validation", fmt.Sprintf("A %s block has no inline text for a citation marker.", kind), "Remove marker, or target a paragraph, quote or callout.", editor.Issue{Path: "input.marker", BlockID: blockID})
				}
				content = copyRecord(content)
				runs := append(append([]any{}, anySlice(content["runs"])...), record{"text": "", "citationId": id})
				content["runs"] = runs
			}
			ids := []any{}
			seen := map[string]bool{}
			for _, cid := range append(append([]any{}, anySlice(block["citationIds"])...), id) {
				if s := cid.(string); !seen[s] {
					seen[s] = true
					ids = append(ids, s)
				}
			}
			operations = append(operations, record{"type": "updateBlock", "blockId": blockID, "expectedVersion": version, "content": content, "citationIds": ids})
		}
		return commit(c, operations, commitOptions{extra: record{"citationId": id}})
	}

	handlers["set_title"] = func(c *ctx) record {
		return commit(c, []any{record{"type": "setTitle", "title": c.strOr("title")}}, commitOptions{})
	}

	handlers["insert_template"] = func(c *ctx) record {
		kind := c.strOr("kind")
		reserved := reservedIDs(c.doc)
		prefix, hasPrefix := c.str("idPrefix")
		if !hasPrefix {
			prefix = kind
			for n := 2; ; n++ {
				used := false
				for id := range reserved {
					if strings.HasPrefix(id, prefix+"-") {
						used = true
						break
					}
				}
				if !used {
					break
				}
				prefix = kind + strconv.Itoa(n)
			}
		}
		subjectRaw := c.strOr("subject")
		subject, err := cleanSubject(subjectRaw)
		var blocks []any
		parent, _ := c.nullable("parentId")
		if err == nil {
			blocks, err = createTemplate(kind, prefix, subject, parent)
		}
		if err != nil {
			reject("validation", err.Error(), "", editor.Issue{Path: "input"})
		}
		var operations []any
		if setTitle, _ := c.boolean("setTitle"); setTitle {
			title, err := templateTitle(kind, subjectRaw)
			if err != nil {
				panic(err)
			}
			operations = append(operations, record{"type": "setTitle", "title": title})
		}
		afterID, hasAfter := c.nullable("afterId")
		operations = append(operations, insertOperations(blocks, afterID, hasAfter)...)
		roots := []any{}
		for _, b := range blocks {
			if asRecord(b)["parentId"] == parent {
				roots = append(roots, asRecord(b)["id"])
			}
		}
		return commit(c, operations, commitOptions{verb: "inserted", extra: record{"idPrefix": prefix, "rootIds": roots}})
	}

	handlers["import_markdown"] = func(c *ctx) record {
		replace := c.in.Values["mode"] == "replace"
		if replace && (c.has("afterId") || c.has("parentId")) {
			reject("validation", `afterId and parentId only apply to mode "append".`, `Remove them, or use mode "append".`, editor.Issue{Path: "input.mode"})
		}
		markdown := c.strOr("markdown")
		parent, _ := c.nullable("parentId")
		prefix, hasPrefix := c.str("idPrefix")
		blocks := markdownBlocks(c, markdown, parent, prefix, hasPrefix)
		var operations []any
		if setTitle, _ := c.boolean("setTitle"); setTitle {
			if title, ok := leadingTitle(markdown); ok {
				operations = append(operations, record{"type": "setTitle", "title": title})
			}
		}
		if replace {
			var roots []record
			for _, b := range blocksOf(c.doc) {
				if b["parentId"] == nil {
					roots = append(roots, b)
				}
			}
			per := limit("blocksPerOperation")
			for start := 0; start < len(roots); start += per {
				var refs []any
				for _, b := range roots[start:min(start+per, len(roots))] {
					refs = append(refs, record{"blockId": b["id"], "expectedVersion": b["version"]})
				}
				operations = append(operations, record{"type": "deleteBlocks", "blocks": refs})
			}
		}
		var afterID any
		hasAfter := false
		if !replace {
			afterID, hasAfter = c.nullable("afterId")
		}
		operations = append(operations, insertOperations(blocks, afterID, hasAfter)...)
		mode := "append"
		if replace {
			mode = "replace"
		}
		return commit(c, operations, commitOptions{path: generatedPath(blocks), verb: "imported", extra: record{"mode": mode}})
	}
}

func anySlice(v any) []any { l, _ := v.([]any); return l }

func fromValidation(issues []validation.Issue) []editor.Issue {
	out := make([]editor.Issue, len(issues))
	for i, is := range issues {
		out[i] = editor.Issue{Code: is.Code, Message: is.Message, Path: is.Path, Hint: is.Hint}
	}
	return out
}

func blockTypeNames() []string {
	return []string{"section", "heading", "paragraph", "list", "table", "chart", "embed", "timestamp", "quote", "callout", "code", "divider", "image", "toggle", "metrics", "toc", "pageBreak"}
}

// titlePattern is /^\s*#\s+(.+?)\s*#*\s*$/m with the line terminators other than \n mapped to \n first, so Go's multiline
// anchors agree with JavaScript's.
var titlePattern = regexp.MustCompile(`(?m)^[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*#[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+([^\n]+?)[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*#*[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*$`)

var terminators = strings.NewReplacer("\r", "\n", " ", "\n", " ", "\n")

// leadingTitle is the title in a leading "# Title" line: the first non-blank line, if it is a level-1 heading.
func leadingTitle(markdown string) (string, bool) {
	first := ""
	for _, line := range strings.Split(markdown, "\n") {
		if jsTrim(line) != "" {
			first = line
			break
		}
	}
	m := titlePattern.FindStringSubmatch(terminators.Replace(first))
	if m == nil || m[1] == "" {
		return "", false
	}
	return utf16Prefix(m[1], limit("title")), true
}

// run executes one action: it validates the input against the action's schema, runs the handler and never panics.
func run(service Service, action *actionSpec, input any, context Context) (result record) {
	target := service
	defer func() {
		if r := recover(); r != nil {
			if is, ok := r.(issue); ok {
				result = failure(service, []editor.Issue{is.Issue})
				return
			}
			result = failure(service, []editor.Issue{{Code: "validation", Message: "The action could not be completed safely.", Hint: "Check the input against the action schema and retry."}})
		}
	}()
	if input == nil {
		input = &validation.Object{Values: map[string]any{}}
	}
	copied := plainCopy(input, "input")
	obj, ok := copied.(*validation.Object)
	if !ok {
		reject("validation", "Input must be a JSON object.", "Send the arguments as an object.", editor.Issue{Path: "input"})
	}
	check(action.InputSchema, obj, "input", action.InputSchema)
	dryRun := action.Access == "write" && obj.Values["dryRun"] == true
	if dryRun {
		target = scratchService(service.Read())
	}
	actor := context.Actor
	if actor == nil {
		actor = map[string]any{"id": "agent", "kind": "agent"}
	}
	now := context.Now
	if now == nil {
		now = isoNow
	}
	c := &ctx{service: target, actor: actor, now: now, in: obj, doc: target.Read(), name: action.Name}
	out := handlers[action.Name](c)
	if dryRun && out["ok"] == true {
		revision := out["revision"]
		delete(out, "revision")
		out["ok"], out["revision"], out["revisionAfter"], out["dryRun"] = true, recNum(service.Read(), "revision"), revision, true
	}
	return out
}

// RunAction runs one action by name over a service. It never panics: unknown names, bad input and Core rejections all
// return {"ok": false, "issues": ..., "currentRevision": ...}. input may be decoded JSON (validation.Decode) or plain
// maps and slices.
func RunAction(service Service, name string, input any, context Context) map[string]any {
	action, ok := spec().actionByName[name]
	if !ok {
		names := make([]string, len(spec().actions))
		for i, a := range spec().actions {
			names[i] = a.Name
		}
		return failure(service, []editor.Issue{{Code: "not-found", Message: "Unknown action " + dq(name) + ".", Hint: "Available actions: " + strings.Join(names, ", ") + "."}})
	}
	return run(service, action, input, context)
}

var _ = math.Inf

// dq quotes a value the way the reference writes it in messages: in double quotes, nothing escaped.
func dq(s string) string { return `"` + s + `"` }
