import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const port = process.env.REDMINE_MCP_PORT ?? "7399";
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
for (const [name, args] of [["get_current_user", {}], ["list_issues", { assigned_to_id: "me", limit: 3 }]] as const) {
  const r: any = await client.callTool({ name, arguments: args });
  console.log(`${r.isError ? "FAIL" : "OK  "} ${name}: ${r.content[0].text.slice(0, r.isError ? 3000 : 400)}`);
}
await client.close();
