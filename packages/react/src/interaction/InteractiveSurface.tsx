import type { ReactNode } from 'react';
import type { Interaction, SurfaceOptions } from '@super-solution/editor-ui';
import { BlockActionMenu } from './BlockActionMenu.js';
import { ChartEditor, ShortcutHelp } from './Dialogs.js';
import { BlockGutter, BlockOutline, DropIndicator, SelectionOverlay } from './Gutter.js';
import { ConflictNotice, FeedbackBar } from './Notices.js';
import { SlashMenu } from './SlashMenu.js';
import { FormattingToolbar, LinkEditor, SelectionToolbar, UrlPrompt } from './Toolbars.js';
import { InteractionContext, LabelsContext, SurfaceContext, useInteraction } from './context.js';
import { useSurfaceBinding } from './hooks.js';
import { mergeLabels } from './labels.js';
import type { InteractionLabels } from './labels.js';

/** Which parts of the interaction layer a surface shows. Everything defaults to on; switch off what the host replaces. */
export type InteractionParts = {
  gutter?: boolean; hoverOutline?: boolean; selectionOverlay?: boolean; dropIndicator?: boolean; slashMenu?: boolean; formattingToolbar?: boolean; selectionToolbar?: boolean;
  blockMenu?: boolean; linkEditor?: boolean; shortcutHelp?: boolean; chartEditor?: boolean; conflictNotice?: boolean;
  /** The built-in transient message bar. Turn off when the host renders its own toasts from `onFeedback`. */
  feedback?: boolean;
};
export type InteractiveSurfaceProps = InteractionParts & {
  interaction?: Interaction;
  children?: ReactNode;
  className?: string;
  labels?: Partial<InteractionLabels>;
  /** Pointer and layout tuning (gutter width, long-press time, drag threshold, drop options). */
  surface?: SurfaceOptions;
};

/**
 * Wraps a rendered document with pointer, keyboard and clipboard handling, and mounts the overlay components (gutter, hover outline,
 * selection, drop indicator, menus and toolbars). The children are the document view itself, for example `<ReportView />`.
 * Every overlay is also exported on its own, for hosts that compose their own surface.
 */
export function InteractiveSurface(props: InteractiveSurfaceProps): ReactNode {
  const interaction = useInteraction(props.interaction);
  const { ref, binding } = useSurfaceBinding(interaction, props.surface);
  const labels = mergeLabels(props.labels);
  const on = (flag: boolean | undefined): boolean => flag !== false;
  return <InteractionContext.Provider value={interaction}><LabelsContext.Provider value={labels}><SurfaceContext.Provider value={binding}>
    <div ref={ref} className={`se-surface${props.className ? ` ${props.className}` : ''}`} tabIndex={0} role="group" aria-label={labels.surface}>
      {on(props.conflictNotice) ? <ConflictNotice /> : null}
      {props.children}
      {binding ? <div className="se-overlays">
        {on(props.selectionOverlay) ? <SelectionOverlay /> : null}
        {on(props.hoverOutline) ? <BlockOutline /> : null}
        {on(props.dropIndicator) ? <DropIndicator /> : null}
        {on(props.gutter) ? <BlockGutter {...(props.surface?.gutterWidth === undefined ? {} : { width: props.surface.gutterWidth })} /> : null}
        {on(props.slashMenu) ? <SlashMenu /> : null}
        {on(props.formattingToolbar) ? <FormattingToolbar /> : null}
        {on(props.linkEditor) ? <LinkEditor /> : null}
        {on(props.slashMenu) ? <UrlPrompt /> : null}
        {on(props.selectionToolbar) ? <SelectionToolbar /> : null}
        {on(props.blockMenu) ? <BlockActionMenu /> : null}
        {on(props.chartEditor) ? <ChartEditor /> : null}
        {on(props.shortcutHelp) ? <ShortcutHelp /> : null}
      </div> : null}
      {on(props.feedback) ? <FeedbackBar /> : null}
    </div>
  </SurfaceContext.Provider></LabelsContext.Provider></InteractionContext.Provider>;
}
