require("dotenv").config();
const axios = require("axios");
const express = require("express");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TARGET_CHANNEL_IDS = (process.env.TARGET_CHANNEL_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const TARGET_VIDEO_IDS = (process.env.TARGET_VIDEO_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const NTFY_TOPIC = process.env.NTFY_TOPIC || "";
const PORT = process.env.PORT || 3000;

if (!NTFY_TOPIC) throw new Error("NTFY_TOPIC env var is required");

// ─── STATE ────────────────────────────────────────────────────────────────────
const seenMessageIds = new Map();   // videoId -> Set of message IDs
const streamLogs     = new Map();   // videoId -> last N log entries
const activeStreams  = new Map();   // videoId -> { status, continuation, ... }
const userCooldowns  = new Map();   // `${videoId}:${authorId}` -> timestamp

const COOLDOWN_MS     = 10_000;     // 10s anti-spam per user per stream
const LOG_MAX_ENTRIES = 200;
const MAX_SEEN_IDS    = 5000;       // cap memory per stream

// ─── LOGGING ─────────────────────────────────────────────────────────────────
function log(videoId, level, message) {
  const entry = { ts: new Date().toISOString(), level, message };
  if (!streamLogs.has(videoId)) streamLogs.set(videoId, []);
  const logs = streamLogs.get(videoId);
  logs.push(entry);
  if (logs.length > LOG_MAX_ENTRIES) logs.shift();
  console.log(`[${level}] [${videoId}] ${message}`);
}

// ─── YOUTUBE INTERNAL API HELPERS ─────────────────────────────────────────────

// Mimics a real Chrome browser making the initial page request
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif," +
    "image/webp,*/*;q=0.8",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

const API_HEADERS = {
  ...BROWSER_HEADERS,
  "Content-Type": "application/json",
  Origin: "https://www.youtube.com",
  Referer: "https://www.youtube.com/",
  "X-Youtube-Client-Name": "1",
  "X-Youtube-Client-Version": "2.20240101.00.00",
};

/**
 * Fetches the YouTube watch page and extracts:
 * - Initial continuation token for live chat
 * - API key (INNERTUBE_API_KEY)
 * - Visitor data / client context
 */
async function fetchInitialChatData(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}&pbj=1`;
  const res = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: BROWSER_HEADERS,
    timeout: 15_000,
  });

  const html = res.data;

  // Extract ytInitialData JSON blob
  const dataMatch = html.match(/ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
  if (!dataMatch) throw new Error("Could not find ytInitialData in page");

  // Extract API key
  const apiKeyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
  const apiKey = apiKeyMatch ? apiKeyMatch[1] : "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

  // Extract client version
  const clientVersionMatch = html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/);
  const clientVersion = clientVersionMatch ? clientVersionMatch[1] : "2.20240101.00.00";

  // Extract visitor data
  const visitorDataMatch = html.match(/"visitorData"\s*:\s*"([^"]+)"/);
  const visitorData = visitorDataMatch ? visitorDataMatch[1] : "";

  let ytData;
  try {
    ytData = JSON.parse(dataMatch[1]);
  } catch {
    throw new Error("Failed to parse ytInitialData JSON");
  }

  // Navigate to live chat continuation token
  const continuation = extractInitialContinuation(ytData);
  if (!continuation) {
    // Check if stream is offline / VOD
    const isLive = html.includes('"isLive":true') || html.includes('"liveBroadcastDetails"');
    if (!isLive) throw new Error("Stream does not appear to be live");
    throw new Error("Could not find live chat continuation token");
  }

  return { continuation, apiKey, clientVersion, visitorData };
}

function extractInitialContinuation(ytData) {
  try {
    // Path 1: standard live chat tab
    const tabs = ytData?.contents?.twoColumnWatchNextResults
      ?.conversationBar?.liveChatRenderer?.continuations;
    if (tabs) {
      for (const c of tabs) {
        const token =
          c?.timedContinuationData?.continuation ||
          c?.invalidationContinuationData?.continuation ||
          c?.liveChatReplayContinuationData?.continuation;
        if (token) return token;
      }
    }

    // Path 2: sub-menu panel
    const panel = ytData?.contents?.twoColumnWatchNextResults
      ?.conversationBar?.liveChatRenderer;
    if (panel?.continuations?.[0]) {
      const c = panel.continuations[0];
      return (
        c?.timedContinuationData?.continuation ||
        c?.invalidationContinuationData?.continuation
      );
    }
  } catch {}
  return null;
}

/**
 * Calls YouTube's internal /live_chat/get_live_chat endpoint.
 * Returns { messages, nextContinuation, timeoutMs }
 *
 * This is a LONG-POLL style call — YouTube itself does this every ~1-5s
 * in the browser. We honor whatever timeout YouTube gives us.
 */
async function fetchLiveChatPage(apiKey, clientVersion, visitorData, continuation) {
  const url = `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${apiKey}`;

  const body = {
    context: {
      client: {
        clientName: "WEB",
        clientVersion,
        visitorData,
        hl: "en",
        gl: "US",
        userAgent: BROWSER_HEADERS["User-Agent"],
      },
    },
    continuation,
  };

  const res = await axios.post(url, body, {
    headers: API_HEADERS,
    timeout: 30_000,
  });

  return parseChatResponse(res.data);
}

function parseChatResponse(data) {
  const messages = [];
  let nextContinuation = null;
  let timeoutMs = 2000; // default fallback

  const renderer =
    data?.continuationContents?.liveChatContinuation ||
    data?.contents?.liveChatContinuation;

  if (!renderer) return { messages, nextContinuation, timeoutMs };

  // Extract next continuation + server-suggested timeout
  for (const c of renderer?.continuations || []) {
    const timed = c?.timedContinuationData || c?.invalidationContinuationData;
    if (timed) {
      nextContinuation = timed.continuation;
      // YouTube tells us how long to wait (in ms) — respect it
      timeoutMs = timed.timeoutMs ?? 2000;
      break;
    }
  }

  // Extract chat messages
  for (const action of renderer?.actions || []) {
    const item =
      action?.addChatItemAction?.item?.liveChatTextMessageRenderer ||
      action?.addChatItemAction?.item?.liveChatPaidMessageRenderer;
    if (!item) continue;

    const id = item.id;
    const authorName = item.authorName?.simpleText || "Unknown";
    const authorChannelId = item.authorExternalChannelId || "";
    const text = (item.message?.runs || [])
      .map(r => r.text || "")
      .join("");
    const timestampUsec = item.timestampUsec;

    if (id && text) {
      messages.push({ id, authorName, authorChannelId, text, timestampUsec });
    }
  }

  return { messages, nextContinuation, timeoutMs };
}

// ─── DEDUPLICATION ────────────────────────────────────────────────────────────
function isSeen(videoId, msgId) {
  if (!seenMessageIds.has(videoId)) seenMessageIds.set(videoId, new Set());
  return seenMessageIds.get(videoId).has(msgId);
}

function markSeen(videoId, msgId) {
  const set = seenMessageIds.get(videoId);
  set.add(msgId);
  // Evict oldest entries if cap exceeded (crude but effective)
  if (set.size > MAX_SEEN_IDS) {
    const first = set.values().next().value;
    set.delete(first);
  }
}

// ─── ANTI-SPAM COOLDOWN ───────────────────────────────────────────────────────
function isOnCooldown(videoId, authorId) {
  const key = `${videoId}:${authorId}`;
  const last = userCooldowns.get(key) || 0;
  return Date.now() - last < COOLDOWN_MS;
}

function setCooldown(videoId, authorId) {
  userCooldowns.set(`${videoId}:${authorId}`, Date.now());
}

// ─── NTFY NOTIFICATION ────────────────────────────────────────────────────────
async function sendNotification(videoId, authorName, messageText) {
  try {
    await axios.post(
      `https://ntfy.sh/${NTFY_TOPIC}`,
      messageText,
      {
        headers: {
          Title: `💬 ${authorName} in ${videoId}`,
          Tags: "youtube,live",
          Priority: "high",
          "Content-Type": "text/plain",
        },
        timeout: 10_000,
      }
    );
    log(videoId, "NOTIFY", `Sent notification for ${authorName}: ${messageText.slice(0, 60)}`);
  } catch (err) {
    log(videoId, "ERROR", `ntfy failed: ${err.message}`);
  }
}

// ─── STREAM LISTENER ──────────────────────────────────────────────────────────
/**
 * Processes a batch of messages from one chat fetch.
 * Filters by TARGET_CHANNEL_IDS, deduplicates, applies cooldown, notifies.
 */
async function processMessages(videoId, messages) {
  for (const msg of messages) {
    if (isSeen(videoId, msg.id)) continue;
    markSeen(videoId, msg.id);

    const shouldNotify =
      TARGET_CHANNEL_IDS.length === 0 ||
      TARGET_CHANNEL_IDS.includes(msg.authorChannelId);

    if (!shouldNotify) continue;
    if (isOnCooldown(videoId, msg.authorChannelId)) {
      log(videoId, "COOLDOWN", `Skipped ${msg.authorName} (cooldown)`);
      continue;
    }

    setCooldown(videoId, msg.authorChannelId);
    log(videoId, "MATCH", `${msg.authorName}: ${msg.text}`);
    await sendNotification(videoId, msg.authorName, msg.text);
  }
}

/**
 * Main event-driven loop for a single video stream.
 *
 * Architecture note: This uses YouTube's OWN continuation/timeout mechanism.
 * YouTube's web client does the exact same thing. The server tells us
 * how long to wait (timeoutMs) before the next request — we honor that,
 * making this as efficient and "human-like" as possible.
 *
 * This is NOT interval polling — the delay between requests is dynamic
 * and server-dictated, identical to how the browser works.
 */
async function streamListener(videoId) {
  log(videoId, "INFO", "Starting stream listener");
  activeStreams.set(videoId, { status: "initializing", since: new Date().toISOString() });

  let retryCount = 0;
  const MAX_RETRIES = 999; // practically infinite, but bounded
  const RETRY_BASE_DELAY_MS = 5_000;
  const RETRY_MAX_DELAY_MS = 120_000;

  while (retryCount < MAX_RETRIES) {
    try {
      // ── INIT PHASE ──────────────────────────────────────────────────────────
      log(videoId, "INFO", "Fetching initial chat data from watch page...");
      const { continuation: initCont, apiKey, clientVersion, visitorData } =
        await fetchInitialChatData(videoId);

      activeStreams.set(videoId, {
        status: "live",
        since: new Date().toISOString(),
        retries: retryCount,
      });
      retryCount = 0; // reset on successful connect
      log(videoId, "INFO", "Connected to live chat stream");

      // ── STREAMING PHASE ─────────────────────────────────────────────────────
      let continuation = initCont;

      while (true) {
        if (!continuation) {
          log(videoId, "WARN", "No continuation token — stream may have ended");
          break;
        }

        const { messages, nextContinuation, timeoutMs } =
          await fetchLiveChatPage(apiKey, clientVersion, visitorData, continuation);

        await processMessages(videoId, messages);

        continuation = nextContinuation;

        // Honor YouTube's server-suggested wait time (typically 1000–5000ms)
        // This is how the YouTube browser client works — NOT arbitrary polling
        if (timeoutMs > 0) {
          await sleep(timeoutMs);
        }
      }

      log(videoId, "WARN", "Stream ended or continuation exhausted — will retry");
    } catch (err) {
      const isStreamOffline = err.message?.includes("not appear to be live");
      log(videoId, "ERROR", `Stream error: ${err.message}`);
      activeStreams.set(videoId, {
        status: isStreamOffline ? "offline" : "reconnecting",
        since: new Date().toISOString(),
        error: err.message,
        retries: retryCount,
      });

      if (isStreamOffline) {
        // Stream not live — poll less aggressively to detect when it goes live
        log(videoId, "INFO", "Stream offline — checking again in 60s");
        await sleep(60_000);
      } else {
        retryCount++;
        const delay = Math.min(
          RETRY_BASE_DELAY_MS * Math.pow(1.5, retryCount - 1),
          RETRY_MAX_DELAY_MS
        );
        log(videoId, "INFO", `Reconnecting in ${Math.round(delay / 1000)}s (retry ${retryCount})`);
        await sleep(delay);
      }
    }
  }

  log(videoId, "ERROR", `Max retries exceeded for ${videoId} — giving up`);
  activeStreams.set(videoId, { status: "failed", since: new Date().toISOString() });
}

// ─── CHANNEL → LIVE VIDEO AUTO-DETECTION ─────────────────────────────────────
/**
 * Checks if a YouTube channel currently has an active live stream,
 * and returns the video ID if found.
 */
async function detectLiveStream(channelId) {
  try {
    const url = `https://www.youtube.com/@${channelId}/live`;
    const res = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 15_000 });
    const html = res.data;

    // Extract current video ID from the live redirect page
    const vidMatch = html.match(/"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/);
    const isLive = html.includes('"isLive":true') || html.includes('"liveBroadcastDetails"');

    if (vidMatch && isLive) return vidMatch[1];

    // Fallback: look for watch?v= in page
    const watchMatch = html.match(/watch\?v=([a-zA-Z0-9_-]{11})/);
    if (watchMatch && isLive) return watchMatch[1];
  } catch (err) {
    console.error(`[CHANNEL] [${channelId}] Detection failed: ${err.message}`);
  }
  return null;
}

/**
 * Continuously monitors a channel and auto-attaches to new live streams.
 */
async function channelWatcher(channelId) {
  console.log(`[CHANNEL] Watching channel: ${channelId}`);
  const activeVideoIds = new Set();

  while (true) {
    try {
      const videoId = await detectLiveStream(channelId);
      if (videoId && !activeVideoIds.has(videoId)) {
        console.log(`[CHANNEL] Detected live stream ${videoId} on channel ${channelId}`);
        activeVideoIds.add(videoId);
        // Launch a stream listener for this video (non-blocking)
        streamListener(videoId).catch(err =>
          console.error(`[STREAM] ${videoId} crashed: ${err.message}`)
        );
      }
    } catch (err) {
      console.error(`[CHANNEL] ${channelId} watcher error: ${err.message}`);
    }

    // Check for new live streams every 60s (this is channel detection, not chat polling)
    await sleep(60_000);
  }
}

// ─── STATUS SERVER ────────────────────────────────────────────────────────────
function startStatusServer() {
  const app = express();

  app.get("/", (req, res) => {
    res.json({ status: "running", uptime: process.uptime() });
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
    res.json({
      uptime: process.uptime(),
      monitoredVideos: TARGET_VIDEO_IDS,
      monitoredChannels: TARGET_CHANNEL_IDS,
      streams,
    });
  });

  app.get("/logs/:videoId", (req, res) => {
    const logs = streamLogs.get(req.params.videoId) || [];
    res.json(logs);
  });

  app.listen(PORT, () => {
    console.log(`[STATUS] Server running on port ${PORT}`);
  });
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  YouTube Live Chat Notifier");
  console.log(`  Videos  : ${TARGET_VIDEO_IDS.join(", ") || "(none)"}`);
  console.log(`  Channels: ${TARGET_CHANNEL_IDS.join(", ") || "(none)"}`);
  console.log(`  ntfy    : https://ntfy.sh/${NTFY_TOPIC}`);
  console.log("═══════════════════════════════════════════");

  startStatusServer();

  // Launch a stream listener per configured video ID (parallel)
  for (const videoId of TARGET_VIDEO_IDS) {
    streamListener(videoId).catch(err =>
      console.error(`[STREAM] ${videoId} crashed: ${err.message}`)
    );
  }

  // Launch channel watchers for auto-detection (parallel)
  for (const channelId of TARGET_CHANNEL_IDS) {
    channelWatcher(channelId).catch(err =>
      console.error(`[CHANNEL] ${channelId} watcher crashed: ${err.message}`)
    );
  }
}

main();
