require("dotenv").config();
const axios = require("axios");
const express = require("express");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TARGET_CHANNEL_IDS = (process.env.TARGET_CHANNEL_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const TARGET_VIDEO_IDS = (process.env.TARGET_VIDEO_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const NTFY_TOPIC        = process.env.NTFY_TOPIC || "";
const YOUTUBE_COOKIES   = process.env.YOUTUBE_COOKIES || "";
const PORT              = process.env.PORT || 3000;

if (!NTFY_TOPIC) throw new Error("NTFY_TOPIC env var is required");

// ─── STATE ────────────────────────────────────────────────────────────────────
const seenMessageIds = new Map();
const streamLogs     = new Map();
const activeStreams  = new Map();
const userCooldowns  = new Map();

const COOLDOWN_MS     = 10_000;
const LOG_MAX_ENTRIES = 200;
const MAX_SEEN_IDS    = 5000;

// ─── LOGGING ──────────────────────────────────────────────────────────────────
function log(videoId, level, message) {
  const entry = { ts: new Date().toISOString(), level, message };
  if (!streamLogs.has(videoId)) streamLogs.set(videoId, []);
  const logs = streamLogs.get(videoId);
  logs.push(entry);
  if (logs.length > LOG_MAX_ENTRIES) logs.shift();
  console.log(`[${level}] [${videoId}] ${message}`);
}

// ─── HEADERS ──────────────────────────────────────────────────────────────────
function getBrowserHeaders() {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language":           "en-US,en;q=0.9",
    "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Cache-Control":             "no-cache",
    "Pragma":                    "no-cache",
    "Sec-Ch-Ua":                 '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-Ch-Ua-Mobile":          "?0",
    "Sec-Ch-Ua-Platform":        '"Windows"',
    "Sec-Fetch-Dest":            "document",
    "Sec-Fetch-Mode":            "navigate",
    "Sec-Fetch-Site":            "none",
    "Sec-Fetch-User":            "?1",
    "Upgrade-Insecure-Requests": "1",
  };
  if (YOUTUBE_COOKIES) headers["Cookie"] = YOUTUBE_COOKIES;
  return headers;
}

function getApiHeaders() {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language":          "en-US,en;q=0.9",
    "Accept":                   "*/*",
    "Content-Type":             "application/json",
    "Origin":                   "https://www.youtube.com",
    "Referer":                  "https://www.youtube.com/",
    "X-Youtube-Client-Name":    "1",
    "X-Youtube-Client-Version": "2.20240101.00.00",
    "Sec-Ch-Ua":                '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-Ch-Ua-Mobile":         "?0",
    "Sec-Ch-Ua-Platform":       '"Windows"',
    "Sec-Fetch-Dest":           "empty",
    "Sec-Fetch-Mode":           "cors",
    "Sec-Fetch-Site":           "same-origin",
  };
  if (YOUTUBE_COOKIES) headers["Cookie"] = YOUTUBE_COOKIES;
  return headers;
}

// ─── AXIOS WITH RETRY ─────────────────────────────────────────────────────────
async function axiosWithRetry(config, label, maxRetries = 5) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await axios(config);
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429) {
        attempt++;
        const retryAfter = err?.response?.headers?.["retry-after"];
        const waitMs = retryAfter
          ? parseInt(retryAfter) * 1000
          : Math.min(30_000 * Math.pow(2, attempt - 1), 300_000);
        console.log(`[WARN] [${label}] 429 — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${maxRetries})`);
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }
  throw new Error("Max retries exceeded after repeated 429s");
}

// ─── FETCH INITIAL CHAT DATA ──────────────────────────────────────────────────
async function fetchInitialChatData(videoId) {
  const res = await axiosWithRetry({
    method: "get",
    url: `https://www.youtube.com/watch?v=${videoId}`,
    headers: getBrowserHeaders(),
    timeout: 20_000,
  }, videoId);

  const html = res.data;

  const isLiveFlag      = html.includes('"isLive":true');
  const hasChat         = html.includes('liveChatRenderer');
  const hasContinuation = html.includes('"continuation"');
  log(videoId, "DEBUG",
    `Page fetched — isLive=${isLiveFlag} hasChat=${hasChat} hasContinuation=${hasContinuation}`
  );

  // Extract ytInitialData
  let ytData = null;
  const patterns = [
    /ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s,
    /ytInitialData\s*=\s*(\{.+?\})\s*;/s,
    /window\["ytInitialData"\]\s*=\s*(\{.+?\});/s,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      try { ytData = JSON.parse(match[1]); break; } catch {}
    }
  }
  if (!ytData) throw new Error("Could not parse ytInitialData from page");

  // Debug: dump conversationBar structure
  try {
    const chatSection = ytData?.contents?.twoColumnWatchNextResults?.conversationBar;
    log(videoId, "DEBUG", `conversationBar keys: ${JSON.stringify(Object.keys(chatSection || {}))}`);
    const lcr = chatSection?.liveChatRenderer;
    log(videoId, "DEBUG", `liveChatRenderer continuations: ${JSON.stringify(lcr?.continuations?.slice(0, 1))}`);
  } catch (e) {
    log(videoId, "DEBUG", `debug dump failed: ${e.message}`);
  }

  const apiKeyMatch        = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
  const clientVersionMatch = html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/);
  const visitorDataMatch   = html.match(/"visitorData"\s*:\s*"([^"]+)"/);

  const apiKey        = apiKeyMatch?.[1]        || "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  const clientVersion = clientVersionMatch?.[1] || "2.20240101.00.00";
  const visitorData   = visitorDataMatch?.[1]   || "";

  log(videoId, "DEBUG", `clientVersion=${clientVersion}`);

  const continuation = extractInitialContinuation(ytData, html);
  if (!continuation) {
    if (!isLiveFlag && !hasChat) throw new Error("Stream does not appear to be live");
    throw new Error("Could not find live chat continuation token");
  }

  log(videoId, "DEBUG", `Token: ${continuation.slice(0, 50)}...`);
  return { continuation, apiKey, clientVersion, visitorData };
}

// ─── EXTRACT CONTINUATION TOKEN ───────────────────────────────────────────────
function extractInitialContinuation(ytData, html) {
  const candidates = [];

  // Path 1: conversationBar
  try {
    const continuations = ytData?.contents?.twoColumnWatchNextResults
      ?.conversationBar?.liveChatRenderer?.continuations;
    if (continuations) for (const c of continuations) {
      candidates.push(
        c?.timedContinuationData?.continuation,
        c?.invalidationContinuationData?.continuation,
        c?.liveChatReplayContinuationData?.continuation
      );
    }
  } catch {}

  // Path 2: engagementPanels
  try {
    for (const panel of ytData?.engagementPanels || []) {
      const renderer = panel?.engagementPanelSectionListRenderer
        ?.content?.liveChatRenderer;
      if (renderer?.continuations) for (const c of renderer.continuations) {
        candidates.push(
          c?.timedContinuationData?.continuation,
          c?.invalidationContinuationData?.continuation
        );
      }
    }
  } catch {}

  // Path 3: secondaryResults
  try {
    const results = ytData?.contents?.twoColumnWatchNextResults;
    for (const item of results?.secondaryResults?.secondaryResults?.results || []) {
      const chat = item?.liveChatRenderer;
      if (chat?.continuations) for (const c of chat.continuations) {
        candidates.push(c?.timedContinuationData?.continuation);
      }
    }
  } catch {}

  // Path 4: deep regex on raw HTML — ANY token length 20+, no prefix restriction
  try {
    const matches = [...html.matchAll(/"continuation"\s*:\s*"([^"]{20,})"/g)];
    for (const m of matches) candidates.push(m[1]);
  } catch {}

  // Path 5: deep regex on stringified ytData
  try {
    const str = JSON.stringify(ytData);
    const matches = [...str.matchAll(/"continuation"\s*:\s*"([^"]{20,})"/g)];
    for (const m of matches) candidates.push(m[1]);
  } catch {}

  const found = candidates.filter(Boolean);
  console.log(`[DEBUG] Found ${found.length} continuation candidates`);
  if (found.length > 0) {
    console.log(`[DEBUG] First: ${found[0].slice(0, 60)}...`);
    console.log(`[DEBUG] All prefixes: ${found.slice(0, 5).map(t => t.slice(0, 10)).join(", ")}`);
  }

  return found[0] || null;
}

// ─── FETCH LIVE CHAT PAGE ─────────────────────────────────────────────────────
async function fetchLiveChatPage(videoId, apiKey, clientVersion, visitorData, continuation) {
  const url = `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${apiKey}`;

  const res = await axiosWithRetry({
    method: "post",
    url,
    headers: getApiHeaders(),
    data: {
      context: {
        client: {
          clientName: "WEB",
          clientVersion,
          visitorData,
          hl: "en",
          gl: "US",
        },
      },
      continuation,
    },
    timeout: 30_000,
  }, videoId);

  return parseChatResponse(res.data);
}

function parseChatResponse(data) {
  const messages = [];
  let nextContinuation = null;
  let timeoutMs = 3000;

  const renderer =
    data?.continuationContents?.liveChatContinuation ||
    data?.contents?.liveChatContinuation;

  if (!renderer) return { messages, nextContinuation, timeoutMs };

  for (const c of renderer?.continuations || []) {
    const timed = c?.timedContinuationData || c?.invalidationContinuationData;
    if (timed) {
      nextContinuation = timed.continuation;
      timeoutMs = timed.timeoutMs ?? 3000;
      break;
    }
  }

  for (const action of renderer?.actions || []) {
    const item =
      action?.addChatItemAction?.item?.liveChatTextMessageRenderer ||
      action?.addChatItemAction?.item?.liveChatPaidMessageRenderer ||
      action?.addChatItemAction?.item?.liveChatMembershipItemRenderer;
    if (!item) continue;

    const id              = item.id;
    const authorName      = item.authorName?.simpleText || "Unknown";
    const authorChannelId = item.authorExternalChannelId || "";
    const text = (item.message?.runs || item.headerSubtext?.runs || [])
      .map(r => r.text || "").join("");

    if (id && text) messages.push({ id, authorName, authorChannelId, text });
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
  if (set.size > MAX_SEEN_IDS) set.delete(set.values().next().value);
}

// ─── COOLDOWN ─────────────────────────────────────────────────────────────────
function isOnCooldown(videoId, authorId) {
  return Date.now() - (userCooldowns.get(`${videoId}:${authorId}`) || 0) < COOLDOWN_MS;
}
function setCooldown(videoId, authorId) {
  userCooldowns.set(`${videoId}:${authorId}`, Date.now());
}

// ─── NTFY ─────────────────────────────────────────────────────────────────────
async function sendNotification(videoId, authorName, messageText) {
  try {
    await axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, messageText, {
      headers: {
        Title:          `💬 ${authorName} in ${videoId}`,
        Tags:           "youtube,live",
        Priority:       "high",
        "Content-Type": "text/plain",
      },
      timeout: 10_000,
    });
    log(videoId, "NOTIFY", `${authorName}: ${messageText.slice(0, 60)}`);
  } catch (err) {
    log(videoId, "ERROR", `ntfy failed: ${err.message}`);
  }
}

// ─── PROCESS MESSAGES ─────────────────────────────────────────────────────────
async function processMessages(videoId, messages) {
  for (const msg of messages) {
    if (isSeen(videoId, msg.id)) continue;
    markSeen(videoId, msg.id);

    const shouldNotify =
      TARGET_CHANNEL_IDS.length === 0 ||
      TARGET_CHANNEL_IDS.includes(msg.authorChannelId);

    if (!shouldNotify) continue;
    if (isOnCooldown(videoId, msg.authorChannelId)) {
      log(videoId, "COOLDOWN", `Skipped ${msg.authorName}`);
      continue;
    }

    setCooldown(videoId, msg.authorChannelId);
    log(videoId, "MATCH", `${msg.authorName}: ${msg.text}`);
    await sendNotification(videoId, msg.authorName, msg.text);
  }
}

// ─── STREAM LISTENER ──────────────────────────────────────────────────────────
async function streamListener(videoId) {
  log(videoId, "INFO", "Starting stream listener");
  activeStreams.set(videoId, { status: "initializing", since: new Date().toISOString() });

  let retryCount = 0;

  while (true) {
    try {
      log(videoId, "INFO", "Fetching initial chat data...");
      const { continuation: initCont, apiKey, clientVersion, visitorData } =
        await fetchInitialChatData(videoId);

      activeStreams.set(videoId, {
        status: "live",
        since: new Date().toISOString(),
        retries: retryCount,
      });
      retryCount = 0;
      log(videoId, "INFO", "✅ Connected to live chat");

      let continuation = initCont;

      while (true) {
        if (!continuation) {
          log(videoId, "WARN", "No continuation — stream ended");
          break;
        }

        const { messages, nextContinuation, timeoutMs } =
          await fetchLiveChatPage(videoId, apiKey, clientVersion, visitorData, continuation);

        log(videoId, "DEBUG", `${messages.length} messages | next in ${timeoutMs}ms`);
        await processMessages(videoId, messages);

        continuation = nextContinuation;
        if (timeoutMs > 0) await sleep(timeoutMs);
      }

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
        log(videoId, "INFO", "Offline — retrying in 60s");
        await sleep(60_000);
      } else {
        retryCount++;
        const delay = Math.min(15_000 * Math.pow(1.5, retryCount - 1), 120_000);
        log(videoId, "INFO", `Reconnecting in ${Math.round(delay / 1000)}s (retry ${retryCount})`);
        await sleep(delay);
      }
    }
  }
}

// ─── CHANNEL WATCHER ──────────────────────────────────────────────────────────
async function detectLiveStream(channelId) {
  const urls = channelId.startsWith("UC")
    ? [
        `https://www.youtube.com/channel/${channelId}/live`,
        `https://www.youtube.com/channel/${channelId}`,
      ]
    : [
        `https://www.youtube.com/@${channelId}/live`,
        `https://www.youtube.com/@${channelId}`,
      ];

  for (const url of urls) {
    try {
      const res = await axiosWithRetry({
        method: "get",
        url,
        headers: getBrowserHeaders(),
        timeout: 15_000,
      }, channelId);

      const html     = res.data;
      const isLive   = html.includes('"isLive":true');
      const vidMatch = html.match(/watch\?v=([a-zA-Z0-9_-]{11})/);

      if (vidMatch && isLive) {
        console.log(`[CHANNEL] ✅ Found live stream ${vidMatch[1]} at ${url}`);
        return vidMatch[1];
      }
      console.log(`[CHANNEL] No live stream at ${url} (isLive=${isLive})`);
    } catch (err) {
      console.log(`[CHANNEL] URL failed (${url}): ${err.message}`);
    }
  }
  return null;
}

async function channelWatcher(channelId) {
  console.log(`[CHANNEL] Watching: ${channelId}`);
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
      } else if (!videoId) {
        console.log(`[CHANNEL] ${channelId} — no live stream, checking again in 60s`);
      }
    } catch (err) {
      console.error(`[CHANNEL] ${channelId} error: ${err.message}`);
    }
    await sleep(60_000);
  }
}

// ─── STATUS SERVER ────────────────────────────────────────────────────────────
function startStatusServer() {
  const app = express();

  app.get("/", (req, res) =>
    res.json({ status: "running", uptime: process.uptime() })
  );

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

  app.get("/logs/:videoId", (req, res) =>
    res.json(streamLogs.get(req.params.videoId) || [])
  );

  app.listen(PORT, () => console.log(`[STATUS] Running on port ${PORT}`));
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  YouTube Live Chat Notifier");
  console.log(`  Videos  : ${TARGET_VIDEO_IDS.join(", ") || "(none)"}`);
  console.log(`  Channels: ${TARGET_CHANNEL_IDS.join(", ") || "(none)"}`);
  console.log(`  ntfy    : https://ntfy.sh/${NTFY_TOPIC}`);
  console.log(`  Cookies : ${YOUTUBE_COOKIES ? "✅ provided" : "❌ none (may get 429s)"}`);
  console.log("═══════════════════════════════════════════");

  startStatusServer();

  for (const videoId of TARGET_VIDEO_IDS) {
    streamListener(videoId).catch(err =>
      console.error(`[STREAM] ${videoId} crashed: ${err.message}`)
    );
  }

  for (const channelId of TARGET_CHANNEL_IDS) {
    channelWatcher(channelId).catch(err =>
      console.error(`[CHANNEL] ${channelId} crashed: ${err.message}`)
    );
  }
}

main();
