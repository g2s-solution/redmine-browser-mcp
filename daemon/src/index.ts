import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

const config = loadConfig();
const app = createApp(config);
if (!config.allowedExtensionId) {
  console.error(
    "warning: REDMINE_MCP_EXTENSION_ID is not set, so any browser extension can connect; pin it to the id shown in the extension popup",
  );
}
const port = await app.listen();
console.error(
  `redmine-mcp daemon listening on http://127.0.0.1:${port}/mcp (extension ws: /ext)${config.readOnly ? " [READ_ONLY]" : ""}`,
);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
