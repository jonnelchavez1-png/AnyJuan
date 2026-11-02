// Printing that prints ONLY what you give it (a receipt, a report), never the whole screen.
// It builds a small hidden page, puts the content in it and prints that page.

/** Paper sizes the receipt can use. width is in millimetres; "a4" prints a normal sheet with a narrow receipt on it. */
export const PAPERS = {
  '58': { label: '58 mm roll (small thermal)', css: '@page { size: 58mm auto; margin: 2mm; } body { width: 54mm; }' },
  '80': { label: '80 mm roll (standard thermal)', css: '@page { size: 80mm auto; margin: 3mm; } body { width: 74mm; }' },
  a4: { label: 'A4 / Letter sheet', css: '@page { margin: 15mm; } body { width: 100mm; margin: 0 auto; }' },
};

const BASE_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; color: #000; background: #fff; font: 12px/1.35 ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; }
  h1, h2, h3 { margin: 0 0 4px; text-align: center; }
  .receipt { padding: 0; }
  .line { display: flex; justify-content: space-between; gap: 6px; }
  .center { text-align: center; white-space: pre-line; }
  hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 2px 4px; border-bottom: 1px solid #999; } .right { text-align: right; }
`;

/**
 * @param {string} html   markup to print (it comes from our own screens, already escaped by React)
 * @param {{paper?: string, css?: string, title?: string}} [opts]
 */
export function printHtml(html, { paper = '80', css = '', title = 'Print' } = {}) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const paperCss = css ? '' : (PAPERS[paper] || PAPERS['80']).css;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/[<>&]/g, '')}</title><style>${BASE_CSS}${paperCss}${css}</style></head><body>${html}</body></html>`);
  doc.close();
  const go = () => {
    try { frame.contentWindow.focus(); frame.contentWindow.print(); } finally { setTimeout(() => frame.remove(), 2000); }
  };
  setTimeout(go, 150);
  return frame;
}

/** Remember a small per-device choice (such as the paper size). Never fails if storage is blocked. */
export function remember(key, value) {
  try { if (value === undefined) return window.localStorage.getItem(key); window.localStorage.setItem(key, value); } catch { /* blocked: fine */ }
  return null;
}
