/**
 * Shared stdin reader for all hook scripts.
 * Cross-platform (Windows/macOS/Linux) — no bash/jq dependency.
 *
 * Uses event-based flowing mode to avoid two platform bugs:
 * - `for await (process.stdin)` hangs on macOS when piped via spawnSync
 * - `readFileSync(0)` throws EOF/EISDIR on Windows, EAGAIN on Linux
 */

export function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data.replace(/^\uFEFF/, "")));
    process.stdin.on("error", reject);
    process.stdin.resume();
  });
}
