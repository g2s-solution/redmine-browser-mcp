import { BUILD } from "./build.js";
import type { FromExtension, HttpRequestMsg, HttpResultMsg, ToExtension } from "../../shared/protocol.js";

export interface LinkOptions {
  url: string;
  handle: (msg: HttpRequestMsg) => Promise<HttpResultMsg>;
  WebSocketCtor?: typeof WebSocket;
  pingMs?: number;
  maxBackoffMs?: number;
  version?: string;
  onStatus?: (connected: boolean) => void;
}

export function startLink(opts: LinkOptions): { stop(): void } {
  const WS = opts.WebSocketCtor ?? WebSocket;
  const pingMs = opts.pingMs ?? 20_000;
  const maxBackoff = opts.maxBackoffMs ?? 30_000;
  let ws: WebSocket | null = null;
  let stopped = false;
  let backoff = 500;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const send = (m: FromExtension) => {
    if (ws?.readyState === 1) ws.send(JSON.stringify(m));
  };

  const connect = () => {
    if (stopped) return;
    const sock = new WS(opts.url);
    ws = sock;
    sock.onopen = () => {
      backoff = 500;
      opts.onStatus?.(true);
      send({ type: "hello", version: opts.version ?? "dev", build: BUILD });
      pingTimer = setInterval(() => send({ type: "ping" }), pingMs);
    };
    sock.onmessage = (ev) => {
      let msg: ToExtension;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "http") void opts.handle(msg).then(send);
    };
    let settled = false;
    const onGone = () => {
      if (settled) return;
      settled = true;
      clearInterval(pingTimer);
      if (!stopped) opts.onStatus?.(false);
      if (ws === sock) ws = null;
      if (stopped) return;
      retryTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, maxBackoff);
    };
    // Runtimes differ on whether a failed handshake also fires "close", so either event schedules the retry (once).
    sock.onclose = onGone;
    sock.onerror = onGone;
  };

  connect();
  return {
    stop() {
      stopped = true;
      clearInterval(pingTimer);
      clearTimeout(retryTimer);
      ws?.close();
    },
  };
}
