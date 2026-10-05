import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApplyResult } from '@super-solution/editor-core';
import type { Labels, PartialLabels } from '@super-solution/editor-ui';
import { defaultLabels } from '@super-solution/editor-ui';
import { LabelsContext, useLabels } from '../render/context.js';
import { OverlayPortal, usePortalSetting } from '../portal.js';
import type { PortalContainer } from '../portal.js';

export type ToastTone = 'success' | 'error' | 'info' | 'warning' | 'conflict';
export type ToastAction = { label: string; onClick: () => void };
export type ToastInput = {
  tone?: ToastTone;
  title?: string;
  message: string;
  /** Milliseconds before it dismisses itself. Errors and conflicts stay until dismissed unless you set this. */
  duration?: number;
  action?: ToastAction;
  /** A stable key: a toast with the same key replaces the previous one instead of stacking. */
  key?: string;
};
export type Toast = ToastInput & { id: string; tone: ToastTone };
export type ToastApi = {
  toasts: readonly Toast[];
  show(toast: ToastInput): string;
  success(message: string, options?: Omit<ToastInput, 'message' | 'tone'>): string;
  error(message: string, options?: Omit<ToastInput, 'message' | 'tone'>): string;
  info(message: string, options?: Omit<ToastInput, 'message' | 'tone'>): string;
  warning(message: string, options?: Omit<ToastInput, 'message' | 'tone'>): string;
  /** "This document changed" with a Reload action. */
  conflict(options: { onReload: () => void; message?: string }): string;
  /** Turns a failed `editor.apply` into the right toast (conflict, or the first issue with its hint). Returns null on success. */
  notifyApplyResult(result: ApplyResult, options?: { onReload?: () => void; successMessage?: string }): string | null;
  dismiss(id: string): void;
  clear(): void;
};
const ToastContext = createContext<ToastApi | null>(null);

/** The toast a failed apply result should produce, or null when it succeeded. Pure, so hosts can reuse it. */
export function toastFromApplyResult(result: ApplyResult, labels: Labels = defaultLabels, options: { onReload?: (() => void) | undefined } = {}): ToastInput | null {
  if (result.ok) return null;
  const conflict = result.issues.find((issue) => issue.code === 'conflict');
  if (conflict) return { tone: 'conflict', key: 'conflict', title: labels.toasts.conflictTitle, message: labels.toasts.conflictBody, ...(options.onReload ? { action: { label: labels.toasts.reload, onClick: options.onReload } } : {}) };
  const first = result.issues[0];
  const message = first ? `${first.message}${first.hint ? ` ${first.hint}` : ''}` : labels.toasts.error;
  return { tone: 'error', title: labels.toasts.error, message };
}

let counter = 0;
export type ToastProviderProps = {
  children?: ReactNode;
  labels?: PartialLabels;
  /** Most toasts visible at once; the oldest is dropped. Default 4. */
  max?: number;
  /** Default lifetime of success, info and warning toasts in ms. Default 5000. */
  duration?: number;
  /** Where the stack sits. Default `bottom-right`. */
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'bottom-center';
  /**
   * Mount the stack under another element (default `document.body`), so an ancestor with a `transform`, `filter` or `container-type`
   * cannot trap its `position: fixed` box; `false` keeps it in place. Left out, a stack inside `ReportEditor` follows the editor's
   * `portalContainer` and a stand-alone `ToastProvider` renders where you put it.
   */
  portalContainer?: PortalContainer;
};

/** Provides `useToasts()` and renders the toast stack. Success and info are polite; errors and conflicts are alerts. */
export function ToastProvider({ children, labels: override, max = 4, duration = 5_000, position = 'bottom-right', portalContainer }: ToastProviderProps): ReactNode {
  const labels = useLabels(override);
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const dismiss = useCallback((id: string) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const show = useCallback((input: ToastInput): string => {
    const id = `toast-${++counter}`;
    const toast: Toast = { ...input, id, tone: input.tone ?? 'info' };
    setToasts((current) => [...current.filter((entry) => input.key === undefined || entry.key !== input.key), toast].slice(-max));
    return id;
  }, [max]);
  const api = useMemo<ToastApi>(() => ({
    toasts, show, dismiss, clear: () => setToasts([]),
    success: (message, options) => show({ ...options, message, tone: 'success' }),
    error: (message, options) => show({ ...options, message, tone: 'error' }),
    info: (message, options) => show({ ...options, message, tone: 'info' }),
    warning: (message, options) => show({ ...options, message, tone: 'warning' }),
    conflict: ({ onReload, message }) => show({ tone: 'conflict', key: 'conflict', title: labels.toasts.conflictTitle, message: message ?? labels.toasts.conflictBody, action: { label: labels.toasts.reload, onClick: onReload } }),
    notifyApplyResult(result, options) {
      const input = toastFromApplyResult(result, labels, { onReload: options?.onReload });
      if (!input) return options?.successMessage ? show({ tone: 'success', message: options.successMessage }) : null;
      return show(input);
    },
  }), [toasts, show, dismiss, labels]);
  return <ToastContext.Provider value={api}>
    {children}
    <ToastViewport toasts={toasts} onDismiss={dismiss} defaultDuration={duration} position={position} labels={labels} portalContainer={portalContainer} />
  </ToastContext.Provider>;
}

/** Toast actions for the nearest `ToastProvider`. Outside a provider the calls are no-ops, so components can call it unconditionally. */
export function useToasts(): ToastApi {
  const api = useContext(ToastContext);
  return useMemo(() => api ?? {
    toasts: [], show: () => '', success: () => '', error: () => '', info: () => '', warning: () => '', conflict: () => '', notifyApplyResult: () => null, dismiss: () => undefined, clear: () => undefined,
  }, [api]);
}

function ToastItem({ toast, onDismiss, defaultDuration, labels }: { toast: Toast; onDismiss: (id: string) => void; defaultDuration: number; labels: Labels }): ReactNode {
  const [paused, setPaused] = useState(false);
  const sticky = toast.duration === undefined && (toast.tone === 'error' || toast.tone === 'conflict');
  const remaining = useRef(toast.duration ?? defaultDuration);
  useEffect(() => {
    if (sticky || paused || remaining.current <= 0) return;
    const started = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => { clearTimeout(timer); remaining.current -= Date.now() - started; };
  }, [paused, sticky, toast.id, onDismiss]);
  const urgent = toast.tone === 'error' || toast.tone === 'conflict';
  return <li className="se-toast" data-tone={toast.tone} role={urgent ? 'alert' : 'status'}
    onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}
    onKeyDown={(event) => { if (event.key === 'Escape') onDismiss(toast.id); }}>
    <span className="se-toast-bar" aria-hidden="true" />
    <div className="se-toast-body">
      {toast.title ? <strong className="se-toast-title">{toast.title}</strong> : null}
      <span className="se-toast-message">{toast.message}</span>
    </div>
    {toast.action ? <button type="button" className="se-button" data-primary={toast.tone === 'conflict' || undefined} onClick={() => { toast.action!.onClick(); onDismiss(toast.id); }}>{toast.action.label}</button> : null}
    <button type="button" className="se-toast-close" aria-label={labels.toasts.dismiss} onClick={() => onDismiss(toast.id)}>×</button>
  </li>;
}

/** The visible stack. `ToastProvider` renders one; render your own only when you manage toast state yourself. */
export function ToastViewport({ toasts, onDismiss, defaultDuration = 5_000, position = 'bottom-right', labels, portalContainer }: { toasts: readonly Toast[]; onDismiss: (id: string) => void; defaultDuration?: number; position?: ToastProviderProps['position']; labels?: Labels; portalContainer?: PortalContainer }): ReactNode {
  const inherited = useContext(LabelsContext), resolved = labels ?? inherited, setting = usePortalSetting();
  const stack = <section className="se-toasts" data-position={position} role="region" aria-label={resolved.toasts.region}>
    <ul>{toasts.map((toast) => <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} defaultDuration={defaultDuration} labels={resolved} />)}</ul>
  </section>;
  return portalContainer === undefined && !setting ? stack : <OverlayPortal container={portalContainer}>{stack}</OverlayPortal>;
}
