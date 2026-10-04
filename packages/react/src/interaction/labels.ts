/** Every string the interaction components show. Pass `labels` to translate or reword; unspecified entries keep the English default. */
export type InteractionLabels = {
  surface: string;
  placeholderParagraph: string;
  placeholderHeading: string;
  placeholderListItem: string;
  placeholderToggle: string;
  placeholderSection: string;
  placeholderQuote: string;
  placeholderCallout: string;
  placeholderCode: string;
  placeholderCell: string;
  codeLanguage: string;
  addBlock: string;
  dragHandle: string;
  slashMenu: string;
  slashEmpty: string;
  slashHeading: string;
  formattingToolbar: string;
  bold: string; italic: string; underline: string; strike: string; code: string; highlight: string; link: string; clearHighlight: string;
  highlightColor: (color: string) => string;
  selectionToolbar: string;
  blocksSelected: (count: number) => string;
  duplicate: string; delete: string; moveUp: string; moveDown: string; copy: string; clearSelection: string; turnInto: string;
  blockMenu: string;
  linkDialog: string; linkUrl: string; linkApply: string; linkRemove: string; cancel: string;
  urlDialog: string; urlInsert: string;
  chartEditor: string; chartTitle: string; chartKind: string; chartCaption: string; chartSource: string; chartStacked: string; chartHorizontal: string; done: string;
  shortcutHelp: string; shortcutHelpClose: string; shortcutHelpHint: string; markdownShortcuts: string;
  conflictTitle: string; conflictKeepMine: string; conflictUseLatest: string; conflictDeleted: string;
  readOnly: string;
  toggleTodo: (item: string) => string;
  toggleOpen: string; toggleClose: string;
  tableToolbar: string; addRow: string; addColumn: string; removeRow: string; removeColumn: string; alignLeft: string; alignCenter: string; alignRight: string;
  undo: string; redo: string; help: string; documentFont: string; documentPage: string;
  dismiss: string;
};
export const defaultInteractionLabels: InteractionLabels = {
  surface: 'Document editor',
  placeholderParagraph: "Type '/' for commands",
  placeholderHeading: 'Heading',
  placeholderListItem: 'List item',
  placeholderToggle: 'Toggle title',
  placeholderSection: 'Section title',
  placeholderQuote: 'Quote',
  placeholderCallout: 'Callout',
  placeholderCode: 'Code',
  placeholderCell: '',
  codeLanguage: 'Code language',
  addBlock: 'Add a block below',
  dragHandle: 'Drag to move, or open the block menu',
  slashMenu: 'Insert a block',
  slashEmpty: 'No matching blocks',
  slashHeading: 'Blocks',
  formattingToolbar: 'Text formatting',
  bold: 'Bold', italic: 'Italic', underline: 'Underline', strike: 'Strikethrough', code: 'Code', highlight: 'Highlight', link: 'Link', clearHighlight: 'Remove highlight',
  highlightColor: (color) => `Highlight ${color}`,
  selectionToolbar: 'Selected blocks',
  blocksSelected: (count) => `${count} block${count === 1 ? '' : 's'} selected`,
  duplicate: 'Duplicate', delete: 'Delete', moveUp: 'Move up', moveDown: 'Move down', copy: 'Copy as markdown', clearSelection: 'Clear selection', turnInto: 'Turn into',
  blockMenu: 'Block actions',
  linkDialog: 'Edit link', linkUrl: 'Link address (https)', linkApply: 'Apply', linkRemove: 'Remove link', cancel: 'Cancel',
  urlDialog: 'Add address', urlInsert: 'Insert',
  chartEditor: 'Chart settings', chartTitle: 'Title', chartKind: 'Chart type', chartCaption: 'Caption', chartSource: 'Source', chartStacked: 'Stacked', chartHorizontal: 'Horizontal bars', done: 'Done',
  shortcutHelp: 'Keyboard shortcuts', shortcutHelpClose: 'Close shortcuts', shortcutHelpHint: 'Press Esc to close', markdownShortcuts: 'Markdown shortcuts',
  conflictTitle: 'This block was changed elsewhere', conflictKeepMine: 'Keep my version', conflictUseLatest: 'Use the latest', conflictDeleted: 'The block you were editing was deleted.',
  readOnly: 'Read only',
  toggleTodo: (item) => item ? `Mark "${item}" as done` : 'Mark as done',
  toggleOpen: 'Expand', toggleClose: 'Collapse',
  tableToolbar: 'Table', addRow: 'Add row', addColumn: 'Add column', removeRow: 'Delete row', removeColumn: 'Delete column', alignLeft: 'Align left', alignCenter: 'Align center', alignRight: 'Align right',
  undo: 'Undo', redo: 'Redo', help: 'Keyboard shortcuts', documentFont: 'Document font', documentPage: 'Page format',
  dismiss: 'Dismiss',
};
export function mergeInteractionLabels(overrides?: Partial<InteractionLabels>): InteractionLabels { return overrides ? { ...defaultInteractionLabels, ...overrides } : defaultInteractionLabels; }
