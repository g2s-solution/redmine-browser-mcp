import { DEFAULT_PORT, parsePort, parseRedmineUrl } from "./settings.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const domain = $<HTMLInputElement>("domain");
const port = $<HTMLInputElement>("port");
const message = $("message");
const conn = $("conn");

function say(text: string, isError = false): void {
  message.textContent = text;
  message.className = isError ? "error" : "ok";
}

async function refreshStatus(): Promise<void> {
  try {
    const s = await chrome.runtime.sendMessage({ type: "status" });
    conn.textContent = s?.connected ? "Connected to the local daemon" : "Not connected to the local daemon";
    conn.className = s?.connected ? "ok" : "error";
  } catch {
    conn.textContent = "Starting…";
  }
}

chrome.storage.local.get(["redmineBase", "port"]).then((v) => {
  domain.value = v.redmineBase || "";
  port.value = String(v.port || DEFAULT_PORT);
});

$("save").addEventListener("click", async () => {
  const parsed = parseRedmineUrl(domain.value);
  if (!parsed.ok) return say(parsed.error, true);
  const p = parsePort(port.value);
  if (!p) return say("Port must be between 1 and 65535", true);
  // Must run inside the click handler: Chrome only shows the permission prompt for a user gesture.
  const granted = await chrome.permissions.request({ origins: [`${parsed.origin}/*`] });
  if (!granted) return say(`Permission for ${parsed.origin} was not granted; the extension cannot reach it`, true);
  await chrome.storage.local.set({ redmineBase: parsed.baseUrl, port: p });
  domain.value = parsed.baseUrl;
  say("Saved. Log in to Redmine in this browser if you have not yet.");
});

void refreshStatus();
setInterval(refreshStatus, 1500);
