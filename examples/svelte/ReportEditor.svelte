<!--
  <super-editor> in a Svelte 5 component (TypeScript).

  Setup, once, in your root layout or entry:
    import '@supersolutions/super-editor-ui/styles.css';
  Svelte needs no compiler option for custom elements. Pass the report as `report={…}` (a prop named `document` would shadow the global).

  Read this first: mode="edit" is the BASIC editor (a plain-text textarea per block, an Edit button, a small toolbar), not the
  interactive one from `ReportEditor` in @supersolutions/super-editor-react (no "/" menu, block selection, keyboard navigation between
  blocks or rich paste). The element marks itself with data-editor="basic" while in edit mode and warns once in the console.
  Use mode="view" (the default) for a read-only document, which is fully rendered.

  This file is not compiled by this repository's tests (it has no Svelte dependency). It uses only what tests/element.test.ts covers:
  the `mode` and `theme` attributes, the `load()` method, and the `change` and `error` events. tests/examples-framework.test.ts
  checks that every attribute and event named here is one the element documents.
-->
<script lang="ts">
  import { defineSuperEditor, type SuperEditorChangeDetail, type SuperEditorElement, type SuperEditorErrorDetail } from '@supersolutions/super-editor-element';

  let { report, mode = 'view', theme = 'host', onchange, onerror }: {
    report: unknown; mode?: 'view' | 'edit'; theme?: 'light' | 'dark' | 'auto' | 'host';
    onchange?: (detail: SuperEditorChangeDetail) => void; onerror?: (message: string) => void;
  } = $props();
  let element: SuperEditorElement | undefined = $state();

  defineSuperEditor(); // registers <super-editor> once (safe to call again)

  // Load whenever the element exists or the parent passes a new document (an invalid one is refused and raises `error`).
  $effect(() => { element?.load(report); });
</script>

<super-editor
  bind:this={element}
  {mode}
  {theme}
  onchange={(event: Event) => { if (event.target === element) onchange?.((event as CustomEvent<SuperEditorChangeDetail>).detail); }}
  onerror={(event: Event) => onerror?.((event as CustomEvent<SuperEditorErrorDetail>).detail.message)}
></super-editor>
