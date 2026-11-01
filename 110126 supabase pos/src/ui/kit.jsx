import { useCallback, useEffect, useId, useRef, useState } from 'react';

/** Load something once (and again on demand). Returns { data, error, loading, reload }. */
export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const counter = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++counter.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fnRef.current();
      if (mine === counter.current) setState({ data, error: null, loading: false });
    } catch (e) {
      if (mine === counter.current) setState({ data: null, error: e.message || String(e), loading: false });
    }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, deps);
  return { ...state, reload };
}

export function Loading({ label = 'Loading…' }) {
  return <div className="empty" role="status">{label}</div>;
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="notice bad" role="alert">
      <div>{error}</div>
      {onRetry && <button className="btn small secondary" style={{ marginTop: '.5rem' }} onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Field({ label, hint, children, id }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

/** A small "i" that explains a number. Works with hover, keyboard focus and tap. */
export function Tip({ text }) {
  const id = useId();
  return (
    <span className="tip">
      <button type="button" className="info" aria-label="What does this mean?" aria-describedby={id}>i</button>
      <span className="bubble" role="tooltip" id={id}>{text}</span>
    </span>
  );
}

export function Badge({ tone, children }) {
  return <span className={`badge ${tone || ''}`}>{children}</span>;
}

/** A modal dialog: closes with Escape, keeps focus inside, returns focus afterwards. */
export function Dialog({ title, onClose, children, actions, wide }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const node = ref.current;
    const focusable = () => node.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    (focusable()[0] || node).focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); }
      if (e.key === 'Tab') {
        const list = [...focusable()].filter((el) => !el.disabled);
        if (!list.length) return;
        const first = list[0]; const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus?.(); };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1} style={wide ? { maxWidth: 680 } : undefined}>
        <div className="row between"><h2>{title}</h2><button className="btn ghost small no-print" onClick={onClose} aria-label="Close">✕</button></div>
        <div style={{ marginTop: '.75rem' }}>{children}</div>
        {actions && <div className="actions no-print">{actions}</div>}
      </div>
    </div>
  );
}

/** Ask "are you sure?" and optionally for a reason. */
export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', danger, askReason, onConfirm, onClose }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    if (askReason && !reason.trim()) { setError('Please write a reason.'); return; }
    setBusy(true); setError('');
    try { await onConfirm(reason.trim()); onClose(); } catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <Dialog title={title} onClose={onClose} actions={<>
      <button className="btn secondary" onClick={onClose} disabled={busy}>Cancel</button>
      <button className={`btn ${danger ? 'danger' : ''}`} onClick={go} disabled={busy}>{busy ? 'Working…' : confirmLabel}</button>
    </>}>
      <p>{message}</p>
      {askReason && <Field label="Reason" id="reason"><input id="reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
      {error && <div className="notice bad" role="alert">{error}</div>}
    </Dialog>
  );
}

export function PageHead({ title, children }) {
  return <div className="page-head"><h1>{title}</h1><div className="row">{children}</div></div>;
}

/** Download rows as a spreadsheet-friendly CSV file. Cells starting with = + - @ are neutralised (formula injection). */
export function downloadCsv(filename, header, rows) {
  const esc = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
