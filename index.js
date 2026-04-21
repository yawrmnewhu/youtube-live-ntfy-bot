require("dotenv").config();
const axios = require("axios");
const express = require("express");
const http = require("http");
const https = require("https");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TARGET_CHANNEL_IDS = (process.env.TARGET_CHANNEL_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const TARGET_VIDEO_IDS = (process.env.TARGET_VIDEO_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const NTFY_TOPIC        = process.env.NTFY_TOPIC || "";
const YOUTUBE_COOKIES   = process.env.YOUTUBE_COOKIES || "";
const PORT              = process.env.PORT || 3000;

// Aggressive polling: override YT's suggested timeout (usually 5000ms) with floor/ceil
const MIN_POLL_MS       = parseInt(process.env.MIN_POLL_MS || "800", 10);
const MAX_POLL_MS       = parseInt(process.env.MAX_POLL_MS || "2000", 10);
const CHANNEL_CHECK_MS  = parseInt(process.env.CHANNEL_CHECK_MS || "20000", 10);

if (!NTFY_TOPIC) throw new Error("NTFY_TOPIC env var is required");

// ─── HTTP CLIENTS WITH KEEP-ALIVE (huge latency win) ──────────────────────────
const httpAgent  = new http.Agent({
  keepAlive: true,
  maxSockets: 64,
  keepAliveMsecs: 30_000,
});
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  keepAliveMsecs: 30_000,
});

// Raise listener limit — we have many concurrent workers sharing socket pool
require("events").EventEmitter.defaultMaxListeners = 50;
httpAgent.setMaxListeners(50);
httpsAgent.setMaxListeners(50);

// Dedicated axios instance — reuses sockets → saves ~200–500ms per request
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
const seenMessageIds = new Map();
const streamLogs     = new Map();
const activeStreams  = new Map();
const userCooldowns  = new Map();

const COOLDOWN_MS     = 10_000;
const LOG_MAX_ENTRIES = 200;
const MAX_SEEN_IDS    = 5000;

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

// ─── AXIOS WITH RETRY (only retry on 429/5xx) ─────────────────────────────────
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

// ─── EXTRACT CONTINUATION TOKEN ───────────────────────────────────────────────
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

    if (id && text) messages.push({ id, authorName, authorChannelId, text });
  }
  return { messages, nextContinuation, timeoutMs };
}

// ─── DEDUPLICATION ────────────────────────────────────────────────────────────
function isSeen(videoId, msgId) {
  const set = seenMessageIds.get(videoId);
  return set ? set.has(msgId) : false;
}
function markSeen(videoId, msgId) {
  let set = seenMessageIds.get(videoId);
  if (!set) { set = new Set(); seenMessageIds.set(videoId, set); }
  set.add(msgId);
  if (set.size > MAX_SEEN_IDS) set.delete(set.values().next().value);
}

function isOnCooldown(videoId, authorId) {
  return Date.now() - (userCooldowns.get(`${videoId}:${authorId}`) || 0) < COOLDOWN_MS;
}
function setCooldown(videoId, authorId) {
  userCooldowns.set(`${videoId}:${authorId}`, Date.now());
}

// ─── NTFY (fire-and-forget for lowest latency) ────────────────────────────────
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
function processMessages(videoId, messages) {
  const targets = TARGET_CHANNEL_IDS.length === 0 ? null : new Set(TARGET_CHANNEL_IDS);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (isSeen(videoId, msg.id)) continue;
    markSeen(videoId, msg.id);

    if (targets && !targets.has(msg.authorChannelId)) continue;
    if (isOnCooldown(videoId, msg.authorChannelId)) continue;

    setCooldown(videoId, msg.authorChannelId);
    log(videoId, "MATCH", `${msg.authorName}: ${msg.text}`);
    sendNotification(videoId, msg.authorName, msg.text);
  }
}

// ─── STREAM LISTENER (with request pipelining) ────────────────────────────────
async function streamListener(videoId) {
  log(videoId, "INFO", "Starting stream listener");
  activeStreams.set(videoId, { status: "initializing", since: new Date().toISOString() });

  let retryCount = 0;

  while (true) {
    try {
      const { continuation: initCont, apiKey, clientVersion, visitorData } =
        await fetchInitialChatData(videoId);

      activeStreams.set(videoId, {
        status: "live", since: new Date().toISOString(), retries: retryCount,
      });
      retryCount = 0;
      log(videoId, "INFO", "✅ Connected to live chat");

      let continuation = initCont;
      let pendingFetch = null;

      while (continuation) {
        const fetchPromise = pendingFetch ||
          fetchLiveChatPage(videoId, apiKey, clientVersion, visitorData, continuation);
        pendingFetch = null;

        const { messages, nextContinuation, timeoutMs } = await fetchPromise;

        if (nextContinuation) {
          const nextStart = Date.now();
          const requiredWait = timeoutMs;

          processMessages(videoId, messages);

          const elapsed = Date.now() - nextStart;
          if (elapsed < requiredWait) await sleep(requiredWait - elapsed);

          pendingFetch = fetchLiveChatPage(videoId, apiKey, clientVersion, visitorData, nextContinuation);
        } else {
          processMessages(videoId, messages);
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
  app.get("/", (req, res) => res.json({ status: "running", uptime: process.uptime() }));
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
      config: { MIN_POLL_MS, MAX_POLL_MS, CHANNEL_CHECK_MS },
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
  console.log("  YouTube Live Chat Notifier (real-time)");
  console.log(`  Poll window: ${MIN_POLL_MS}–${MAX_POLL_MS}ms`);
  console.log(`  Videos  : ${TARGET_VIDEO_IDS.join(", ") || "(none)"}`);
  console.log(`  Channels: ${TARGET_CHANNEL_IDS.join(", ") || "(none)"}`);
  console.log(`  ntfy    : https://ntfy.sh/${NTFY_TOPIC}`);
  console.log(`  Cookies : ${YOUTUBE_COOKIES ? "✅" : "❌ (recommended!)"}`);
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
