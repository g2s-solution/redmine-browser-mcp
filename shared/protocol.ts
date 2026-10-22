export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface HttpRequestMsg {
  id: string;
  type: "http";
  method: HttpMethod;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export type ErrorCode =
  | "AUTH_REQUIRED"
  | "CSRF"
  | "NETWORK"
  | "FORBIDDEN_PATH"
  | "NOT_FOUND"
  | "VALIDATION"
  | "HTTP"
  | "TIMEOUT"
  | "NOT_CONNECTED";

export interface HttpOkMsg {
  id: string;
  type: "http-result";
  ok: true;
  status: number;
  json?: unknown;
}

export interface HttpErrMsg {
  id: string;
  type: "http-result";
  ok: false;
  error: { code: ErrorCode; message: string; status?: number; details?: unknown };
}

export type HttpResultMsg = HttpOkMsg | HttpErrMsg;
export type ControlMsg = { type: "ping" } | { type: "pong" } | { type: "hello"; version: string; build?: string };
export type ToExtension = HttpRequestMsg | ControlMsg;
export type FromExtension = HttpResultMsg | ControlMsg;

const SEG = "[A-Za-z0-9_-]+";
const READ_PATHS = [
  /^\/issues(\/\d+)?\.json$/,
  /^\/projects\.json$/,
  new RegExp(`^/projects/${SEG}(/(memberships|versions))?\\.json$`),
  /^\/users\/current\.json$/,
  /^\/search\.json$/,
  /^\/issue_statuses\.json$/,
  /^\/trackers\.json$/,
  /^\/enumerations\/(issue_priorities|time_entry_activities)\.json$/,
];

export function isAllowedRequest(method: string, path: string): boolean {
  if (!path.startsWith("/") || path.includes("..") || path.includes("?") || path.includes("//")) return false;
  if (method === "GET") return READ_PATHS.some((r) => r.test(path));
  if (method === "POST") return path === "/issues.json" || path === "/time_entries.json";
  if (method === "PUT" || method === "DELETE") return /^\/issues\/\d+\.json$/.test(path);
  return false;
}
