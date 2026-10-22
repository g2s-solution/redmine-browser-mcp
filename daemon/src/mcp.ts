import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuditFn } from "./audit.js";
import { RedmineError, type RedmineClient } from "./redmine.js";
import pkg from "../../package.json" with { type: "json" };
import { tools } from "./tools/index.js";

export interface McpDeps {
  client: RedmineClient;
  readOnly: boolean;
  audit: AuditFn;
}

const text = (v: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v) }],
  isError,
});

export function formatError(e: unknown): string {
  if (e instanceof RedmineError) {
    const d = e.details ? ` ${JSON.stringify(e.details)}` : "";
    const http = e.status ? ` (HTTP ${e.status})` : "";
    return `${e.code}: ${e.message}${http}${d}`;
  }
  return e instanceof Error ? e.message : String(e);
}

export function createMcpServer({ client, readOnly, audit }: McpDeps): McpServer {
  const server = new McpServer({ name: "redmine-bridge", version: pkg.version });
  for (const t of tools) {
    if (t.write && readOnly) continue;
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: t.shape,
        annotations: t.write ? { readOnlyHint: false, destructiveHint: false } : { readOnlyHint: true },
      },
      async (args: any) => {
        try {
          const out = await t.run(client, args);
          if (t.write) audit({ tool: t.name, args, ok: true });
          return text(out);
        } catch (e) {
          if (t.write) audit({ tool: t.name, args, ok: false, error: formatError(e) });
          const unknownOutcome = t.write && e instanceof RedmineError && (e.code === "TIMEOUT" || e.code === "NETWORK");
          return text(
            formatError(e) +
              (unknownOutcome ? ". The write may or may not have been applied: check in Redmine before retrying." : ""),
            true,
          );
        }
      },
    );
  }
  return server;
}
