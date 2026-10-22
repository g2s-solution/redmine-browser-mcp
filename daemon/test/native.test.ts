import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { extensionIdFromKey } from "../../shared/extensionId.js";
import { encodeFrame, FrameDecoder } from "../../shared/native.js";
import { Bridge } from "../src/bridge.js";
import {
  hostManifest,
  install,
  launcherScript,
  manifestDirs,
  readExtensionId,
  uninstall,
} from "../src/install-host.js";
import { until } from "./helpers.js";

const repoDir = resolve(import.meta.dirname, "..", "..");

describe("native framing", () => {
  it("round-trips, including multi-byte text", () => {
    const d = new FrameDecoder();
    expect(d.push(encodeFrame('{"a":"héllo ✓"}'))).toEqual(['{"a":"héllo ✓"}']);
  });

  it("reassembles frames split at any byte boundary and several frames per chunk", () => {
    const wire = Buffer.concat([encodeFrame('{"n":1}'), encodeFrame('{"n":2}'), encodeFrame('{"n":3}')]);
    const d = new FrameDecoder();
    const out: string[] = [];
    for (let i = 0; i < wire.length; i++) out.push(...d.push(wire.subarray(i, i + 1)));
    expect(out).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
    expect(new FrameDecoder().push(wire)).toHaveLength(3);
  });

  it("enforces size limits in both directions", () => {
    expect(() => encodeFrame("x".repeat(20), 10)).toThrow(/limit/);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(100);
    expect(() => new FrameDecoder(50).push(header)).toThrow(/limit/);
  });
});

describe("Bridge over a native channel", () => {
  function setup() {
    const toHost = new PassThrough();
    const fromHost = new PassThrough();
    const bridge = new Bridge({ requestTimeoutMs: 500 });
    bridge.attachNative(toHost, fromHost);
    const decoder = new FrameDecoder();
    const received: any[] = [];
    fromHost.on("data", (c) => received.push(...decoder.push(c).map((s) => JSON.parse(s))));
    return { toHost, fromHost, bridge, received };
  }

  it("sends requests as frames and settles on the framed reply", async () => {
    const { toHost, bridge, received } = setup();
    expect(bridge.connected).toBe(true);
    const p = bridge.request({ method: "GET", path: "/issues.json" });
    await until(() => received.length === 1);
    expect(received[0]).toMatchObject({ type: "http", method: "GET", path: "/issues.json" });
    toHost.write(
      encodeFrame(JSON.stringify({ id: received[0].id, type: "http-result", ok: true, status: 200, json: { ok: 1 } })),
    );
    expect(await p).toMatchObject({ ok: true, json: { ok: 1 } });
  });

  it("answers ping, records hello, and ignores junk frames", async () => {
    const { toHost, bridge, received } = setup();
    toHost.write(encodeFrame("not json"));
    toHost.write(encodeFrame("null"));
    toHost.write(encodeFrame(JSON.stringify({ type: "hello", version: "1", build: "b" })));
    toHost.write(encodeFrame(JSON.stringify({ type: "ping" })));
    await until(() => received.some((m) => m.type === "pong"));
    expect(bridge.hello).toEqual({ version: "1", build: "b" });
  });

  it("fails pending requests and reports disconnected when Chrome closes the pipe", async () => {
    const { toHost, bridge } = setup();
    const p = bridge.request({ method: "GET", path: "/issues.json" });
    toHost.end();
    expect(await p).toMatchObject({ ok: false, error: { code: "NETWORK" } });
    await until(() => !bridge.connected);
  });

  it("drops the channel on an oversized frame", async () => {
    const { toHost, bridge } = setup();
    const bad = Buffer.alloc(4);
    bad.writeUInt32LE(0xffffffff);
    toHost.write(bad);
    await until(() => !bridge.connected);
  });
});

describe("native host process", () => {
  const children: Array<{ kill(): void }> = [];
  afterEach(() => children.splice(0).forEach((c) => c.kill()));

  function startHost(port: number) {
    const child = spawn("npx", ["tsx", "daemon/src/native-host.ts"], {
      cwd: repoDir,
      env: {
        ...process.env,
        REDMINE_MCP_PORT: String(port),
        REDMINE_MCP_STATE_DIR: mkdtempSync(join(tmpdir(), "rmcp-")),
      },
    });
    children.push(child);
    const decoder = new FrameDecoder();
    const frames: any[] = [];
    child.stdout.on("data", (c) => frames.push(...decoder.push(c).map((s) => JSON.parse(s))));
    return { child, frames };
  }

  it("serves MCP on loopback and relays tool calls to the extension over stdio", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const { child, frames } = startHost(port);
    child.stdin.write(encodeFrame(JSON.stringify({ type: "ping" })));
    await until(() => frames.some((f) => f.type === "pong"), 15000);

    const call = fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_current_user", arguments: {} },
      }),
    }).then((r) => r.json() as Promise<any>);
    await until(() => frames.some((f) => f.type === "http"), 5000);
    const req = frames.find((f) => f.type === "http");
    expect(req).toMatchObject({ method: "GET", path: "/users/current.json" });
    child.stdin.write(
      encodeFrame(
        JSON.stringify({
          id: req.id,
          type: "http-result",
          ok: true,
          status: 200,
          json: { user: { id: 5, login: "u", firstname: "A", lastname: "B", mail: "m@x" } },
        }),
      ),
    );
    const body = await call;
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({ id: 5, login: "u" });
  }, 40000);

  it("exits when Chrome closes stdin, and exits non-zero if the port is taken", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const first = startHost(port);
    first.child.stdin.write(encodeFrame(JSON.stringify({ type: "ping" })));
    await until(() => first.frames.some((f) => f.type === "pong"), 15000);

    const second = startHost(port);
    const code = await new Promise<number | null>((r) => second.child.on("exit", r));
    expect(code).toBe(1);

    first.child.stdin.end();
    await new Promise<void>((r) => first.child.on("exit", () => r()));
  }, 40000);
});

describe("installer", () => {
  const home = () => mkdtempSync(join(tmpdir(), "rmcp-home-"));

  it("derives the extension id from the manifest key", () => {
    expect(readExtensionId(repoDir)).toMatch(/^[a-p]{32}$/);
    expect(readExtensionId(repoDir)).toBe(
      extensionIdFromKey(JSON.parse(readFileSync(join(repoDir, "extension/manifest.json"), "utf8")).key),
    );
  });

  it("keeps the published extension id stable", () => {
    // Changing extension/manifest.json "key" changes this id and breaks every installed native host manifest.
    expect(readExtensionId(repoDir)).toBe("nhcphgmoomfcfoakphjjjpdbbdjeioaj");
  });

  it("writes a launcher and a manifest only for browsers that exist", () => {
    const h = home();
    mkdirSync(join(h, ".config", "google-chrome"), { recursive: true });
    mkdirSync(join(h, ".config", "chromium"), { recursive: true });
    const r = install({ repoDir, nodePath: process.execPath, home: h, platform: "linux", readOnly: true, port: 7400 });
    expect(r.manifests).toHaveLength(2);
    const manifest = JSON.parse(readFileSync(r.manifests[0], "utf8"));
    expect(manifest).toMatchObject({
      name: "com.redmine_bridge.daemon",
      type: "stdio",
      path: r.launcher,
      allowed_origins: [`chrome-extension://${r.extensionId}/`],
    });
    expect(statSync(r.launcher).mode & 0o111).not.toBe(0);
    const script = readFileSync(r.launcher, "utf8");
    expect(script).toContain("export READ_ONLY=1");
    expect(script).toContain("export REDMINE_MCP_PORT=7400");
    expect(script).toContain("daemon/src/native-host.ts");
    expect(uninstall(h, "linux")).toHaveLength(2);
    expect(existsSync(r.launcher)).toBe(false);
  });

  it("fails clearly with no browser profile, on Windows, and for unsafe paths", () => {
    expect(() => install({ repoDir, nodePath: process.execPath, home: home(), platform: "linux" })).toThrow(
      /no Chrome/,
    );
    expect(() => manifestDirs(home(), "win32")).toThrow(/not supported/);
    expect(() =>
      launcherScript({ repoDir: '/tmp/a"b', nodePath: "/usr/bin/node", home: "/h", platform: "linux" }),
    ).toThrow(/cannot be used/);
  });

  it("host manifest only allows the extension origin", () => {
    expect(hostManifest("abc", "/p")).toMatchObject({ allowed_origins: ["chrome-extension://abc/"] });
  });
});
