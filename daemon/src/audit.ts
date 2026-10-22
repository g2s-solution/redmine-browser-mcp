import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AuditFn = (entry: { tool: string; args: unknown; ok: boolean; error?: string }) => void;

export function createAudit(path: string): AuditFn {
  return (entry) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
    } catch {
      // audit failures must not break the tool call
    }
  };
}
