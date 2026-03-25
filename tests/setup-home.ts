import { afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";

// Test-only isolation: many adapters/plugins intentionally write session state under
// homedir(), so the suite must not point at the contributor's real HOME.
export const fakeHome = mkdtempSync(join(tmpdir(), "context-mode-test-home-"));
const root = parse(fakeHome).root;
const saved = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  HOMEDRIVE: process.env.HOMEDRIVE,
  HOMEPATH: process.env.HOMEPATH,
};

export const realHome = saved.HOME ?? "";

process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.HOMEDRIVE = root.replace(/[\\/]+$/, "");
process.env.HOMEPATH = fakeHome.slice(root.length) || root;

vi.mock("node:os", async () => {
  const mod = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...mod, homedir: () => fakeHome };
});

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
