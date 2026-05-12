import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "crates/peoplegraph/target/release/peoplegraph");
const destination = resolve(root, "bin/peoplegraph");

try {
	await stat(source);
} catch {
	console.error(`Missing release binary: ${source}`);
	console.error("Run `npm run build:peoplegraph` first.");
	process.exit(1);
}

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
await chmod(destination, 0o755);
console.log(`Copied ${source} -> ${destination}`);
