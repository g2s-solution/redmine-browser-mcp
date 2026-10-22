import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses safe defaults", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ port: 7399, readOnly: false, requestTimeoutMs: 20000 });
    expect(c.auditPath).toMatch(/redmine-mcp\/audit\.log$/);
    expect(c.allowedExtensionId).toBeUndefined();
  });

  it("reads overrides from the environment", () => {
    const c = loadConfig({
      REDMINE_MCP_PORT: "8123",
      READ_ONLY: "1",
      REDMINE_MCP_TIMEOUT_MS: "500",
      REDMINE_MCP_STATE_DIR: "/tmp/state",
      REDMINE_MCP_EXTENSION_ID: "abc",
    });
    expect(c).toMatchObject({
      port: 8123,
      readOnly: true,
      requestTimeoutMs: 500,
      auditPath: "/tmp/state/audit.log",
      allowedExtensionId: "abc",
    });
  });

  it.each([
    ["REDMINE_MCP_PORT", ""],
    ["REDMINE_MCP_PORT", "0"],
    ["REDMINE_MCP_PORT", "70000"],
    ["REDMINE_MCP_PORT", "abc"],
    ["REDMINE_MCP_TIMEOUT_MS", "abc"],
    ["REDMINE_MCP_TIMEOUT_MS", "5"],
  ])("rejects %s=%j instead of silently misbehaving", (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(name);
  });

  it("only READ_ONLY=1 enables read-only mode", () => {
    expect(loadConfig({ READ_ONLY: "true" }).readOnly).toBe(false);
  });

  it("logs with a timestamp on stderr", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    loadConfig({}).log?.("hello");
    expect(spy.mock.calls[0][0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] hello$/);
    spy.mockRestore();
  });
});
