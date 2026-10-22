export const DEFAULT_PORT = 7399;

export type Parsed = { ok: true; baseUrl: string; origin: string } | { ok: false; error: string };

const LOCAL = new Set(["localhost", "127.0.0.1"]);

// Accepts "redmine.example.com", "https://redmine.example.com/redmine/" and similar; keeps an optional path prefix.
export function parseRedmineUrl(input: string): Parsed {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "Enter your Redmine address" };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: "Not a valid address" };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL.has(url.hostname))) {
    return { ok: false, error: "Use https:// (http:// is only allowed for localhost)" };
  }
  if (url.username || url.password) return { ok: false, error: "Do not put credentials in the address" };
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, baseUrl: url.origin + path, origin: url.origin };
}

export function parsePort(input: string): number | undefined {
  const n = Number(input.trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
}
