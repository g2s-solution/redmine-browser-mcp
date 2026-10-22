import { RedmineExecutor } from "./core.js";
import { startLink } from "./link.js";
import { DEFAULT_PORT } from "./settings.js";

let link: { stop(): void } | null = null;
let connected = false;
let generation = 0;

// restart() is triggered from several events at once; only the latest call may start a link.
async function restart(): Promise<void> {
  const mine = ++generation;
  link?.stop();
  link = null;
  connected = false;
  const stored = await chrome.storage.local.get(["port", "redmineBase"]);
  if (mine !== generation) return;
  const baseUrl: string = stored.redmineBase || "";
  if (!baseUrl) {
    void chrome.action.setBadgeText({ text: "?" });
    return;
  }
  const executor = new RedmineExecutor(fetch.bind(globalThis), baseUrl);
  link = startLink({
    url: `ws://127.0.0.1:${stored.port || DEFAULT_PORT}/ext`,
    version: chrome.runtime.getManifest().version,
    handle: (m) => executor.handle(m),
    onStatus: (ok) => {
      connected = ok;
      void chrome.action.setBadgeText({ text: ok ? "ON" : "OFF" });
    },
  });
}

chrome.runtime.onInstalled.addListener(() => void restart());
chrome.runtime.onStartup.addListener(() => void restart());
chrome.storage.onChanged.addListener(() => void restart());
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== "status") return;
  reply({ connected });
});
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (!link) void restart();
});
void restart();
