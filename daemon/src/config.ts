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

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const stateDir = env.REDMINE_MCP_STATE_DIR ?? join(homedir(), ".local", "state", "redmine-mcp");
  return {
    port: integer(env, "REDMINE_MCP_PORT", 7399, 1, 65535),
    readOnly: env.READ_ONLY === "1",
    requestTimeoutMs: integer(env, "REDMINE_MCP_TIMEOUT_MS", 20000, 100, 600000),
    auditPath: join(stateDir, "audit.log"),
    allowedExtensionId: env.REDMINE_MCP_EXTENSION_ID,
    log: (m) => console.error(`[${new Date().toISOString()}] ${m}`),
  };
}
