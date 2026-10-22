import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Bridge } from "./bridge.js";
import { createAudit } from "./audit.js";
import type { Config } from "./config.js";
import { createMcpServer } from "./mcp.js";
import { RedmineClient } from "./redmine.js";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString();
  return raw ? JSON.parse(raw) : undefined;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// Guards against DNS rebinding and cross-site requests from web pages: only loopback Host names, and no browser Origin on /mcp.
export function requestAllowed(req: IncomingMessage, isMcp: boolean): boolean {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!LOCAL_HOSTS.has(host)) return false;
  return !(isMcp && req.headers.origin !== undefined);
}

export interface App {
  server: Server;
  bridge: Bridge;
  listen(): Promise<number>;
  close(): Promise<void>;
}

export function createApp(config: Config): App {
  const bridge = new Bridge(config);
  const client = new RedmineClient(bridge);
  const audit = createAudit(config.auditPath);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!requestAllowed(req, url.pathname === "/mcp")) {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          ok: true,
          extensionConnected: bridge.connected,
          extension: bridge.hello,
          readOnly: config.readOnly,
        }),
      );
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    try {
      const body = await readJson(req);
      const mcp = createMcpServer({ client, readOnly: config.readOnly, audit });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(400).end(String(e instanceof Error ? e.message : e));
    }
  });
  server.on("upgrade", (req, socket, head) => {
    if (!requestAllowed(req, false)) {
      socket.destroy();
      return;
    }
    bridge.handleUpgrade(req, socket, head);
  });

  return {
    server,
    bridge,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
      }),
    close: () =>
      new Promise((resolve) => {
        bridge.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
