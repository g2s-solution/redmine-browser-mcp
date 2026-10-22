import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  port: number;
  readOnly: boolean;
  requestTimeoutMs: number;
  auditPath: string;
  allowedExtensionId?: string;
  log?: (msg: string) => void;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const stateDir = env.REDMINE_MCP_STATE_DIR ?? join(homedir(), ".local", "state", "redmine-mcp");
  return {
    port: Number(env.REDMINE_MCP_PORT ?? 7399),
    readOnly: env.READ_ONLY === "1",
    requestTimeoutMs: Number(env.REDMINE_MCP_TIMEOUT_MS ?? 20000),
    auditPath: join(stateDir, "audit.log"),
    allowedExtensionId: env.REDMINE_MCP_EXTENSION_ID,
    log: (m) => console.error(`[${new Date().toISOString()}] ${m}`),
  };
}
