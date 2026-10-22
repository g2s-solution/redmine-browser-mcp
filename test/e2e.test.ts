import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RedmineExecutor } from "../extension/src/core.js";
import { startLink } from "../extension/src/link.js";
import { WebSocket as WsClient } from "ws";
import { EXT_ORIGIN, startApp, until } from "../daemon/test/helpers.js";

class ExtensionWebSocket extends WsClient {
  constructor(url: string) {
    super(url, { origin: EXT_ORIGIN });
  }
}

const CSRF = "csrf-abc";
const KEY = "0123456789abcdef0123456789abcdef01234567";

function fakeRedmine() {
  const state = {
    deleted: [] as number[],
    key: KEY,
    loggedIn: true,
    issueStatus: "New",
    notes: [] as string[],
    writes: 0,
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const send = (status: number, body: unknown, type = "application/json") =>
      res.writeHead(status, { "content-type": type }).end(typeof body === "string" ? body : JSON.stringify(body));
    if (!state.loggedIn) return void res.writeHead(302, { location: "https://sso.example/login" }).end();
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (url.pathname === "/my/api_key")
        return send(200, `<pre id="api-access-key" class="autoscroll">${state.key}</pre>`, "text/html");
      if (url.pathname === "/my/account")
        return send(200, `<html><head><meta name="csrf-token" content="${CSRF}" /></head></html>`, "text/html");
      if (url.pathname.endsWith(".json") && req.headers["x-redmine-api-key"] !== state.key) {
        return void res
          .writeHead(401, { "content-type": "application/json", "www-authenticate": 'Basic realm="Redmine API"' })
          .end();
      }
      if (url.pathname === "/users/current.json")
        return send(200, {
          user: { id: 5, login: "khoi", firstname: "Khoi", lastname: "N", mail: "k@x", api_key: state.key },
        });
      if (url.pathname === "/issues.json" && req.method === "GET") {
        return send(200, {
          total_count: 1,
          offset: 0,
          issues: [
            {
              id: 1,
              subject: `q=${url.searchParams.get("status_id")}`,
              status: { name: state.issueStatus },
              project: { name: "P" },
            },
          ],
        });
      }
      if (url.pathname === "/issues/2.json" && req.method === "DELETE") {
        if (req.headers["x-csrf-token"] !== CSRF) return send(422, "", "text/plain");
        state.deleted.push(2);
        return void res.writeHead(204).end();
      }
      if (url.pathname === "/issues/1.json" && req.method === "PUT") {
        if (req.headers["x-csrf-token"] !== CSRF) return send(422, "", "text/plain");
        const issue = JSON.parse(raw).issue;
        state.writes++;
        if (issue.status_id === 99) return send(422, { errors: ["Status is invalid"] });
        if (issue.status_id === 2) state.issueStatus = "In Progress";
        if (issue.notes) state.notes.push(issue.notes);
        return void res.writeHead(204).end();
      }
      send(404, {});
    });
  });
  return new Promise<{ server: Server; state: typeof state; url: string }>((r) =>
    server.listen(0, "127.0.0.1", () =>
      r({ server, state, url: `http://127.0.0.1:${(server.address() as any).port}` }),
    ),
  );
}

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

async function stack(over = {}) {
  const rm = await fakeRedmine();
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        rm.server.close(() => r());
        rm.server.closeAllConnections();
      }),
  );
  const { app, port, config } = await startApp(over);
  cleanup.push(() => app.close());
  const ex = new RedmineExecutor(fetch, rm.url);
  const link = startLink({
    url: `ws://127.0.0.1:${port}/ext`,
    WebSocketCtor: ExtensionWebSocket as any,
    handle: (m) => ex.handle(m),
  });
  cleanup.push(() => link.stop());
  await until(() => app.bridge.connected);
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  cleanup.push(() => client.close());
  const call = async (name: string, args: any = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, text: r.content[0].text as string };
  };
  return { rm, port, config, client, call };
}

describe("end to end: MCP client -> daemon -> extension core -> fake Redmine", () => {
  it("reads the current user and lists issues", async () => {
    const { call } = await stack();
    expect(JSON.parse((await call("get_current_user")).text)).toMatchObject({ login: "khoi", name: "Khoi N" });
    const list = JSON.parse((await call("list_issues", { status: "*" })).text);
    expect(list.items[0]).toMatchObject({ id: 1, subject: "q=*", status: "New" });
  });

  it("updates an issue through CSRF and the change is visible on read", async () => {
    const { call, rm } = await stack();
    const r = await call("update_issue", { id: 1, status_id: 2, notes: "from claude" });
    expect(r.isError).toBe(false);
    expect(rm.state.notes).toEqual(["from claude"]);
    expect(JSON.parse((await call("list_issues")).text).items[0].status).toBe("In Progress");
  });

  it("deletes an issue only after the confirm_id guard, through CSRF", async () => {
    const { call, rm } = await stack();
    expect((await call("delete_issue", { id: 2, confirm_id: 3 })).isError).toBe(true);
    expect(rm.state.deleted).toEqual([]);
    expect((await call("delete_issue", { id: 2, confirm_id: 2 })).isError).toBe(false);
    expect(rm.state.deleted).toEqual([2]);
  });

  it("returns Redmine validation errors", async () => {
    const { call } = await stack();
    const r = await call("update_issue", { id: 1, status_id: 99 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Status is invalid");
  });

  it("never exposes the API key to the MCP client, even when Redmine echoes it", async () => {
    const { call } = await stack();
    const outputs = [
      await call("get_current_user"),
      await call("list_issues"),
      await call("update_issue", { id: 1, status_id: 99 }),
    ];
    for (const o of outputs) expect(o.text).not.toContain(KEY);
  });

  it("keeps working after the user's API key is regenerated", async () => {
    const { call, rm } = await stack();
    expect((await call("get_current_user")).isError).toBe(false);
    rm.state.key = "a".repeat(40);
    expect((await call("get_current_user")).isError).toBe(false);
  });

  it("reports AUTH_REQUIRED when the session expires, then recovers after login", async () => {
    const { call, rm } = await stack();
    rm.state.loggedIn = false;
    const r = await call("get_current_user");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("AUTH_REQUIRED");
    rm.state.loggedIn = true;
    expect((await call("get_current_user")).isError).toBe(false);
  });

  it("READ_ONLY exposes no write tools and never writes", async () => {
    const { client, rm } = await stack({ readOnly: true });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("update_issue");
    expect(rm.state.writes).toBe(0);
  });

  it("tells the caller when Chrome/extension is not connected", async () => {
    const { app, port } = await startApp();
    cleanup.push(() => app.close());
    const client = new Client({ name: "e2e", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    cleanup.push(() => client.close());
    const r: any = await client.callTool({ name: "get_current_user", arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("NOT_CONNECTED");
  });
});
