import type { Interaction, ShortcutContext } from './interaction.js';
import type { ShortcutDefinition, ShortcutRegistry } from './shortcuts.js';
import type { TurnIntoTarget } from './convert.js';
import { fieldText } from './fields.js';

/** The default shortcut map. Every entry has a stable id so hosts can rebind or disable it: `shortcuts: { 'format.bold': ['Mod+Alt+B'], 'block.duplicate': null }`. */
const editing = (c: ShortcutContext): boolean => c.state.editing !== null;
const selecting = (c: ShortcutContext): boolean => c.state.editing === null && c.state.selection.ids.length > 0 && c.state.drag === null;
const acting = (c: ShortcutContext): boolean => editing(c) || selecting(c);
const slashOpen = (c: ShortcutContext): boolean => c.state.slash !== null;

export function registerDefaultShortcuts(interaction: Interaction, registry: ShortcutRegistry<ShortcutContext>): void {
  const add = (definition: ShortcutDefinition<ShortcutContext>): void => { registry.register(definition); };
  const turn = (id: string, keys: string, description: string, target: TurnIntoTarget): void => add({ id, keys: [keys], description, group: 'Blocks', when: acting, run: () => { interaction.commands.turnInto(target); } });

  // The slash menu captures navigation keys while it is open.
  add({ id: 'slash.next', keys: ['ArrowDown'], description: 'Next command', group: 'Slash menu', priority: 100, hidden: true, when: slashOpen, run: () => { interaction.slash.move(1); } });
  add({ id: 'slash.prev', keys: ['ArrowUp'], description: 'Previous command', group: 'Slash menu', priority: 100, hidden: true, when: slashOpen, run: () => { interaction.slash.move(-1); } });
  add({ id: 'slash.run', keys: ['Enter', 'Tab'], description: 'Insert the highlighted command', group: 'Slash menu', priority: 100, hidden: true, when: slashOpen, run: () => { interaction.slash.run(); } });
  add({ id: 'slash.close', keys: ['Escape'], description: 'Close the menu', group: 'Slash menu', priority: 100, hidden: true, when: slashOpen, run: () => { interaction.slash.close(); } });

  add({ id: 'text.bold', keys: ['Mod+B'], description: 'Bold', group: 'Text formatting', when: editing, run: () => { interaction.format.toggle('bold'); } });
  add({ id: 'text.italic', keys: ['Mod+I'], description: 'Italic', group: 'Text formatting', when: editing, run: () => { interaction.format.toggle('italic'); } });
  add({ id: 'text.underline', keys: ['Mod+U'], description: 'Underline', group: 'Text formatting', when: editing, run: () => { interaction.format.toggle('underline'); } });
  add({ id: 'text.strike', keys: ['Mod+Shift+S'], description: 'Strikethrough', group: 'Text formatting', when: editing, run: () => { interaction.format.toggle('strike'); } });
  add({ id: 'text.code', keys: ['Mod+E'], description: 'Inline code', group: 'Text formatting', when: editing, run: () => { interaction.format.toggle('code'); } });
  add({ id: 'text.highlight', keys: ['Mod+Shift+H'], description: 'Highlight', group: 'Text formatting', when: editing, run: () => { const marked = interaction.getState().textSelection?.highlight; interaction.format.highlight(marked ? null : 'yellow'); } });
  add({ id: 'text.link', keys: ['Mod+K'], description: 'Add or edit link', group: 'Text formatting', when: editing, run: () => { interaction.format.openLink(); } });

  turn('block.paragraph', 'Mod+Alt+0', 'Turn into text', 'paragraph');
  turn('block.heading1', 'Mod+Alt+1', 'Turn into heading 1', 'heading1');
  turn('block.heading2', 'Mod+Alt+2', 'Turn into heading 2', 'heading2');
  turn('block.heading3', 'Mod+Alt+3', 'Turn into heading 3', 'heading3');
  turn('block.number', 'Mod+Shift+7', 'Turn into numbered list', 'number');
  turn('block.bullet', 'Mod+Shift+8', 'Turn into bulleted list', 'bullet');
  turn('block.todo', 'Mod+Shift+9', 'Turn into to-do list', 'todo');
  turn('block.quote', 'Mod+Alt+Q', 'Turn into quote', 'quote');
  turn('block.code', 'Mod+Alt+C', 'Turn into code block', 'code');
  add({ id: 'block.duplicate', keys: ['Mod+D'], description: 'Duplicate block', group: 'Blocks', when: acting, run: () => { interaction.commands.duplicateBlocks(); } });
  add({ id: 'block.moveUp', keys: ['Alt+Shift+ArrowUp'], description: 'Move block up', group: 'Blocks', when: acting, run: () => { interaction.commands.moveStep('up'); } });
  add({ id: 'block.moveDown', keys: ['Alt+Shift+ArrowDown'], description: 'Move block down', group: 'Blocks', when: acting, run: () => { interaction.commands.moveStep('down'); } });
  add({ id: 'block.delete', keys: ['Backspace', 'Delete'], description: 'Delete selected blocks', group: 'Selection', when: selecting, run: () => { interaction.commands.deleteBlocks(); } });

  add({ id: 'selection.all', keys: ['Mod+A'], description: 'Select all blocks (press twice inside text)', group: 'Selection', run: () => {
    const caret = interaction.edit.caret();
    if (caret) {
      const content = interaction.edit.draftContent(caret.blockId);
      // The first press selects the text of the field natively; once it is all selected (or there is none), the next press selects the blocks.
      if (content && !(caret.start === 0 && caret.end === fieldText(content, caret.field).length)) return false;
    }
    interaction.selection.selectAll();
  } });
  add({ id: 'selection.escape', keys: ['Escape'], description: 'Clear selection or stop editing', group: 'Selection', run: () => interaction.escape() });
  add({ id: 'selection.up', keys: ['ArrowUp'], description: 'Select previous block', group: 'Selection', hidden: true, when: selecting, run: () => { interaction.selection.move(-1); } });
  add({ id: 'selection.down', keys: ['ArrowDown'], description: 'Select next block', group: 'Selection', hidden: true, when: selecting, run: () => { interaction.selection.move(1); } });
  add({ id: 'selection.extendUp', keys: ['Shift+ArrowUp'], description: 'Extend selection up', group: 'Selection', when: selecting, run: () => { interaction.selection.move(-1, true); } });
  add({ id: 'selection.extendDown', keys: ['Shift+ArrowDown'], description: 'Extend selection down', group: 'Selection', when: selecting, run: () => { interaction.selection.move(1, true); } });
  add({ id: 'selection.open', keys: ['Enter'], description: 'Edit the selected block', group: 'Selection', when: selecting, run: () => {
    const [id] = interaction.getState().selection.ids;
    const block = id ? interaction.editor.getSnapshot().blocks.find((entry) => entry.id === id) : undefined;
    if (!block) return false;
    if (block.content.type === 'chart') { interaction.openChartEditor(block.id); return; }
    return interaction.edit.start(block.id, { caret: 'end' }) ? undefined : false;
  } });

  add({ id: 'edit.enter', keys: ['Enter'], description: 'New block (splits at the caret)', group: 'Editing', when: editing, run: () => { interaction.edit.enter(); } });
  add({ id: 'edit.softBreak', keys: ['Shift+Enter'], description: 'New line inside the block', group: 'Editing', when: editing, run: () => { interaction.edit.softBreak(); } });
  add({ id: 'edit.backspace', keys: ['Backspace'], description: 'Merge or convert at the start of a block', group: 'Editing', hidden: true, when: editing, run: () => interaction.edit.backspace() });
  add({ id: 'edit.delete', keys: ['Delete'], description: 'Merge the next paragraph', group: 'Editing', hidden: true, when: editing, run: () => interaction.edit.deleteForward() });
  add({ id: 'edit.indent', keys: ['Tab'], description: 'Indent list item', group: 'Editing', when: editing, run: () => interaction.edit.indent(1) });
  add({ id: 'edit.outdent', keys: ['Shift+Tab'], description: 'Outdent list item', group: 'Editing', when: editing, run: () => interaction.edit.indent(-1) });
  add({ id: 'edit.up', keys: ['ArrowUp'], description: 'Move to the block above', group: 'Editing', hidden: true, when: editing, run: () => interaction.edit.navigate('up') });
  add({ id: 'edit.down', keys: ['ArrowDown'], description: 'Move to the block below', group: 'Editing', hidden: true, when: editing, run: () => interaction.edit.navigate('down') });
  add({ id: 'edit.left', keys: ['ArrowLeft'], description: 'Move to the previous block', group: 'Editing', hidden: true, when: editing, run: () => interaction.edit.navigate('left') });
  add({ id: 'edit.right', keys: ['ArrowRight'], description: 'Move to the next block', group: 'Editing', hidden: true, when: editing, run: () => interaction.edit.navigate('right') });

  add({ id: 'history.undo', keys: ['Mod+Z'], description: 'Undo', group: 'History', run: () => { interaction.commands.undo(); } });
  add({ id: 'history.redo', keys: ['Mod+Shift+Z', 'Mod+Y'], description: 'Redo', group: 'History', run: () => { interaction.commands.redo(); } });

  add({ id: 'help.toggle', keys: ['Mod+/'], description: 'Show keyboard shortcuts', group: 'General', run: () => { interaction.toggleHelp(); } });
  add({ id: 'help.question', keys: ['?'], description: 'Show keyboard shortcuts', group: 'General', hidden: true, when: (c) => !editing(c), run: () => { interaction.toggleHelp(); } });
}
