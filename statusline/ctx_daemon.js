#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const { spawn } = require("child_process");
const path = require("path");

const PORT = 47523;
const CACHE_FILE = path.join(__dirname, "segment_cache.json");
const LOG_FILE = path.join(__dirname, "analysis.log");
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MIN_INTERVAL_MS = 60 * 1000; // 60 seconds between analyses
const MIN_PCT_DELTA = 10; // 10% context increase before re-analyze
const ANALYSIS_TIMEOUT_MS = 2 * 60 * 1000; // 2 minute timeout for claude calls

let cache = loadCache();
let lastRequestTime = Date.now();
let analysisInFlight = false;
let currentAnalysisChild = null;

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error("Failed to save cache:", e.message);
  }
}

function shouldAnalyze(sessionId, pct) {
  if (analysisInFlight) return false;
  const c = cache[sessionId];
  if (!c) return true;
  const pctDelta = pct - (c.lastPct || 0);
  const timeDelta = Date.now() - (c.lastTime || 0);
  return pctDelta >= MIN_PCT_DELTA && timeDelta >= MIN_INTERVAL_MS;
}

function runAnalysis(sessionId, transcriptPath, pct) {
  if (analysisInFlight) return;
  analysisInFlight = true;

  // Read transcript and extract conversation
  let transcript = "";
  try {
    const lines = fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/).filter(Boolean);
    const messages = [];
    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        const role = j.message?.role;
        if (role === "user" || role === "assistant") {
          const content = j.message?.content;
          let text = "";
          if (typeof content === "string") {
            text = content;
          } else if (Array.isArray(content)) {
            text = content
              .filter(c => c.type === "text")
              .map(c => c.text)
              .join(" ");
          }
          // Truncate very long messages but keep enough context
          if (text.length > 500) {
            text = text.slice(0, 500) + "...";
          }
          if (text.trim()) {
            const prefix = role === "user" ? "USER" : "ASST";
            messages.push(`[${prefix}] ${text.trim()}`);
          }
        }
      } catch {}
    }
    transcript = messages.join("\n\n");
  } catch (e) {
    console.error("Failed to read transcript:", e.message);
    analysisInFlight = false;
    return;
  }

  const prompt = `You are analyzing a coding assistant conversation to create a statusline visualization. Extract the main topics discussed.

This is a conversation between a user and an AI coding assistant working on a software project. Identify what technical topics, features, bugs, or tasks were discussed.

Output format (single line, no explanation):
name1 XX%|name2 XX%|name3 XX%

Example outputs:
- "auth middleware 30%|user API 25%|database schema 25%|testing 20%"
- "React hooks 45%|form validation 35%|CSS styling 20%"
- "memory leak fix 65%|profiling setup 35%"

Rules:
- 3-6 topic segments, be SPECIFIC (e.g. "JWT auth" not "authentication", "Redis caching" not "caching")
- Names: 1-4 words, use technical terms from the conversation
- Percentages reflect relative time spent on each topic, must sum to 100
- Order by recency: MOST RECENTLY discussed topic goes LAST (rightmost), oldest first

Conversation transcript:
${transcript}`;

  log(`START session=${sessionId} pct=${pct}`);

  const child = spawn("claude", ["--print", "--model", "claude-sonnet-4-20250514", "-p", prompt], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  currentAnalysisChild = child;

  // Timeout to prevent stuck processes
  const timeout = setTimeout(() => {
    if (currentAnalysisChild === child) {
      log(`TIMEOUT session=${sessionId} - killing after ${ANALYSIS_TIMEOUT_MS}ms`);
      child.kill("SIGTERM");
    }
  }, ANALYSIS_TIMEOUT_MS);

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => stdout += d.toString());
  child.stderr.on("data", (d) => stderr += d.toString());

  child.on("close", (code) => {
    clearTimeout(timeout);
    currentAnalysisChild = null;
    analysisInFlight = false;

    if (code !== 0) {
      log(`ERROR session=${sessionId} code=${code} stderr=${stderr.slice(0, 500)}`);
      return;
    }

    // Parse response: "topic1 XX%|topic2 XX%|free XX%"
    const line = stdout.trim().split("\n").pop() || "";
    log(`RESULT session=${sessionId} raw=${line.slice(0, 200)}`);

    const segments = line.split("|").map(s => {
      const match = s.trim().match(/^(.+?)\s+(\d+)%$/);
      if (match) return { name: match[1].trim(), pct: parseInt(match[2], 10) };
      return null;
    }).filter(Boolean);

    if (segments.length > 0) {
      cache[sessionId] = {
        lastPct: pct,
        lastTime: Date.now(),
        segments,
      };
      saveCache();
      log(`CACHED session=${sessionId} segments=${segments.length}`);
    } else {
      log(`PARSE_FAIL session=${sessionId} - no valid segments from: ${line.slice(0, 100)}`);
    }
  });

  child.on("error", (err) => {
    clearTimeout(timeout);
    currentAnalysisChild = null;
    analysisInFlight = false;
    log(`SPAWN_ERROR session=${sessionId} err=${err.message}`);
  });
}

const server = http.createServer((req, res) => {
  lastRequestTime = Date.now();

  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/segments") {
    res.writeHead(404);
    res.end();
    return;
  }

  const sessionId = url.searchParams.get("session") || "unknown";
  const pct = parseFloat(url.searchParams.get("pct") || "0");
  const transcriptPath = url.searchParams.get("transcript") || "";

  // Check if we should start a new analysis
  if (shouldAnalyze(sessionId, pct) && transcriptPath) {
    runAnalysis(sessionId, transcriptPath, pct);
  }

  // Return cached segments (or empty if none yet)
  const c = cache[sessionId];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    segments: c?.segments || [],
    pending: analysisInFlight,
  }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`ctx_daemon listening on port ${PORT}`);
});

// Idle timeout check
setInterval(() => {
  if (Date.now() - lastRequestTime > IDLE_TIMEOUT_MS) {
    console.log("Idle timeout reached, shutting down");
    process.exit(0);
  }
}, 60000);

// Handle graceful shutdown
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
