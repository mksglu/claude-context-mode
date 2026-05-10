/**
 * BaseAdapter — shared implementation for methods identical across all adapters.
 *
 * Each concrete adapter extends this and provides platform-specific logic.
 *
 * Shared methods:
 *   - getSessionDir()       — builds session dir from sessionDirSegments
 *   - backupSettings()      — copies settings file to .bak
 *
 * Adapters with custom logic override the relevant method:
 *   - vscode-copilot: overrides getSessionDir (checks .github dir)
 *   - opencode: overrides getSessionDir (XDG_CONFIG_HOME / APPDATA)
 *              and backupSettings (calls checkPluginRegistration first)
 *   - openclaw: overrides backupSettings (searches 3 config paths)
 *
 * NOTE — C2 narrowing (2026-05): `getSessionDBPath` and `getSessionEventsPath`
 * were removed. Both were SHALLOW pure derivatives of `getSessionDir() +
 * projectDir` (interface complexity == implementation complexity). All
 * adapter-storage path computation now flows through ONE site:
 * `resolveSessionDbPath({ projectDir, sessionsDir: adapter.getSessionDir() })`
 * in `src/session/db.ts`. Adapters expose only `getSessionDir()` for
 * storage-related path concerns.
 */

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

  /**
   * Default: build config dir from sessionDirSegments rooted at $HOME.
   *
   * Contract: ALWAYS returns an absolute path. Adapters with project-scoped
   * or non-home-rooted config dirs (cursor, vscode-copilot, jetbrains-copilot,
   * openclaw, opencode) override this and resolve their segments against
   * `projectDir` (or `process.cwd()` when omitted).
   *
   * @param _projectDir Unused by the home-rooted default — accepted so
   *                    project-scoped overrides honor the same signature.
   */
  getConfigDir(_projectDir?: string): string {
    return join(homedir(), ...this.sessionDirSegments);
  }

  /**
   * Default: Claude Code convention. Most adapters override with their
   * own platform-specific instruction file name (AGENTS.md, GEMINI.md, ...).
   */
  getInstructionFiles(): string[] {
    return ["CLAUDE.md"];
  }

  /**
   * Default: <configDir>/memory. Always absolute (configDir is absolute by
   * contract). Adapters with a different memory dir name (e.g., codex uses
   * "memories" plural) override this.
   */
  getMemoryDir(): string {
    return join(this.getConfigDir(), "memory");
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

  abstract getSettingsPath(): string;
}
