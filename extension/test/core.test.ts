import { describe, expect, it, vi } from "vitest";
import { extractApiKey, extractCsrf, RedmineExecutor } from "../src/core.js";

const BASE = "https://r.test";
const KEY = "0123456789abcdef0123456789abcdef01234567";
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html" } });
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const unauthorized = () =>
  new Response("", {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": 'Basic realm="Redmine API"' },
  });
const req = (over: any = {}) => ({
  id: "1",
  type: "http" as const,
  method: "GET" as const,
  path: "/issues.json",
  ...over,
});

type Api = (url: string, init: any) => Response | Promise<Response>;

// A Redmine stand-in: HTML pages work with the session, API calls need the key header.
function site(api: Api, state = { key: KEY, csrf: "TOK", loggedIn: true }) {
  const calls: Array<{ url: string; init: any }> = [];
  const fn = vi.fn(async (url: string, init: any = {}) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    if (!state.loggedIn) return new Response(null, { status: 302, headers: { location: "https://sso" } });
    if (path === "/my/api_key") {
      return init.headers?.["x-requested-with"]
        ? new Response(`$('#api-access-key').html('${state.key}');`, { headers: { "content-type": "text/javascript" } })
        : html(`<pre id="api-access-key" class="autoscroll">${state.key}</pre>`);
    }
    if (path === "/my/account") return html(`<meta name="csrf-token" content="${state.csrf}" />`);
    if (init.headers?.["x-redmine-api-key"] !== state.key) return unauthorized();
    return api(url, init);
  });
  return { fn, calls, state, exec: new RedmineExecutor(fn as any, BASE) };
}

describe("extractors", () => {
  it("extractCsrf handles both attribute orders", () => {
    expect(extractCsrf('<meta name="csrf-token" content="abc==" />')).toBe("abc==");
    expect(extractCsrf('<meta content="xyz" name="csrf-token">')).toBe("xyz");
    expect(extractCsrf("<html></html>")).toBeUndefined();
  });
  it("extractApiKey", () => {
    expect(extractApiKey(`<pre id='api-access-key' class="autoscroll">\n${KEY}\n</pre>`)).toBe(KEY);
    expect(extractApiKey("<pre>nothing</pre>")).toBeUndefined();
  });
});

describe("GET with the session-derived API key", () => {
  it("reads the key from the session, sends it as a header, and caches it", async () => {
    const s = site(() => json({ issues: [] }));
    expect(await s.exec.handle(req({ query: { limit: "5" } }))).toMatchObject({ ok: true, json: { issues: [] } });
    await s.exec.handle(req());
    const api = s.calls.filter((c) => c.url.includes("/issues.json"));
    expect(api[0].url).toBe(`${BASE}/issues.json?limit=5`);
    expect(api[0].init).toMatchObject({ credentials: "include", redirect: "manual" });
    expect(api[0].init.headers["x-redmine-api-key"]).toBe(KEY);
    expect(s.calls.filter((c) => c.url.endsWith("/my/api_key"))).toHaveLength(1);
    expect(s.calls.find((c) => c.url.endsWith("/my/api_key"))!.init.headers["x-requested-with"]).toBe("XMLHttpRequest");
  });

  it("falls back to /my/account when /my/api_key has no key", async () => {
    const calls: string[] = [];
    const f = async (url: string, init: any = {}) => {
      calls.push(new URL(url).pathname);
      const p = new URL(url).pathname;
      if (p === "/my/api_key") return new Response("", { status: 404 });
      if (p === "/my/account") return html(`<pre id="api-access-key">${KEY}</pre>`);
      return init.headers["x-redmine-api-key"] === KEY ? json({ ok: 1 }) : unauthorized();
    };
    expect(await new RedmineExecutor(f as any, BASE).handle(req())).toMatchObject({ ok: true });
    expect(calls.slice(0, 3)).toEqual(["/my/api_key", "/my/api_key", "/my/account"]);
  });

  it("refetches the key once after a 401 (key was regenerated)", async () => {
    const s = site(() => json({ ok: 1 }));
    await s.exec.handle(req());
    s.state.key = "f".repeat(40);
    expect(await s.exec.handle(req())).toMatchObject({ ok: true });
    expect(s.calls.filter((c) => c.url.endsWith("/my/api_key"))).toHaveLength(2);
  });

  it("reports AUTH_REQUIRED when the key keeps being rejected", async () => {
    const s = site(() => unauthorized());
    s.fn.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/my/api_key" ? html(`<pre id="api-access-key">${KEY}</pre>`) : unauthorized(),
    );
    s.state.key = KEY;
    expect(await s.exec.handle(req())).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
  });

  it("reports AUTH_REQUIRED when the session is logged out", async () => {
    const s = site(() => json({}), { key: KEY, csrf: "T", loggedIn: false });
    expect(await s.exec.handle(req())).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
  });

  it("reports a clear error when no key can be found", async () => {
    const f = async () => html("<html>no key here</html>");
    const r: any = await new RedmineExecutor(f as any, BASE).handle(req());
    expect(r.error.code).toBe("AUTH_REQUIRED");
    expect(r.error.message).toContain("API access key");
  });

  it("refuses paths outside the allowlist without fetching", async () => {
    const f = vi.fn();
    for (const path of ["/admin", "/my/account", "/my/api_key"]) {
      expect(await new RedmineExecutor(f as any, BASE).handle(req({ path }))).toMatchObject({
        error: { code: "FORBIDDEN_PATH" },
      });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it.each([
    ["redirect", () => new Response(null, { status: 302, headers: { location: "https://sso" } })],
    ["html 403 (protection page)", () => html("<html>Access denied</html>", 403)],
    ["html 200 (login page)", () => html("<html>login</html>")],
  ])("maps %s to AUTH_REQUIRED", async (_n, make) => {
    expect(await site(make).exec.handle(req())).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
  });

  it("maps 404, json 403, 500 and network failure", async () => {
    expect(await site(() => json({}, 404)).exec.handle(req())).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(await site(() => json({}, 403)).exec.handle(req())).toMatchObject({ error: { code: "HTTP", status: 403 } });
    expect(await site(() => html("boom", 500)).exec.handle(req())).toMatchObject({
      error: { code: "HTTP", status: 500 },
    });
    expect(
      await site(() => {
        throw new Error("offline");
      }).exec.handle(req()),
    ).toMatchObject({ error: { code: "NETWORK", message: "offline" } });
  });
});

describe("the API key never leaves the executor", () => {
  it("scrubs api_key fields from results", async () => {
    const s = site(() => json({ user: { id: 1, login: "u", api_key: KEY, nested: [{ api_key: KEY, ok: 1 }] } }));
    const r = await s.exec.handle(req({ path: "/users/current.json" }));
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(r).toMatchObject({ ok: true, json: { user: { id: 1, login: "u", nested: [{ ok: 1 }] } } });
  });

  it("redacts the key from error details", async () => {
    const s = site(() => html(`server error, request key=${KEY}`, 500));
    expect(JSON.stringify(await s.exec.handle(req()))).not.toContain(KEY);
    const s2 = site(() => html(`<html>${KEY}</html>`, 403));
    expect(JSON.stringify(await s2.exec.handle(req()))).not.toContain(KEY);
  });

  it("does not put the key in a validation error either", async () => {
    const s = site(() => json({ errors: [`bad ${KEY}`] }, 422));
    const r = await s.exec.handle(req({ method: "PUT", path: "/issues/1.json", body: { issue: {} } }));
    expect(r).toMatchObject({ error: { code: "VALIDATION" } });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("never puts the CSRF token in diagnostics or error details", async () => {
    const csrf = "abcDEF+ghi/JKL0123456789mnoPQRstu==";
    const s = site(() => html(`<html>oops ${csrf} and ${csrf}</html>`, 500), { key: KEY, csrf, loggedIn: true });
    const r = await s.exec.handle(req({ method: "PUT", path: "/issues/1.json", body: { issue: {} } }));
    expect(JSON.stringify(r)).not.toContain(csrf);
    const s2 = site(() => html(`<html>${csrf}</html>`, 403), { key: KEY, csrf, loggedIn: true });
    await s2.exec.handle(req({ method: "PUT", path: "/issues/1.json", body: { issue: {} } }));
    expect(JSON.stringify(await s2.exec.handle(req()))).not.toContain(csrf);
  });
});

describe("writes", () => {
  const put = (over: any = {}) =>
    req({ method: "PUT", path: "/issues/1.json", body: { issue: { notes: "x" } }, ...over });

  it("sends key and CSRF token, returns ok on 204, fetches the token once", async () => {
    const s = site(() => new Response(null, { status: 204 }));
    expect(await s.exec.handle(put())).toMatchObject({ ok: true, status: 204 });
    expect(await s.exec.handle(put())).toMatchObject({ ok: true });
    const writes = s.calls.filter((c) => c.url.includes("/issues/1.json"));
    expect(writes[0].init.headers).toMatchObject({ "x-csrf-token": "TOK", "x-redmine-api-key": KEY });
    expect(s.calls.filter((c) => c.url.endsWith("/my/account"))).toHaveLength(1);
  });

  it("refreshes the CSRF token and retries once on a bare 422", async () => {
    let writes = 0;
    const s = site((_u, init) => {
      writes++;
      return init.headers["x-csrf-token"] === "NEW"
        ? new Response(null, { status: 204 })
        : new Response("", { status: 422 });
    });
    s.state.csrf = "OLD";
    const first = s.exec.handle(put());
    s.fn.mockImplementation(async (url: string, init: any = {}) => {
      const p = new URL(url).pathname;
      if (p === "/my/api_key") return html(`<pre id="api-access-key">${KEY}</pre>`);
      if (p === "/my/account") return html(`<meta name="csrf-token" content="${writes === 0 ? "OLD" : "NEW"}" />`);
      writes++;
      return init.headers["x-csrf-token"] === "NEW"
        ? new Response(null, { status: 204 })
        : new Response("", { status: 422 });
    });
    expect(await first).toMatchObject({ ok: true });
    expect(writes).toBe(2);
  });

  it("gives up with CSRF after two bare 422s", async () => {
    const s = site(() => new Response("", { status: 422 }));
    expect(await s.exec.handle(put())).toMatchObject({ error: { code: "CSRF" } });
  });

  it("returns validation errors from a json 422 without retrying", async () => {
    let writes = 0;
    const s = site(() => {
      writes++;
      return json({ errors: ["Subject cannot be blank"] }, 422);
    });
    expect(await s.exec.handle(put())).toMatchObject({
      error: { code: "VALIDATION", details: ["Subject cannot be blank"] },
    });
    expect(writes).toBe(1);
  });

  it("reports a redirect while loading the CSRF page as AUTH_REQUIRED, and other failures as NETWORK", async () => {
    const make = (status: number) =>
      new RedmineExecutor(
        (async (url: string, init: any = {}) => {
          const p = new URL(url).pathname;
          if (p === "/my/api_key") return html(`<pre id="api-access-key">${KEY}</pre>`);
          if (p === "/my/account") return status === 302 ? new Response(null, { status }) : html("", status);
          return init.headers?.["x-redmine-api-key"] === KEY ? json({}) : unauthorized();
        }) as any,
        BASE,
      );
    expect(await make(302).handle(put())).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
    expect(await make(500).handle(put())).toMatchObject({
      error: { code: "NETWORK", message: expect.stringContaining("HTTP 500") },
    });
  });

  it("refuses DELETE", async () => {
    expect(await site(() => json({})).exec.handle(put({ method: "DELETE" }))).toMatchObject({
      error: { code: "FORBIDDEN_PATH" },
    });
  });
});
