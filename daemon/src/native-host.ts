import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

// Started by Chrome (Native Messaging): the extension reaches this process over stdin/stdout, and the same
// process serves the MCP endpoint on loopback. stdout carries only protocol frames; everything else goes to stderr.
const config = loadConfig();
const app = createApp(config);
try {
  await app.listen();
} catch (e) {
  // Usually a manually started daemon already owns the port; the extension then falls back to its WebSocket.
  console.error(`native host cannot listen on 127.0.0.1:${config.port}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
process.stdout.on("error", () => {});
app.bridge.attachNative(process.stdin, process.stdout);
const shutdown = () => void app.close().then(() => process.exit(0));
process.stdin.on("close", shutdown);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, shutdown);
