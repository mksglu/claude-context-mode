#!/usr/bin/env node
/**
 * Post-build deploy script for the OpenClaw plugin.
 * Clears jiti cache and restarts the gateway process.
 */

import { execSync } from "node:child_process";
import { globSync } from "node:fs";
import { unlinkSync } from "node:fs";

// 1. Clear jiti cache
console.log("[deploy] Clearing jiti cache...");
try {
  const files = globSync("/tmp/jiti/context-mode-index.*.cjs");
  for (const f of files) {
    unlinkSync(f);
    console.log(`  removed ${f}`);
  }
  if (files.length === 0) {
    console.log("  no cached files found");
  }
} catch {
  console.log("  jiti cache dir not found or already clean");
}

// 2. Find and kill openclaw gateway (system auto-respawns it)
console.log("[deploy] Restarting openclaw gateway...");
try {
  const pid = execSync("pgrep -f openclaw", { encoding: "utf-8" }).trim();
  if (pid) {
    const pids = pid.split("\n");
    for (const p of pids) {
      try {
        process.kill(Number(p), "SIGTERM");
        console.log(`  killed PID ${p}`);
      } catch {
        // process may have already exited
      }
    }
    console.log("[deploy] Gateway will auto-respawn.");
  }
} catch {
  console.log("  no openclaw gateway process found — nothing to restart");
}

console.log("[deploy] Done.");
