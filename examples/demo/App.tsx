import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Density, ThemeName } from '@super-solution/editor-ui';
import { ToastProvider } from '@super-solution/editor-react';
import { DocView, type PanelTab } from './DocView.js';
import { emptyPage, startPages, templatePage, type Doc } from './documents.js';
import { DEFAULT_PARTS, type Parts } from './PartsTab.js';
import { Rail } from './Rail.js';
import { Icon, Segmented, type Option } from './ui.js';

const THEMES: readonly Option<ThemeName>[] = [{ value: 'light', label: 'Light', icon: 'sun' }, { value: 'dark', label: 'Dark', icon: 'moon' }, { value: 'auto', label: 'Auto', icon: 'auto' }];
const DENSITIES: readonly Option<Density>[] = [{ value: 'comfortable', label: 'Comfortable', icon: 'roomy' }, { value: 'compact', label: 'Compact', icon: 'tight' }];

/**
 * The workspace: pages on the left, the interactive editor in the middle, History / Agent / Sources on the right. App owns what outlives a
 * page (the page list, theme, density, panel tab, editor parts); `DocView` owns what belongs to one page and is remounted when it changes.
 */
export function App(): ReactNode {
  const [docs, setDocs] = useState<Doc[]>(startPages);
  const [activeId, setActiveId] = useState(() => docs[0]!.id);
  const [theme, setTheme] = useState<ThemeName>('auto');
  const [density, setDensity] = useState<Density>('comfortable');
  const [tab, setTab] = useState<PanelTab>('agent');
  const [parts, setParts] = useState<Parts>(DEFAULT_PARTS);
  const [drawer, setDrawer] = useState<'rail' | 'panel' | null>(null);
  const [center, setCenter] = useState<HTMLElement | null>(null);
  const active = docs.find((doc) => doc.id === activeId) ?? docs[0]!;

  // The page chrome follows the editor's theme: the --se-* tokens are set on <html>, so every panel, the toasts and the body inherit them.
  useEffect(() => { document.documentElement.dataset.seTheme = theme; }, [theme]);
  useEffect(() => { document.title = `${active.name} · Super Editor`; }, [active.name]);
  useEffect(() => {
    if (!drawer) return;
    const close = (event: KeyboardEvent): void => { if (event.key === 'Escape') setDrawer(null); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [drawer]);

  const show = (page: Doc): void => { setDocs((previous) => [...previous, page]); setActiveId(page.id); setDrawer(null); };
  const toggle = (which: 'rail' | 'panel'): void => setDrawer(drawer === which ? null : which);

  return <ToastProvider position="bottom-center">
    <div className="app" data-drawer={drawer ?? undefined}>
      <a className="skip-link" href="#main">Skip to the document</a>
      <header className="bar">
        <button type="button" className="se-icon-button bar-toggle" aria-label="Pages and outline" aria-expanded={drawer === 'rail'} onClick={() => toggle('rail')}><Icon name="menu" /></button>
        <span className="brand">Super Editor</span><span className="bar-tag">workspace demo</span>
        <div className="bar-controls">
          <Segmented label="Theme" value={theme} options={THEMES} onChange={(value) => setTheme(value)} />
          <Segmented label="Density" value={density} options={DENSITIES} onChange={(value) => setDensity(value)} />
        </div>
        <button type="button" className="se-icon-button bar-toggle" aria-label="History, agent and sources" aria-expanded={drawer === 'panel'} onClick={() => toggle('panel')}><Icon name="panel" /></button>
      </header>
      <Rail docs={docs} active={active} scroller={center} open={drawer === 'rail'} onClose={() => setDrawer(null)}
        onOpen={(id) => { setActiveId(id); setDrawer(null); }} onTemplate={(kind) => show(templatePage(kind))} onEmpty={() => show(emptyPage())} />
      <DocView key={active.id} doc={active} theme={theme} density={density} parts={parts} onParts={setParts} tab={tab} onTab={setTab}
        panelOpen={drawer === 'panel'} onClosePanel={() => setDrawer(null)} centerRef={setCenter} />
      <button type="button" className="scrim" aria-label="Close the open panel" tabIndex={-1} onClick={() => setDrawer(null)} />
    </div>
  </ToastProvider>;
}
