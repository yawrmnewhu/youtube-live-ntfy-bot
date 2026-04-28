require("dotenv").config();
const axios = require("axios");
const express = require("express");
const http = require("http");
const https = require("https");

// ─── CRASH PROTECTION ─────────────────────────────────────────────────────────
process.on("uncaughtException", err => {
  console.error("[FATAL] uncaughtException:", err?.stack || err);
  scheduleRestart("uncaughtException", 2000);
});
process.on("unhandledRejection", err => {
  console.error("[FATAL] unhandledRejection:", err?.stack || err);
});

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TARGET_CHANNEL_IDS = (process.env.TARGET_CHANNEL_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const TARGET_VIDEO_IDS = (process.env.TARGET_VIDEO_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const NTFY_TOPIC        = process.env.NTFY_TOPIC || "";
const YOUTUBE_COOKIES   = process.env.YOUTUBE_COOKIES || "";
const PORT              = process.env.PORT || 3000;

const MIN_POLL_MS       = parseInt(process.env.MIN_POLL_MS || "300", 10);
const MAX_POLL_MS       = parseInt(process.env.MAX_POLL_MS || "1500", 10);
const ACTIVE_POLL_MS    = parseInt(process.env.ACTIVE_POLL_MS || "250", 10);
const CHANNEL_CHECK_MS  = parseInt(process.env.CHANNEL_CHECK_MS || "20000", 10);

// ─── AUTO-RESTART CONFIG ──────────────────────────────────────────────────────
const MEM_WARN_MB       = parseInt(process.env.MEM_WARN_MB       || "350", 10);
const MEM_RESTART_MB    = parseInt(process.env.MEM_RESTART_MB    || "450", 10);
const MEM_HARD_LIMIT_MB = parseInt(process.env.MEM_HARD_LIMIT_MB || "480", 10);
const MEM_CHECK_MS      = parseInt(process.env.MEM_CHECK_MS      || "15000", 10);
const MAX_UPTIME_HOURS  = parseInt(process.env.MAX_UPTIME_HOURS  || "24", 10);
const SHUTDOWN_GRACE_MS = parseInt(process.env.SHUTDOWN_GRACE_MS || "10000", 10);

// ─── NTFY 429 AUTO-RESTART CONFIG ─────────────────────────────────────────────
// Restart immediately on the first 429 (default), or after N within a window.
const NTFY_429_THRESHOLD   = parseInt(process.env.NTFY_429_THRESHOLD   || "1", 10);
const NTFY_429_WINDOW_MS   = parseInt(process.env.NTFY_429_WINDOW_MS   || "60000", 10);
const NTFY_429_RESTART_DELAY_MS = parseInt(process.env.NTFY_429_RESTART_DELAY_MS || "2000", 10);

if (!NTFY_TOPIC) throw new Error("NTFY_TOPIC env var is required");

// ─── HTTP CLIENTS ─────────────────────────────────────────────────────────────
const httpAgent  = new http.Agent({  keepAlive: true, maxSockets: 64, keepAliveMsecs: 30_000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30_000 });
require("events").EventEmitter.defaultMaxListeners = 50;

const yt = axios.create({
  httpAgent, httpsAgent, timeout: 15_000, maxRedirects: 3,
  responseType: "json", validateStatus: s => s >= 200 && s < 300,
});
const ntfyClient = axios.create({ httpAgent, httpsAgent, timeout: 5_000 });

// ─── STATE ────────────────────────────────────────────────────────────────────
const seenMessageIds = new Map();
const streamLogs     = new Map();
const activeStreams  = new Map();
const userCooldowns  = new Map();
const skipFirstBatch = new Map();

const COOLDOWN_MS       = 10_000;
const LOG_MAX_ENTRIES   = 100;
const SEEN_TTL_MS       = 30 * 60 * 1000;
const SEEN_MAX_PER_VID  = 5_000;

let isShuttingDown    = false;
let restartScheduled  = false;
const startTime       = Date.now();

// ntfy 429 tracking
const ntfy429Timestamps = [];

// ─── UTILS ────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(videoId, level, message) {
  const entry = { ts: new Date().toISOString(), level, message };
  if (!streamLogs.has(videoId)) streamLogs.set(videoId, []);
  const logs = streamLogs.get(videoId);
  logs.push(entry);
  if (logs.length > LOG_MAX_ENTRIES) logs.shift();
  if (level !== "DEBUG") console.log(`[${level}] [${videoId}] ${message}`);
}

// ─── AUTO-RESTART ─────────────────────────────────────────────────────────────
function getMemMB() {
  const mem = process.memoryUsage();
  return { rss: mem.rss / 1048576, heap: mem.heapUsed / 1048576, ext: mem.external / 1048576 };
}

function scheduleRestart(reason, delay = 0) {
  if (restartScheduled) return;
  restartScheduled = true;
  console.log(`[RESTART] Scheduled (reason: ${reason}, delay: ${delay}ms)`);
  setTimeout(() => gracefulShutdown(reason), delay);
}

async function gracefulShutdown(reason) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n═══ GRACEFUL SHUTDOWN (${reason}) ═══`);
  const mem = getMemMB();
  console.log(`  Memory: RSS=${mem.rss.toFixed(1)}MB Heap=${mem.heap.toFixed(1)}MB`);
  console.log(`  Uptime: ${((Date.now() - startTime) / 1000 / 60).toFixed(1)} min`);

  // Skip ntfy notification on 429 restarts (we're already rate-limited).
  const skipNtfy = reason.startsWith("ntfy_429");
  if (!skipNtfy) {
    try {
      await Promise.race([
        ntfyClient.post(`https://ntfy.sh/${NTFY_TOPIC}`, `Service restarting: ${reason}`, {
          headers: { Title: "🔄 Auto-restart", Tags: "warning", Priority: "low" },
          timeout: 3000,
        }),
        sleep(3000),
      ]);
    } catch {}
  }

  if (httpServer) {
    try {
      await new Promise(resolve => {
        httpServer.close(() => resolve());
        setTimeout(resolve, 3000);
      });
    } catch {}
  }

  try { httpAgent.destroy();  } catch {}
  try { httpsAgent.destroy(); } catch {}

  seenMessageIds.clear();
  streamLogs.clear();
  activeStreams.clear();
  userCooldowns.clear();
  skipFirstBatch.clear();

  console.log(`[RESTART] Exiting in ${SHUTDOWN_GRACE_MS}ms...`);
  await sleep(SHUTDOWN_GRACE_MS);
  // Non-zero exit → Railway restarts the service automatically.
  process.exit(1);
}

// ─── MEMORY MONITOR ───────────────────────────────────────────────────────────
let lastWarnAt = 0;
function monitorMemory() {
  setInterval(() => {
    if (isShuttingDown) return;
    const mem = getMemMB();
    const now = Date.now();

    if (mem.rss > MEM_HARD_LIMIT_MB) {
      console.error(`[MEM] 🚨 HARD LIMIT: RSS=${mem.rss.toFixed(1)}MB > ${MEM_HARD_LIMIT_MB}MB`);
      scheduleRestart("hard_memory_limit", 0);
      return;
    }
    if (mem.rss > MEM_RESTART_MB) {
      console.warn(`[MEM] ⚠️  Restart: RSS=${mem.rss.toFixed(1)}MB > ${MEM_RESTART_MB}MB`);
      if (global.gc) {
        global.gc();
        const after = getMemMB();
        console.log(`[MEM] After GC: RSS=${after.rss.toFixed(1)}MB`);
        if (after.rss > MEM_RESTART_MB) scheduleRestart("memory_restart", 1000);
      } else {
        scheduleRestart("memory_restart_nogc", 1000);
      }
      return;
    }
    if (mem.rss > MEM_WARN_MB && now - lastWarnAt > 60_000) {
      lastWarnAt = now;
      console.warn(`[MEM] Warning: RSS=${mem.rss.toFixed(1)}MB Heap=${mem.heap.toFixed(1)}MB`);
      if (global.gc) global.gc();
    }
    const uptimeH = (now - startTime) / 3600000;
    if (uptimeH > MAX_UPTIME_HOURS) {
      console.log(`[RESTART] Max uptime (${uptimeH.toFixed(1)}h)`);
      scheduleRestart("max_uptime", 0);
    }
  }, MEM_CHECK_MS);
}

function getStateSize() {
  let total = 0;
  for (const m of seenMessageIds.values()) total += m.size;
  return {
    seenMessages: total, videos: seenMessageIds.size, logs: streamLogs.size,
    streams: activeStreams.size, cooldowns: userCooldowns.size,
  };
}

// ─── HEADERS ──────────────────────────────────────────────────────────────────
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function getBrowserHeaders() {
  const h = {
    "User-Agent": UA,
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
  };
  if (YOUTUBE_COOKIES) h.Cookie = YOUTUBE_COOKIES;
  return h;
}
function getApiHeaders() {
  const h = {
    "User-Agent": UA, "Content-Type": "application/json", "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate, br",
    "Origin": "https://www.youtube.com", "Referer": "https://www.youtube.com/",
    "X-Youtube-Client-Name": "1", "X-Youtube-Client-Version": "2.20240101.00.00",
  };
  if (YOUTUBE_COOKIES) h.Cookie = YOUTUBE_COOKIES;
  return h;
}

// ─── AXIOS WITH RETRY ─────────────────────────────────────────────────────────
async function request(config, label, maxRetries = 3) {
  let attempt = 0;
  while (true) {
    if (isShuttingDown) throw new Error("Shutting down");
    try {
      return await yt(config);
    } catch (err) {
      const status = err?.response?.status;
      if ((status === 429 || (status >= 500 && status < 600)) && attempt < maxRetries) {
        attempt++;
        const retryAfter = err?.response?.headers?.["retry-after"];
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000
          : Math.min(2000 * Math.pow(2, attempt - 1), 30_000);
        log(label, "WARN", `${status} — retry in ${waitMs}ms (${attempt}/${maxRetries})`);
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }
}

// ─── FETCH INITIAL CHAT DATA ──────────────────────────────────────────────────
async function fetchInitialChatData(videoId) {
  const res = await request({
    method: "get", url: `https://www.youtube.com/watch?v=${videoId}`,
    headers: getBrowserHeaders(), responseType: "text",
    transformResponse: [d => d],
  }, videoId);

  let html = res.data;
  const isLiveFlag = html.includes('"isLive":true');

  let ytData = null;
  const patterns = [
    /ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s,
    /ytInitialData\s*=\s*(\{.+?\})\s*;/s,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) { try { ytData = JSON.parse(match[1]); break; } catch {} }
  }
  if (!ytData) { html = null; throw new Error("Could not parse ytInitialData"); }

  const apiKey = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1]
    || "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/)?.[1]
    || "2.20240101.00.00";
  const visitorData = html.match(/"visitorData"\s*:\s*"([^"]+)"/)?.[1] || "";

  const continuation = extractInitialContinuation(ytData, html);
  html = null;
  if (!continuation) {
    if (!isLiveFlag) throw new Error("Stream does not appear to be live");
    throw new Error("Could not find live chat continuation token");
  }
  return { continuation, apiKey, clientVersion, visitorData };
}

function extractInitialContinuation(ytData) {
  const candidates = [];
  try {
    const continuations = ytData?.contents?.twoColumnWatchNextResults
      ?.conversationBar?.liveChatRenderer?.continuations || [];
    for (const c of continuations) {
      candidates.push(
        c?.invalidationContinuationData?.continuation,
        c?.timedContinuationData?.continuation,
      );
    }
  } catch {}
  try {
    for (const panel of ytData?.engagementPanels || []) {
      const renderer = panel?.engagementPanelSectionListRenderer?.content?.liveChatRenderer;
      for (const c of renderer?.continuations || []) {
        candidates.push(
          c?.invalidationContinuationData?.continuation,
          c?.timedContinuationData?.continuation,
        );
      }
    }
  } catch {}
  try {
    const str = JSON.stringify(ytData);
    const matches = [...str.matchAll(/"continuation"\s*:\s*"([^"]{20,})"/g)];
    for (const m of matches) candidates.push(m[1]);
  } catch {}
  return candidates.filter(Boolean)[0] || null;
}

// ─── FETCH LIVE CHAT PAGE ─────────────────────────────────────────────────────
async function fetchLiveChatPage(videoId, apiKey, clientVersion, visitorData, continuation) {
  const res = await request({
    method: "post",
    url: `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${apiKey}&prettyPrint=false`,
    headers: getApiHeaders(),
    data: {
      context: { client: { clientName: "WEB", clientVersion, visitorData, hl: "en", gl: "US" } },
      continuation,
    },
  }, videoId);
  return parseChatResponse(res.data);
}

// ─── EMOJI EXTRACTION ─────────────────────────────────────────────────────────
function extractRunText(run) {
  if (!run) return "";
  if (typeof run.text === "string") return run.text;
  if (run.emoji) {
    const e = run.emoji;
    const isCustom = e.isCustomEmoji === true;
    if (!isCustom) {
      if (e.emojiId && typeof e.emojiId === "string") return e.emojiId;
    }
    if (Array.isArray(e.shortcuts) && e.shortcuts.length > 0) return e.shortcuts[0];
    const label = e?.image?.accessibility?.accessibilityData?.label;
    if (label) return `:${label}:`;
    if (e.emojiId) return e.emojiId;
  }
  return "";
}

function parseChatResponse(data) {
  const messages = [];
  let nextContinuation = null;
  let timeoutMs = MIN_POLL_MS;

  const renderer = data?.continuationContents?.liveChatContinuation
    || data?.contents?.liveChatContinuation;
  if (!renderer) return { messages, nextContinuation, timeoutMs };

  for (const c of renderer?.continuations || []) {
    const inv = c?.invalidationContinuationData;
    const timed = c?.timedContinuationData;
    if (inv) { nextContinuation = inv.continuation; timeoutMs = inv.timeoutMs ?? MIN_POLL_MS; break; }
    else if (timed) { nextContinuation = timed.continuation; timeoutMs = timed.timeoutMs ?? MIN_POLL_MS; }
  }
  timeoutMs = Math.max(MIN_POLL_MS, Math.min(timeoutMs, MAX_POLL_MS));

  const actions = renderer?.actions || [];
  for (const action of actions) {
    const addItem = action?.addChatItemAction?.item;
    if (!addItem) continue;
    const item = addItem.liveChatTextMessageRenderer
      || addItem.liveChatPaidMessageRenderer
      || addItem.liveChatMembershipItemRenderer;
    if (!item) continue;

    const id = item.id;
    const authorName = item.authorName?.simpleText || "Unknown";
    const authorChannelId = item.authorExternalChannelId || "";
    const runs = item.message?.runs || item.headerSubtext?.runs || [];
    let text = "";
    for (let i = 0; i < runs.length; i++) text += extractRunText(runs[i]);
    const tsUsec = parseInt(item.timestampUsec || "0", 10);

    if (id && text.length > 0) messages.push({ id, authorName, authorChannelId, text, tsUsec });
  }
  return { messages, nextContinuation, timeoutMs };
}

// ─── DEDUP ────────────────────────────────────────────────────────────────────
function isSeen(videoId, msgId) {
  const map = seenMessageIds.get(videoId);
  return map ? map.has(msgId) : false;
}
function markSeen(videoId, msgId) {
  let map = seenMessageIds.get(videoId);
  if (!map) { map = new Map(); seenMessageIds.set(videoId, map); }
  map.set(msgId, Date.now());
}

function cleanupSeen() {
  const now = Date.now();
  for (const [videoId, map] of seenMessageIds.entries()) {
    for (const [id, ts] of map.entries()) {
      if (now - ts > SEEN_TTL_MS) map.delete(id);
    }
    while (map.size > SEEN_MAX_PER_VID) {
      const firstKey = map.keys().next().value;
      map.delete(firstKey);
    }
    if (map.size === 0) seenMessageIds.delete(videoId);
  }
  for (const [key, ts] of userCooldowns.entries()) {
    if (now - ts > COOLDOWN_MS * 10) userCooldowns.delete(key);
  }
}
setInterval(cleanupSeen, 5 * 60 * 1000);

function isOnCooldown(videoId, authorId) {
  return Date.now() - (userCooldowns.get(`${videoId}:${authorId}`) || 0) < COOLDOWN_MS;
}
function setCooldown(videoId, authorId) {
  userCooldowns.set(`${videoId}:${authorId}`, Date.now());
}

// ─── NTFY 429 HANDLER ─────────────────────────────────────────────────────────
function handleNtfy429(retryAfterHeader) {
  const now = Date.now();
  // Drop timestamps outside the rolling window.
  while (ntfy429Timestamps.length && now - ntfy429Timestamps[0] > NTFY_429_WINDOW_MS) {
    ntfy429Timestamps.shift();
  }
  ntfy429Timestamps.push(now);

  console.error(
    `[NTFY] 🚫 429 rate-limited (${ntfy429Timestamps.length}/${NTFY_429_THRESHOLD} in ` +
    `${NTFY_429_WINDOW_MS}ms window)` +
    (retryAfterHeader ? `, Retry-After=${retryAfterHeader}` : "")
  );

  if (ntfy429Timestamps.length >= NTFY_429_THRESHOLD) {
    console.error(`[NTFY] 🚨 429 threshold hit → triggering Railway restart`);
    scheduleRestart("ntfy_429_rate_limit", NTFY_429_RESTART_DELAY_MS);
  }
}

// ─── NTFY ─────────────────────────────────────────────────────────────────────
function sendNotification(videoId, authorName, messageText) {
  const bodyBuf = Buffer.from(messageText, "utf8");
  const titleStr = `💬 ${authorName} in ${videoId}`;

  ntfyClient.post(`https://ntfy.sh/${NTFY_TOPIC}`, bodyBuf, {
    headers: {
      Title: "=?UTF-8?B?" + Buffer.from(titleStr, "utf8").toString("base64") + "?=",
      Tags: "youtube,live",
      Priority: "high",
      "Content-Type": "text/plain; charset=utf-8",
    },
  }).then(() => {
    log(videoId, "NOTIFY", `${authorName}: ${messageText.slice(0, 60)}`);
  }).catch(err => {
    const status = err?.response?.status;
    const retryAfter = err?.response?.headers?.["retry-after"];
    log(videoId, "ERROR", `ntfy failed${status ? ` (${status})` : ""}: ${err.message}`);
    if (status === 429) handleNtfy429(retryAfter);
  });
}

// ─── PROCESS MESSAGES ─────────────────────────────────────────────────────────
function processMessages(videoId, messages, isFirstBatch) {
  const targets = TARGET_CHANNEL_IDS.length === 0 ? null : new Set(TARGET_CHANNEL_IDS);
  const silent = isFirstBatch && skipFirstBatch.get(videoId) === true;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (isSeen(videoId, msg.id)) continue;
    markSeen(videoId, msg.id);
    if (silent) continue;
    if (targets && !targets.has(msg.authorChannelId)) continue;
    if (isOnCooldown(videoId, msg.authorChannelId)) continue;

    setCooldown(videoId, msg.authorChannelId);
    log(videoId, "MATCH", `${msg.authorName}: ${msg.text}`);
    sendNotification(videoId, msg.authorName, msg.text);
  }
  if (isFirstBatch) skipFirstBatch.set(videoId, false);
}

// ─── STREAM LISTENER ──────────────────────────────────────────────────────────
async function streamListener(videoId) {
  log(videoId, "INFO", "Starting stream listener");
  activeStreams.set(videoId, { status: "initializing", since: new Date().toISOString() });

  const MAX_OFFLINE_RETRIES = 5;
  let offlineCount = 0;
  let retryCount = 0;

  try {
    while (!isShuttingDown) {
      try {
        const { continuation: initCont, apiKey, clientVersion, visitorData } =
          await fetchInitialChatData(videoId);

        activeStreams.set(videoId, {
          status: "live", since: new Date().toISOString(), retries: retryCount,
        });
        retryCount = 0;
        offlineCount = 0;
        log(videoId, "INFO", "✅ Connected to live chat");

        skipFirstBatch.set(videoId, true);

        let continuation = initCont;
        let pendingFetch = null;
        let isFirst = true;

        while (continuation && !isShuttingDown) {
          const fetchPromise = pendingFetch
            || fetchLiveChatPage(videoId, apiKey, clientVersion, visitorData, continuation);
          pendingFetch = null;

          const result = await fetchPromise;
          if (result && result.__error) throw result.__error;

          const { messages, nextContinuation, timeoutMs } = result;
          const effectiveWait = messages.length > 0
            ? Math.max(ACTIVE_POLL_MS, MIN_POLL_MS)
            : timeoutMs;

          if (nextContinuation && !isShuttingDown) {
            const nextStart = Date.now();
            pendingFetch = fetchLiveChatPage(videoId, apiKey, clientVersion, visitorData, nextContinuation)
              .catch(err => ({ __error: err }));

            processMessages(videoId, messages, isFirst);
            isFirst = false;

            const elapsed = Date.now() - nextStart;
            if (elapsed < effectiveWait) await sleep(effectiveWait - elapsed);
          } else {
            processMessages(videoId, messages, isFirst);
            isFirst = false;
          }
          continuation = nextContinuation;
        }
        log(videoId, "WARN", "No continuation — stream ended");
        offlineCount++;
        if (offlineCount >= MAX_OFFLINE_RETRIES) {
          log(videoId, "INFO", "Stream ended — shutting down listener");
          return;
        }
      } catch (err) {
        if (isShuttingDown) return;
        const offline = err.message?.includes("not appear to be live");
        log(videoId, "ERROR", `Stream error: ${err.message}`);
        activeStreams.set(videoId, {
          status: offline ? "offline" : "reconnecting",
          since: new Date().toISOString(),
          error: err.message, retries: retryCount,
        });

        if (offline) {
          offlineCount++;
          if (offlineCount >= MAX_OFFLINE_RETRIES) {
            log(videoId, "INFO", "Stream offline — shutting down listener");
            return;
          }
          await sleep(30_000);
        } else {
          retryCount++;
          if (retryCount > 10) {
            log(videoId, "ERROR", "Too many retries — giving up");
            return;
          }
          const delay = Math.min(5_000 * Math.pow(1.5, retryCount - 1), 60_000);
          log(videoId, "INFO", `Reconnecting in ${Math.round(delay / 1000)}s`);
          await sleep(delay);
        }
      }
    }
  } finally {
    log(videoId, "INFO", "Cleaning up listener state");
    seenMessageIds.delete(videoId);
    streamLogs.delete(videoId);
    activeStreams.delete(videoId);
    skipFirstBatch.delete(videoId);
    for (const key of userCooldowns.keys()) {
      if (key.startsWith(`${videoId}:`)) userCooldowns.delete(key);
    }
  }
}

// ─── CHANNEL WATCHER ──────────────────────────────────────────────────────────
async function detectLiveStream(channelId) {
  const urls = channelId.startsWith("UC")
    ? [`https://www.youtube.com/channel/${channelId}/live`]
    : [`https://www.youtube.com/@${channelId}/live`];

  for (const url of urls) {
    try {
      const res = await request({
        method: "get", url,
        headers: getBrowserHeaders(), responseType: "text",
        transformResponse: [d => d],
      }, channelId);
      const html = res.data;
      const isLive = html.includes('"isLive":true');
      const vidMatch = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
      if (vidMatch && isLive) return vidMatch[1];
    } catch (err) {
      console.log(`[CHANNEL] ${url}: ${err.message}`);
    }
  }
  return null;
}

async function channelWatcher(channelId) {
  console.log(`[CHANNEL] Watching: ${channelId} (every ${CHANNEL_CHECK_MS}ms)`);
  const activeListeners = new Map();

  while (!isShuttingDown) {
    try {
      const videoId = await detectLiveStream(channelId);
      if (videoId && !activeListeners.has(videoId)) {
        console.log(`[CHANNEL] ✅ New live stream: ${videoId}`);
        const p = streamListener(videoId)
          .catch(err => console.error(`[STREAM] ${videoId} crashed: ${err.message}`))
          .finally(() => {
            activeListeners.delete(videoId);
            console.log(`[CHANNEL] Listener for ${videoId} removed`);
          });
        activeListeners.set(videoId, p);
      }
    } catch (err) {
      console.error(`[CHANNEL] ${channelId} error: ${err.message}`);
    }
    await sleep(CHANNEL_CHECK_MS);
  }
}

// ─── STATUS SERVER ────────────────────────────────────────────────────────────
let httpServer = null;
function startStatusServer() {
  const app = express();
  app.get("/", (req, res) => {
    const mem = getMemMB();
    res.json({
      status: isShuttingDown ? "shutting_down" : "running",
      uptime: process.uptime(),
      memoryMB: { rss: mem.rss.toFixed(1), heap: mem.heap.toFixed(1), ext: mem.ext.toFixed(1) },
      limits: { warn: MEM_WARN_MB, restart: MEM_RESTART_MB, hard: MEM_HARD_LIMIT_MB },
      ntfy429: { recent: ntfy429Timestamps.length, threshold: NTFY_429_THRESHOLD, windowMs: NTFY_429_WINDOW_MS },
      state: getStateSize(),
    });
  });
  app.get("/status", (req, res) => {
    const streams = {};
    for (const [id, info] of activeStreams.entries()) {
      streams[id] = {
        ...info,
        seenMessages: seenMessageIds.get(id)?.size || 0,
        logs: streamLogs.get(id)?.slice(-20) || [],
      };
    }
    const mem = getMemMB();
    res.json({
      uptime: process.uptime(),
      memoryMB: { rss: mem.rss.toFixed(1), heap: mem.heap.toFixed(1), ext: mem.ext.toFixed(1) },
      state: getStateSize(),
      ntfy429: { recent: ntfy429Timestamps.length, threshold: NTFY_429_THRESHOLD, windowMs: NTFY_429_WINDOW_MS },
      monitoredVideos: TARGET_VIDEO_IDS,
      monitoredChannels: TARGET_CHANNEL_IDS,
      streams,
    });
  });
  app.get("/logs/:videoId", (req, res) =>
    res.json(streamLogs.get(req.params.videoId) || [])
  );
  app.post("/restart", (req, res) => {
    res.json({ ok: true, message: "Manual restart triggered" });
    scheduleRestart("manual", 500);
  });
  httpServer = app.listen(PORT, "0.0.0.0", () => console.log(`[STATUS] Running on port ${PORT}`));
}

// ─── SIGNAL HANDLERS ──────────────────────────────────────────────────────────
process.on("SIGTERM", () => { console.log("[SIGNAL] SIGTERM"); gracefulShutdown("SIGTERM"); });
process.on("SIGINT",  () => { console.log("[SIGNAL] SIGINT");  gracefulShutdown("SIGINT");  });

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  YouTube Live Chat Notifier (auto-restart)");
  console.log(`  Node     : ${process.version}`);
  console.log(`  Poll     : ${MIN_POLL_MS}–${MAX_POLL_MS}ms (active ${ACTIVE_POLL_MS}ms)`);
  console.log(`  Videos   : ${TARGET_VIDEO_IDS.join(", ") || "(none)"}`);
  console.log(`  Channels : ${TARGET_CHANNEL_IDS.join(", ") || "(none)"}`);
  console.log(`  ntfy     : https://ntfy.sh/${NTFY_TOPIC}`);
  console.log(`  Cookies  : ${YOUTUBE_COOKIES ? "✅" : "❌"}`);
  console.log(`  Memory   : warn=${MEM_WARN_MB}MB restart=${MEM_RESTART_MB}MB hard=${MEM_HARD_LIMIT_MB}MB`);
  console.log(`  ntfy 429 : restart after ${NTFY_429_THRESHOLD} hit(s) / ${NTFY_429_WINDOW_MS}ms`);
  console.log(`  GC       : ${global.gc ? "✅" : "❌ (start with --expose-gc)"}`);
  console.log("═══════════════════════════════════════════");

  startStatusServer();
  monitorMemory();

  for (const videoId of TARGET_VIDEO_IDS) {
    streamListener(videoId).catch(err => console.error(`[STREAM] ${videoId}: ${err.message}`));
  }
  for (const channelId of TARGET_CHANNEL_IDS) {
    channelWatcher(channelId).catch(err => console.error(`[CHANNEL] ${channelId}: ${err.message}`));
  }
}

main();
