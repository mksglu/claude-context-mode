#!/usr/bin/env node
// Render scripts/benchmarks-video/bench.html to a 1280x720 mp4 + gif.
//
// Usage:  node render.mjs
// Deps:   playwright (auto-installed on first run), ffmpeg (system).
// Output: ../../docs/assets/preview-benchmarks.{mp4,gif}

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, unlinkSync, renameSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML = resolve(__dirname, "bench.html");
const TMP = resolve(__dirname, ".tmp");
const ASSETS = resolve(__dirname, "../../docs/assets");
const OUT_MP4 = resolve(ASSETS, "preview-benchmarks.mp4");
const OUT_GIF = resolve(ASSETS, "preview-benchmarks.gif");

const WIDTH = 1280;
const HEIGHT = 720;
const DURATION_S = 9; // full animation including footer reveal + hold

if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
if (!existsSync(ASSETS)) mkdirSync(ASSETS, { recursive: true });

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright not installed. Run: npm i -D playwright && npx playwright install chromium");
  process.exit(1);
}

console.log(`> launching headless chromium (${WIDTH}x${HEIGHT})`);
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 2,
  recordVideo: { dir: TMP, size: { width: WIDTH, height: HEIGHT } },
});
const page = await context.newPage();

console.log(`> loading ${HTML}`);
await page.goto(`file://${HTML}`);
await page.waitForLoadState("networkidle");

console.log(`> recording ${DURATION_S}s`);
await page.waitForTimeout(DURATION_S * 1000);

const video = page.video();
await page.close();
await context.close();
await browser.close();

const webmPath = await video.path();
console.log(`> raw webm: ${webmPath} (${(statSync(webmPath).size / 1024).toFixed(1)} KB)`);

console.log(`> converting to mp4: ${OUT_MP4}`);
const mp4 = spawnSync("ffmpeg", [
  "-y", "-loglevel", "error",
  "-i", webmPath,
  "-vf", `scale=${WIDTH}:${HEIGHT}:flags=lanczos,fps=30`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "slow", "-crf", "20",
  "-movflags", "+faststart",
  OUT_MP4,
], { stdio: "inherit" });
if (mp4.status !== 0) process.exit(mp4.status ?? 1);

console.log(`> generating palette`);
const palette = resolve(TMP, "palette.png");
spawnSync("ffmpeg", [
  "-y", "-loglevel", "error",
  "-i", OUT_MP4,
  "-vf", `fps=15,scale=1280:-1:flags=lanczos,palettegen=stats_mode=full`,
  palette,
], { stdio: "inherit" });

console.log(`> converting to gif: ${OUT_GIF}`);
const gif = spawnSync("ffmpeg", [
  "-y", "-loglevel", "error",
  "-i", OUT_MP4,
  "-i", palette,
  "-lavfi", `fps=15,scale=1280:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
  OUT_GIF,
], { stdio: "inherit" });
if (gif.status !== 0) process.exit(gif.status ?? 1);

console.log(`> cleanup`);
for (const f of readdirSync(TMP)) unlinkSync(resolve(TMP, f));

const mp4KB = (statSync(OUT_MP4).size / 1024).toFixed(1);
const gifKB = (statSync(OUT_GIF).size / 1024).toFixed(1);
console.log(`✓ mp4: ${OUT_MP4} (${mp4KB} KB)`);
console.log(`✓ gif: ${OUT_GIF} (${gifKB} KB)`);
