/**
 * BaseAdapter — shared implementation for methods identical across all adapters.
 *
 * Eliminates ~288 lines of duplication across 12 adapters.
 * Each concrete adapter extends this and provides platform-specific logic.
 *
 * Shared methods:
 *   - getSessionDir()       — builds session dir from sessionDirSegments
 *   - getSessionDBPath()    — SHA-256 hash of projectDir → .db file
 *   - getSessionEventsPath()— SHA-256 hash of projectDir → -events.md file
 *   - backupSettings()      — copies settings file to .bak
 *
 * Adapters with custom logic override the relevant method:
 *   - vscode-copilot: overrides getSessionDir (checks .github dir)
 *   - opencode: overrides getSessionDir (XDG_CONFIG_HOME / APPDATA)
 *              and backupSettings (calls checkPluginRegistration first)
 *   - openclaw: overrides backupSettings (searches 3 config paths)
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { accessSync, copyFileSync, constants, mkdirSync } from "node:fs";
import { homedir } from "node:os";

export abstract class BaseAdapter {
  constructor(protected readonly sessionDirSegments: string[]) {}

  getSessionDir(): string {
    const dir = join(homedir(), ...this.sessionDirSegments, "context-mode", "sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  getSessionDBPath(projectDir: string): string {
    const hash = createHash("sha256")
      .update(projectDir)
      .digest("hex")
      .slice(0, 16);
    return join(this.getSessionDir(), `${hash}.db`);
  }

  getSessionEventsPath(projectDir: string): string {
    const hash = createHash("sha256")
      .update(projectDir)
      .digest("hex")
      .slice(0, 16);
    return join(this.getSessionDir(), `${hash}-events.md`);
  }

  backupSettings(): string | null {
    const settingsPath = this.getSettingsPath();
    try {
      accessSync(settingsPath, constants.R_OK);
      const backupPath = settingsPath + ".bak";
      copyFileSync(settingsPath, backupPath);
      return backupPath;
    } catch {
      return null;
    }
  }

  /**
   * Default instruction files: CLAUDE.md (Claude Code convention).
   * Override in platform-specific adapters (e.g., Qwen: ["QWEN.md"]).
   */
  getInstructionFiles(): string[] {
    return ["CLAUDE.md"];
  }

  abstract getSettingsPath(): string;
}
