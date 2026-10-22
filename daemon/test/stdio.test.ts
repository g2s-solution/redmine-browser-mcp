import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { relay } from "../src/stdio.js";
import { startApp } from "./helpers.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function run(port: number, lines: object[]): Promise<any[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (d) => chunks.push(String(d)));
  const done = relay(input, output, port);
  for (const l of lines) input.write(JSON.stringify(l) + "\n");
  input.end();
  await done;
  return chunks
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const init = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

describe("stdio relay", () => {
  it("forwards requests to the daemon and ignores notifications", async () => {
    const { app, port } = await startApp();
    closers.push(() => app.close());
    const out = await run(port, [
      init,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    expect(out.map((m) => m.id)).toEqual(expect.arrayContaining([1, 2]));
    expect(out).toHaveLength(2);
    expect(out.find((m) => m.id === 2).result.tools.map((t: any) => t.name)).toContain("get_issue");
  });

  it("answers with a JSON-RPC error when the daemon is not running", async () => {
    const { app, port } = await startApp();
    await app.close();
    const out = await run(port, [{ jsonrpc: "2.0", id: 7, method: "tools/list" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 7, error: { code: -32000 } });
    expect(out[0].error.message).toContain("npm run daemon");
  });

  it("skips malformed lines", async () => {
    const { app, port } = await startApp();
    closers.push(() => app.close());
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (d) => chunks.push(String(d)));
    const done = relay(input, output, port);
    input.write("not json\n");
    input.end();
    await done;
    expect(chunks).toEqual([]);
  });

  it("works as a spawned process even when HTTPS_PROXY points somewhere unreachable", async () => {
    const { app, port } = await startApp();
    closers.push(() => app.close());
    const child = spawn("npx", ["tsx", "daemon/src/stdio.ts"], {
      env: {
        ...process.env,
        REDMINE_MCP_PORT: String(port),
        HTTPS_PROXY: "http://127.0.0.1:9",
        HTTP_PROXY: "http://127.0.0.1:9",
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stdin.end(JSON.stringify(init) + "\n");
    await new Promise((r) => child.on("close", r));
    expect(JSON.parse(out.trim())).toMatchObject({ id: 1, result: { serverInfo: { name: "redmine-bridge" } } });
  });
});
