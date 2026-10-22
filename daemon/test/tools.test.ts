import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAudit } from "../src/audit.js";
import { createMcpServer } from "../src/mcp.js";
import { RedmineClient } from "../src/redmine.js";

type Req = { method: string; path: string; query?: Record<string, string>; body?: any };

async function setup(respond: (r: Req) => any, readOnly = false) {
  const calls: Req[] = [];
  const bridge = {
    request: vi.fn(async (r: Req) => {
      calls.push(r);
      return respond(r);
    }),
  };
  const auditPath = join(mkdtempSync(join(tmpdir(), "rmcp-")), "audit.log");
  const server = createMcpServer({ client: new RedmineClient(bridge as any), readOnly, audit: createAudit(auditPath) });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: any = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return {
      isError: r.isError,
      text: r.content[0].text as string,
      json: r.isError ? undefined : JSON.parse(r.content[0].text),
    };
  };
  return { client, call, calls, auditPath };
}
const ok = (json?: any) => ({ id: "1", type: "http-result", ok: true, status: json ? 200 : 204, json });
const fail = (code: string, message: string, details?: any) => ({
  id: "1",
  type: "http-result",
  ok: false,
  error: { code, message, details },
});

describe("read tools", () => {
  it("get_current_user shapes the user", async () => {
    const { call } = await setup(() =>
      ok({ user: { id: 5, login: "khoi", firstname: "K", lastname: "N", mail: "k@x", api_key: "SECRET" } }),
    );
    const r = await call("get_current_user");
    expect(r.json).toEqual({ id: 5, login: "khoi", name: "K N", mail: "k@x" });
    expect(r.text).not.toContain("SECRET");
  });

  it("list_issues maps filters to Redmine query params", async () => {
    const { call, calls } = await setup(() =>
      ok({
        total_count: 1,
        offset: 0,
        issues: [{ id: 1, project: { name: "P" }, status: { name: "New" }, subject: "S", assigned_to: { name: "Me" } }],
      }),
    );
    const r = await call("list_issues", {
      project_id: "p1",
      assigned_to_id: "me",
      updated_since: "2026-01-02",
      subject_contains: "bug",
      status: "*",
    });
    expect(calls[0].query).toMatchObject({
      project_id: "p1",
      assigned_to_id: "me",
      status_id: "*",
      updated_on: ">=2026-01-02",
      subject: "~bug",
      limit: "25",
    });
    expect(r.json.items[0]).toMatchObject({ id: 1, project: "P", status: "New", assignee: "Me" });
  });

  it("get_issue requests includes and clips long journals", async () => {
    const long = "x".repeat(5000);
    const { call, calls } = await setup(() =>
      ok({
        issue: {
          id: 9,
          subject: "S",
          journals: [
            {
              id: 1,
              user: { name: "U" },
              notes: long,
              private_notes: true,
              details: [{ property: "attr", name: "status_id", old_value: "1", new_value: "2" }],
            },
          ],
        },
      }),
    );
    const r = await call("get_issue", { id: 9 });
    expect(calls[0].path).toBe("/issues/9.json");
    expect(calls[0].query?.include).toContain("journals");
    expect(r.json.journals[0].notes.length).toBeLessThan(2100);
    expect(r.json.journals[0]).toMatchObject({ private: true, changes: [{ name: "status_id", new: "2" }] });
  });

  it("reports an empty Redmine response clearly instead of throwing a TypeError", async () => {
    const { call } = await setup(() => ok());
    const r = await call("get_current_user");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("no user");
    expect((await call("get_issue", { id: 1 })).text).toContain("no issue");
  });

  it("validates arguments", async () => {
    const { call } = await setup(() => ok({}));
    const r = await call("get_issue", { id: -1 });
    expect(r.isError).toBe(true);
  });

  it("surfaces bridge errors as tool errors", async () => {
    const { call } = await setup(() => fail("AUTH_REQUIRED", "log in again"));
    const r = await call("get_current_user");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("AUTH_REQUIRED");
  });

  it("list_statuses and list_project_members", async () => {
    const { call } = await setup((r) =>
      r.path === "/issue_statuses.json"
        ? ok({ issue_statuses: [{ id: 1, name: "New", is_closed: false }] })
        : ok({ total_count: 1, memberships: [{ user: { id: 2, name: "A" }, roles: [{ name: "Dev" }] }] }),
    );
    expect((await call("list_statuses")).json.items[0]).toEqual({ id: 1, name: "New", is_closed: false });
    expect((await call("list_project_members", { project_id: "p" })).json.items[0]).toEqual({
      user: { id: 2, name: "A" },
      group: null,
      roles: ["Dev"],
    });
  });
});

describe("write tools", () => {
  it("update_issue sends only provided fields and audits", async () => {
    const { call, calls, auditPath } = await setup(() => ok());
    const r = await call("update_issue", { id: 3, status_id: 2, notes: "done" });
    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: "/issues/3.json",
      body: { issue: { status_id: 2, notes: "done" } },
    });
    expect(r.json).toEqual({ ok: true, id: 3, updated: ["status_id", "notes"] });
    expect(JSON.parse(readFileSync(auditPath, "utf8").trim())).toMatchObject({ tool: "update_issue", ok: true });
  });

  it("update_issue with no fields errors without calling Redmine", async () => {
    const { call, calls } = await setup(() => ok());
    expect((await call("update_issue", { id: 3 })).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("add_note, create_issue and log_time", async () => {
    const { call, calls } = await setup((r) =>
      r.method === "POST" && r.path === "/issues.json"
        ? ok({ issue: { id: 77, subject: "N" } })
        : r.method === "POST"
          ? ok({ time_entry: { id: 8 } })
          : ok(),
    );
    await call("add_note", { id: 1, notes: "hi", private: true });
    expect(calls[0].body).toEqual({ issue: { notes: "hi", private_notes: true } });
    expect((await call("create_issue", { project_id: "p", subject: "N" })).json.issue.id).toBe(77);
    expect((await call("log_time", { issue_id: 1, hours: 1.5 })).json.id).toBe(8);
    expect(calls[2].body).toEqual({ time_entry: { issue_id: 1, hours: 1.5 } });
  });

  it("create_issue warns when Redmine fell back to another tracker", async () => {
    const { call } = await setup(() => ok({ issue: { id: 5, subject: "S", tracker: { id: 1, name: "Bug" } } }));
    const r = await call("create_issue", { project_id: "p", subject: "S", tracker_id: 2 });
    expect(r.json.warning).toContain("not enabled");
    expect((await call("create_issue", { project_id: "p", subject: "S", tracker_id: 1 })).json.warning).toBeUndefined();
  });

  it("list_project_trackers reads the project's enabled trackers", async () => {
    const { call, calls } = await setup(() => ok({ project: { trackers: [{ id: 7, name: "AILAB - Feature" }] } }));
    expect((await call("list_project_trackers", { project_id: "support" })).json.items).toEqual([
      { id: 7, name: "AILAB - Feature" },
    ]);
    expect(calls[0]).toMatchObject({ path: "/projects/support.json", query: { include: "trackers" } });
  });

  it("records failed writes in the audit log", async () => {
    const { call, auditPath } = await setup(() => fail("VALIDATION", "bad", ["Subject cannot be blank"]));
    const r = await call("create_issue", { project_id: "p", subject: "x" });
    expect(r.text).toContain("Subject cannot be blank");
    expect(JSON.parse(readFileSync(auditPath, "utf8").trim())).toMatchObject({ ok: false });
  });

  it("says a timed-out write may have been applied", async () => {
    const { call } = await setup(() => fail("TIMEOUT", "extension did not answer in time"));
    const w = await call("add_note", { id: 1, notes: "x" });
    expect(w.text).toContain("may or may not have been applied");
    expect((await call("get_current_user")).text).not.toContain("may or may not");
  });

  it("READ_ONLY hides write tools", async () => {
    const { client } = await setup(() => ok(), true);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("get_issue");
    for (const w of ["update_issue", "add_note", "create_issue", "log_time"]) expect(names).not.toContain(w);
  });
});
