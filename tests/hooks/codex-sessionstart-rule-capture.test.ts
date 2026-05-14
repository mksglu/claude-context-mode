import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { loadDatabase } from "../../src/db-base.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CODEX_SESSIONSTART_PATH = join(__dirname, "..", "..", "hooks", "codex", "sessionstart.mjs");

function readRuleRows(codexHome: string) {
  const sessionDir = join(codexHome, "context-mode", "sessions");
  const dbFiles = readdirSync(sessionDir).filter((file) => file.endsWith(".db"));
  const Database = loadDatabase();
  const rows: Array<{ type: string; data: string }> = [];

  for (const file of dbFiles) {
    const db = new Database(join(sessionDir, file), { readonly: true });
    try {
      rows.push(
        ...db.prepare(
          "SELECT type, data FROM session_events WHERE category = 'rule' ORDER BY id",
        ).all() as Array<{ type: string; data: string }>,
      );
    } finally {
      db.close();
    }
  }

  return rows;
}

describe("hooks/codex/sessionstart.mjs — rule capture", () => {
  let fakeHome: string;
  let fakeProject: string;
  let codexHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "ctx-codex-home-"));
    fakeProject = mkdtempSync(join(tmpdir(), "ctx-codex-project-"));
    codexHome = join(fakeHome, ".codex");
    mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeProject, { recursive: true, force: true });
  });

  test("captures project AGENTS.md as rule events on startup", () => {
    writeFileSync(
      join(fakeProject, "AGENTS.md"),
      "# Project rules\n\nUse context-mode for analysis.\n",
      "utf8",
    );

    const result = spawnSync("node", [CODEX_SESSIONSTART_PATH], {
      input: JSON.stringify({
        session_id: "codex-rule-capture-session",
        source: "startup",
        cwd: fakeProject,
      }),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CODEX_HOME: codexHome,
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);

    const rows = readRuleRows(codexHome);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "rule", data: join(fakeProject, "AGENTS.md") }),
        expect.objectContaining({
          type: "rule_content",
          data: expect.stringContaining("Use context-mode for analysis."),
        }),
      ]),
    );
  });
});
