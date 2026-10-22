import { describe, expect, it } from "vitest";
import { isAllowedRequest } from "../../shared/protocol.js";

describe("isAllowedRequest", () => {
  it.each([
    ["GET", "/issues.json"],
    ["GET", "/issues/12.json"],
    ["GET", "/projects.json"],
    ["GET", "/projects/abc-1/memberships.json"],
    ["GET", "/users/current.json"],
    ["GET", "/search.json"],
    ["GET", "/issue_statuses.json"],
    ["GET", "/enumerations/issue_priorities.json"],
    ["POST", "/issues.json"],
    ["POST", "/time_entries.json"],
    ["PUT", "/issues/12.json"],
    ["DELETE", "/issues/12.json"],
  ])("allows %s %s", (m, p) => expect(isAllowedRequest(m, p)).toBe(true));

  it.each([
    ["DELETE", "/issues.json"],
    ["DELETE", "/time_entries/1.json"],
    ["DELETE", "/projects/p.json"],
    ["DELETE", "/users/5.json"],
    ["PUT", "/issues.json"],
    ["POST", "/issues/12.json"],
    ["GET", "/admin"],
    ["GET", "/settings.json"],
    ["GET", "/issues/../admin.json"],
    ["GET", "/issues.json?x=1"],
    ["GET", "//evil.com/issues.json"],
    ["GET", "https://evil.com/issues.json"],
    ["PUT", "/time_entries.json"],
    ["GET", "/users.json"],
    ["GET", "/users/5.json"],
    ["GET", "/time_entries.json"],
    ["GET", "/my/account"],
    ["GET", "/my/api_key"],
    ["GET", "/projects/a/b/memberships.json"],
  ])("rejects %s %s", (m, p) => expect(isAllowedRequest(m, p)).toBe(false));
});
