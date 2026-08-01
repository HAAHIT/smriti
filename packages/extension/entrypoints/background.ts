// Background Service Worker.
//
// New architecture: no native messaging. The offscreen document owns SQLite,
// embeddings, and backfill. Background manages:
//   • Offscreen document lifecycle (create / keep alive / auto-recover).
//   • Message routing: content scripts → offscreen.
//   • Per-host capture toggle (persisted in chrome.storage.local).
//   • Badge updates.
//   • Toolbar icon → opens options page.

import { defineBackground } from "wxt/sandbox";
import type { CaptureEvent, SourceId } from "@smriti/shared";
import { hostsForSource, sourceForHostname } from "../lib/connectors/registry";

const OFFSCREEN_URL = chrome.runtime.getURL("/offscreen.html");

// Per-host capture pause. Persisted in chrome.storage.local.
const PAUSED_HOSTS_KEY = "smriti:paused-hosts";
const pausedHosts = new Set<string>();

void browser.storage.local.get(PAUSED_HOSTS_KEY).then((o) => {
  const list = o[PAUSED_HOSTS_KEY];
  if (Array.isArray(list)) list.forEach((h) => pausedHosts.add(String(h)));
});

function persistPausedHosts(): void {
  browser.storage.local.set({ [PAUSED_HOSTS_KEY]: [...pausedHosts] }).catch(() => {});
}

// Notify any open tabs on `host` immediately, so the sidebar's composer
// watch doesn't wait on its 60s poll to react to a Settings toggle.
//
// Also notifies the source's *other* hosts: pausing chatgpt.com must reach an
// open chat.openai.com tab too, since both feed the same source.
async function broadcastCaptureToggle(host: string, off: boolean): Promise<void> {
  const source = sourceForHostname(host);
  const targets = new Set(source ? hostsForSource(source.id) : [host]);
  targets.add(host);

  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    try {
      const h = new URL(tab.url).hostname.replace(/^www\./, "");
      if (!targets.has(h) && !sameSource(h, targets)) continue;
    } catch {
      continue;
    }
    browser.tabs.sendMessage(tab.id, { kind: "capture_toggle", host, off }).catch(() => {});
  }
}

/** True if hostname `h` is a subdomain of one of `targets`. */
function sameSource(h: string, targets: Set<string>): boolean {
  for (const t of targets) if (h.endsWith(`.${t}`)) return true;
  return false;
}

// ─── Offscreen document lifecycle ────────────────────────────────────────────
//
// Chrome can close an offscreen document when the service worker is dormant.
// We guard against this with:
//   1. ensureOffscreen() checks hasDocument() before every sendToOffscreen()
//   2. A 25-second keepalive ping (below Chrome's ~30s SW dormancy window)
//   3. The offscreen doc sends "offscreen_ready" when it boots so we know
//      when it's safe to send messages.

let offscreenReady = false;
// The last boot error, if the offscreen doc failed to initialize. Set on
// "offscreen_error" so waiters reject fast instead of hanging forever.
let offscreenError: string | null = null;
let readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
let offscreenCreating: Promise<void> | null = null;

// How long an RPC waits for the offscreen doc to signal ready before giving up.
const OFFSCREEN_READY_TIMEOUT_MS = 20_000;

async function ensureOffscreen(): Promise<void> {
  if (offscreenCreating) return offscreenCreating;
  let existing = await chrome.offscreen.hasDocument();
  // A doc that exists but failed to boot is useless — tear it down and recreate
  // so a retry can recover instead of rejecting against the broken instance.
  if (existing && offscreenError) {
    await chrome.offscreen.closeDocument().catch(() => {});
    existing = false;
  }
  if (!existing) {
    offscreenReady = false;
    offscreenError = null;
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: "SQLite database and embedding model for conversation archive",
      })
      .finally(() => { offscreenCreating = null; });
    await offscreenCreating;
  } else if (!offscreenReady) {
    // The doc exists but this service-worker instance never saw its one-shot
    // "offscreen_ready" — the SW was terminated and restarted while the doc
    // survived (offscreen docs outlive the SW), so the broadcast went to a dead
    // SW. Probe it directly instead of blocking ~20s for a broadcast that
    // already fired; a booted doc reports ready and we mark it ourselves.
    await probeExistingOffscreen();
  }
}

// Mark the offscreen doc ready and release any RPCs blocked in waitForOffscreen.
function markOffscreenReady(): void {
  offscreenReady = true;
  offscreenError = null;
  setBadgeOk();
  const waiters = readyWaiters.splice(0);
  waiters.forEach((w) => w.resolve());
}

// Confirm an already-existing offscreen doc is alive *and* finished booting
// (DB initialized). Used after a SW restart, when the ready broadcast was lost.
// A ping reply with ready:true means it's safe to send RPCs.
async function probeExistingOffscreen(): Promise<void> {
  try {
    const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "ping" });
    if ((res as { result?: { ready?: boolean } } | null)?.result?.ready) markOffscreenReady();
  } catch {
    // Still booting (or not listening yet); waitForOffscreen + the ready
    // broadcast / timeout cover it.
  }
}

function waitForOffscreen(): Promise<void> {
  if (offscreenReady) return Promise.resolve();
  if (offscreenError) return Promise.reject(new Error(offscreenError));
  return new Promise((resolve, reject) => {
    let settled = false;
    const waiter = {
      resolve: () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); },
      reject: (e: Error) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); },
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      readyWaiters = readyWaiters.filter((w) => w !== waiter);
      reject(new Error("offscreen document did not become ready in time"));
    }, OFFSCREEN_READY_TIMEOUT_MS);
    readyWaiters.push(waiter);
  });
}

// Keepalive: ping the offscreen doc every 25 s.
// This prevents Chrome from closing it while the service worker is still
// being kept alive by pending messages.
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

function startKeepalive(): void {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    chrome.offscreen.hasDocument().then((has) => {
      if (!has) {
        offscreenReady = false;
        void ensureOffscreen();
      }
    }).catch(() => {});
  }, 25_000);
}

// ─── Send message to offscreen doc ───────────────────────────────────────────

async function sendToOffscreen(payload: Record<string, unknown>): Promise<unknown> {
  await ensureOffscreen();
  await waitForOffscreen();
  const result = await chrome.runtime.sendMessage({ ...payload, target: "offscreen" });
  // If offscreen returned an error object, propagate it.
  const r = result as { ok?: boolean; error?: string } | null;
  if (r && r.ok === false) throw new Error(r.error ?? "offscreen error");
  return result;
}

// ─── Background entry point ───────────────────────────────────────────────────

export default defineBackground(() => {
  console.log("[smriti] background ready");

  // Create offscreen doc on startup.
  void ensureOffscreen();
  startKeepalive();

  // Fresh install → open the memory-first onboarding funnel.
  chrome.runtime.onInstalled.addListener((d) => {
    if (d.reason === "install") {
      void chrome.tabs.create({ url: chrome.runtime.getURL("/options.html#/welcome") });
    }
  });

  // Toolbar icon → open options page.
  browser.action.onClicked.addListener(() => {
    browser.runtime.openOptionsPage().catch(() => {
      browser.tabs.create({ url: browser.runtime.getURL("/options.html") });
    });
  });

  // ─── Message router ──────────────────────────────────────────────────────

  browser.runtime.onMessage.addListener(
    ((msg: unknown, _sender: unknown, sendResponse: (r: unknown) => void): true | undefined => {
      if (typeof msg !== "object" || msg === null) return;
      const kind = (msg as { kind?: string }).kind;

      // ── Offscreen lifecycle events ──────────────────────────────────────

      if (kind === "offscreen_ready") {
        console.log("[smriti] offscreen ready");
        markOffscreenReady();
        return;
      }

      if (kind === "offscreen_error") {
        const error = (msg as { error?: string }).error ?? "offscreen failed to start";
        console.error("[smriti] offscreen boot error:", error);
        offscreenError = error;
        offscreenReady = false;
        setBadgeError();
        // Fail any in-flight RPCs immediately instead of leaving them to hang.
        const waiters = readyWaiters.splice(0);
        waiters.forEach((w) => w.reject(new Error(error)));
        return;
      }

      // ── Backfill progress (forwarded from offscreen → listeners) ────────

      if (kind === "backfill_progress" || kind === "backfill_done") {
        void browser.storage.local.set({ "smriti:last_progress": msg });
        broadcastToUi(msg).catch(() => {});
        return;
      }

      // ── Build-memory progress (forwarded from offscreen → listeners) ────
      if (kind === "build_progress") {
        broadcastToUi(msg).catch(() => {});
        return;
      }

      // ── Capture events from content scripts ─────────────────────────────

      if (kind === "capture") {
        const events = (msg as { events: CaptureEvent[] }).events;
        handleCapture(events)
          .then((res) => sendResponse({ ok: true, res }))
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      }

      // ── Start backfill (from options page) ───────────────────────────────

      if (kind === "start_backfill") {
        const platform = (msg as { platform: SourceId }).platform;
        sendToOffscreen({ type: "start_backfill", platform })
          .then((res) => {
            const r = (res as { result?: { resuming?: boolean } })?.result ?? res as { resuming?: boolean };
            sendResponse({ ok: true, resuming: (r as { resuming?: boolean })?.resuming ?? false });
          })
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      }

      // ── Direct offscreen pass-through ────────────────────────────────────
      // Options page / sidebar send { kind: "to_offscreen", type, ...payload }.

      if (kind === "to_offscreen") {
        const { kind: _k, ...payload } = msg as Record<string, unknown>;
        sendToOffscreen(payload)
          .then((res) => sendResponse({ ok: true, res }))
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      }

      // ── Capture toggle ────────────────────────────────────────────────────

      if (kind === "capture_toggle") {
        const host = String((msg as { host?: string }).host ?? "");
        const off = !!(msg as { off?: boolean }).off;
        if (host) {
          if (off) pausedHosts.add(host);
          else pausedHosts.delete(host);
          persistPausedHosts();
          void broadcastCaptureToggle(host, off);
        }
        sendResponse({ ok: true });
        return true;
      }

      // ── Get capture-paused hosts (content scripts self-gate on this) ─────

      if (kind === "get_capture_paused") {
        sendResponse({ ok: true, paused: [...pausedHosts] });
        return true;
      }

      // ── Get backfill progress (for options page) ─────────────────────────

      if (kind === "get_backfill_progress") {
        browser.storage.local.get("smriti:last_progress")
          .then((o) => sendResponse({ ok: true, progress: o["smriti:last_progress"] ?? null }))
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      }

      // ── Health check / ping ───────────────────────────────────────────────

      if (kind === "health_check") {
        sendToOffscreen({ type: "ping" })
          .then(() => { setBadgeOk(); sendResponse({ ok: true }); })
          .catch((err) => { setBadgeError(); sendResponse({ ok: false, error: String(err) }); });
        return true;
      }

      return undefined; // no handler matched
    }) as Parameters<typeof browser.runtime.onMessage.addListener>[0],
  );
});

// ─── Capture handling ─────────────────────────────────────────────────────────

async function handleCapture(events: CaptureEvent[]): Promise<{ accepted: number }> {
  if (!events || events.length === 0) return { accepted: 0 };

  const filtered = events.filter((e) => {
    // A source can serve several hosts (ChatGPT: chatgpt.com and the legacy
    // chat.openai.com). Pausing any one of them pauses the source, so a user
    // who pauses on the host they can see isn't silently still captured on the
    // other.
    const hosts = hostsForSource(e.platform);
    return hosts.length === 0 || !hosts.some((h) => pausedHosts.has(h));
  });
  if (filtered.length === 0) return { accepted: 0 };

  const res = await sendToOffscreen({ type: "ingest", events: filtered });
  const r = (res as { result?: { accepted: number } })?.result ?? res as { accepted?: number };
  const accepted = (r as { accepted?: number })?.accepted ?? 0;

  if (accepted > 0) bumpBadge(accepted);
  return { accepted };
}

// ─── Badge helpers ────────────────────────────────────────────────────────────

let pendingBadge = 0;
let badgeTimer: ReturnType<typeof setTimeout> | null = null;

function bumpBadge(n: number): void {
  if (n <= 0) return;
  pendingBadge += n;
  browser.action.setBadgeBackgroundColor({ color: "#1f8a4c" }).catch(() => {});
  browser.action.setBadgeText({ text: String(pendingBadge) }).catch(() => {});
  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    pendingBadge = 0;
    browser.action.setBadgeText({ text: "" }).catch(() => {});
  }, 8_000);
}

function setBadgeOk(): void {
  browser.action.setBadgeBackgroundColor({ color: "#1f8a4c" }).catch(() => {});
  browser.action.setBadgeText({ text: "" }).catch(() => {});
}

function setBadgeError(): void {
  browser.action.setBadgeBackgroundColor({ color: "#b00020" }).catch(() => {});
  browser.action.setBadgeText({ text: "!" }).catch(() => {});
}

// ─── UI broadcast ─────────────────────────────────────────────────────────────

async function broadcastToUi(msg: unknown): Promise<void> {
  const tabs = await browser.tabs.query({});
  const optionsUrl = browser.runtime.getURL("/options.html");
  for (const tab of tabs) {
    if (tab.id && tab.url && tab.url.startsWith(optionsUrl)) {
      browser.tabs.sendMessage(tab.id, msg).catch(() => {});
    }
  }
}
