/**
 * Deny-policy project-dir resolution tests.
 *
 * `checkFilePathDenyPolicy` must use the canonical `getProjectDir()` helper so
 * that all supported adapters resolve project root via the full env cascade
 * (CLAUDE_PROJECT_DIR, GEMINI_PROJECT_DIR, VSCODE_CWD, OPENCODE_PROJECT_DIR,
 * PI_PROJECT_DIR, CONTEXT_MODE_PROJECT_DIR, cwd).
 *
 * The previous implementation used `process.env.CLAUDE_PROJECT_DIR ?? cwd()`
 * which fails open (or matches the wrong repo's deny rules) on every
 * non-Claude adapter — a P0 security bug.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(
  resolve(__dirname, "../../src/server.ts"),
  "utf-8",
);

describe("checkFilePathDenyPolicy: project-dir resolution", () => {
  test("function exists in server.ts", () => {
    expect(serverSrc).toContain("function checkFilePathDenyPolicy");
  });

  test("uses canonical getProjectDir() helper, not ad-hoc cascade", () => {
    const fnMatch = serverSrc.match(
      /function checkFilePathDenyPolicy[\s\S]*?^}/m,
    );
    expect(fnMatch).not.toBeNull();
    const body = fnMatch![0];

    // GREEN: must call getProjectDir()
    expect(body).toMatch(/getProjectDir\(\)/);

    // RED-guard: must NOT use the divergent ad-hoc resolution that
    // skips GEMINI_PROJECT_DIR / VSCODE_CWD / OPENCODE_PROJECT_DIR /
    // PI_PROJECT_DIR / CONTEXT_MODE_PROJECT_DIR.
    expect(body).not.toMatch(
      /process\.env\.CLAUDE_PROJECT_DIR\s*\?\?\s*process\.cwd\(\)/,
    );
    // Also reject the `||` variant of the ad-hoc cascade.
    expect(body).not.toMatch(
      /process\.env\.CLAUDE_PROJECT_DIR\s*\|\|\s*process\.cwd\(\)/,
    );
  });

  test("does not bypass adapter env vars", () => {
    const fnMatch = serverSrc.match(
      /function checkFilePathDenyPolicy[\s\S]*?^}/m,
    );
    const body = fnMatch![0];
    // The function body itself must not reference any specific adapter env var
    // directly — all resolution flows through getProjectDir().
    expect(body).not.toContain("GEMINI_PROJECT_DIR");
    expect(body).not.toContain("VSCODE_CWD");
    expect(body).not.toContain("OPENCODE_PROJECT_DIR");
    expect(body).not.toContain("PI_PROJECT_DIR");
    expect(body).not.toContain("CONTEXT_MODE_PROJECT_DIR");
    expect(body).not.toContain("IDEA_INITIAL_DIRECTORY");
  });
});
