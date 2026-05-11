import { vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";

import { getActiveFakeHome } from "./util/isolated-env-state.js";

// Import this helper only from suites that exercise homedir()-backed session state.
// We keep fake HOME opt-in per suite instead of global in vitest.config.ts so
// unrelated tests still run against their normal environment and do not inherit
// unnecessary path/env indirection.
export const fakeHome = mkdtempSync(join(tmpdir(), "context-mode-test-home-"));
const root = parse(fakeHome).root;
export const realHome = process.env.HOME ?? "";

process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.HOMEDRIVE = root.replace(/[\\/]+$/, "");
process.env.HOMEPATH = fakeHome.slice(root.length) || root;

// `node:os` mock: defer to `withIsolatedEnv()` when a scoped fake HOME is
// active; otherwise return the suite-wide fakeHome. This lets tests opt into
// stricter Windows-aware isolation without forking the mock setup.
vi.mock("node:os", async () => {
  const mod = await vi.importActual<typeof import("node:os")>("node:os");
  const realTmp = mod.tmpdir();
  return {
    ...mod,
    homedir: () => getActiveFakeHome() ?? fakeHome,
    tmpdir: () => getActiveFakeHome() ?? realTmp,
  };
});
