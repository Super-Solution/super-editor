// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

package editor

import (
	"fmt"
	"strings"

	"github.com/Super-Solution/super-editor/backends/go/validation"
)

const reuseHint = "Choose a fresh ID. IDs of deleted blocks stay reserved so old references cannot point at new content."

func newBlock(input record, at string) record {
	b := cloneRecord(input)
	b["version"] = 1.0
	b["createdAt"] = at
	b["updatedAt"] = at
	return b
}

type blockRef struct {
	id      string
	version float64
}

func refsOf(op record) []blockRef {
	items := op["blocks"].([]any)
	out := make([]blockRef, len(items))
	for i, it := range items {
		r := it.(record)
		out[i] = blockRef{r["blockId"].(string), numOf(r, "expectedVersion")}
	}
	return out
}

func applyOperation(d *draft, op record, highWater map[string]float64, at string, pending map[string]bool) {
	switch op["type"] {
	case "insertBlock":
		input := op["block"].(record)
		id := input["id"].(string)
		if pending[id] || d.find(id) != nil {
			reject("duplicate", "Block ID is already used or reserved.", id, reuseHint)
		}
		b := newBlock(input, at)
		d.put(b, anchorOf(op))
		highWater[id] = 1
		pending[id] = true

	case "updateBlock":
		b := d.blockAt(op["blockId"].(string), numOf(op, "expectedVersion"))
		b["content"] = clone(op["content"])
		if ids, ok := op["citationIds"]; ok {
			b["citationIds"] = clone(ids)
		}
		tick(b, highWater, at)

	case "moveBlock":
		b := d.blockAt(op["blockId"].(string), numOf(op, "expectedVersion"))
		// Validate the destination before detaching; cycles are validated against the final atomic document.
		d.parentExists(op["parentId"])
		if p, ok := op["parentId"].(string); ok && d.subtreeIDs([]string{b["id"].(string)})[p] {
			reject("validation", "A block cannot be moved into itself or its own descendant.", b["id"].(string), "Choose a destination outside the moved subtree.")
		}
		d.relocate(b, op["parentId"], anchorOf(op))
		tick(b, highWater, at)

	case "deleteBlock":
		id := op["blockId"].(string)
		d.blockAt(id, numOf(op, "expectedVersion"))
		d.remove(d.subtreeIDs([]string{id}), highWater, at)

	case "setTitle":
		d.doc["title"] = op["title"]

	case "setFormat":
		d.doc["format"] = clone(op["format"])

	case "addCitation":
		c := op["citation"].(record)
		for _, existing := range d.citations {
			if existing["id"] == c["id"] {
				reject("duplicate", "Citation ID already exists.", "", "Use updateCitation to change an existing citation, or choose a new ID.")
			}
		}
		d.citations = append(d.citations, cloneRecord(c))

	case "insertBlocks":
		// The first block follows afterId; each later block follows the previous block with the same parent, or is appended to its parent.
		last := map[any]string{}
		for i, it := range op["blocks"].([]any) {
			input := it.(record)
			id := input["id"].(string)
			if pending[id] {
				reject("duplicate", "Block ID is already used or reserved.", id, reuseHint)
			}
			b := newBlock(input, at)
			at2 := anchorOf(op)
			if i > 0 {
				at2 = unset
				if prev, ok := last[input["parentId"]]; ok {
					at2 = after(prev)
				}
			}
			d.put(b, at2)
			highWater[id] = 1
			pending[id] = true
			last[input["parentId"]] = id
		}

	case "duplicateBlock":
		duplicate(d, op, at, highWater, pending)

	case "replaceText":
		b := d.blockAt(op["blockId"].(string), numOf(op, "expectedVersion"))
		all, _ := op["all"].(bool)
		sensitive, _ := op["caseSensitive"].(bool)
		content := b["content"].(record)
		next, count, ok := replaceInContent(content, op["find"].(string), op["replace"].(string), all, sensitive)
		if !ok {
			reject("validation", fmt.Sprintf("A %s block has no text to replace.", content["type"]), b["id"].(string), "Use updateBlock to change this block.")
		}
		if count == 0 {
			matching := "is not"
			if sensitive {
				matching = "is"
			}
			reject("not-found", "The text to replace was not found in the block.", b["id"].(string),
				fmt.Sprintf("Matching %s case-sensitive. Read the block and copy the exact wording; a match cannot span separate list items or table cells.", matching))
		}
		b["content"] = next
		tick(b, highWater, at)

	case "deleteBlocks":
		refs := refsOf(op)
		roots := make([]string, len(refs))
		for i, ref := range refs {
			d.blockAt(ref.id, ref.version)
			roots[i] = ref.id
		}
		d.remove(d.subtreeIDs(roots), highWater, at)

	case "moveBlocks":
		refs := refsOf(op)
		moving := map[string]bool{}
		for _, ref := range refs {
			moving[ref.id] = true
		}
		blocks := make([]record, len(refs))
		for i, ref := range refs {
			blocks[i] = d.blockAt(ref.id, ref.version)
		}
		to := anchorOf(op)
		if to.set && !to.null && moving[to.id] {
			reject("validation", "afterId cannot be one of the moved blocks.", to.id, "Anchor on a block that stays in place, or omit afterId.")
		}
		d.parentExists(op["parentId"])
		if p, ok := op["parentId"].(string); ok {
			roots := make([]string, 0, len(moving))
			for _, ref := range refs {
				roots = append(roots, ref.id)
			}
			if d.subtreeIDs(roots)[p] {
				reject("validation", "A block cannot be moved into itself or its own descendant.", p, "Choose a destination outside the moved subtrees.")
			}
		}
		// Blocks land in the given order: the first after afterId, each later one after its predecessor.
		for i, b := range blocks {
			place := to
			if i > 0 {
				place = after(blocks[i-1]["id"].(string))
			}
			d.relocate(b, op["parentId"], place)
			tick(b, highWater, at)
		}

	case "updateCitation":
		c := op["citation"].(record)
		for i, existing := range d.citations {
			if existing["id"] == c["id"] {
				d.citations[i] = cloneRecord(c)
				return
			}
		}
		reject("not-found", "Citation does not exist.", "", fmt.Sprintf(`No citation "%s". Use addCitation to create it.`, c["id"]))

	case "removeCitation":
		removeCitation(d, op["citationId"].(string), highWater, at)
	}
}

func removeCitation(d *draft, id string, highWater map[string]float64, at string) {
	index := -1
	for i, c := range d.citations {
		if c["id"] == id {
			index = i
			break
		}
	}
	if index == -1 {
		reject("not-found", "Citation does not exist.", "", fmt.Sprintf(`No citation "%s". Read the document to list citation IDs.`, id))
	}
	d.citations = append(d.citations[:index], d.citations[index+1:]...)
	// References are stripped, never left dangling: block-level IDs, inline markers, and marker-only runs.
	for _, b := range d.blocks {
		changed := false
		if ids := stringsOf(b["citationIds"]); contains(ids, id) {
			kept := []any{}
			for _, entry := range ids {
				if entry != id {
					kept = append(kept, entry)
				}
			}
			b["citationIds"] = kept
			changed = true
		}
		content := b["content"].(record)
		if t := content["type"]; t == "paragraph" || t == "quote" || t == "callout" {
			runs := content["runs"].([]any)
			marked := false
			for _, r := range runs {
				if r.(record)["citationId"] == id {
					marked = true
				}
			}
			if marked {
				kept := []any{}
				for _, r := range runs {
					run := r.(record)
					if run["citationId"] != id || run["text"] != "" {
						if run["citationId"] == id {
							delete(run, "citationId")
						}
						kept = append(kept, run)
					}
				}
				content["runs"] = kept
				changed = true
			}
		}
		if changed {
			tick(b, highWater, at)
		}
	}
}

func duplicate(d *draft, op record, at string, highWater map[string]float64, pending map[string]bool) {
	original := d.blockAt(op["blockId"].(string), numOf(op, "expectedVersion"))
	children := map[string][]record{}
	for _, b := range d.blocks {
		if p, ok := b["parentId"].(string); ok {
			children[p] = append(children[p], b)
		}
	}
	order := []record{original}
	var walk func(id string)
	walk = func(id string) {
		for _, child := range children[id] {
			order = append(order, child)
			walk(child["id"].(string))
		}
	}
	walk(original["id"].(string))
	newIDs := op["newIds"].(*validation.Object)
	needed := make([]string, len(order))
	neededSet := map[string]bool{}
	for i, b := range order {
		needed[i] = b["id"].(string)
		neededSet[needed[i]] = true
	}
	var missing, unexpected []string
	for _, id := range needed {
		if _, ok := newIDs.Values[id]; !ok {
			missing = append(missing, id)
		}
	}
	for _, id := range newIDs.Keys {
		if !neededSet[id] {
			unexpected = append(unexpected, id)
		}
	}
	if len(missing) > 0 || len(unexpected) > 0 {
		var hint strings.Builder
		if len(missing) > 0 {
			hint.WriteString("Missing: " + strings.Join(missing, ", ") + ". ")
		}
		if len(unexpected) > 0 {
			hint.WriteString("Not part of this subtree: " + strings.Join(unexpected, ", ") + ". ")
		}
		hint.WriteString("Required old IDs: " + strings.Join(needed, ", ") + ".")
		reject("validation", fmt.Sprintf("newIds must map exactly the duplicated block and its %d descendant(s).", len(needed)-1), original["id"].(string), hint.String())
	}
	for _, id := range needed {
		fresh := newIDs.Values[id].(string)
		if pending[fresh] {
			reject("duplicate", "Block ID is already used or reserved.", fresh, "Choose a fresh ID for each copy. IDs of deleted blocks stay reserved.")
		}
	}
	for i, source := range order {
		copied := cloneRecord(source)
		copied["id"] = newIDs.Values[source["id"].(string)]
		if i > 0 {
			copied["parentId"] = newIDs.Values[source["parentId"].(string)]
		}
		copied["version"] = 1.0
		copied["createdAt"] = at
		copied["updatedAt"] = at
		place := unset
		if i == 0 {
			place = anchorOf(op)
			if !place.set {
				place = after(original["id"].(string))
			}
		}
		d.put(copied, place)
		fresh := copied["id"].(string)
		highWater[fresh] = 1
		pending[fresh] = true
	}
}
