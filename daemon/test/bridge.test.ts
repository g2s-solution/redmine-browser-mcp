import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { request } from "node:http";
import { originAllowed } from "../src/bridge.js";
import { EXT_ORIGIN, startApp, until } from "./helpers.js";

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

async function boot(over = {}) {
  const s = await startApp(over);
  cleanup.push(() => s.app.close());
  return s;
}
function connect(port: number, origin: string | null = EXT_ORIGIN) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`, { origin: origin ?? undefined });
  cleanup.push(() => ws.close());
  return ws;
}
const opened = (ws: WebSocket) =>
  new Promise<void>((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
const rejected = (ws: WebSocket) => new Promise<string>((res) => ws.on("error", (e) => res(e.message)));

describe("helpers", () => {
  it("originAllowed", () => {
    expect(originAllowed(undefined)).toBe(false);
    expect(originAllowed("chrome-extension://abc")).toBe(true);
    expect(originAllowed("https://evil.com")).toBe(false);
    expect(originAllowed("chrome-extension://abc", "xyz")).toBe(false);
    expect(originAllowed("chrome-extension://xyz", "xyz")).toBe(true);
  });
});

describe("Bridge auth", () => {
  it("rejects a web-page origin", async () => {
    const { port } = await boot();
    expect(await rejected(connect(port, "https://evil.com"))).toContain("403");
  });
  it("rejects a client with no Origin", async () => {
    const { port } = await boot();
    expect(await rejected(connect(port, null))).toContain("403");
  });
  it("pins the extension id when configured", async () => {
    const { port } = await boot({ allowedExtensionId: "other" });
    expect(await rejected(connect(port))).toContain("403");
  });
  it("accepts an extension origin", async () => {
    const { port, app } = await boot();
    await opened(connect(port));
    await until(() => app.bridge.connected);
  });
  it("accepts loopback Host names with a port", async () => {
    const { port } = await boot();
    const get = (host: string) =>
      new Promise<number>((res, rej) => {
        const r = request({ host: "127.0.0.1", port, path: "/health", headers: { host } }, (m) => {
          m.resume();
          res(m.statusCode!);
        });
        r.on("error", rej);
        r.end();
      });
    expect(await get(`localhost:${port}`)).toBe(200);
    expect(await get(`127.0.0.1:${port}`)).toBe(200);
    expect(await get(`[::1]:${port}`)).toBe(200);
    expect(await get("evil.example.com")).toBe(403);
  });

  it("refuses a rebinding Host header and a browser Origin on /mcp", async () => {
    const { port } = await boot();
    const status = (headers: Record<string, string>) =>
      new Promise<number>((res, rej) => {
        const r = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers }, (m) => {
          m.resume();
          res(m.statusCode!);
        });
        r.on("error", rej);
        r.end("{}");
      });
    expect(await status({ host: "evil.example.com" })).toBe(403);
    expect(await status({ origin: "https://evil.com" })).toBe(403);
  });
  it("404s other ws paths", async () => {
    const { port } = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/other`, { origin: EXT_ORIGIN });
    expect(await rejected(ws)).toContain("404");
  });
});

describe("Bridge request/response", () => {
  it("fails fast when no extension is connected", async () => {
    const { app } = await boot();
    const r = await app.bridge.request({ method: "GET", path: "/issues.json" });
    expect(r).toMatchObject({ ok: false, error: { code: "NOT_CONNECTED" } });
  });

  it("round-trips a request", async () => {
    const { port, app } = await boot();
    const ws = connect(port);
    await opened(ws);
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      ws.send(JSON.stringify({ id: m.id, type: "http-result", ok: true, status: 200, json: { echo: m.path } }));
    });
    await until(() => app.bridge.connected);
    const r = await app.bridge.request({ method: "GET", path: "/issues.json" });
    expect(r).toMatchObject({ ok: true, json: { echo: "/issues.json" } });
  });

  it("answers ping with pong", async () => {
    const { port } = await boot();
    const ws = connect(port);
    await opened(ws);
    const got = new Promise<string>((res) => ws.on("message", (d) => res(JSON.parse(d.toString()).type)));
    ws.send(JSON.stringify({ type: "ping" }));
    expect(await got).toBe("pong");
  });

  it("times out when the extension is silent", async () => {
    const { port, app } = await boot({ requestTimeoutMs: 100 });
    await opened(connect(port));
    await until(() => app.bridge.connected);
    expect(await app.bridge.request({ method: "GET", path: "/issues.json" })).toMatchObject({
      ok: false,
      error: { code: "TIMEOUT" },
    });
  });

  it("fails pending requests when the extension disconnects", async () => {
    const { port, app } = await boot();
    const ws = connect(port);
    await opened(ws);
    await until(() => app.bridge.connected);
    const p = app.bridge.request({ method: "GET", path: "/issues.json" });
    ws.close();
    expect(await p).toMatchObject({ ok: false, error: { code: "NETWORK" } });
  });

  it("fails requests pending on a socket that gets replaced", async () => {
    const { port, app } = await boot();
    const a = connect(port);
    await opened(a);
    await until(() => app.bridge.connected);
    const pending = app.bridge.request({ method: "GET", path: "/issues.json" });
    await opened(connect(port));
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: "NETWORK", message: expect.stringContaining("reconnected") },
    });
  });

  it("ignores non-object and malformed messages without crashing", async () => {
    const { port, app } = await boot();
    const ws = connect(port);
    await opened(ws);
    for (const junk of ["null", "42", '"x"', "{not json"]) ws.send(junk);
    ws.send(JSON.stringify({ type: "hello", version: "1", build: "b" }));
    await until(() => app.bridge.hello?.build === "b");
    expect(app.bridge.connected).toBe(true);
  });

  it("a newer connection replaces the older one", async () => {
    const { port, app } = await boot();
    const a = connect(port);
    await opened(a);
    await until(() => app.bridge.connected);
    const closed = new Promise<void>((res) => a.on("close", () => res()));
    const b = connect(port);
    await opened(b);
    await closed;
    expect(app.bridge.connected).toBe(true);
  });
});
