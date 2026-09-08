import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const dir = await mkdtemp(join(tmpdir(), "people-intelligence-"));
try {
  await build({
    entryPoints: ["tests/intelligence.test.ts"],
    outfile: join(dir, "test.cjs"),
    alias: { obsidian: "./tests/obsidian-stub.ts" },
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  const result = spawnSync(
    process.execPath,
    ["--test", join(dir, "test.cjs")],
    { stdio: "inherit" },
  );
  process.exitCode = result.status ?? 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
