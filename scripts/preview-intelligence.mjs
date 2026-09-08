import { context } from "esbuild";
import { mkdtemp, copyFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = await mkdtemp(join(tmpdir(), "people-preview-"));
await copyFile("styles.css", join(directory, "styles.css"));
await writeFile(
  join(directory, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>People intelligence — synthetic preview</title><link rel="stylesheet" href="styles.css"><style>:root{--background-primary:#fcfcfa;--background-secondary:#f3f4f0;--background-modifier-border:#dfe2dc;--text-normal:#24332e;--text-muted:#6b7972}body{margin:0;font-family:system-ui,sans-serif}body>header{padding:10px 24px;background:#203e34;color:white;font-size:12px}button,input,select{font-family:inherit}#source-status{font-size:12px}</style></head><body><header>SYNTHETIC PREVIEW · All names, connections and activity are demonstration data.<div id="source-status" role="status"></div></header><div id="app"></div><script src="preview.js"></script></body></html>`,
);
const ctx = await context({
  entryPoints: ["tests/intelligence-preview.ts"],
  bundle: true,
  outfile: join(directory, "preview.js"),
  format: "iife",
  platform: "browser",
});
const server = await ctx.serve({
  servedir: directory,
  host: "127.0.0.1",
  port: 4178,
});
console.log(
  `People intelligence preview: http://127.0.0.1:${server.port} (synthetic data)`,
);
