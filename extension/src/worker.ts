import { RedmineExecutor } from "./core.js";
import { startLink } from "./link.js";
import { NATIVE_HOST_NAME, startNativeLink } from "./native.js";
import { DEFAULT_PORT } from "./settings.js";

let link: { stop(): void } | null = null;
let connected = false;
let mode: "native" | "websocket" | "" = "";
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
  const version = chrome.runtime.getManifest().version;
  const handle = executor.handle.bind(executor);
  const onStatus = (ok: boolean) => {
    connected = ok;
    void chrome.action.setBadgeText({ text: ok ? "ON" : "OFF" });
  };
  let inner: { stop(): void } | null = null;
  let stopped = false;
  // Prefer the native host (Chrome starts the daemon itself); fall back to a manually started daemon over WebSocket.
  const useWebSocket = () => {
    if (stopped) return;
    mode = "websocket";
    inner = startLink({ url: `ws://127.0.0.1:${stored.port || DEFAULT_PORT}/ext`, version, handle, onStatus });
  };
  mode = "native";
  inner = startNativeLink({
    connect: () => chrome.runtime.connectNative(NATIVE_HOST_NAME),
    handle,
    version,
    onStatus,
    onUnavailable: useWebSocket,
  });
  link = {
    stop() {
      stopped = true;
      inner?.stop();
    },
  };
}

chrome.runtime.onInstalled.addListener(() => void restart());
chrome.runtime.onStartup.addListener(() => void restart());
chrome.storage.onChanged.addListener(() => void restart());
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== "status") return;
  reply({ connected, mode });
});
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (!link) void restart();
});
void restart();
