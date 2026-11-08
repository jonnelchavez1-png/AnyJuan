// Printing that prints ONLY what you give it (a receipt, a report), never the whole screen.
// It builds a small hidden page, puts the content in it and prints that page.

/**
 * Paper sizes the receipt can use (millimetres).
 * Roll paper (thermal receipt printers): the page is exactly the paper width and exactly as TALL as the receipt, so every item
 * fits on one strip and no blank paper is fed. "body" is the printable width: most 80 mm printers print 72 mm, most 58 mm print 48 mm.
 * The receipt is centred on the paper, so a printer that trims the edges unevenly still looks balanced.
 */
export const PAPERS = {
  '58': { label: '58 mm roll (small thermal)', roll: true, page: 58, body: 48, font: 11 },
  '80': { label: '80 mm roll (standard thermal)', roll: true, page: 80, body: 72, font: 12 },
  a4: { label: 'A4 / Letter sheet', roll: false },
};

/** The page rules for a paper. For a roll, heightMm is the measured height of the receipt. */
export function paperCss(paper, heightMm) {
  const p = PAPERS[paper] || PAPERS['80'];
  // margin 0 on the page means the browser has no room to print its own title, date and web address; the space is made inside the page instead
  if (!p.roll) return '@page { margin: 0; } html { width: auto; } body { width: 100mm; margin: 0 auto; padding: 15mm 0; font-size: 13px; }';
  const h = heightMm ? `${heightMm}mm` : '200mm';
  return `@page { size: ${p.page}mm ${h}; margin: 0; } html { width: auto; } body { width: ${p.body}mm; margin: 0 auto; padding: 3mm 0 8mm; font-size: ${p.font}px; }`;
}

/** Height (mm) a roll receipt needs, from its on-screen height in pixels. A little spare so the last line is never cut. */
export function heightMmFor(px) { return Math.ceil((px * 25.4) / 96) + 2; }

const BASE_CSS = `
  * { box-sizing: border-box; }
  html, body { height: auto; }
  body { margin: 0; color: #000; background: #fff; font: 12px/1.35 ui-monospace, "SFMono-Regular", Menlo, Consolas, "Courier New", monospace; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  h1, h2, h3 { margin: 0 0 4px; text-align: center; overflow-wrap: anywhere; }
  .receipt { padding: 0; max-width: none; width: 100%; margin: 0; font-size: inherit; }
  .receipt > div { overflow-wrap: anywhere; }
  .line { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }
  .line > span:first-child, .line > strong:first-child { min-width: 0; overflow-wrap: anywhere; }
  .line > :last-child { white-space: nowrap; text-align: right; }
  .center { text-align: center; white-space: pre-line; }
  .small { font-size: .9em; }
  hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 2px 4px; border-bottom: 1px solid #999; } .right { text-align: right; }
`;

/**
 * @param {string} html   markup to print (it comes from our own screens, already escaped by React)
 * @param {{paper?: string, css?: string, title?: string}} [opts]
 */
export function printHtml(html, { paper = '80', css = '', title = 'Print' } = {}) {
  const frame = document.createElement('iframe');
  const p = PAPERS[paper] || PAPERS['80'];
  const roll = !css && p.roll;
  frame.setAttribute('aria-hidden', 'true');
  // the hidden page is as wide as the paper while we measure it, so the receipt lays out exactly as it will print
  frame.style.cssText = `position:fixed;right:0;bottom:0;width:${roll ? p.page + 'mm' : '0'};height:0;border:0;`;
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/[<>&]/g, '')}</title><style>${BASE_CSS}</style><style id="paper">${css || paperCss(paper)}</style></head><body>${html}</body></html>`);
  doc.close();
  const go = () => {
    try {
      // a roll page must be exactly as tall as the receipt (a page of "auto" height is not understood by browsers)
      if (roll) doc.getElementById('paper').textContent = paperCss(paper, heightMmFor(doc.body.getBoundingClientRect().height));
      frame.contentWindow.focus(); frame.contentWindow.print();
    } finally { setTimeout(() => frame.remove(), 2000); }
  };
  setTimeout(go, 150);
  return frame;
}

/** Remember a small per-device choice (such as the paper size). Never fails if storage is blocked. */
export function remember(key, value) {
  try { if (value === undefined) return window.localStorage.getItem(key); window.localStorage.setItem(key, value); } catch { /* blocked: fine */ }
  return null;
}
