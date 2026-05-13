/**
 * adapters/types — Platform adapter interface for multi-platform hook support.
 *
 * Defines the contract that each platform adapter must implement.
 * Three paradigms exist across supported platforms:
 *   A) JSON stdin/stdout — Claude Code, Gemini CLI, VS Code Copilot, Copilot CLI, Cursor
 *   B) TS Plugin Functions — OpenCode
 *   C) MCP-only (no hooks) — Codex CLI
 *
 * The MCP server layer is 100% portable and needs no adapter.
 * Only the hook layer requires platform-specific adapters.
 */

// ─────────────────────────────────────────────────────────
// Hook paradigm
// ─────────────────────────────────────────────────────────

export type HookParadigm = "json-stdio" | "ts-plugin" | "mcp-only";

// ─────────────────────────────────────────────────────────
// Platform capabilities
// ─────────────────────────────────────────────────────────

export interface PlatformCapabilities {
  /** Platform supports PreToolUse / BeforeTool / tool.execute.before hooks. */
  preToolUse: boolean;
  /** Platform supports PostToolUse / AfterTool / tool.execute.after hooks. */
  postToolUse: boolean;
  /** Platform supports PreCompact / PreCompress / session.compacting hooks. */
  preCompact: boolean;
  /** Platform supports SessionStart / session.created hooks. */
  sessionStart: boolean;
  /** Platform allows modifying tool input arguments via hooks. */
  canModifyArgs: boolean;
  /** Platform allows modifying tool output via PostToolUse hooks. */
  canModifyOutput: boolean;
  /** Platform allows injecting context during session start or compaction. */
  canInjectSessionContext: boolean;
}

// ─────────────────────────────────────────────────────────
// Normalized hook event types
// ─────────────────────────────────────────────────────────

/** Normalized PreToolUse event — platform-agnostic representation. */
export interface PreToolUseEvent {
  /** Tool name being invoked (e.g., "Bash", "Read", "WebFetch"). */
  toolName: string;
  /** Tool input arguments as key-value pairs. */
  toolInput: Record<string, unknown>;
  /** Session ID extracted by the adapter. */
  sessionId: string;
  /** Project directory (if available). */
  projectDir?: string;
  /** Raw platform-specific input (for passthrough if needed). */
  raw: unknown;
}

/** Normalized PostToolUse event — platform-agnostic representation. */
export interface PostToolUseEvent {
  /** Tool name that was invoked. */
  toolName: string;
  /** Tool input arguments. */
  toolInput: Record<string, unknown>;
  /** Tool output/response (if available). */
  toolOutput?: string;
  /** Whether the tool call resulted in an error. */
  isError?: boolean;
  /** Session ID extracted by the adapter. */
  sessionId: string;
  /** Project directory (if available). */
  projectDir?: string;
  /** Raw platform-specific input. */
  raw: unknown;
}

/** Normalized PreCompact event. */
export interface PreCompactEvent {
  /** Session ID. */
  sessionId: string;
  /** Project directory (if available). */
  projectDir?: string;
  /** Raw platform-specific input. */
  raw: unknown;
}

/** Normalized SessionStart event. */
export interface SessionStartEvent {
  /** Session ID. */
  sessionId: string;
  /** Lifecycle source: fresh start, compaction, resume, or clear. */
  source: "startup" | "compact" | "resume" | "clear";
  /** Project directory (if available). */
  projectDir?: string;
  /** Raw platform-specific input. */
  raw: unknown;
}

// ─────────────────────────────────────────────────────────
// Hook response types
// ─────────────────────────────────────────────────────────

/** Response from PreToolUse hook — can block, modify, inject context, or pass through. */
export interface PreToolUseResponse {
  /**
   * "allow"   = pass through (no action)
   * "deny"    = block tool execution
   * "modify"  = change input args
   * "context" = inject additional context (soft guidance)
   * "ask"     = prompt user for confirmation (security policy match)
   */
  decision: "allow" | "deny" | "modify" | "context" | "ask";
  /** Reason for denial (shown to the model). */
  reason?: string;
  /** Modified tool input (only when decision = "modify"). */
  updatedInput?: Record<string, unknown>;
  /** Additional context to inject (only when decision = "context"). */
  additionalContext?: string;
}

/** Response from PostToolUse hook — can inject context or modify output. */
export interface PostToolUseResponse {
  /** Additional context to inject after tool output. */
  additionalContext?: string;
  /** Modified tool output (if platform supports it). */
  updatedOutput?: string;
}

/** Response from PreCompact hook — injects context before compaction. */
export interface PreCompactResponse {
  /** Context to preserve across compaction. */
  context?: string;
}

/** Response from SessionStart hook — injects context at session start. */
export interface SessionStartResponse {
  /** Context to inject at session start. */
  context?: string;
}

// ─────────────────────────────────────────────────────────
// Hook config types
// ─────────────────────────────────────────────────────────

/** A single hook entry in platform configuration. */
export interface HookEntry {
  /** Tool matcher pattern (empty = match all). */
  matcher: string;
  /** Hook commands/handlers to execute. */
  hooks: Array<{
    type: string;
    command: string;
  }>;
}

/** Hook registration map — maps hook types to their entries. */
export type HookRegistration = Record<string, HookEntry[]>;

// ─────────────────────────────────────────────────────────
// Adapter interface
// ─────────────────────────────────────────────────────────

/**
 * HookAdapter — contract for platform-specific hook implementations.
 *
 * Each supported platform (Claude Code, Gemini CLI, OpenCode, etc.)
 * provides an adapter that normalizes its hook I/O into a common format.
 */
export interface HookAdapter {
  /** Human-readable platform name (e.g., "Claude Code", "Gemini CLI"). */
  readonly name: string;

  /** Hook I/O paradigm used by this platform. */
  readonly paradigm: HookParadigm;

  /** What this platform supports. */
  readonly capabilities: PlatformCapabilities;

  // ── Input parsing ──────────────────────────────────────

  /** Parse raw PreToolUse input into normalized form. */
  parsePreToolUseInput(raw: unknown): PreToolUseEvent;

  /** Parse raw PostToolUse input into normalized form. */
  parsePostToolUseInput(raw: unknown): PostToolUseEvent;

  /** Parse raw PreCompact input (optional — not all platforms support it). */
  parsePreCompactInput?(raw: unknown): PreCompactEvent;

  /** Parse raw SessionStart input (optional — not all platforms support it). */
  parseSessionStartInput?(raw: unknown): SessionStartEvent;

  // ── Response formatting ────────────────────────────────

  /** Format a PreToolUse response into platform-specific output. */
  formatPreToolUseResponse(response: PreToolUseResponse): unknown;

  /** Format a PostToolUse response into platform-specific output. */
  formatPostToolUseResponse(response: PostToolUseResponse): unknown;

  /** Format a PreCompact response into platform-specific output. */
  formatPreCompactResponse?(response: PreCompactResponse): unknown;

  /** Format a SessionStart response into platform-specific output. */
  formatSessionStartResponse?(response: SessionStartResponse): unknown;

  // ── Configuration ──────────────────────────────────────

  /** Path to the platform's settings file (e.g., ~/.claude/settings.json). */
  getSettingsPath(): string;

  /**
   * Directory where session data is stored.
   *
   * NOTE — C2 narrowing (2026-05): this is the ONLY storage-path concern an
   * adapter exposes. Per-project DB paths are derived by callers via
   * `resolveSessionDbPath({ projectDir, sessionsDir: adapter.getSessionDir() })`
   * (see `src/session/db.ts`). Per-project events.md paths follow the same
   * `<sessionDir>/<hash><suffix>-events.md` shape and are computed inline at
   * the small number of call sites that need them (server.ts, hooks).
   */
  getSessionDir(): string;

  /**
   * Platform config directory.
   *
   * Contract: ALWAYS returns an absolute path. Never returns a relative
   * segment, never returns an empty string. This eliminates the leaky-seam
   * where callers could not tell whether the return needed further resolution.
   *
   * Resolution rules:
   *   - Home-rooted platforms (claude-code, codex, qwen, gemini, antigravity,
   *     zed, opencode, …) return paths under `homedir()` / XDG / APPDATA.
   *   - Project-scoped platforms (cursor → `.cursor`, vscode-copilot &
   *     jetbrains-copilot → `.github`, kiro → `.kiro`, openclaw → project root)
   *     resolve their segment against the supplied `projectDir`. When
   *     `projectDir` is omitted, `process.cwd()` is used as the fallback.
   *
   * @param projectDir Optional project root used to resolve project-scoped
   *                   adapters. Ignored by home-rooted adapters.
   */
  getConfigDir(projectDir?: string): string;

  /**
   * Names of platform-native instruction/rule files that act as the
   * project's "user CLAUDE.md equivalent" (e.g., ["CLAUDE.md"],
   * ["AGENTS.md"], ["GEMINI.md"]). Auto-memory scans for these in the
   * project root and config dir, and rule-detection emits "rule" events
   * when they are read.
   */
  getInstructionFiles(): string[];

  /**
   * Directory where persistent per-user memory is stored
   * (e.g., ~/.claude/memory, ~/.codex/memories). Auto-memory scans
   * *.md files in this directory.
   */
  getMemoryDir(): string;

  /** Generate hook registration config for this platform. */
  generateHookConfig(pluginRoot: string): HookRegistration;

  /** Read current platform settings. */
  readSettings(): Record<string, unknown> | null;

  /** Write platform settings. */
  writeSettings(settings: Record<string, unknown>): void;

  // ── Diagnostics (doctor) ───────────────────────────────

  /** Validate that hooks are properly configured for this platform. */
  validateHooks(pluginRoot: string): DiagnosticResult[];

  /**
   * Adapter-defined per-platform health checks (Algo-D1).
   *
   * OPTIONAL. Adapters that don't override return nothing — they don't
   * have this class of check today. claude-code overrides with hook-script
   * existence checks that join `pluginRoot + scriptName` directly via
   * `existsSync`, so doctor never round-trips through a regex on a hook
   * command (the #548 root cause).
   *
   * Adapter #16 with hook scripts inherits the contract by overriding;
   * adapter #17 without hook scripts simply doesn't override. The doctor
   * iterates `adapter.getHealthChecks?.(pluginRoot) ?? []` and renders
   * each — no per-adapter wiring in the doctor body.
   */
  getHealthChecks?(pluginRoot: string): readonly HealthCheck[];

  /** Check if the plugin is registered/enabled on this platform. */
  checkPluginRegistration(): DiagnosticResult;

  /** Get the installed version from this platform's registry/marketplace. */
  getInstalledVersion(): string;

  // ── Upgrade ────────────────────────────────────────────

  /** Configure all hooks for this platform. Returns change descriptions. */
  configureAllHooks(pluginRoot: string): string[];

  /** Backup platform settings before modification. Returns backup path or null. */
  backupSettings(): string | null;

  /** Set executable permissions on hook scripts. Returns paths that were set. */
  setHookPermissions(pluginRoot: string): string[];

  /** Update platform's plugin registry to point to given path and version. */
  updatePluginRegistry(pluginRoot: string, version: string): void;

}

// ─────────────────────────────────────────────────────────
// Diagnostic result
// ─────────────────────────────────────────────────────────

/** Result from a platform-specific diagnostic check. */
export interface DiagnosticResult {
  /** What was checked. */
  check: string;
  /** Pass, fail, or warning. */
  status: "pass" | "fail" | "warn";
  /** Human-readable message. */
  message: string;
  /** Suggested fix command (if applicable). */
  fix?: string;
}

/**
 * Adapter-defined health check (Algo-D1).
 *
 * Lighter-weight than `DiagnosticResult`: adapters declare a name and a
 * synchronous `check()` thunk. The doctor renders the result. The
 * thunk-style intentionally avoids forcing adapters into async — the
 * existsSync probe used by claude-code is sync and the doctor invokes it
 * directly without an `await`. Adapters needing async work return a
 * pre-resolved status (the check ran at thunk-creation time) or extend
 * `validateHooks()` instead.
 */
export interface HealthCheck {
  /** Human-readable check title (e.g. "Hook script exists: pretooluse.mjs"). */
  readonly name: string;
  /** Synchronous check thunk. Returns OK or FAIL with optional detail. */
  check(): { status: "OK" | "FAIL"; detail?: string };
}

// ─────────────────────────────────────────────────────────
// Platform detection
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
// Cross-platform command helpers (#369, #372)
// ─────────────────────────────────────────────────────────

/**
 * Build a cross-platform `node <script>` command string.
 *
 * Fixes two Windows bugs:
 *   #369 — Bare `node` fails on Windows Git Bash (MSYS) because PATH
 *          resolution is unreliable. Uses `process.execPath` instead.
 *   #372 — MSYS rewrites absolute paths on non-C: drives (e.g.
 *          `C:\Users\...` → `D:\c\Users\...`). Forward slashes +
 *          double-quoting prevents the translation.
 *
 * Safe on macOS/Linux — quoting and forward slashes are no-ops there.
 */
export function buildNodeCommand(scriptPath: string): string {
  const nodePath = process.execPath.replace(/\\/g, "/");
  const safePath = scriptPath.replace(/\\/g, "/");
  return `"${nodePath}" "${safePath}"`;
}

/**
 * Strict inverse of `buildNodeCommand`.
 *
 * Returns `{ nodePath, scriptPath }` ONLY when `cmd` could have been
 * produced by `buildNodeCommand` — i.e. exactly two double-quoted args
 * separated by whitespace. Anything else (bare `node …`, single quotes,
 * unquoted ambiguous input, CLI dispatcher entries) returns `null`.
 *
 * Why strict: the legacy `\S+\.mjs` fallback in
 * `src/util/hook-config.ts:24` and the two-step regex in
 * `src/adapters/claude-code/hooks.ts:178` silently grabbed the path tail
 * after the last whitespace whenever the host wire-format dropped quotes,
 * producing the #548 doubled-path FAIL when `pluginRoot` contained
 * spaces (e.g. `C:\Users\High Ground Services\…`). A canonical inverse
 * lets every emit (`buildNodeCommand`) round-trip through every parse
 * (`parseNodeCommand`) without inventing fallbacks. Adapter #16 inherits
 * the contract by importing one module.
 */
export function parseNodeCommand(
  cmd: string,
): { nodePath: string; scriptPath: string } | null {
  if (typeof cmd !== "string" || cmd.length === 0) return null;
  // Match `"<nodePath>" "<scriptPath>"` with arbitrary whitespace
  // separator. Both segments must be non-empty and contain no embedded
  // double quotes — buildNodeCommand never emits embedded quotes.
  const m = cmd.match(/^"([^"]+)"\s+"([^"]+)"\s*$/);
  if (!m) return null;
  return { nodePath: m[1], scriptPath: m[2] };
}

/** Supported platform identifiers. */
export type PlatformId =
  | "claude-code"
  | "gemini-cli"
  | "opencode"
  | "kilo"
  | "openclaw"
  | "codex"
  | "vscode-copilot"
  | "jetbrains-copilot"
  | "cursor"
  | "antigravity"
  | "kiro"
  | "pi"
  | "omp"
  | "zed"
  | "qwen-code"
  | "unknown";

/** Detection signal used to identify which platform is running. */
export interface DetectionSignal {
  /** Platform identifier. */
  platform: PlatformId;
  /** Confidence: env var match > config dir match > fallback. */
  confidence: "high" | "medium" | "low";
  /** How it was detected. */
  reason: string;
}
