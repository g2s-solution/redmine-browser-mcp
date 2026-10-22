import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, "dist");
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(root, "src/worker.ts"), join(root, "src/popup.ts")],
  bundle: true,
  format: "esm",
  target: "chrome116",
  outdir: out,
  logLevel: "info",
  define: { __BUILD__: JSON.stringify(new Date().toISOString()) },
});
for (const f of ["manifest.json", "popup.html"]) copyFileSync(join(root, f), join(out, f));
