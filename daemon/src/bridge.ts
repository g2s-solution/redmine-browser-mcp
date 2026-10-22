import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { FromExtension, HttpRequestMsg, HttpResultMsg } from "../../shared/protocol.js";

export interface BridgeOptions {
  requestTimeoutMs: number;
  allowedExtensionId?: string;
  log?: (msg: string) => void;
}

interface Pending {
  resolve: (r: HttpResultMsg) => void;
  timer: NodeJS.Timeout;
}

export function originAllowed(origin: string | undefined, extensionId?: string): boolean {
  if (origin === undefined || !origin.startsWith("chrome-extension://")) return false;
  return extensionId ? origin === `chrome-extension://${extensionId}` : true;
}

export class Bridge {
  private wss = new WebSocketServer({ noServer: true });
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  hello: { version: string; build?: string } | null = null;

  constructor(private opts: BridgeOptions) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const reject = (code: number, text: string) => {
      this.opts.log?.(`extension connection rejected: ${code} ${text} (origin: ${req.headers.origin ?? "none"})`);
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== "/ext") return reject(404, "Not Found");
    if (!originAllowed(req.headers.origin, this.opts.allowedExtensionId)) return reject(403, "Forbidden");
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws));
  }

  private attach(ws: WebSocket): void {
    this.socket?.close(1000, "replaced");
    this.socket = ws;
    this.opts.log?.("extension connected");
    ws.on("message", (data) => {
      let msg: FromExtension;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "hello") this.hello = { version: msg.version, build: msg.build };
      else if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      else if (msg.type === "http-result") this.settle(msg);
    });
    ws.on("close", () => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.hello = null;
      this.opts.log?.("extension disconnected");
      this.failAll("extension disconnected");
    });
  }

  private settle(msg: HttpResultMsg): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    p.resolve(msg);
  }

  private failAll(message: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ id, type: "http-result", ok: false, error: { code: "NETWORK", message } });
    }
    this.pending.clear();
  }

  request(req: Omit<HttpRequestMsg, "id" | "type">): Promise<HttpResultMsg> {
    const id = String(++this.seq);
    if (!this.connected) {
      return Promise.resolve({
        id,
        type: "http-result",
        ok: false,
        error: {
          code: "NOT_CONNECTED",
          message: "Chrome extension is not connected. Open Chrome with the Redmine bridge extension enabled.",
        },
      });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, type: "http-result", ok: false, error: { code: "TIMEOUT", message: "extension did not answer in time" } });
      }, this.opts.requestTimeoutMs);
      this.pending.set(id, { resolve, timer });
      this.socket!.send(JSON.stringify({ ...req, id, type: "http" } satisfies HttpRequestMsg));
    });
  }

  close(): void {
    this.failAll("bridge closing");
    this.socket?.close();
    this.wss.close();
  }
}
