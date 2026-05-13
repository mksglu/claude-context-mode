/**
 * adapters/client-map — MCP clientInfo.name → PlatformId mapping.
 *
 * Source: Apify MCP Client Capabilities Registry
 * https://github.com/apify/mcp-client-capabilities
 *
 * Only includes platforms we have adapters for.
 */

import type { PlatformId } from "./types.js";

export const CLIENT_NAME_TO_PLATFORM: Record<string, PlatformId> = {
  "claude-code": "claude-code",
  "gemini-cli-mcp-client": "gemini-cli",
  "antigravity-client": "antigravity",
  "cursor-vscode": "cursor",
  "Visual-Studio-Code": "vscode-copilot",
  "JetBrains Client": "jetbrains-copilot",
  "IntelliJ IDEA": "jetbrains-copilot",
  "PyCharm": "jetbrains-copilot",
  "Codex": "codex",
  "codex-mcp-client": "codex",
  "Kilo Code": "kilo",
  "Kiro CLI": "kiro",
  "Pi CLI": "pi",
  "Pi Coding Agent": "pi",
  // Issue #542 — Pi rebranded to OMP. Upstream
  // refs/platforms/oh-my-pi/packages/coding-agent/src/mcp/client.ts:46-49
  // ships clientInfo.name = "omp-coding-agent". Resolved to the OMP
  // adapter (~/.omp/, PI_CODING_AGENT_DIR). Legacy "Pi CLI" /
  // "Pi Coding Agent" entries above still resolve to the pi adapter.
  "omp-coding-agent": "omp",
  "Zed": "zed",
  "zed": "zed",
  "qwen-code": "qwen-code",
  "qwen-cli-mcp-client": "qwen-code",
};
