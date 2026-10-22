import { request } from "node:http";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

// Claude Code sends MCP-over-HTTP through HTTPS_PROXY, and a corporate proxy cannot reach 127.0.0.1 (503).
// A stdio server is spawned by Claude Code instead; node:http never uses the proxy variables, so this relay
// forwards each JSON-RPC message to the local daemon directly. The daemon is stateless, so one POST per message works.
function post(port: number, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function rpcError(id: unknown, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

export async function relay(input: Readable, output: Writable, port: number): Promise<void> {
  const inflight: Promise<void>[] = [];
  const handle = async (line: string) => {
    let id: unknown;
    try {
      id = JSON.parse(line)?.id;
    } catch {
      return;
    }
    try {
      const res = await post(port, line);
      if (res.status === 202 || !res.text.trim()) return;
      if (res.status !== 200) throw new Error(`daemon answered HTTP ${res.status}`);
      output.write(JSON.stringify(JSON.parse(res.text)) + "\n");
    } catch (e) {
      if (id === undefined) return;
      const why = e instanceof Error ? e.message : String(e);
      output.write(
        rpcError(id, `redmine daemon on 127.0.0.1:${port} failed (${why}); start it with "npm run daemon"`) + "\n",
      );
    }
  };
  for await (const line of createInterface({ input })) {
    if (line.trim()) inflight.push(handle(line));
  }
  await Promise.all(inflight);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await relay(process.stdin, process.stdout, Number(process.env.REDMINE_MCP_PORT ?? 7399));
}
