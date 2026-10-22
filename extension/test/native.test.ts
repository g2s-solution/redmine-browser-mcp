import { describe, expect, it, vi } from "vitest";
import { startNativeLink, type NativePortLike } from "../src/native.js";

function fakePort() {
  const messageCbs: Array<(m: unknown) => void> = [];
  const disconnectCbs: Array<() => void> = [];
  const sent: any[] = [];
  const port: NativePortLike & { sent: any[]; emit(m: unknown): void; drop(): void; disconnected: boolean } = {
    sent,
    disconnected: false,
    postMessage: (m) => sent.push(m),
    disconnect() {
      port.disconnected = true;
    },
    onMessage: { addListener: (cb) => messageCbs.push(cb) },
    onDisconnect: { addListener: (cb) => disconnectCbs.push(cb) },
    emit: (m) => messageCbs.forEach((cb) => cb(m)),
    drop: () => disconnectCbs.forEach((cb) => cb()),
  };
  return port;
}

const never = async () => {
  throw new Error("unused");
};

describe("startNativeLink", () => {
  it("says hello, goes online on the first pong, and answers http requests", async () => {
    const port = fakePort();
    const states: boolean[] = [];
    startNativeLink({
      connect: () => port,
      handle: async (m) => ({ id: m.id, type: "http-result", ok: true, status: 200, json: { path: m.path } }),
      onUnavailable: () => {},
      onStatus: (c) => states.push(c),
      version: "9",
      build: "b",
    });
    expect(port.sent[0]).toEqual({ type: "hello", version: "9", build: "b" });
    expect(port.sent[1]).toEqual({ type: "ping" });
    port.emit({ type: "pong" });
    port.emit({ type: "pong" });
    expect(states).toEqual([true]);
    port.emit({ id: "3", type: "http", method: "GET", path: "/issues.json" });
    await vi.waitFor(() =>
      expect(port.sent.at(-1)).toMatchObject({ id: "3", ok: true, json: { path: "/issues.json" } }),
    );
  });

  it("reports the host unavailable when connect throws or the port drops before any answer", () => {
    const a = vi.fn();
    startNativeLink({
      connect: () => {
        throw new Error("Specified native messaging host not found.");
      },
      handle: never,
      onUnavailable: a,
    });
    expect(a).toHaveBeenCalledWith(expect.stringContaining("not found"));

    const port = fakePort();
    const b = vi.fn();
    startNativeLink({ connect: () => port, handle: never, onUnavailable: b });
    port.drop();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("reconnects after a working connection is lost", async () => {
    const ports = [fakePort(), fakePort()];
    let n = 0;
    const states: boolean[] = [];
    const unavailable = vi.fn();
    startNativeLink({
      connect: () => ports[n++],
      handle: never,
      onUnavailable: unavailable,
      onStatus: (c) => states.push(c),
      maxBackoffMs: 20,
    });
    ports[0].emit({ type: "pong" });
    ports[0].drop();
    await vi.waitFor(() => expect(n).toBe(2));
    ports[1].emit({ type: "pong" });
    expect(states).toEqual([true, false, true]);
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("stop() disconnects and prevents any further reconnect", async () => {
    const port = fakePort();
    let n = 0;
    const link = startNativeLink({
      connect: () => (n++, port),
      handle: never,
      onUnavailable: () => {},
      maxBackoffMs: 10,
    });
    port.emit({ type: "pong" });
    link.stop();
    expect(port.disconnected).toBe(true);
    port.drop();
    await new Promise((r) => setTimeout(r, 60));
    expect(n).toBe(1);
  });
});
