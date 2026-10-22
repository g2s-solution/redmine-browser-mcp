import type { IncomingMessage } from "node:http";
import type { Duplex, Readable, Writable } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { encodeFrame, FrameDecoder } from "../../shared/native.js";
import type { FromExtension, HttpRequestMsg, HttpResultMsg } from "../../shared/protocol.js";

export interface BridgeOptions {
  requestTimeoutMs: number;
  allowedExtensionId?: string;
  log?: (msg: string) => void;
}

// One live connection to the extension: a WebSocket, or Chrome's Native Messaging pipe.
interface Channel {
  send(json: string): void;
  close(): void;
  isOpen(): boolean;
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
  private channel: Channel | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  hello: { version: string; build?: string } | null = null;

  constructor(private opts: BridgeOptions) {}

  get connected(): boolean {
    return this.channel?.isOpen() ?? false;
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
    const link = this.adopt({
      send: (json) => ws.send(json),
      close: () => ws.close(1000, "replaced"),
      isOpen: () => ws.readyState === WebSocket.OPEN,
    });
    ws.on("message", (data) => link.onMessage(data.toString()));
    ws.on("close", link.onClose);
  }

  // Chrome starts this process and talks to it over stdin/stdout; ending stdin means Chrome closed the port.
  attachNative(input: Readable, output: Writable): void {
    const decoder = new FrameDecoder();
    let open = true;
    const link = this.adopt({
      send: (json) => output.write(encodeFrame(json)),
      close: () => {
        open = false;
      },
      isOpen: () => open,
    });
    input.on("data", (chunk: Buffer) => {
      try {
        for (const raw of decoder.push(chunk)) link.onMessage(raw);
      } catch (e) {
        this.opts.log?.(`native channel closed: ${e instanceof Error ? e.message : String(e)}`);
        input.destroy();
      }
    });
    const gone = () => {
      open = false;
      link.onClose();
    };
    input.on("end", gone);
    input.on("close", gone);
  }

  private adopt(channel: Channel): { onMessage: (raw: string) => void; onClose: () => void } {
    if (this.channel) {
      this.failAll("extension reconnected; resend the request");
      this.channel.close();
    }
    this.channel = channel;
    this.opts.log?.("extension connected");
    return {
      onMessage: (raw) => {
        let msg: FromExtension;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "hello") this.hello = { version: msg.version, build: msg.build };
        else if (msg.type === "ping") channel.send(JSON.stringify({ type: "pong" }));
        else if (msg.type === "http-result") this.settle(msg);
      },
      onClose: () => {
        if (this.channel !== channel) return;
        this.channel = null;
        this.hello = null;
        this.opts.log?.("extension disconnected");
        this.failAll("extension disconnected");
      },
    };
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
        resolve({
          id,
          type: "http-result",
          ok: false,
          error: { code: "TIMEOUT", message: "extension did not answer in time" },
        });
      }, this.opts.requestTimeoutMs);
      this.pending.set(id, { resolve, timer });
      this.channel!.send(JSON.stringify({ ...req, id, type: "http" } satisfies HttpRequestMsg));
    });
  }

  close(): void {
    this.failAll("bridge closing");
    this.channel?.close();
    this.wss.close();
  }
}
