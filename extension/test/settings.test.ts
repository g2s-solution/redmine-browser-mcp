import { describe, expect, it } from "vitest";
import { parsePort, parseRedmineUrl } from "../src/settings.js";

describe("parseRedmineUrl", () => {
  it.each([
    ["redmine.example.com", "https://redmine.example.com", "https://redmine.example.com"],
    ["  https://redmine.example.com/  ", "https://redmine.example.com", "https://redmine.example.com"],
    ["https://host.example.com/redmine///", "https://host.example.com/redmine", "https://host.example.com"],
    ["https://host.example.com:8443/", "https://host.example.com:8443", "https://host.example.com:8443"],
    ["http://localhost:3000", "http://localhost:3000", "http://localhost:3000"],
  ])("accepts %s", (input, baseUrl, origin) => {
    expect(parseRedmineUrl(input)).toEqual({ ok: true, baseUrl, origin });
  });

  it.each([
    ["", "Enter"],
    ["http://redmine.example.com", "https://"],
    ["ftp://redmine.example.com", "https://"],
    ["https://user:pw@redmine.example.com", "credentials"],
    ["https://", "valid"],
  ])("rejects %j", (input, hint) => {
    const r = parseRedmineUrl(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(hint);
  });
});

describe("parsePort", () => {
  it("accepts valid ports only", () => {
    expect(parsePort("7399")).toBe(7399);
    expect(parsePort(" 80 ")).toBe(80);
    for (const bad of ["0", "65536", "abc", "", "1.5", "-1"]) expect(parsePort(bad)).toBeUndefined();
  });
});
