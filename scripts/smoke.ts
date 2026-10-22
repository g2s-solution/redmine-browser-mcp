import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// --quiet hides the returned data (user name, issues) so the output is safe to paste or hand to an agent.
const quiet = process.argv.includes("--quiet");
let failed = false;
const port = process.env.REDMINE_MCP_PORT ?? "7399";
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
for (const [name, args] of [
  ["get_current_user", {}],
  ["list_issues", { assigned_to_id: "me", limit: 3 }],
] as const) {
  const r: any = await client.callTool({ name, arguments: args });
  const detail = r.isError
    ? r.content[0].text.slice(0, 3000)
    : quiet
      ? "(data hidden)"
      : r.content[0].text.slice(0, 400);
  console.log(`${r.isError ? "FAIL" : "OK  "} ${name}: ${detail}`);
  if (r.isError) failed = true;
}
await client.close();
process.exit(failed ? 1 : 0);
