/**
 * adapters/detect — Auto-detect which platform is running.
 *
 * Detection priority:
 *   1. Environment variables (high confidence)
 *   2. Config directory existence (medium confidence)
 *   3. Fallback to Claude Code (low confidence — most common)
 *
 * Verified env vars per platform (from source code audit):
 *   - Claude Code:    CLAUDE_CODE_ENTRYPOINT, CLAUDE_PLUGIN_ROOT,
 *                     CLAUDE_PROJECT_DIR, CLAUDE_SESSION_ID | ~/.claude/
 *   - Gemini CLI:     GEMINI_PROJECT_DIR (hooks), GEMINI_CLI (MCP) | ~/.gemini/
 *   - KiloCode:       KILO, KILO_PID | ~/.config/kilo/
 *   - OpenCode:       OPENCODE, OPENCODE_PID | ~/.config/opencode/
 *   - OpenClaw:       OPENCLAW_HOME, OPENCLAW_CLI | ~/.openclaw/
 *   - Codex CLI:      CODEX_CI, CODEX_THREAD_ID | ~/.codex/
 *   - Cursor:         CURSOR_TRACE_ID (MCP), CURSOR_CLI (terminal) | ~/.cursor/
 *   - VS Code Copilot: VSCODE_PID, VSCODE_CWD | ~/.vscode/
 *   - JetBrains Copilot: IDEA_INITIAL_DIRECTORY, IDEA_HOME, JETBRAINS_CLIENT_ID | ~/.config/JetBrains/
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

import type { PlatformId, DetectionSignal, HookAdapter } from "./types.js";
import { CLIENT_NAME_TO_PLATFORM } from "./client-map.js";

/**
 * Issue #539 — fallback disambiguator. When env-var detection would
 * otherwise resolve to vscode-copilot (because Microsoft's `code` exports
 * VSCODE_PID into every spawned child), we look at
 * ~/.claude/plugins/installed_plugins.json. If that file lists context-mode
 * as an installed plugin, the runtime MUST be Claude Code — VS Code Copilot
 * has no concept of Claude plugins. Memoized per-process: the file is read
 * at most once, with a tri-state cache so a missing/malformed file does not
 * trigger repeated I/O on the detect() hot path.
 */
type PluginCache = { hasCM: boolean } | "miss" | null;
let claudeCodePluginCache: PluginCache = null;

function claudeCodeHasContextModePlugin(): boolean {
  if (claudeCodePluginCache !== null) {
    return claudeCodePluginCache !== "miss" && claudeCodePluginCache.hasCM;
  }
  try {
    const path = resolve(homedir(), ".claude", "plugins", "installed_plugins.json");
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as {
      plugins?: Record<string, unknown>;
      enabledPlugins?: Record<string, unknown>;
    };
    const keys = [
      ...Object.keys(parsed.plugins ?? {}),
      ...Object.keys(parsed.enabledPlugins ?? {}),
    ];
    const hasCM = keys.some((k) => k.includes("context-mode"));
    claudeCodePluginCache = { hasCM };
    return hasCM;
  } catch {
    claudeCodePluginCache = "miss";
    return false;
  }
}

/** Test-only: reset the installed_plugins.json memo so each test starts cold. */
export function __resetClaudeCodePluginCacheForTests(): void {
  claudeCodePluginCache = null;
}

/**
 * Test-only: pretend installed_plugins.json does not exist (or has no
 * context-mode entry). Lets tests that exercise the genuine vscode-copilot
 * env-var path run on a developer machine that actually has context-mode
 * installed as a Claude Code plugin.
 */
export function __seedClaudeCodePluginCacheMissForTests(): void {
  claudeCodePluginCache = "miss";
}

/**
 * Tag for each PLATFORM_ENV_VARS row.
 *   - `workspace`: env var names a project/working directory. Used by
 *     `resolveProjectDir({ strictPlatform })` to form the candidate list,
 *     and by Pi's bridge to scrub foreign workspace vars on child spawn.
 *   - `identification`: env var only signals which host is running; carries
 *     no project path. NEVER scrubbed (some are load-bearing, e.g.
 *     CLAUDE_PLUGIN_ROOT for hook integrations).
 *
 * Issue #545 — algorithmic env-leak fix. The split allows resolveProjectDir
 * to derive ALLOW (own workspace vars) and BAN (other platforms' workspace
 * vars) sets from a single registry, satisfying MUST-3 (15 adapters equal).
 */
export type EnvVarRole = "workspace" | "identification";
export interface PlatformEnvEntry {
  readonly name: string;
  readonly role: EnvVarRole;
  /**
   * When `false`, this entry is NOT used as a high-confidence detection
   * signal — only consumed by `workspaceEnvVarsFor`/`foreignWorkspaceEnv`
   * (project-dir cascade and bridge env scrub). Use for consumer-set
   * workspace vars that the host runtime never emits itself, so that a
   * stale env var on an unrelated host does not misclassify the platform.
   * Default: `true` (entry participates in detection).
   *
   * Issue #542 — PI_PROJECT_DIR / PI_WORKSPACE_DIR are consumer-set and
   * MUST NOT trigger Pi detection on their own.
   */
  readonly detect?: boolean;
}

/**
 * High-confidence env vars per platform, checked in priority order.
 * Single source of truth — consumed by detectPlatform() below, by
 * `resolveProjectDir({ strictPlatform })` for cascade construction, and by
 * Pi's bridge env scrub. Tests also iterate this map to clear platform-
 * related env vars deterministically.
 *
 * The map shape is `Map<PlatformId, ReadonlyArray<PlatformEnvEntry>>`. Use
 * `getEnvVarNames(p)` to get just the names (legacy `string[]` shape).
 */
const _PLATFORM_ENV_VARS_RAW: ReadonlyArray<readonly [PlatformId, readonly PlatformEnvEntry[]]> = [
  // Order matters: forks listed BEFORE the fork's parent so collision
  // detection works. Every entry verified against platform's own runtime
  // source code (PR #376 follow-up: full audit, May 2026 — see git blame).
  // Claude Code — verified against a live `env` dump (2026-05-11):
  //   CLAUDE_CODE_ENTRYPOINT=cli              (set on every CC session)
  //   CLAUDE_PLUGIN_ROOT=/Users/.../<version>  (set when a plugin is loaded)
  //   CLAUDE_PROJECT_DIR=/Users/.../project    (set in hooks context)
  //   CLAUDE_SESSION_ID=<uuid>                 (legacy session marker)
  // CLAUDE_CODE_ENTRYPOINT and CLAUDE_PLUGIN_ROOT are CC-exclusive — they
  // are the disambiguators for issue #539 (Claude Code running inside a
  // VS Code integrated terminal that has VSCODE_PID set). They MUST be
  // checked here so detect resolves to claude-code BEFORE falling through
  // to vscode-copilot below.
  ["claude-code", [
    { name: "CLAUDE_CODE_ENTRYPOINT", role: "identification" },
    { name: "CLAUDE_PLUGIN_ROOT",     role: "identification" },
    { name: "CLAUDE_PROJECT_DIR",     role: "workspace" },
    { name: "CLAUDE_SESSION_ID",      role: "identification" },
  ]],
  // antigravity (Electron/VSCode fork) — google-gemini/gemini-cli
  // packages/core/src/ide/detect-ide.ts checks ANTIGRAVITY_CLI_ALIAS as the
  // canonical Antigravity marker. Listed before vscode-copilot.
  ["antigravity", [
    { name: "ANTIGRAVITY_CLI_ALIAS", role: "identification" },
  ]],
  // cursor (VSCode fork) — listed before vscode-copilot. CURSOR_TRACE_ID has
  // 800+ hits in major OSS detection libs (Vercel Next.js, Bun, Google
  // gemini-cli, Nx, CrewAI). CURSOR_CWD is the documented workspace var
  // (issue #521) — listed first so workspace cascade picks it up.
  ["cursor", [
    { name: "CURSOR_CWD",       role: "workspace" },
    { name: "CURSOR_TRACE_ID",  role: "identification" },
    { name: "CURSOR_CLI",       role: "identification" },
  ]],
  // kilo (OpenCode fork) — Kilo-Org/kilocode packages/opencode/src/index.ts:138 + 139
  // sets `process.env.KILO = 1` + `process.env.KILO_PID = String(process.pid)`.
  ["kilo", [
    { name: "KILO",     role: "identification" },
    { name: "KILO_PID", role: "identification" },
  ]],
  // opencode — sst/opencode packages/opencode/src/index.ts:108-109 sets
  // OPENCODE=1 + OPENCODE_PID=<pid> on every CLI invocation.
  // OPENCODE_PROJECT_DIR is the documented workspace var (consumed by the
  // legacy resolver cascade) — listed first so the workspace cascade picks
  // it up under strict mode.
  ["opencode", [
    { name: "OPENCODE_PROJECT_DIR", role: "workspace" },
    { name: "OPENCODE",             role: "identification" },
    { name: "OPENCODE_PID",         role: "identification" },
  ]],
  // zed — zed-industries/zed crates/terminal/src/terminal.rs sets ZED_TERM=true
  // in `insert_zed_terminal_env()`. Google's gemini-cli uses ZED_SESSION_ID.
  ["zed", [
    { name: "ZED_SESSION_ID", role: "identification" },
    { name: "ZED_TERM",       role: "identification" },
  ]],
  // codex — openai/codex codex-rs/core/src/exec_env.rs sets CODEX_THREAD_ID
  // per exec; unified_exec/process_manager.rs sets CODEX_CI in CI mode.
  ["codex", [
    { name: "CODEX_THREAD_ID", role: "identification" },
    { name: "CODEX_CI",        role: "identification" },
  ]],
  // gemini-cli — GEMINI_PROJECT_DIR per google-gemini/gemini-cli
  // docs/hooks/index.md; GEMINI_CLI is the MCP-server sentinel.
  ["gemini-cli", [
    { name: "GEMINI_PROJECT_DIR", role: "workspace" },
    { name: "GEMINI_CLI",         role: "identification" },
  ]],
  // vscode-copilot — VSCODE_PID + VSCODE_CWD set by microsoft/vscode bootstrap.
  // Listed AFTER cursor and antigravity since they inherit these vars as forks.
  ["vscode-copilot", [
    { name: "VSCODE_CWD", role: "workspace" },
    { name: "VSCODE_PID", role: "identification" },
  ]],
  // jetbrains-copilot — IDEA_INITIAL_DIRECTORY set by JetBrains launcher.
  // (IDEA_HOME and JETBRAINS_CLIENT_ID removed — no source-line evidence.)
  ["jetbrains-copilot", [
    { name: "IDEA_INITIAL_DIRECTORY", role: "workspace" },
  ]],
  // qwen-code — QWEN_PROJECT_DIR per QwenLM/qwen-code docs/users/features/hooks.md.
  // (QWEN_SESSION_ID removed — 0 hits in qwen-code repository.)
  ["qwen-code", [
    { name: "QWEN_PROJECT_DIR", role: "workspace" },
  ]],
  // omp (can1357/oh-my-pi). PI_CODING_AGENT_DIR is the upstream
  // agent-dir override per `packages/utils/src/dirs.ts:193`. Listed
  // BEFORE pi so OMP is not misclassified as Pi when both are installed.
  ["omp", [
    { name: "PI_CODING_AGENT_DIR", role: "workspace" },
  ]],
  // pi — Issue #542 marker correction. PI_PROJECT_DIR is a consumer-set
  // var (read by src/adapters/pi/extension.ts) but is NOT auto-set by
  // the Pi runtime — verified against
  //   refs/platforms/oh-my-pi/packages/coding-agent/src/mcp/transports/stdio.ts:55-63
  // (env passthrough only, no synthesis). The Pi runtime DOES set
  // PI_CONFIG_DIR (config dir override), PI_SESSION_FILE (active session
  // path), and PI_COMPILED (binary build marker). PI_CODING_AGENT_DIR is
  // owned by OMP above; keep it there.
  //
  // Issue #545 — PI_WORKSPACE_DIR / PI_PROJECT_DIR are workspace vars set
  // by Pi's bridge so the resolver picks them up under strict mode.
  // PI_WORKSPACE_DIR comes first (extension-set, freshest) before
  // PI_PROJECT_DIR (user override) per registry-author cascade order.
  ["pi", [
    // Issue #545 — workspace vars set by Pi's bridge so resolveProjectDir
    // under strict mode picks them up. detect=false because PI_*_DIR are
    // consumer-set and must NOT misclassify a non-Pi host as Pi (#542).
    { name: "PI_WORKSPACE_DIR", role: "workspace",      detect: false },
    { name: "PI_PROJECT_DIR",   role: "workspace",      detect: false },
    { name: "PI_CONFIG_DIR",    role: "identification" },
    { name: "PI_SESSION_FILE",  role: "identification" },
    { name: "PI_COMPILED",      role: "identification" },
  ]],
  // openclaw — removed (runtime never sets OPENCLAW_HOME or OPENCLAW_CLI;
  // detection falls through to ~/.openclaw/ config-dir tier below).
  // kiro — not listed (no auto-set process env vars; ~/.kiro/ config-dir tier).
];

export const PLATFORM_ENV_VARS: ReadonlyMap<PlatformId, readonly PlatformEnvEntry[]> = new Map(
  _PLATFORM_ENV_VARS_RAW,
);

/**
 * Backwards-compat shim: legacy `string[]` shape used by detection logic and
 * by tests that iterate the registry to clear env vars. Always returns the
 * names in registry order.
 */
export function getEnvVarNames(platform: PlatformId): string[] {
  return (PLATFORM_ENV_VARS.get(platform) ?? []).map((e) => e.name);
}

/**
 * Issue #545 — return only role=workspace env var names for a platform, in
 * registry order. Empty array for adapters with no workspace var (e.g.
 * codex, kilo, zed, antigravity, openclaw, kiro). Consumed by
 * `resolveProjectDir({ strictPlatform })` to build the cascade.
 */
export function workspaceEnvVarsFor(platform: PlatformId): string[] {
  return (PLATFORM_ENV_VARS.get(platform) ?? [])
    .filter((e) => e.role === "workspace")
    .map((e) => e.name);
}

/**
 * Issue #545 — return the union of workspace env vars from ALL platforms
 * EXCEPT the given one. Consumed by Pi's bridge env scrub (strip foreign
 * workspace vars from spawned MCP child) and by the matrix regression test.
 */
export function foreignWorkspaceEnv(platform: PlatformId): Set<string> {
  const ban = new Set<string>();
  for (const [p, vars] of PLATFORM_ENV_VARS) {
    if (p === platform) continue;
    for (const v of vars) {
      if (v.role === "workspace") ban.add(v.name);
    }
  }
  return ban;
}

/**
 * Sync map from platform identifier → home-relative path segments where that
 * platform stores its config. Mirrors the `super([...])` argument passed by
 * each adapter — kept in sync as the single source of truth used when we need
 * a session dir BEFORE an adapter has been instantiated (race window between
 * MCP server start and `initialize` handshake completion).
 *
 * Returns `null` for "unknown" or any string outside the supported set so the
 * caller can decide on a safe fallback.
 */
export function getSessionDirSegments(platform: string): string[] | null {
  switch (platform) {
    case "claude-code":      return [".claude"];
    case "gemini-cli":       return [".gemini"];
    case "antigravity":      return [".gemini"];
    case "openclaw":         return [".openclaw"];
    case "codex":            return [".codex"];
    case "cursor":           return [".cursor"];
    case "vscode-copilot":   return [".vscode"];
    case "kiro":             return [".kiro"];
    case "pi":               return [".pi"];
    case "omp":              return [".omp"];
    case "qwen-code":        return [".qwen"];
    case "kilo":             return [".config", "kilo"];
    case "opencode":         return [".config", "opencode"];
    case "zed":              return [".config", "zed"];
    case "jetbrains-copilot": return [".config", "JetBrains"];
    default:                 return null;
  }
}

/**
 * Detect the current platform by checking env vars and config dirs.
 *
 * @param clientInfo - Optional MCP clientInfo from initialize handshake.
 *   When provided, takes highest priority (zero-config detection).
 */
export function detectPlatform(clientInfo?: { name: string; version?: string }): DetectionSignal {
  // ── Highest priority: MCP clientInfo ──────────────────
  if (clientInfo?.name) {
    const platform = CLIENT_NAME_TO_PLATFORM[clientInfo.name];
    if (platform) {
      return {
        platform,
        confidence: "high",
        reason: `MCP clientInfo.name="${clientInfo.name}"`,
      };
    }
    // Qwen Code uses dynamic client names: qwen-cli-mcp-client-<serverName>
    if (clientInfo.name.startsWith("qwen-cli-mcp-client")) {
      return {
        platform: "qwen-code",
        confidence: "high",
        reason: `MCP clientInfo.name="${clientInfo.name}" (qwen-cli pattern)`,
      };
    }
  }

  // ── Explicit platform override ────────────────────────
  const platformOverride = process.env.CONTEXT_MODE_PLATFORM;
  if (platformOverride) {
    const validPlatforms: PlatformId[] = [
      "claude-code", "gemini-cli", "kilo", "opencode", "codex",
      "vscode-copilot", "jetbrains-copilot", "cursor", "antigravity", "kiro", "pi", "omp", "zed", "qwen-code",
    ];
    if (validPlatforms.includes(platformOverride as PlatformId)) {
      return {
        platform: platformOverride as PlatformId,
        confidence: "high",
        reason: `CONTEXT_MODE_PLATFORM=${platformOverride} override`,
      };
    }
  }

  // ── High confidence: environment variables ─────────────

  for (const [platform, vars] of PLATFORM_ENV_VARS) {
    if (vars.some((v) => v.detect !== false && process.env[v.name])) {
      // Issue #539 belt-and-suspenders: VSCODE_PID/VSCODE_CWD are exported
      // by VS Code into EVERY child process — including a Claude Code CLI
      // launched from the integrated terminal. If env vars alone want to
      // resolve to vscode-copilot, but ~/.claude/plugins/installed_plugins.json
      // lists context-mode as a Claude Code plugin, the runtime must be
      // Claude Code (VS Code Copilot has no plugin concept). The env-var
      // tier above already handles the common case via CLAUDE_CODE_ENTRYPOINT
      // / CLAUDE_PLUGIN_ROOT; this branch covers MCP-server-only boots where
      // those vars have not propagated yet.
      if (platform === "vscode-copilot" && claudeCodeHasContextModePlugin()) {
        return {
          platform: "claude-code",
          confidence: "high",
          reason:
            "VSCODE_PID set but ~/.claude/plugins/installed_plugins.json lists context-mode (issue #539 fallback)",
        };
      }
      return {
        platform,
        confidence: "high",
        reason: `${vars.filter((v) => v.detect !== false).map((v) => v.name).join(" or ")} env var set`,
      };
    }
  }

  // ── Medium confidence: config directory existence ──────

  const home = homedir();

  if (existsSync(resolve(home, ".claude"))) {
    return {
      platform: "claude-code",
      confidence: "medium",
      reason: "~/.claude/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".gemini"))) {
    return {
      platform: "gemini-cli",
      confidence: "medium",
      reason: "~/.gemini/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".codex"))) {
    return {
      platform: "codex",
      confidence: "medium",
      reason: "~/.codex/ directory exists",
    };
  }

  // Issue #542 — CLI agents BEFORE host IDEs.
  //
  // Cursor (a VSCode fork) is the most installed editor across our user
  // base. Checking ~/.cursor/ first means every CLI agent co-installed
  // with Cursor (Pi, OMP, Kiro, Qwen) silently routes through
  // CursorAdapter even though the agent owns the session — Cursor merely
  // hosts the terminal. Reorder: agents (.kiro/.omp/.pi/.qwen/.openclaw)
  // win the medium-confidence tier, editors (~/.cursor/, ~/.vscode/,
  // JetBrains) lose. Verified by the detect-config-dir.test.ts matrix.
  if (existsSync(resolve(home, ".kiro"))) {
    return {
      platform: "kiro",
      confidence: "medium",
      reason: "~/.kiro/ directory exists",
    };
  }

  // OMP listed BEFORE pi: shared ~/.pi history with OMP-only ~/.omp/ marker.
  if (existsSync(resolve(home, ".omp"))) {
    return {
      platform: "omp",
      confidence: "medium",
      reason: "~/.omp/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".pi"))) {
    return {
      platform: "pi",
      confidence: "medium",
      reason: "~/.pi/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".qwen"))) {
    return {
      platform: "qwen-code",
      confidence: "medium",
      reason: "~/.qwen/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".openclaw"))) {
    return {
      platform: "openclaw",
      confidence: "medium",
      reason: "~/.openclaw/ directory exists",
    };
  }

  // Cursor / host IDEs — checked AFTER all CLI agents (issue #542).
  if (existsSync(resolve(home, ".cursor"))) {
    return {
      platform: "cursor",
      confidence: "medium",
      reason: "~/.cursor/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".config", "kilo"))) {
    return {
      platform: "kilo",
      confidence: "medium",
      reason: "~/.config/kilo/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".config", "JetBrains"))) {
    return {
      platform: "jetbrains-copilot",
      confidence: "medium",
      reason: "~/.config/JetBrains/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".config", "opencode"))) {
    return {
      platform: "opencode",
      confidence: "medium",
      reason: "~/.config/opencode/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".config", "zed"))) {
    return {
      platform: "zed",
      confidence: "medium",
      reason: "~/.config/zed/ directory exists",
    };
  }

  // ── Low confidence: fallback ───────────────────────────

  return {
    platform: "claude-code",
    confidence: "low",
    reason: "No platform detected, defaulting to Claude Code",
  };
}

/**
 * Get the adapter instance for a given platform.
 * Lazily imports platform-specific adapter modules.
 */
export async function getAdapter(platform?: PlatformId): Promise<HookAdapter> {
  const target = platform ?? detectPlatform().platform;

  switch (target) {
    case "claude-code": {
      const { ClaudeCodeAdapter } = await import("./claude-code/index.js");
      return new ClaudeCodeAdapter();
    }

    case "gemini-cli": {
      const { GeminiCLIAdapter } = await import("./gemini-cli/index.js");
      return new GeminiCLIAdapter();
    }

    case "kilo":
    case "opencode": {
      const { OpenCodeAdapter } = await import("./opencode/index.js");
      return new OpenCodeAdapter(target);
    }

    case "openclaw": {
      const { OpenClawAdapter } = await import("./openclaw/index.js");
      return new OpenClawAdapter();
    }

    case "codex": {
      const { CodexAdapter } = await import("./codex/index.js");
      return new CodexAdapter();
    }

    case "vscode-copilot": {
      const { VSCodeCopilotAdapter } = await import("./vscode-copilot/index.js");
      return new VSCodeCopilotAdapter();
    }

    case "jetbrains-copilot": {
      const { JetBrainsCopilotAdapter } = await import("./jetbrains-copilot/index.js");
      return new JetBrainsCopilotAdapter();
    }

    case "cursor": {
      const { CursorAdapter } = await import("./cursor/index.js");
      return new CursorAdapter();
    }

    case "antigravity": {
      const { AntigravityAdapter } = await import("./antigravity/index.js");
      return new AntigravityAdapter();
    }

    case "kiro": {
      const { KiroAdapter } = await import("./kiro/index.js");
      return new KiroAdapter();
    }

    case "zed": {
      const { ZedAdapter } = await import("./zed/index.js");
      return new ZedAdapter();
    }

    case "qwen-code": {
      const { QwenCodeAdapter } = await import("./qwen-code/index.js");
      return new QwenCodeAdapter();
    }

    case "omp": {
      const { OMPAdapter } = await import("./omp/index.js");
      return new OMPAdapter();
    }

    case "pi": {
      // Issue #473 follow-up: without this case, getAdapter("pi") fell
      // through to ClaudeCodeAdapter and Pi sessions wrote into
      // ~/.claude/context-mode/. PiAdapter pins storage to ~/.pi/.
      const { PiAdapter } = await import("./pi/index.js");
      return new PiAdapter();
    }

    default: {
      // Unsupported platform — fall back to Claude Code adapter
      // (MCP server works everywhere, hooks may not)
      const { ClaudeCodeAdapter } = await import("./claude-code/index.js");
      return new ClaudeCodeAdapter();
    }
  }
}
