import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";

export const EXT_ORIGIN = "chrome-extension://testext";

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    port: 0,
    readOnly: false,
    requestTimeoutMs: 1000,
    auditPath: join(mkdtempSync(join(tmpdir(), "rmcp-")), "audit.log"),
    ...over,
  };
}

export async function startApp(over: Partial<Config> = {}) {
  const config = testConfig(over);
  const app = createApp(config);
  const port = await app.listen();
  return { app, port, config };
}

export async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("until: timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
