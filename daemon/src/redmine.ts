import type { Bridge } from "./bridge.js";
import type { ErrorCode, HttpMethod } from "../../shared/protocol.js";

export class RedmineError extends Error {
  constructor(public code: ErrorCode, message: string, public status?: number, public details?: unknown) {
    super(message);
  }
}

export class RedmineClient {
  constructor(private bridge: Pick<Bridge, "request">) {}

  async call<T = any>(method: HttpMethod, path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<T | undefined> {
    const res = await this.bridge.request({ method, path, query: opts.query, body: opts.body });
    if (!res.ok) throw new RedmineError(res.error.code, res.error.message, res.error.status, res.error.details);
    return res.json as T | undefined;
  }

  get<T = any>(path: string, query?: Record<string, string | number | undefined>): Promise<T | undefined> {
    const q: Record<string, string> = {};
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) q[k] = String(v);
    return this.call<T>("GET", path, { query: q });
  }
}
