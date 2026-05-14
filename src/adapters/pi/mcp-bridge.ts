/**
 * MCP-stdio bridge for the Pi Coding Agent extension.
 *
 * Pi 0.73.x has no native MCP support — its README is explicit:
 *   > "No MCP. Build CLI tools with READMEs (see Skills), or build an
 *   >  extension that adds MCP support."
 *
 * Without this bridge, the routing block tells the LLM to call
 * `ctx_execute`, `ctx_search`, etc. — but those tools never enter Pi's
 * tool list, so the LLM cannot reach them. context-mode then becomes a
 * pure cost on Pi (~2.5K tokens of system-prompt overhead with 0
 * actual ctx_* calls). Reported in mksglu/context-mode#426.
 *
 * The bridge spawns `server.bundle.mjs` as a long-lived child via stdio
 * JSON-RPC, performs the MCP handshake, calls `tools/list` once, and
 * registers each returned tool through `pi.registerTool({ … })`. Each
 * tool's `execute()` forwards into the child via `tools/call` — same
 * code path Claude Code, Gemini CLI, and the other adapters use, so
 * Pi behavior matches the rest of the platform suite.
 *
 * No external dependencies — pure node:child_process + JSON line frames.
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { detectRuntimes } from "../../runtime.js";
import { foreignWorkspaceEnv, foreignIdentificationEnv } from "../detect.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

// ── Fork-bomb prevention (#516) ──────────────────────────────────────
//
// Original bug: `spawn(process.execPath, [serverScript])` recursively
// re-executed the Pi binary on Bun-only systems where `process.execPath`
// IS pi itself. Each spawn re-loaded context-mode → spawned again →
// took the box down.
//
// Defence in depth:
//   1. resolveJsRuntimeForBridge() refuses pi-named binaries even when
//      detectRuntimes() returns one, falling back to PATH-resolved
//      node/bun.
//   2. Spawn passes CONTEXT_MODE_BRIDGE_DEPTH=1 in child env so any
//      transitive bridge load can detect the recursion via env counter.
//   3. bootstrapMCPTools() aborts if CONTEXT_MODE_BRIDGE_DEPTH > 0 in
//      its own env — catches recursion that bypasses the binary-name
//      check (e.g. a `node` shim that re-execs Pi).

const PI_BINARY_BASENAME = /^pi(\.exe)?$/i;
const BRIDGE_DEPTH_ENV = "CONTEXT_MODE_BRIDGE_DEPTH";
const isWindows = process.platform === "win32";

function basename(p: string): string {
  const segs = p.split(/[\\/]/);
  return segs[segs.length - 1] ?? "";
}

function whichOnPath(cmd: string): string | null {
  try {
    const probe = isWindows ? `where ${cmd}` : `command -v ${cmd}`;
    const out = execSync(probe, { encoding: "utf-8", stdio: "pipe" })
      .trim()
      .split(/\r?\n/)[0]
      ?.trim();
    return out && out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export interface ResolveDeps {
  detect?: () => { javascript: string | null };
  which?: (cmd: string) => string | null;
  execPath?: string;
}

/**
 * Resolve a JS runtime safe to spawn the MCP server with.
 *
 * Returns `null` when no real runtime is reachable (caller must skip
 * the bridge gracefully — see bootstrapMCPTools). Pi-named binaries are
 * explicitly rejected at every step to prevent the #516 fork bomb.
 */
export function resolveJsRuntimeForBridge(deps: ResolveDeps = {}): string | null {
  const detect = deps.detect ?? (() => detectRuntimes());
  const which = deps.which ?? whichOnPath;
  const execPath = deps.execPath ?? process.execPath;

  const isPi = (p: string | null | undefined): boolean =>
    !!p && PI_BINARY_BASENAME.test(basename(p));

  // 1. Prefer detectRuntimes().javascript when it is NOT pi.
  let candidate: string | null = null;
  try {
    candidate = detect().javascript ?? null;
  } catch {
    candidate = null;
  }
  if (candidate && !isPi(candidate)) return candidate;

  // 2. Fall back to PATH-resolved node, then bun.
  for (const cmd of ["node", "bun"]) {
    const resolved = which(cmd);
    if (resolved && !isPi(resolved)) return resolved;
  }

  // 3. Last resort: process.execPath only if it is not pi.
  if (execPath && !isPi(execPath)) return execPath;

  return null;
}

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface MCPCallResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
// Tools/call may run shell commands or fetch URLs — wider window than
// initialize/list, but still bounded so a hung server can't block Pi.
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/**
 * Minimal stdio JSON-RPC client targeting the context-mode MCP server.
 *
 * Implementation notes:
 *   - One outstanding ID per request; results matched by `id` from the
 *     returned envelope. Notifications (no id) are sent fire-and-forget.
 *   - Buffer is split on `\n` because the MCP server writes one
 *     newline-delimited JSON message per `console.log` / `stdout.write`
 *     invocation — this is the standard MCP stdio transport framing.
 *   - On child exit / error, every in-flight request is rejected so
 *     callers do not hang forever.
 */
export class MCPStdioClient {
  private child: ChildProcess | null = null;
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = "";
  private initialized = false;
  private exited = false;
  /**
   * Live env passed to the spawned child — exposed (read-only intent)
   * so tests can pin the fork-bomb-prevention env counter (#516)
   * without needing to attach a process-tree probe.
   */
  _spawnEnv: NodeJS.ProcessEnv | null = null;

  constructor(
    private readonly serverScript: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly runtimeOverride: string | null = null,
  ) {}

  /** Spawn the MCP child. Idempotent. */
  start(): void {
    if (this.child) return;
    this.exited = false;
    // Pick a JS runtime that is NOT the host process (#516). When Pi
    // is the host binary, process.execPath would re-exec Pi and fork
    // bomb the box. resolveJsRuntimeForBridge prefers bun/node and
    // explicitly rejects pi-named binaries.
    const runtime =
      this.runtimeOverride ?? resolveJsRuntimeForBridge() ?? process.execPath;
    // Increment the depth counter so any transitive bridge load inside
    // the child can short-circuit before spawning yet another server.
    const depth = Number.parseInt(this.env[BRIDGE_DEPTH_ENV] ?? "0", 10);
    const childEnv: NodeJS.ProcessEnv = {
      ...this.env,
      [BRIDGE_DEPTH_ENV]: String(Number.isFinite(depth) ? depth + 1 : 1),
    };
    // Issue #545 — scrub foreign workspace env vars before spawn.
    //
    // Pi's MCP bridge inherits the host shell env (including a prior
    // `claude` invocation's CLAUDE_PROJECT_DIR). Without this scrub, the
    // spawned MCP server resolves getProjectDir() to the foreign workspace
    // and Pi's sessions write into the wrong project. The ban list is
    // derived ALGORITHMICALLY from PLATFORM_ENV_VARS (every other adapter's
    // workspace-role vars), so adding adapter #16 grows the scrub
    // automatically — no edit to this file. Pi's own workspace vars and
    // the universal escape hatch (CONTEXT_MODE_PROJECT_DIR) are NEVER
    // scrubbed.
    for (const banned of foreignWorkspaceEnv("pi")) {
      delete childEnv[banned];
    }
    // Issue #561 — scrub foreign IDENTIFICATION env vars before spawn.
    //
    // Foreign identification vars hijack detectPlatform() — must scrub
    // when spawning child under a different host (#561). When Pi runs
    // co-resident with Claude Code, the inherited shell env carries
    // CLAUDE_CODE_ENTRYPOINT and CLAUDE_PLUGIN_ROOT; the spawned MCP
    // child's detectPlatform() then walks PLATFORM_ENV_VARS in priority
    // order (claude-code first), returns claude-code, and Pi's session
    // data lands in ~/.claude/context-mode/ instead of Pi's own dir.
    // Pi's OWN identification vars (PI_CONFIG_DIR / PI_SESSION_FILE /
    // PI_COMPILED) are excluded from the ban set so the child still
    // detects pi correctly.
    for (const banned of foreignIdentificationEnv("pi")) {
      delete childEnv[banned];
    }
    this._spawnEnv = childEnv;
    this.child = spawn(runtime, [this.serverScript], {
      // Pipe stderr (#472 round-3): swallowing it via "ignore" hides
      // server crash diagnostics — the user only saw "ctx_* tools will
      // not be callable" with no clue WHY. Forwarding to process.stderr
      // with a [mcp-bridge] prefix lets ops grep across session noise.
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    });
    this.child.stdout?.on("data", (chunk) => this.onData(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      // Preserve original line breaks; prefix every non-empty line so
      // multi-line traces stay grep-friendly.
      const prefixed = text
        .split(/\r?\n/)
        .map((line, i, arr) =>
          i === arr.length - 1 && line === "" ? "" : `[mcp-bridge] ${line}`,
        )
        .join("\n");
      process.stderr.write(prefixed);
    });
    this.child.on("exit", () => this.onExit());
    this.child.on("error", () => this.onExit());
  }

  private onExit(): void {
    if (this.exited) return;
    this.exited = true;
    const err = new Error("MCP server exited");
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // skip non-JSON noise (e.g. stray log lines)
      }
      if (typeof msg.id !== "number" || !this.pending.has(msg.id)) continue;
      const handler = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) handler.reject(msg.error);
      else handler.resolve(msg.result);
    }
  }

  request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.child) throw new Error("MCP client not started");
    if (this.exited) return Promise.reject(new Error("MCP server has exited"));
    const id = ++this.requestId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`MCP request timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.child!.stdin?.write(frame + "\n");
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.child) return;
    const frame = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.child.stdin?.write(frame + "\n");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      clientInfo: {
        name: "pi-coding-agent-context-mode-bridge",
        version: "1.0",
      },
    });
    this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.request<{ tools?: MCPTool[] }>("tools/list", {});
    return Array.isArray(result.tools) ? result.tools : [];
  }

  async callTool(name: string, args: unknown): Promise<MCPCallResult> {
    return this.request<MCPCallResult>(
      "tools/call",
      { name, arguments: args ?? {} },
      DEFAULT_CALL_TIMEOUT_MS,
    );
  }

  shutdown(): void {
    if (!this.child) return;
    const child = this.child;
    try {
      child.kill("SIGTERM");
    } catch {
      // best effort
    }
    // SIGKILL fallback (#472 round-3): a child that ignores SIGTERM
    // (e.g. installed handler that swallows the signal, or stuck in
    // an uninterruptible syscall) becomes a zombie because we null
    // the handle immediately. Schedule a hard kill bounded at 5s; the
    // .unref() prevents this timer from keeping the parent alive after
    // legitimate work is done.
    setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      } catch {
        // best effort
      }
    }, 5000).unref();
    this.child = null;
    this.initialized = false;
    this.exited = true;
  }
}

/**
 * Subset of the Pi ExtensionAPI we touch. Typed structurally so we don't
 * pull `@earendil-works/pi-coding-agent` as a build dependency — keeps
 * the bundle size unchanged and matches the existing pi-extension.ts
 * style (which also types `pi` as `any`).
 */
export interface PiToolRegistration {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
    isError?: boolean;
  }>;
}

export interface PiLikeAPI {
  registerTool: (tool: PiToolRegistration) => void;
}

/** Result of bootstrapping the bridge. */
export interface BridgeHandle {
  /** Names of tools registered with Pi (for diagnostics / tests). */
  tools: string[];
  /** Idempotent shutdown — terminates the MCP child. */
  shutdown: () => void;
  /** Underlying client, exposed for tests / advanced callers. */
  client: MCPStdioClient;
}

/**
 * Spawn the MCP server and register each of its tools with Pi via
 * `pi.registerTool()`. The same JSON Schema returned by `tools/list` is
 * passed straight through as `parameters` — TypeBox emits JSON-Schema
 * compatible objects, so any Pi runtime that validates JSON Schema
 * accepts this shape (verified against pi 0.73.x).
 *
 * Errors during MCP `tools/call` are translated to a `throw` from the
 * `execute()` callback — Pi's contract is "throw to mark the tool call
 * failed", which lets the LLM see and adapt.
 */
export interface BootstrapOptions {
  env?: NodeJS.ProcessEnv;
  /** DI hook for tests: override the runtime resolver entirely. */
  _resolveJsRuntime?: () => string | null;
}

/**
 * Empty-but-valid handle returned when bootstrap is skipped (#516).
 * Keeps the shutdown contract intact so callers do not need null checks.
 */
function skippedBridge(): BridgeHandle {
  return {
    tools: [],
    shutdown: () => {
      /* nothing to shut down */
    },
    client: new MCPStdioClient("/dev/null"),
  };
}

export async function bootstrapMCPTools(
  pi: PiLikeAPI,
  serverScript: string,
  options: BootstrapOptions = {},
): Promise<BridgeHandle> {
  const env = options.env ?? process.env;

  // Recursion guard (#516): if an ancestor bridge already incremented
  // the depth counter, refuse to spawn another child — even if the
  // binary-name check would let us through. Catches `node` shims that
  // re-exec Pi and other host swaps that bypass basename detection.
  const depth = Number.parseInt(env[BRIDGE_DEPTH_ENV] ?? "0", 10);
  if (Number.isFinite(depth) && depth > 0) {
    process.stderr.write(
      `[context-mode] WARNING: skipping MCP bridge — ${BRIDGE_DEPTH_ENV}=${depth} ` +
        `indicates recursion (fork-bomb guard, #516). ctx_* tools will not be callable.\n`,
    );
    return skippedBridge();
  }

  // Runtime guard (#516): when neither node nor bun is on PATH and the
  // host process is pi, there is no safe binary to spawn. Log once and
  // return an empty handle — the rest of the extension keeps working.
  const runtime = (options._resolveJsRuntime ?? resolveJsRuntimeForBridge)();
  if (runtime === null) {
    process.stderr.write(
      `[context-mode] WARNING: no JS runtime found (need node or bun on PATH). ` +
        `Skipping MCP bridge to avoid fork bomb (#516). ctx_* tools will not be callable.\n`,
    );
    return skippedBridge();
  }

  const client = new MCPStdioClient(serverScript, env, runtime);
  client.start();
  await client.initialize();
  const tools = await client.listTools();
  const registered: string[] = [];

  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description ?? "",
      // MCP tools/list returns JSON Schema; Pi validates against JSON
      // Schema (TypeBox is just JSON Schema with extra Symbol metadata
      // for type inference). Empty-object fallback keeps tools that
      // declare no parameters callable.
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
      async execute(_toolCallId, params) {
        const result = await client.callTool(tool.name, params ?? {});
        const text = (result.content ?? [])
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string)
          .join("\n");
        if (result.isError) {
          // Throw is the Pi contract for "tool failed". The text body
          // becomes the error message visible to the LLM, so it sees
          // the same diagnostic the MCP server emitted.
          throw new Error(text || `${tool.name} returned an error`);
        }
        return {
          content: [{ type: "text", text }],
          details: {},
        };
      },
    });
    registered.push(tool.name);
  }

  return {
    tools: registered,
    shutdown: () => client.shutdown(),
    client,
  };
}
