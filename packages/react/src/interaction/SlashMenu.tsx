import { useRef } from 'react';
import type { ReactNode } from 'react';
import { groupSlashItems } from '@super-solution/editor-ui';
import type { Interaction } from '@super-solution/editor-ui';
import { useBlockRect, useDocumentRevision, useInteraction, useInteractionState, useInteractionLabels } from './context.js';
import { keepFocus, useIsoLayoutEffect, useKeepInViewport } from './util.js';

/** DOM id of a slash option, for `aria-activedescendant` on the field that has focus. */
export const slashOptionId = (interaction: Interaction, itemId: string): string => `${interaction.id}-slash-${itemId}`;
export const slashListId = (interaction: Interaction): string => `${interaction.id}-slash`;

/** The "/" menu: a listbox of blocks, filtered as you type. Keyboard handling lives in the interaction layer (arrows, Enter, Tab, Esc). */
export function SlashMenu({ interaction: explicit }: { interaction?: Interaction }): ReactNode {
  const interaction = useInteraction(explicit), labels = useInteractionLabels();
  const state = useInteractionState(interaction, (current) => current.slash);
  useDocumentRevision(interaction);
  const rect = useBlockRect(state?.blockId ?? null);
  const ref = useRef<HTMLDivElement>(null);
  const shift = useKeepInViewport(ref, !!state);
  useIsoLayoutEffect(() => {
    if (!state) return;
    const active = ref.current?.querySelector('[aria-selected="true"]');
    (active as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
  }, [state?.activeIndex, state?.items]);
  if (!state || !rect) return null;
  const groups = groupSlashItems(state.items);
  let index = -1;
  return <div ref={ref} id={slashListId(interaction)} className="se-popup se-slash" data-se-popup role="listbox" aria-label={labels.slashMenu}
    style={{ left: rect.left, top: rect.bottom + 4, ...(shift ? { transform: `translateY(-${shift}px)` } : {}) }} onMouseDown={keepFocus}>
    {groups.length === 0 ? <div className="se-popup-empty" role="presentation">{labels.slashEmpty}</div> : groups.map((group) => <div role="group" aria-label={group.group} key={group.group + group.items[0]!.id}>
      <div className="se-popup-heading" role="presentation">{group.group}</div>
      {group.items.map((item) => {
        index++;
        const at = index;
        return <div key={item.id} id={slashOptionId(interaction, item.id)} role="option" aria-selected={at === state.activeIndex} className="se-slash-item" data-se-slash-item={item.id}
          onClick={() => interaction.slash.run(item)} onMouseMove={() => { if (interaction.getState().slash?.activeIndex !== at) interaction.slash.setActive(at); }}>
          <span className="se-slash-icon" aria-hidden="true">{item.icon}</span>
          <span className="se-slash-text"><span className="se-slash-label">{item.label}</span><span className="se-slash-description">{item.description}</span></span>
          {item.hint ? <kbd className="se-slash-hint" aria-hidden="true">{item.hint}</kbd> : null}
        </div>;
      })}
    </div>)}
  </div>;
}
