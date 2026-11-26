<!--
  <super-editor> in a Vue 3 single-file component (script setup, TypeScript).

  Setup, once, in vite.config.ts:
    vue({ template: { compilerOptions: { isCustomElement: (tag) => tag === 'super-editor' } } })
  and once in main.ts:
    import '@supersolutions/super-editor-ui/styles.css';

  Read this first: mode="edit" is the BASIC editor (a plain-text textarea per block, an Edit button, a small toolbar), not the
  interactive one from `ReportEditor` in @supersolutions/super-editor-react (no "/" menu, block selection, keyboard navigation between
  blocks or rich paste). The element marks itself with data-editor="basic" while in edit mode and warns once in the console.
  Use mode="view" (the default) for a read-only document, which is fully rendered.

  This file is not compiled by this repository's tests (it has no Vue dependency). It uses only what tests/element.test.ts covers:
  the `mode` and `theme` attributes, the `load()` method, and the `change` and `error` events. tests/examples-framework.test.ts
  checks that every attribute and event named here is one the element documents.
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { defineSuperEditor, type SuperEditorChangeDetail, type SuperEditorElement, type SuperEditorErrorDetail } from '@supersolutions/super-editor-element';

const props = defineProps<{ report: unknown; mode?: 'view' | 'edit'; theme?: 'light' | 'dark' | 'auto' | 'host' }>();
const emit = defineEmits<{ change: [detail: SuperEditorChangeDetail]; error: [message: string] }>();
const element = ref<SuperEditorElement | null>(null);

defineSuperEditor(); // registers <super-editor> once (safe to call again)

// The toolbar's <select>s fire native `change` events that bubble through the element: only the element's own event has a detail.
const onChange = (event: Event): void => { if (event.target === element.value) emit('change', (event as CustomEvent<SuperEditorChangeDetail>).detail); };
const onError = (event: Event): void => emit('error', (event as CustomEvent<SuperEditorErrorDetail>).detail.message);

onMounted(() => {
  element.value?.addEventListener('change', onChange);
  element.value?.addEventListener('error', onError);
  element.value?.load(props.report);
});
onBeforeUnmount(() => {
  element.value?.removeEventListener('change', onChange);
  element.value?.removeEventListener('error', onError);
});
// A new document object from the parent replaces the loaded one (an invalid one is refused and raises `error`).
watch(() => props.report, (next) => { element.value?.load(next); });
</script>

<template>
  <super-editor ref="element" :mode="props.mode ?? 'view'" :theme="props.theme ?? 'host'" />
</template>
