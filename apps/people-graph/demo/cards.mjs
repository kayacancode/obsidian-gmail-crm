// Render the movie's title/caption cards to PNG with Playwright, from scenes.yaml.
// The assembler's own card renderer drives a bare headless Chrome and, in this
// environment, produced a browser error page instead of the card; rendering the
// same HTML through Playwright's page.setContent avoids that.
//
//   node demo/cards.mjs demo/scenes.yaml demo/work
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [scenesPath = join(here, 'scenes.yaml'), work = join(here, 'work')] = process.argv.slice(2);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || resolve(here, '..', 'node_modules', 'playwright', 'index.mjs'));
const yaml = await import('yaml');
const doc = yaml.parse(readFileSync(scenesPath, 'utf8'));
const w = doc.width || 1400, h = doc.height || 900;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const html = (title, sub) => `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:${w}px;height:${h}px;background:#101014;color:#e8e6e1;font-family:-apple-system,"Helvetica Neue",Helvetica,Arial,sans-serif;overflow:hidden}
.w{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${Math.max(16, Math.floor(h / 44))}px;text-align:center;padding:0 8%}
h1{margin:0;font-size:${Math.max(28, Math.floor(h / 14))}px;font-weight:650;letter-spacing:-.02em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#f2f2f5}
p{margin:0;font-size:${Math.max(16, Math.floor(h / 32))}px;color:#9a9aa6;line-height:1.35}
</style><div class="w"><h1>${esc(title)}</h1><p>${esc(sub)}</p></div>`;

const outDir = join(resolve(work), 'cards');
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: w, height: h } });
for (const scene of doc.scenes) {
  // A card is any scene with a title and no recorded actions (kind card, or kind image pointing under cards/).
  if (!scene.title || scene.actions) continue;
  await page.setContent(html(scene.title, scene.subtitle), { waitUntil: 'load' });
  const file = scene.src ? join(resolve(work), scene.src) : join(outDir, `${scene.id}.png`);
  mkdirSync(dirname(file), { recursive: true });
  await page.screenshot({ path: file, type: 'png' });
  console.log(`${scene.id}: ${file}`);
}
await browser.close();
