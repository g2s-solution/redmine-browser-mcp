import type { FromExtension, HttpRequestMsg, HttpResultMsg, ToExtension } from "../../shared/protocol.js";

export const NATIVE_HOST_NAME = "com.redmine_bridge.daemon";

// The subset of chrome.runtime.Port that the link uses (also what the tests fake).
export interface NativePortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(cb: (message: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

export interface NativeLinkOptions {
  connect: () => NativePortLike;
  handle: (msg: HttpRequestMsg) => Promise<HttpResultMsg>;
  // Called once if the host never answered (not installed, or it exited because the port is taken).
  onUnavailable: (reason: string) => void;
  onStatus?: (connected: boolean) => void;
  version?: string;
  build?: string;
  pingMs?: number;
  maxBackoffMs?: number;
  // A reload starts the new host while the old one is still releasing the port, so a host that exits before it
  // ever answered is retried a few times before the link gives up on native.
  startAttempts?: number;
  startRetryMs?: number;
}

export function startNativeLink(opts: NativeLinkOptions): { stop(): void } {
  const pingMs = opts.pingMs ?? 20_000;
  const maxBackoff = opts.maxBackoffMs ?? 30_000;
  let port: NativePortLike | null = null;
  let stopped = false;
  let everConnected = false;
  let failedStarts = 0;
  const startAttempts = opts.startAttempts ?? 3;
  const startRetryMs = opts.startRetryMs ?? 600;
  let backoff = 500;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const send = (p: NativePortLike, m: FromExtension) => {
    try {
      p.postMessage(m);
    } catch {
      // the port closed under us; onDisconnect follows
    }
  };

  const open = () => {
    if (stopped) return;
    let p: NativePortLike;
    try {
      p = opts.connect();
    } catch (e) {
      return opts.onUnavailable(e instanceof Error ? e.message : String(e));
    }
    port = p;
    let answered = false;
    p.onMessage.addListener((raw) => {
      const msg = raw as ToExtension;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "pong") {
        if (!answered) {
          answered = true;
          everConnected = true;
          backoff = 500;
          opts.onStatus?.(true);
        }
      } else if (msg.type === "http") void opts.handle(msg).then((r) => send(p, r));
    });
    p.onDisconnect.addListener(() => {
      clearInterval(pingTimer);
      if (port === p) port = null;
      if (stopped) return;
      if (answered) opts.onStatus?.(false);
      if (!answered && !everConnected) {
        failedStarts++;
        if (failedStarts >= startAttempts) return opts.onUnavailable("native host did not start");
        retryTimer = setTimeout(open, startRetryMs * failedStarts);
        return;
      }
      retryTimer = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, maxBackoff);
    });
    send(p, { type: "hello", version: opts.version ?? "dev", build: opts.build });
    send(p, { type: "ping" });
    pingTimer = setInterval(() => send(p, { type: "ping" }), pingMs);
  };

  open();
  return {
    stop() {
      stopped = true;
      clearInterval(pingTimer);
      clearTimeout(retryTimer);
      port?.disconnect();
    },
  };
}
