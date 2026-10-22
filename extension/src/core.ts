import { isAllowedRequest, type ErrorCode, type HttpRequestMsg, type HttpResultMsg } from "../../shared/protocol.js";

export function extractCsrf(html: string): string | undefined {
  const tag = html.match(/<meta[^>]*name=["']csrf-token["'][^>]*>/i)?.[0];
  return tag?.match(/content=["']([^"']+)["']/i)?.[1];
}

export function extractApiKey(html: string): string | undefined {
  const near = html.match(/api-access-key[\s\S]{0,400}/i)?.[0];
  return near?.match(/>\s*([A-Za-z0-9]{20,64})\s*</)?.[1];
}

// Replaces anything token-shaped (including base64 with + / = - _) so a secret in an unexpected place cannot leak.
const maskTokens = (t: string) => t.replace(/[A-Za-z0-9+/=_-]{16,}/g, "<token>").replace(/\s+/g, " ");

const isAuthFailure = (res: Response) =>
  res.type === "opaqueredirect" ||
  res.status === 0 ||
  (res.status >= 300 && res.status < 400) ||
  res.status === 401 ||
  res.status === 403;

// Redmine echoes `api_key` in /users/current.json; remove it from every result.
function scrubJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrubJson);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => k !== "api_key")
        .map(([k, x]) => [k, scrubJson(x)]),
    );
  }
  return v;
}

// Redmine ignores session cookies on .json requests, so the executor reads the user's API key from their
// logged-in session and sends it as a header. The key and the CSRF token must stay in this class: they are
// scrubbed or redacted from every result and are never part of a protocol message.
export class RedmineExecutor {
  private csrf?: string;
  private apiKey?: string;

  constructor(
    private fetchFn: typeof fetch,
    private baseUrl: string,
  ) {}

  async handle(msg: HttpRequestMsg): Promise<HttpResultMsg> {
    const err = (
      code: ErrorCode,
      message: string,
      extra: { status?: number; details?: unknown } = {},
    ): HttpResultMsg => ({
      id: msg.id,
      type: "http-result",
      ok: false,
      error: { code, message, ...extra },
    });
    if (!isAllowedRequest(msg.method, msg.path))
      return err("FORBIDDEN_PATH", `${msg.method} ${msg.path} is not allowed`);

    try {
      let sent = await this.send(msg);
      let csrfRetried = false;
      let keyRetried = false;
      for (;;) {
        if (sent.kind === "csrf-retry" && !csrfRetried) {
          csrfRetried = true;
          this.csrf = undefined;
        } else if (sent.kind === "done" && sent.res.status === 401 && !keyRetried) {
          keyRetried = true;
          this.apiKey = undefined;
        } else break;
        sent = await this.send(msg);
      }
      return this.finish(msg, sent, err);
    } catch (e) {
      if (e instanceof AuthError)
        return err("AUTH_REQUIRED", e.message + "; open Redmine in Chrome and log in again", { details: e.details });
      return err("NETWORK", e instanceof Error ? e.message : String(e));
    }
  }

  // Redmine 6 renders an empty <pre> on /my/account and loads the key over XHR when "Show" is clicked, so try that first.
  private async key(): Promise<string> {
    if (this.apiKey) return this.apiKey;
    const attempts: Array<{
      page: string;
      headers: Record<string, string>;
      extract: (t: string) => string | undefined;
    }> = [
      {
        page: "/my/api_key",
        headers: {
          accept: "text/javascript, application/javascript, */*; q=0.01",
          "x-requested-with": "XMLHttpRequest",
        },
        extract: (t: string) => t.match(/\b[0-9a-f]{40}\b/i)?.[0],
      },
      { page: "/my/api_key", headers: { accept: "text/html" }, extract: extractApiKey },
      { page: "/my/account", headers: { accept: "text/html" }, extract: extractApiKey },
    ];
    const diag: unknown[] = [];
    for (const a of attempts) {
      const res = await this.fetchFn(this.baseUrl + a.page, {
        credentials: "include",
        redirect: "manual",
        headers: a.headers,
      });
      if (isAuthFailure(res)) throw new AuthError("session is not logged in");
      if (res.status !== 200) {
        diag.push({ page: a.page, status: res.status });
        continue;
      }
      const body = await res.text();
      const key = a.extract(body);
      if (key) return (this.apiKey = key);
      // Page snippets are masked (long alphanumeric runs replaced) so a key in an unexpected shape cannot leak.
      const marker = body.search(/api-access-key/i);
      diag.push({
        page: a.page,
        xhr: "x-requested-with" in a.headers,
        status: 200,
        bytes: body.length,
        contentType: res.headers.get("content-type"),
        looksLoggedIn: /logout|class=["']user active["']/i.test(body),
        title: body.match(/<title>([^<]{0,80})/i)?.[1]?.trim(),
        markerContext: marker >= 0 ? maskTokens(body.slice(Math.max(0, marker - 120), marker + 260)) : undefined,
        head:
          a.page === "/my/api_key"
            ? maskTokens(body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").slice(0, 300))
            : undefined,
      });
    }
    throw new AuthError(
      "could not read the API access key from your Redmine account (is the REST API enabled for your account?)",
      diag,
    );
  }

  private async token(): Promise<string> {
    if (this.csrf) return this.csrf;
    const res = await this.fetchFn(this.baseUrl + "/my/account", {
      credentials: "include",
      redirect: "manual",
      headers: { accept: "text/html" },
    });
    if (isAuthFailure(res)) throw new AuthError("session is not logged in");
    if (res.status !== 200) throw new Error(`HTTP ${res.status} while loading the account page for the CSRF token`);
    const csrf = extractCsrf(await res.text());
    if (!csrf) throw new AuthError("could not find CSRF token; session is probably not logged in");
    this.csrf = csrf;
    return csrf;
  }

  private async send(msg: HttpRequestMsg): Promise<Sent> {
    const url = new URL(this.baseUrl + msg.path);
    for (const [k, v] of Object.entries(msg.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: "application/json", "x-redmine-api-key": await this.key() };
    const init: RequestInit = { method: msg.method, credentials: "include", redirect: "manual", headers };
    if (msg.method !== "GET") {
      headers["x-csrf-token"] = await this.token();
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(msg.body ?? {});
    }
    const res = await this.fetchFn(url.toString(), init);
    const contentType = res.headers.get("content-type") ?? "";
    let raw = res.type === "opaqueredirect" ? "" : await res.text();
    for (const secret of [this.apiKey, this.csrf]) if (secret) raw = raw.split(secret).join("[redacted]");
    if (msg.method !== "GET" && res.status === 422 && !contentType.includes("json")) return { kind: "csrf-retry" };
    return { kind: "done", res, contentType, raw };
  }

  private finish(
    msg: HttpRequestMsg,
    sent: Sent,
    err: (c: ErrorCode, m: string, x?: { status?: number; details?: unknown }) => HttpResultMsg,
  ): HttpResultMsg {
    if (sent.kind === "csrf-retry") return err("CSRF", "CSRF token rejected twice");
    const { res, contentType, raw } = sent;
    const isJson = contentType.includes("json");
    const seen = {
      status: res.status,
      type: res.type,
      contentType,
      server: res.headers.get("server"),
      wwwAuthenticate: res.headers.get("www-authenticate"),
      location: res.headers.get("location"),
      body: maskTokens(raw).slice(0, 160),
    };
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400))
      return err("AUTH_REQUIRED", "redirected (login or protection page); open Redmine in Chrome and log in again", {
        status: res.status,
        details: seen,
      });
    if (res.status === 401 || (res.status === 403 && !isJson && raw.trim().startsWith("<")))
      return err("AUTH_REQUIRED", "not authenticated; open Redmine in Chrome and log in again", {
        status: res.status,
        details: seen,
      });
    if (res.status === 404) return err("NOT_FOUND", `${msg.path} not found`, { status: 404 });
    if (res.status === 403) return err("HTTP", "forbidden: you lack permission for this action", { status: 403 });
    if (res.status === 422)
      return err("VALIDATION", "Redmine rejected the data", {
        status: 422,
        details: safeJson(raw)?.errors ?? maskTokens(raw).slice(0, 300),
      });
    if (res.status >= 400)
      return err("HTTP", `HTTP ${res.status}`, { status: res.status, details: maskTokens(raw).slice(0, 300) });
    if (raw === "" || res.status === 204) return { id: msg.id, type: "http-result", ok: true, status: res.status };
    if (!isJson)
      return err(
        "AUTH_REQUIRED",
        "got an HTML page instead of JSON (login or protection page); log in again in Chrome",
        { status: res.status, details: seen },
      );
    const json = safeJson(raw);
    if (json === undefined) return err("HTTP", "invalid JSON from Redmine", { status: res.status });
    return { id: msg.id, type: "http-result", ok: true, status: res.status, json: scrubJson(json) };
  }
}

type Sent = { kind: "csrf-retry" } | { kind: "done"; res: Response; contentType: string; raw: string };

class AuthError extends Error {
  constructor(
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

function safeJson(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
