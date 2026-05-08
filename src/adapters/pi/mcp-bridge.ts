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

import { spawn, type ChildProcess } from "node:child_process";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
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

  constructor(
    private readonly serverScript: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Spawn the MCP child. Idempotent. */
  start(): void {
    if (this.child) return;
    this.exited = false;
    this.child = spawn(process.execPath, [this.serverScript], {
      stdio: ["pipe", "pipe", "ignore"],
      env: this.env,
    });
    this.child.stdout?.on("data", (chunk) => this.onData(chunk));
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
    try {
      this.child.kill("SIGTERM");
    } catch {
      // best effort
    }
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
export async function bootstrapMCPTools(
  pi: PiLikeAPI,
  serverScript: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<BridgeHandle> {
  const client = new MCPStdioClient(serverScript, options.env);
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
