import type { ReactNode } from 'react';
import type { InteractionParts } from '@super-solution/editor-react';

/** `ReportEditor` is a composition: each part of the interaction layer is a prop that can be switched off and replaced by the host. Everything is on by default. */
export type Parts = InteractionParts & { readOnly: boolean };
export const DEFAULT_PARTS: Parts = { readOnly: false };

const PARTS: readonly [keyof InteractionParts, string, string][] = [
  ['gutter', 'Block gutter', 'The + button and the drag handle beside a block.'],
  ['hoverOutline', 'Hover outline', 'The outline around the block under the pointer.'],
  ['selectionOverlay', 'Selection overlay', 'The highlight over selected blocks.'],
  ['dropIndicator', 'Drop indicator', 'The line that shows where a dragged block lands.'],
  ['slashMenu', 'Slash menu', 'Type / on an empty line to insert any block.'],
  ['formattingToolbar', 'Formatting toolbar', 'Bold, italic, links and highlight while text is selected.'],
  ['selectionToolbar', 'Selection toolbar', 'Actions for the selected blocks.'],
  ['blockMenu', 'Block menu', 'Turn into, duplicate, move and delete.'],
  ['linkEditor', 'Link editor', 'The popover for editing a link.'],
  ['chartEditor', 'Chart editor', 'Edit a chart\'s data and style in place.'],
  ['shortcutHelp', 'Shortcut help', 'The dialog behind Mod+/.'],
  ['conflictNotice', 'Conflict notice', 'Shown when someone else changed the block you are typing in.'],
];

export function PartsTab({ parts, onChange }: { parts: Parts; onChange(parts: Parts): void }): ReactNode {
  return <section className="se-panel" aria-label="Editor parts">
    <h2 className="se-panel-title">Editor parts</h2>
    <p className="tab-note">Everything is on by default. Switch a part off to see how the editor degrades, then replace it with your own.</p>
    <ul className="parts">
      <li><label><input type="checkbox" checked={parts.readOnly} onChange={(event) => onChange({ ...parts, readOnly: event.target.checked })} />
        <span><strong>Read-only</strong><small>People cannot edit. The agent still can, through the same API.</small></span></label></li>
      {PARTS.map(([key, label, detail]) => <li key={key}><label><input type="checkbox" checked={parts[key] !== false} onChange={(event) => onChange({ ...parts, [key]: event.target.checked })} /><span><strong>{label}</strong><small>{detail}</small></span></label></li>)}
    </ul>
  </section>;
}
