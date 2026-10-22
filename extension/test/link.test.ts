import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { startLink } from "../src/link.js";

const until = async (cond: () => boolean, ms = 3000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

let closers: Array<() => void> = [];
afterEach(() => {
  closers.forEach((c) => c());
  closers = [];
});

function server(port = 0) {
  const sockets: WsSocket[] = [];
  const received: any[] = [];
  const wss = new WebSocketServer({ port });
  wss.on("connection", (s) => {
    sockets.push(s);
    s.on("message", (d) => received.push(JSON.parse(d.toString())));
  });
  closers.push(() => {
    wss.clients.forEach((c) => c.terminate());
    wss.close();
  });
  return { wss, sockets, received, port: () => (wss.address() as any).port as number };
}

describe("startLink", () => {
  it("sends hello, answers http requests, and pings", async () => {
    const s = server();
    await new Promise((r) => s.wss.once("listening", r));
    const handle = async (m: any) => ({
      id: m.id,
      type: "http-result" as const,
      ok: true as const,
      status: 200,
      json: { path: m.path },
    });
    const link = startLink({ url: `ws://127.0.0.1:${s.port()}`, handle, pingMs: 30 });
    closers.push(() => link.stop());
    await until(() => s.sockets.length === 1);
    s.sockets[0].send(JSON.stringify({ id: "7", type: "http", method: "GET", path: "/issues.json" }));
    await until(() => s.received.some((m) => m.type === "http-result"));
    expect(s.received[0]).toMatchObject({ type: "hello", build: "dev" });
    expect(s.received.find((m) => m.type === "http-result")).toMatchObject({
      id: "7",
      ok: true,
      json: { path: "/issues.json" },
    });
    await until(() => s.received.some((m) => m.type === "ping"));
  });

  it("does not report a disconnect after stop()", async () => {
    const s = server();
    await new Promise((r) => s.wss.once("listening", r));
    const states: boolean[] = [];
    const link = startLink({
      url: `ws://127.0.0.1:${s.port()}`,
      handle: async () => {
        throw new Error("unused");
      },
      onStatus: (c) => states.push(c),
    });
    await until(() => states.includes(true));
    link.stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(states).toEqual([true]);
  });

  it("reconnects after the server drops the connection", async () => {
    const s = server();
    await new Promise((r) => s.wss.once("listening", r));
    const states: boolean[] = [];
    const link = startLink({
      url: `ws://127.0.0.1:${s.port()}`,
      handle: async () => {
        throw new Error("unused");
      },
      maxBackoffMs: 50,
      onStatus: (c) => states.push(c),
    });
    closers.push(() => link.stop());
    await until(() => s.sockets.length === 1);
    s.sockets[0].terminate();
    await until(() => s.sockets.length === 2, 5000);
    expect(states).toContain(false);
  });

  it("keeps retrying until the server appears, and stop() ends it", async () => {
    const probe = server();
    await new Promise((r) => probe.wss.once("listening", r));
    const port = probe.port();
    probe.wss.close();
    probe.wss.clients.forEach((c) => c.terminate());
    await new Promise((r) => setTimeout(r, 50));
    const link = startLink({
      url: `ws://127.0.0.1:${port}`,
      handle: async () => {
        throw new Error("unused");
      },
      maxBackoffMs: 50,
    });
    closers.push(() => link.stop());
    await new Promise((r) => setTimeout(r, 150));
    const s = server(port);
    await until(() => s.sockets.length === 1, 5000);
    link.stop();
    await until(() => s.wss.clients.size === 0);
  });
});
