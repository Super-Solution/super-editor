# Accessibility

What Super Editor does for people who use a keyboard, a screen reader or an input method, what is checked automatically, and what is **not** known. This is a statement of facts about this repository at this version, not a conformance claim: there is no VPAT and no audit by a person who uses assistive technology every day. Read the limits at the end before you rely on it.

## What is checked on every run

`npm run test:e2e` runs `e2e/a11y.e2e.ts` in a real Chromium against the demo (the interactive `ReportEditor`):

| Check | What it proves |
| --- | --- |
| **axe-core** (a `devDependency`, never shipped; WCAG 2.0 to 2.2 A and AA plus axe's best practices) | No violation at rest, while editing a paragraph, with the `/` menu open, with a block selected, with the shortcut dialog open, while editing a table cell and while editing a heading; at 1280 and 390 px wide, in light and dark |
| **Keyboard only** | Tab reaches the document; Down (or Enter) starts at the first block; Down and Up move the selection and say which block it is; Enter edits it, opens a chart's settings or says why there is nothing to edit; Escape steps back out; typed text reaches the document |
| **Input method** | A composition driven through the DevTools protocol (`Input.imeSetComposition`): the composing text is shown, commits as typed, emoji and characters outside the BMP stay whole, and one undo removes the composed run |
| **Direction** | Arabic text in a left-to-right page aligns and flows right to left, both in the rendered view and while editing |

A new violation fails the suite with the rule, the nodes and why, so a regression names what to fix. axe finds only a part of what can be wrong (its own documentation says roughly a third of WCAG issues are detectable automatically); a clean run is a floor.

## How the editor exposes itself

- **The document** is an `<article>` labelled by its title, with real headings, lists, tables with `scope` on header cells, figures with captions, and a polite live region that announces edits by other writers (an agent, another tab).
- **The editing surface** (`.se-surface`) is focusable, named "Document editor" and described by "Press Down or Enter to start at the first block." Only the focused surface answers Down and Enter this way; a button inside the document keeps its own keys.
- **One field is editable at a time.** A text field is a `textbox` with a name ("Paragraph", "List item", "Row 2, column 3", "Column 1 heading"), `aria-multiline` and `aria-placeholder`. A **heading keeps its heading semantics** while it is edited (no `role`, no label: its text is its name).
- **The `/` menu** follows the ARIA 1.2 editable combobox pattern: while the menu is open the field becomes the `combobox` that owns it (`aria-expanded`, `aria-haspopup`, `aria-controls`, `aria-autocomplete="list"`, `aria-activedescendant` on the highlighted option) and goes back to a `textbox` when it closes. Focus never leaves the field.
- **Selection is spoken.** The selection highlight is a drawing, so a visually hidden live region says "Heading selected: Quarterly outlook" for one block (the selection toolbar says "3 blocks selected" for several). Enter on a block with no text (an embed, an image, a divider) gives a notice ("This block has no text to edit…") instead of nothing.
- **Notices** (success with Undo, refused edits, conflicts) are `status` regions, errors and conflicts are `alert`s, each its own region and not a list item.
- **Dialogs** (shortcuts) are modal, labelled, trap focus, close with Escape and return focus; their scrollable body is focusable.
- **Charts** are `role="img"` with a description in words and a data table behind a toggle.
- **Keyboard instead of a mouse everywhere there is a mouse**: moving blocks is `Alt+Shift+Up/Down` (drag and drop is not required), the block menu opens from the handle with Enter or Space, every shortcut is listed under `?` or `Mod+/` and can be rebound or switched off (`shortcuts` option).
- **Motion, contrast, touch**: `prefers-reduced-motion` stops animation, `forced-colors` rules exist for the editor's own controls and panels (not for charts or the rendered document, and not tested in a forced-colors environment), the default palette meets contrast in light and dark (axe checks it on the settled state), touch targets are at least 24 px.
- **Direction**: each block of text takes the direction of its own script (`unicode-bidi: plaintext` on the rendered blocks, `dir="auto"` on editable fields). That is the only right-to-left support: see the limits.

## Naming and translating

The names above are interaction labels (`fieldParagraph`, `fieldListItem`, `fieldCell(row, column)`, `fieldHeaderCell(column)`, …) and the spoken selection text (`blockSelected`, `surfaceHint`): pass `interactionLabels` to translate them, and `messages` for the kind names ("Heading", "Divider") and the notice. See [INTEGRATION.md](INTEGRATION.md#languages-and-formats).

## What is not known or not done

- **No real assistive technology was used.** Nothing here was tried with NVDA, JAWS, VoiceOver, TalkBack or Narrator. The ARIA is checked by axe and follows the patterns in ARIA 1.2, which is not the same as being pleasant to use. Someone who uses a screen reader daily should walk the editor before it is relied on.
- **No real input method.** The composition test drives Chromium's input-method entry points through the DevTools protocol. Bopomofo (Zhuyin), Japanese, Korean and mobile keyboards were **not** tested; their candidate windows and reconversion behave differently in each browser.
- **One browser engine.** Everything automated runs in Chromium. Firefox and Safari were not run (focus, selection and composition events differ).
- **Only the interactive `ReportEditor` is covered.** The classic mode (`interaction={false}`), the `<super-editor mode="edit">` element (which loads the classic editor, see [INTEGRATION.md](INTEGRATION.md#web-component-and-other-frameworks)), the Word-style panels (find and replace, history, proposal review) and the demo's own side panels are **not** part of the axe states above.
- **Right-to-left is text only.** Text direction is automatic, but the interface is not mirrored: the block gutter, toolbars and list markers stay where they are for left-to-right, and `dir="rtl"` on the page is not tested.
- **Colour is checked in the default theme only.** A host that overrides `--se-*` tokens owns its own contrast.
- **No conformance statement.** There is no VPAT, no WCAG conformance claim and no accessibility statement for the product; those need an audit by people, and the owner decides when.
- **Selection announcements assume a polite live region is spoken.** Some screen readers drop a live region that changes while focus is moving; the selection also moves nothing but the highlight, so the focus stays on the surface.

## For hosts

- Give the page a `main` landmark and a skip link; the library does not add landmarks of its own around the editor (`article` for the document, `group` for the surface).
- Keep `aria-label` text of fields in the page's language (`interactionLabels`).
- If you replace the toast stack (`onFeedback`), keep a live region: a success message or a refused edit that is only drawn is invisible to a screen reader.
- Run axe on your own page; `e2e/a11y.e2e.ts` is a template for the states worth checking.
