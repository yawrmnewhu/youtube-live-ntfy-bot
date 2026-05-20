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
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const TARGET_VIDEO_IDS = (process.env.TARGET_VIDEO_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// ✅ HARD-CODED ntfy topic
const NTFY_TOPIC = "ytsignals172";

const YOUTUBE_COOKIES = process.env.YOUTUBE_COOKIES || "";
const PORT = process.env.PORT || 3000;

const MIN_POLL_MS = parseInt(process.env.MIN_POLL_MS || "300", 10);
const MAX_POLL_MS = parseInt(process.env.MAX_POLL_MS || "1500", 10);
const ACTIVE_POLL_MS = parseInt(process.env.ACTIVE_POLL_MS || "250", 10);
const CHANNEL_CHECK_MS = parseInt(process.env.CHANNEL_CHECK_MS || "20000", 10);

// ─── AUTO-RESTART CONFIG ──────────────────────────────────────────────────────
const MEM_WARN_MB = parseInt(process.env.MEM_WARN_MB || "350", 10);
const MEM_RESTART_MB = parseInt(process.env.MEM_RESTART_MB || "450", 10);
const MEM_HARD_LIMIT_MB = parseInt(process.env.MEM_HARD_LIMIT_MB || "480", 10);
const MEM_CHECK_MS = parseInt(process.env.MEM_CHECK_MS || "15000", 10);
const MAX_UPTIME_HOURS = parseInt(process.env.MAX_UPTIME_HOURS || "24", 10);
const SHUTDOWN_GRACE_MS = parseInt(process.env.SHUTDOWN_GRACE_MS || "10000", 10);

// ─── NTFY 429 AUTO-RESTART CONFIG ─────────────────────────────────────────────
const NTFY_429_THRESHOLD = parseInt(
  process.env.NTFY_429_THRESHOLD || "1",
  10
);

const NTFY_429_WINDOW_MS = parseInt(
  process.env.NTFY_429_WINDOW_MS || "60000",
  10
);

const NTFY_429_RESTART_DELAY_MS = parseInt(
  process.env.NTFY_429_RESTART_DELAY_MS || "2000",
  10
);

// ─── HTTP CLIENTS ─────────────────────────────────────────────────────────────
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 64,
  keepAliveMsecs: 30000,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  keepAliveMsecs: 30000,
});

require("events").EventEmitter.defaultMaxListeners = 50;

const yt = axios.create({
  httpAgent,
  httpsAgent,
  timeout: 15000,
  maxRedirects: 3,
  responseType: "json",
  validateStatus: s => s >= 200 && s < 300,
});

const ntfyClient = axios.create({
  httpAgent,
  httpsAgent,
  timeout: 5000,
});

// ─── STATE ────────────────────────────────────────────────────────────────────
const seenMessageIds = new Map();
const streamLogs = new Map();
const activeStreams = new Map();
const userCooldowns = new Map();
const skipFirstBatch = new Map();

const COOLDOWN_MS = 10000;
const LOG_MAX_ENTRIES = 100;
const SEEN_TTL_MS = 30 * 60 * 1000;
const SEEN_MAX_PER_VID = 5000;

let isShuttingDown = false;
let restartScheduled = false;

const startTime = Date.now();

// ntfy 429 tracking
const ntfy429Timestamps = [];

// ─── UTILS ────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(videoId, level, message) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
  };

  if (!streamLogs.has(videoId)) {
    streamLogs.set(videoId, []);
  }

  const logs = streamLogs.get(videoId);

  logs.push(entry);

  if (logs.length > LOG_MAX_ENTRIES) {
    logs.shift();
  }

  if (level !== "DEBUG") {
    console.log(`[${level}] [${videoId}] ${message}`);
  }
}

// ─── AUTO-RESTART ─────────────────────────────────────────────────────────────
function getMemMB() {
  const mem = process.memoryUsage();

  return {
    rss: mem.rss / 1048576,
    heap: mem.heapUsed / 1048576,
    ext: mem.external / 1048576,
  };
}

function scheduleRestart(reason, delay = 0) {
  if (restartScheduled) return;

  restartScheduled = true;

  console.log(
    `[RESTART] Scheduled (reason: ${reason}, delay: ${delay}ms)`
  );

  setTimeout(() => gracefulShutdown(reason), delay);
}

async function gracefulShutdown(reason) {
  if (isShuttingDown) return;

  isShuttingDown = true;

  console.log(`\n═══ GRACEFUL SHUTDOWN (${reason}) ═══`);

  const mem = getMemMB();

  console.log(
    `  Memory: RSS=${mem.rss.toFixed(1)}MB Heap=${mem.heap.toFixed(1)}MB`
  );

  console.log(
    `  Uptime: ${((Date.now() - startTime) / 1000 / 60).toFixed(1)} min`
  );

  // Skip ntfy notification on 429 restarts
  const skipNtfy = reason.startsWith("ntfy_429");

  if (!skipNtfy) {
    try {
      await Promise.race([
        ntfyClient.post(
          `https://ntfy.sh/${NTFY_TOPIC}`,
          `Service restarting: ${reason}`,
          {
            headers: {
              Title: "🔄 Auto-restart",
              Tags: "warning",
              Priority: "low",
            },
            timeout: 3000,
          }
        ),
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

  try {
    httpAgent.destroy();
  } catch {}

  try {
    httpsAgent.destroy();
  } catch {}

  seenMessageIds.clear();
  streamLogs.clear();
  activeStreams.clear();
  userCooldowns.clear();
  skipFirstBatch.clear();

  console.log(
    `[RESTART] Exiting in ${SHUTDOWN_GRACE_MS}ms...`
  );

  await sleep(SHUTDOWN_GRACE_MS);

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
      console.error(
        `[MEM] 🚨 HARD LIMIT: RSS=${mem.rss.toFixed(1)}MB > ${MEM_HARD_LIMIT_MB}MB`
      );

      scheduleRestart("hard_memory_limit", 0);
      return;
    }

    if (mem.rss > MEM_RESTART_MB) {
      console.warn(
        `[MEM] ⚠️ Restart: RSS=${mem.rss.toFixed(1)}MB > ${MEM_RESTART_MB}MB`
      );

      if (global.gc) {
        global.gc();

        const after = getMemMB();

        console.log(
          `[MEM] After GC: RSS=${after.rss.toFixed(1)}MB`
        );

        if (after.rss > MEM_RESTART_MB) {
          scheduleRestart("memory_restart", 1000);
        }
      } else {
        scheduleRestart("memory_restart_nogc", 1000);
      }

      return;
    }

    if (mem.rss > MEM_WARN_MB && now - lastWarnAt > 60000) {
      lastWarnAt = now;

      console.warn(
        `[MEM] Warning: RSS=${mem.rss.toFixed(1)}MB Heap=${mem.heap.toFixed(1)}MB`
      );

      if (global.gc) global.gc();
    }

    const uptimeH = (now - startTime) / 3600000;

    if (uptimeH > MAX_UPTIME_HOURS) {
      console.log(
        `[RESTART] Max uptime (${uptimeH.toFixed(1)}h)`
      );

      scheduleRestart("max_uptime", 0);
    }
  }, MEM_CHECK_MS);
}
