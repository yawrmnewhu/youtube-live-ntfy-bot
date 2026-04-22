require("dotenv").config();
const axios = require("axios");
const express = require("express");
const http = require("http");
const https = require("https");

// ─── CRASH PROTECTION ─────────────────────────────────────────────────────────
process.on("uncaughtException", err => {
  console.error("[FATAL] uncaughtException:", err?.stack || err);
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

// Polling tuning
const MIN_POLL_MS       = parseInt(process.env.MIN_POLL_MS || "500", 10);
const MAX_POLL_MS       = parseInt(process.env.MAX_POLL_MS || "1500", 10);
const ACTIVE_POLL_MS    = parseInt(process.env.ACTIVE_POLL_MS || "400", 10); // when chat is active
const CHANNEL_CHECK_MS  = parseInt(process.env.CHANNEL_CHECK_MS || "20000", 10);

if (!NTFY_TOPIC) throw new Error("NTFY_TOPIC env var is required");

// ─── HTTP CLIENTS WITH KEEP-ALIVE ─────────────────────────────────────────────
const httpAgent  = new http.Agent({
  keepAlive: true, maxSockets: 64, keepAliveMsecs: 30_000,
});
const httpsAgent = new https.Agent({
  keepAlive: true, maxSockets: 64, keepAliveMsecs: 30_000,
});
require("events").EventEmitter.defaultMaxListeners = 50;
httpAgent.setMaxListeners(50);
httpsAgent.setMaxListeners(50);

const yt = axios.create({
  httpAgent, httpsAgent,
  timeout: 15_000,
  maxRedirects: 3,
  responseType: "json",
  validateStatus: s => s >= 200 && s < 300,
});
const ntfyClient = axios.create({
  httpAgent, httpsAgent,
  timeout: 5_000,
});

// ─── STATE ────────────────────────────────────────────────────────────────────
// seenMessageIds: Map<videoId, Map<msgId, timestamp>> — TTL-based so evicted IDs don't re-fire
const seenMessageIds = new Map();
const streamLogs     = new Map();
const activeStreams  = new Map();
const userCooldowns  = new Map();
const skipFirstBatch = new Map(); // Map<videoId, boolean> — don't notify for history on reconnect

const COOLDOWN_MS       = 10_000;
const LOG_MAX_ENTRIES   = 100;
const SEEN_TTL_MS       = 6 * 60 * 60 * 1000; // 6 hours — longer than any typical stream interruption
const SEEN_MAX_PER_VID  = 20_000;

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

// ─── HEADERS ──────────────────────────────────────────────────────────────────
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
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
    "User-Agent": UA,
    "Content-Type": "application/json",
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate, br",
    "Origin": "https://www.youtube.com",
    "Referer": "https://www.youtube.com/",
    "X-Youtube-Client-Name": "1",
    "X-Youtube-Client-Version": "2.20240101.00.00",
  };
  if (YOUTUBE_COOKIES) h.Cookie = YOUTUBE_COOKIES;
  return h;
}

// ─── AXIOS WITH RETRY ─────────────────────────────────────────────────────────
async function request(config, label, maxRetries = 3) {
  let attempt = 0;
  while (true) {
    try {
      return await yt(config);
    } catch (err) {
      const status = err?.response?.status;
      if ((status === 429 || (status >= 500 && status < 600)) && attempt < maxRetries) {
        attempt++;
        const retryAfter = err?.response?.headers?.["retry-after"];
        const waitMs = retryAfter
          ? parseInt(retryAfter) * 1000
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
    method: "get",
    url: `https://www.youtube.com/watch?v=${videoId}`,
    headers: getBrowserHeaders(),
    responseType: "text",
    transformResponse: [d => d],
  }, videoId);

  const html = res.data;
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
  if (!ytData) throw new Error("Could not parse ytInitialData");

  const apiKey        = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1]
    || "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/)?.[1]
    || "2.20240101.00.00";
  const visitorData   = html.match(/"visitorData"\s*:\s*"([^"]+)"/)?.[1] || "";

  const continuation = extractInitialContinuation(ytData, html);
  if (!continuation) {
    if (!isLiveFlag) throw new Error("Stream does not appear to be live");
    throw new Error("Could not find live chat continuation token");
  }
  return { continuation, apiKey, clientVersion, visitorData };
}

function extractInitialContinuation(ytData, html) {
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
      context: {
        client: { clientName: "WEB", clientVersion, visitorData, hl: "en", gl: "US" },
      },
      continuation,
    },
  }, videoId);
  return parseChatResponse(res.data);
}

function parseChatResponse(data) {
  const messages = [];
  let nextContinuation = null;
  let timeoutMs = MIN_POLL_MS;

  const renderer =
    data?.continuationContents?.liveChatContinuation ||
    data?.contents?.liveChatContinuation;
  if (!renderer) return { messages, nextContinuation, timeoutMs };

  for (const c of renderer?.continuations || []) {
    const inv = c?.invalidationContinuationData;
    const timed = c?.timedContinuationData;
    if (inv) {
      nextContinuation = inv.continuation;
      timeoutMs = inv.timeoutMs ?? MIN_POLL_MS;
      break;
    } else if (timed) {
      nextContinuation = timed.continuation;
      timeoutMs = timed.timeoutMs ?? MIN_POLL_MS;
    }
  }

  timeoutMs = Math.max(MIN_POLL_MS, Math.min(timeoutMs, MAX_POLL_MS));

  const actions = renderer?.actions || [];
  for (const action of actions) {
    const addItem = action?.addChatItemAction?.item;
    if (!addItem) continue;
    const item =
      addItem.liveChatTextMessageRenderer ||
      addItem.liveChatPaidMessageRenderer ||
      addItem.liveChatMembershipItemRenderer;
    if (!item) continue;

    const id = item.id;
    const authorName = item.authorName?.simpleText || "Unknown";
    const authorChannelId = item.authorExternalChannelId || "";
    const runs = item.message?.runs || item.headerSubtext?.runs || [];
    let text = "";
    for (let i = 0; i < runs.length; i++) text += runs[i].text || "";

    // Message timestamp from YouTube (microseconds) — use to detect stale history
    const tsUsec = parseInt(item.timestampUsec || "0", 10);

    if (id && text) messages.push({ id, authorName, authorChannelId, text, tsUsec });
  }
  return { messages, nextContinuation, timeoutMs };
}

// ─── DEDUPLICATION WITH TTL ───────────────────────────────────────────────────
function isSeen(videoId, msgId) {
  const map = seenMessageIds.get(videoId);
  return map ? map.has(msgId) : false;
}
function markSeen(videoId, msgId) {
  let map = seenMessageIds.get(videoId);
  if (!map) { map = new Map(); seenMessageIds.set(videoId, map); }
  map.set(msgId, Date.now());
}

// Periodic cleanup — remove entries older than TTL, enforce max size
function cleanupSeen() {
  const now = Date.now();
  for (const [videoId, map] of seenMessageIds.entries()) {
    // TTL eviction
    for (const [id, ts] of map.entries()) {
      if (now - ts > SEEN_TTL_MS) map.delete(id);
    }
    // Hard cap — remove oldest if too big
    while (map.size > SEEN_MAX_PER_VID) {
      const firstKey = map.keys().next().value;
      map.delete(firstKey);
    }
    if (map.size === 0) seenMessageIds.delete(videoId);
  }
  // Cleanup cooldowns too
  for (const [key, ts] of userCooldowns.entries()) {
    if (now - ts > COOLDOWN_MS * 10) userCooldowns.delete(key);
  }
}
setInterval(cleanupSeen, 5 * 60 * 1000); // every 5 minutes

function isOnCooldown(videoId, authorId) {
  return Date.now() - (userCooldowns.get(`${videoId}:${authorId}`) || 0) < COOLDOWN_MS;
}
function setCooldown(videoId, authorId) {
  userCooldowns.set(`${videoId}:${authorId}`, Date.now());
}

// ─── NTFY (fire-and-forget with catch) ────────────────────────────────────────
function sendNotification(videoId, authorName, messageText) {
  ntfyClient.post(`https://ntfy.sh/${NTFY_TOPIC}`, messageText, {
    headers: {
      Title: `💬 ${authorName} in ${videoId}`,
      Tags: "youtube,live",
      Priority: "high",
      "Content-Type": "text/plain; charset=utf-8",
    },
  }).then(() => {
    log(videoId, "NOTIFY", `${authorName}: ${messageText.slice(0, 60)}`);
  }).catch(err => {
    log(videoId, "ERROR", `ntfy failed: ${err.message}`);
  });
}

// ─── PROCESS MESSAGES ─────────────────────────────────────────────────────────
function processMessages(videoId, messages, isFirstBatch) {
  const targets = TARGET_CHANNEL_IDS.length === 0 ? null : new Set(TARGET_CHANNEL_IDS);

  // On reconnect, we want to mark all history as "seen" WITHOUT notifying,
  // so that only genuinely new messages trigger notifications.
  const silent = isFirstBatch && skipFirstBatch.get(videoId) === true;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (isSeen(videoId, msg.id)) continue;
    markSeen(videoId, msg.id);

    if (silent) continue; // skip notifications for history on reconnect

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

  let retryCount = 0;
  let hasConnectedBefore = false;

  while (true) {
    try {
      const { continuation: initCont, apiKey, clientVersion, visitorData } =
        await fetchInitialChatData(videoId);

      activeStreams.set(videoId, {
        status: "live", since: new Date().toISOString(), retries: retryCount,
      });
      retryCount = 0;
      log(videoId, "INFO", "✅ Connected to live chat");

      // On RECONNECT, skip notifications for the first batch (which is history)
      // On first ever connect, we also skip history to avoid old message spam
      skipFirstBatch.set(videoId, true);
      hasConnectedBefore = true;

      let continuation = initCont;
      let pendingFetch = null;
      let isFirst = true;

      while (continuation) {
        const fetchPromise = pendingFetch ||
          fetchLiveChatPage(videoId, apiKey, clientVersion, visitorData, continuation);
        pendingFetch = null;

        const { messages, nextContinuation, timeoutMs } = await fetchPromise;

        // Dynamic polling: if we got messages, chat is active → poll faster
        // If empty, use server's suggested timeout (capped)
        const effectiveWait = messages.length > 0
          ? Math.max(ACTIVE_POLL_MS, MIN_POLL_MS)
          : timeoutMs;

        if (nextContinuation) {
          const nextStart = Date.now();
          // Kick off next fetch IMMEDIATELY (don't wait) — pipeline
          pendingFetch = fetchLiveChatPage(videoId, apiKey, clientVersion, visitorData, nextContinuation)
            .catch(err => { throw err; }); // Propagate to outer

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

    } catch (err) {
      const offline = err.message?.includes("not appear to be live");
      log(videoId, "ERROR", `Stream error: ${err.message}`);
      activeStreams.set(videoId, {
        status: offline ? "offline" : "reconnecting",
        since: new Date().toISOString(),
        error: err.message,
        retries: retryCount,
      });

      if (offline) {
        await sleep(30_000);
      } else {
        retryCount++;
        const delay = Math.min(5_000 * Math.pow(1.5, retryCount - 1), 60_000);
        log(videoId, "INFO", `Reconnecting in ${Math.round(delay / 1000)}s`);
        await sleep(delay);
      }
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
        headers: getBrowserHeaders(),
        responseType: "text",
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
  const activeVideoIds = new Set();

  while (true) {
    try {
      const videoId = await detectLiveStream(channelId);
      if (videoId && !activeVideoIds.has(videoId)) {
        console.log(`[CHANNEL] ✅ New live stream: ${videoId}`);
        activeVideoIds.add(videoId);
        streamListener(videoId).catch(err =>
          console.error(`[STREAM] ${videoId} crashed: ${err.message}`)
        );
      }
    } catch (err) {
      console.error(`[CHANNEL] ${channelId} error: ${err.message}`);
    }
    await sleep(CHANNEL_CHECK_MS);
  }
}

// ─── STATUS SERVER ────────────────────────────────────────────────────────────
function startStatusServer() {
  const app = express();
  app.get("/", (req, res) => res.json({
    status: "running",
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  }));
  app.get("/status", (req, res) => {
    const streams = {};
    for (const [id, info] of activeStreams.entries()) {
      streams[id] = {
        ...info,
        seenMessages: seenMessageIds.get(id)?.size || 0,
        logs: streamLogs.get(id)?.slice(-20) || [],
      };
    }
    res.json({
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      config: { MIN_POLL_MS, MAX_POLL_MS, ACTIVE_POLL_MS, CHANNEL_CHECK_MS },
      monitoredVideos: TARGET_VIDEO_IDS,
      monitoredChannels: TARGET_CHANNEL_IDS,
      streams,
    });
  });
  app.get("/logs/:videoId", (req, res) =>
    res.json(streamLogs.get(req.params.videoId) || [])
  );
  app.listen(PORT, () => console.log(`[STATUS] Running on port ${PORT}`));
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  YouTube Live Chat Notifier (real-time v2)");
  console.log(`  Poll: ${MIN_POLL_MS}–${MAX_POLL_MS}ms (active ${ACTIVE_POLL_MS}ms)`);
  console.log(`  Videos  : ${TARGET_VIDEO_IDS.join(", ") || "(none)"}`);
  console.log(`  Channels: ${TARGET_CHANNEL_IDS.join(", ") || "(none)"}`);
  console.log(`  ntfy    : https://ntfy.sh/${NTFY_TOPIC}`);
  console.log(`  Cookies : ${YOUTUBE_COOKIES ? "✅" : "❌"}`);
  console.log("═══════════════════════════════════════════");

  startStatusServer();
  for (const videoId of TARGET_VIDEO_IDS) {
    streamListener(videoId).catch(err => console.error(`[STREAM] ${videoId}: ${err.message}`));
  }
  for (const channelId of TARGET_CHANNEL_IDS) {
    channelWatcher(channelId).catch(err => console.error(`[CHANNEL] ${channelId}: ${err.message}`));
  }
}

main();
