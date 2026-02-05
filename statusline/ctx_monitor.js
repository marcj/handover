#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const input = readJSON(0);
const transcript = input.transcript_path;
const sessionId = input.session_id || "unknown";
const model = input.model?.display_name ?? "Claude";
const CONTEXT_WINDOW = input.context_window?.context_window_size || 200_000;

// Claude provides these directly - use them if available
const providedUsedPct = input.context_window?.used_percentage;
const providedTokens = input.context_window?.total_input_tokens;
const DAEMON_PORT = 47523;
const DAEMON_SCRIPT = path.join(__dirname, "ctx_daemon.js");

function readJSON(fd) {
  try { return JSON.parse(fs.readFileSync(fd, "utf8")); } catch { return {}; }
}

function color(p) {
  if (p >= 90) return "\x1b[31m"; // red
  if (p >= 70) return "\x1b[33m"; // yellow
  return "\x1b[32m"; // green
}

function segmentColor(i, isFree) {
  if (isFree) return "\x1b[90m"; // gray for free
  const colors = ["\x1b[36m", "\x1b[35m", "\x1b[34m", "\x1b[33m"]; // cyan, magenta, blue, yellow
  return colors[i % colors.length];
}

function usedTotal(u) {
  return (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0) +
         (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
}

function getUsage() {
  if (!transcript) return null;
  let lines;
  try { lines = fs.readFileSync(transcript, "utf8").split(/\r?\n/); } catch { return null; }

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const u = j.message?.usage;
    if (j.isSidechain || j.isApiErrorMessage || !u || usedTotal(u) === 0) continue;
    if (j.message?.role !== "assistant") continue;
    const m = String(j.message?.model ?? "").toLowerCase();
    if (m === "<synthetic>" || m.includes("synthetic")) continue;
    return u;
  }
  return null;
}

function startDaemon() {
  const child = spawn("node", [DAEMON_SCRIPT], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function fetchSegments(pct, callback) {
  const url = `http://127.0.0.1:${DAEMON_PORT}/segments?session=${encodeURIComponent(sessionId)}&pct=${pct}&transcript=${encodeURIComponent(transcript || "")}`;

  const req = http.get(url, { timeout: 80 }, (res) => {
    let data = "";
    res.on("data", (chunk) => data += chunk);
    res.on("end", () => {
      try {
        callback(null, JSON.parse(data));
      } catch {
        callback(null, { segments: [] });
      }
    });
  });

  req.on("error", (e) => {
    if (e.code === "ECONNREFUSED") {
      startDaemon();
    }
    callback(null, { segments: [] });
  });

  req.on("timeout", () => {
    req.destroy();
    callback(null, { segments: [] });
  });
}

function formatSegments(segments) {
  if (!segments || segments.length === 0) return "";

  const BAR_WIDTH = 20;

  // Build the colored bar
  let bar = "";
  let legend = [];

  segments.forEach((s, i) => {
    const isFree = s.name.toLowerCase() === "free";
    const c = segmentColor(i, isFree);
    const width = Math.max(1, Math.round((s.pct / 100) * BAR_WIDTH));
    bar += `${c}${"▒".repeat(width)}\x1b[0m`;

    // Legend: colored dot + name (truncate only if very long)
    const shortName = s.name.length > 15 ? s.name.slice(0, 14) + "…" : s.name;
    legend.push(`${c}● ${shortName}\x1b[0m`);
  });

  // Pad bar to fixed width if needed
  const barLen = segments.reduce((sum, s) => sum + Math.max(1, Math.round((s.pct / 100) * BAR_WIDTH)), 0);
  if (barLen < BAR_WIDTH) {
    bar += "\x1b[90m░\x1b[0m".repeat(BAR_WIDTH - barLen);
  }

  return ` ${bar} ${legend.join("  ")}`;
}

// Main
const usage = getUsage();
if (!usage) {
  // No usage yet - show 0% and note it's a fresh session
  console.log(`\x1b[95m${model}\x1b[0m \x1b[90m│\x1b[0m \x1b[32m0% used\x1b[0m \x1b[90m(new session)\x1b[0m`);
  process.exit(0);
}

// Prefer Claude's provided percentage, fall back to calculating from usage
const pct = providedUsedPct ?? Math.round((usedTotal(usage) * 1000) / CONTEXT_WINDOW) / 10;
// Calculate total tokens as Claude does: input + output roughly
const totalTokens = (input.context_window?.total_input_tokens || 0) + (input.context_window?.total_output_tokens || 0);
// But actually use percentage * context_window for display to match /context
const usedTokens = Math.round((pct / 100) * CONTEXT_WINDOW);
const k = (n) => n >= 1000 ? (n / 1000).toFixed(0) + "k" : n;

// Try to get segments from daemon (with tiny timeout)
fetchSegments(pct, (err, result) => {
  const segmentStr = formatSegments(result?.segments);
  console.log(`\x1b[95m${model}\x1b[0m \x1b[90m│\x1b[0m ${color(pct)}${pct.toFixed(1)}% used\x1b[0m \x1b[90m(${k(usedTokens)})\x1b[0m${segmentStr}`);
});
