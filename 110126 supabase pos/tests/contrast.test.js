// Readability check: every text/background pair used in styles.css must meet WCAG AA (4.5:1 for text,
// 3:1 for large text and chart lines). The colours are read from the stylesheet itself, so editing the theme
// and breaking readability fails this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const vars = Object.fromEntries([...css.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]));
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const c = (v) => (v.startsWith('#') ? v : vars[v]);

const TEXT = [ // [text, background, label]
  ['ink', 'foam', 'body text on page'], ['ink', 'paper', 'text on cards'], ['ink-soft', 'paper', 'muted text on cards'], ['ink-soft', 'foam', 'muted text on page'],
  ['#ffffff', 'tide-strong', 'primary button'], ['#ffffff', 'deep', 'primary button hover'], ['tide-strong', 'paper', 'secondary button / links'], ['tide-strong', 'foam', 'link on page'],
  ['#ffffff', 'bad', 'danger button'], ['bad', 'paper', 'negative change on cards'], ['good', 'paper', 'positive change on cards'],
  ['#ffffff', 'trench', 'selected chip / range'], ['#ffffff', 'tide', 'active menu item'],
  ['#e7f1f9', 'abyss', 'sidebar text'], ['#dcebf6', 'abyss', 'menu links'], ['#dcebf6', 'trench', 'menu links (lower)'], ['#bcd5e8', 'trench', 'sidebar small text (lower)'], ['#bcd5e8', 'abyss', 'sidebar small text'],
  ['#bcd5e8', 'abyss', 'hero label on dark end'], ['#bcd5e8', 'deep', 'hero label on light end'], ['#ffffff', 'deep', 'hero numbers on light end'],
  ['#7ce8d8', 'deep', 'hero "up" change'], ['#ffb3a1', 'deep', 'hero "down" change'],
  ['#075a52', '#dff3f0', 'good badge / notice'], ['#8a5a00', '#fdf0d2', 'warning badge'], ['#5c3b00', '#fdf0d2', 'warning notice'], ['#b3261e', '#fbe4e2', 'bad badge'], ['#7d1a14', '#fbe4e2', 'error notice'],
  ['#ffffff', 'abyss', 'tooltips and toasts'], ['#ffffff', 'good', 'success toast'], ['#ffffff', 'bad', 'error toast'], ['ink', 'mist', 'neutral badge'], ['#000000', '#ffffff', 'receipt'],
];
for (const [fg, bg, label] of TEXT) {
  test(`text contrast AA: ${label}`, () => {
    const r = ratio(c(fg), c(bg));
    assert.ok(r >= 4.5, `${label}: ${fg} on ${bg} is ${r.toFixed(2)}:1, needs 4.5:1`);
  });
}
for (const s of ['series-sales', 'series-profit', 'series-expense']) {
  test(`chart colour readable against the card: ${s}`, () => {
    const r = ratio(c(s), c('paper'));
    assert.ok(r >= 3, `${s} is ${r.toFixed(2)}:1 against white, needs 3:1`);
  });
}
test('chart lines never rely on colour alone: each series has its own line style and marker', () => {
  const src = readFileSync(new URL('../src/ui/charts.jsx', import.meta.url), 'utf8');
  const dashes = [...src.matchAll(/dash: ('[^']*'|undefined), shape: '(\w+)'/g)].map((m) => m[1] + '/' + m[2]);
  assert.equal(dashes.length, 3);
  assert.equal(new Set(dashes).size, 3, dashes.join());
});
