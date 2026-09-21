// Deliberate frame capture for the proof movie. Drives a real browser against the
// local dev instance and writes PNG frames per scene at the scene's `rate`.
//
//   node demo/record.mjs demo/scenes.yaml [--only 02-ask] [--work demo/work]
//
// Verbs: goto, wait_for, click, type, press, pause, scroll_into_view.
// A visible cursor is injected so clicks read as clicks. Typing is human-paced.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintSession } from './session.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [scenesPath = join(here, 'scenes.yaml'), ...rest] = process.argv.slice(2);
const only = rest.includes('--only') ? rest[rest.indexOf('--only') + 1] : null;
const work = rest.includes('--work') ? resolve(rest[rest.indexOf('--work') + 1]) : join(here, 'work');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || resolve(here, '..', 'node_modules', 'playwright', 'index.mjs'));
const yaml = await loadYaml();
const doc = yaml.parse(readFileSync(scenesPath, 'utf8'));
const origin = doc.origin || 'http://localhost:8787';
const width = doc.width || 1400, height = doc.height || 900;

const CURSOR = `(() => {
  const ring = document.createElement('div');
  ring.id = '__demo_cursor';
  ring.style.cssText = 'position:fixed;left:-40px;top:-40px;width:22px;height:22px;border:3px solid rgba(255,64,129,.95);border-radius:50%;box-shadow:0 0 0 2px rgba(255,255,255,.8);pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);transition:transform .08s';
  const attach = () => document.body && document.body.appendChild(ring);
  if (document.body) attach(); else document.addEventListener('DOMContentLoaded', attach);
  document.addEventListener('mousemove', e => { ring.style.left = e.clientX + 'px'; ring.style.top = e.clientY + 'px'; }, true);
  document.addEventListener('mousedown', () => { ring.style.transform = 'translate(-50%,-50%) scale(.6)'; }, true);
  document.addEventListener('mouseup', () => { ring.style.transform = 'translate(-50%,-50%) scale(1)'; }, true);
})();`;

const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
await context.addCookies([{ name: '__Host-people-session', value: mintSession(doc.email), domain: new URL(origin).hostname, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
await context.addInitScript(CURSOR);
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Page.enable');
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let mouse = { x: width / 2, y: height / 2 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function moveTo(x, y) {
  const steps = 18;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < .5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    await page.mouse.move(mouse.x + (x - mouse.x) * e, mouse.y + (y - mouse.y) * e);
    await sleep(16);
  }
  mouse = { x, y };
}
async function center(selector) {
  const el = page.locator(selector).first();
  await el.waitFor({ state: 'visible', timeout: 20_000 });
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return { x: box.x + Math.min(box.width / 2, 200), y: box.y + box.height / 2 };
}
async function act(step) {
  const [verb] = Object.keys(step);
  const arg = step[verb];
  switch (verb) {
    case 'goto': await page.goto(origin + arg, { waitUntil: 'domcontentloaded' }); return;
    case 'wait_for': await page.locator(arg).first().waitFor({ state: 'visible', timeout: 30_000 }); return;
    case 'click': { const p = await center(arg); await moveTo(p.x, p.y); await sleep(120); await page.mouse.down(); await sleep(90); await page.mouse.up(); return; }
    case 'type': for (const ch of String(arg)) { await page.keyboard.type(ch); await sleep(/[.,!?]/.test(ch) ? 180 : 55 + Math.random() * 25); } return;
    case 'press': await page.keyboard.press(arg); return;
    case 'pause': await sleep(Number(arg) * 1000); return;
    case 'scroll_into_view': await page.locator(arg).first().scrollIntoViewIfNeeded(); return;
    default: throw new Error(`unknown verb ${verb}`);
  }
}

const results = [];
for (const scene of doc.scenes) {
  if (scene.kind !== 'frames' && scene.kind !== undefined) continue;
  if (only && scene.id !== only) continue;
  const dir = join(work, scene.src || `frames/${scene.id}`);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const rate = Number(scene.rate || 4), interval = 1000 / rate;
  let n = 0, stop = false;
  const capture = (async () => {
    while (!stop) {
      const started = Date.now();
      // Raw CDP capture: a Playwright screenshot waits for fonts and animations and can take seconds.
      // A capture issued as a navigation begins never replies, so race it and drop that frame.
      const shot = await Promise.race([cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null), sleep(700).then(() => null)]);
      if (shot && shot.data) writeFileSync(join(dir, `frame-${String(++n).padStart(6, '0')}.png`), Buffer.from(shot.data, 'base64'));
      await sleep(Math.max(0, interval - (Date.now() - started)));
    }
  })();
  const t0 = Date.now();
  let error = null;
  try { for (const step of scene.actions || []) await act(step); } catch (e) { error = e.message; }
  stop = true; await capture;
  const seconds = (Date.now() - t0) / 1000;
  results.push({ id: scene.id, frames: n, seconds, error });
  console.log(`${scene.id}: ${n} frames over ${seconds.toFixed(1)}s${error ? ' — ERROR: ' + error : ''}`);
  if (error) break;
}
writeFileSync(join(work, 'record.json'), JSON.stringify({ origin, results, pageErrors: errors }, null, 2));
// Write the scenes file assemble will read, with each frames scene's rate set to the rate actually achieved,
// so the picture plays at real speed against the narration instead of a guessed constant.
const measured = { ...doc, scenes: doc.scenes.map((scene) => {
  const r = results.find((x) => x.id === scene.id);
  return r && r.frames > 1 && r.seconds > 0 ? { ...scene, rate: Number((r.frames / r.seconds).toFixed(3)) } : scene;
}) };
if (!only) writeFileSync(join(work, 'scenes.yaml'), typeof yaml.stringify === 'function' ? yaml.stringify(measured) : readFileSync(scenesPath, 'utf8'));
await browser.close();
if (results.some((r) => r.error) || errors.length) { console.error('record: scene errors or page errors; see work/record.json'); process.exit(1); }

async function loadYaml() {
  try { return await import('yaml'); } catch {}
  // Minimal fallback: the scenes file is written in a subset (top-level scalars, a `scenes` list of maps with
  // scalars, folded `>` text, and an `actions` list of single-key maps). Good enough when the yaml package is absent.
  return { parse: parseSubset };
}
function parseSubset(text) {
  const doc = { scenes: [] };
  let scene = null, field = null, folded = [];
  const flush = () => { if (scene && field) { scene[field] = folded.join(' ').trim(); field = null; folded = []; } };
  for (const raw of text.split('\n')) {
    if (/^\s*#/.test(raw) || !raw.trim()) { if (field && !raw.trim()) folded.push(''); continue; }
    const top = raw.match(/^(\w+):\s*(.*)$/);
    if (top && !raw.startsWith(' ')) { flush(); if (top[1] !== 'scenes') doc[top[1]] = coerce(top[2]); continue; }
    const item = raw.match(/^  - (\w+):\s*(.*)$/);
    if (item) { flush(); scene = { [item[1]]: coerce(item[2]) }; doc.scenes.push(scene); continue; }
    const kv = raw.match(/^    (\w+):\s*(.*)$/);
    if (kv) { flush(); if (kv[2] === '>' ) { field = kv[1]; } else if (kv[1] === 'actions') { scene.actions = []; } else scene[kv[1]] = coerce(kv[2]); continue; }
    const action = raw.match(/^      - (\w+):\s*(.*)$/);
    if (action) { scene.actions.push({ [action[1]]: coerce(action[2]) }); continue; }
    if (field && /^      /.test(raw)) folded.push(raw.trim());
  }
  flush();
  return doc;
}
function coerce(v) {
  v = v.trim();
  if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return v.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}
