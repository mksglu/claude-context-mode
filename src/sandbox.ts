/**
 * Sandbox Configuration Builder
 *
 * Builds filesystem and network sandbox policies for code execution.
 * Resolves allowed domains from (in priority order):
 *   1. CONTEXT_MODE_ALLOWED_DOMAINS env var
 *   2. Claude Code's ~/.claude/settings.json
 *   3. Conservative defaults (github, npm, pypi, etc.)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ==============================================================================
// Types
// ==============================================================================

export interface SandboxConfig {
  disabled: boolean;
  filesystem: {
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
  };
}

// ==============================================================================
// Constants
// ==============================================================================

// Paths that should never be readable from sandboxed code execution.
const SENSITIVE_READ_PATHS = ["~/.ssh", "~/.gnupg", "~/.aws/credentials"];

// Files that sandboxed code should never overwrite, even within the project.
const PROTECTED_WRITE_PATTERNS = [".env"];

// Conservative set of package registries and VCS hosts that most projects need.
const DEFAULT_ALLOWED_DOMAINS = [
  "github.com",
  "api.github.com",
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "rubygems.org",
  "proxy.golang.org",
  "crates.io",
  "static.crates.io",
];

// ==============================================================================
// Domain Resolution
// ==============================================================================

/**
 * Attempts to read allowed domains from Claude Code's settings file.
 * Claude Code stores user settings at ~/.claude/settings.json with two
 * possible key shapes for sandbox network config:
 *   - `sandbox.network.allowedDomains` (nested)
 *   - `sandboxNetwork.allowedDomains` (flat)
 */
function readClaudeCodeDomains(homeDir: string): string[] | null {
  const settingsPath = join(homeDir, ".claude", "settings.json");
  try {
    const raw = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw);

    // Try nested key first: sandbox.network.allowedDomains
    const nested = settings?.sandbox?.network?.allowedDomains;
    if (Array.isArray(nested) && nested.length > 0) return nested;

    // Fall back to flat key: sandboxNetwork.allowedDomains
    const flat = settings?.sandboxNetwork?.allowedDomains;
    if (Array.isArray(flat) && flat.length > 0) return flat;
  } catch {
    // File doesn't exist or isn't valid JSON — not an error.
  }
  return null;
}

/**
 * Resolves allowed domains using a three-tier fallback:
 *   1. CONTEXT_MODE_ALLOWED_DOMAINS env var (comma-separated)
 *   2. Claude Code's ~/.claude/settings.json
 *   3. DEFAULT_ALLOWED_DOMAINS
 */
function resolveAllowedDomains(homeDir: string): string[] {
  const envOverride = process.env.CONTEXT_MODE_ALLOWED_DOMAINS;
  if (envOverride) {
    return envOverride.split(",").map((d) => d.trim()).filter(Boolean);
  }

  const fromSettings = readClaudeCodeDomains(homeDir);
  if (fromSettings) return fromSettings;

  return [...DEFAULT_ALLOWED_DOMAINS];
}

// ==============================================================================
// Public API
// ==============================================================================

/**
 * Builds a sandbox configuration for code execution.
 *
 * @param projectRoot - Absolute path to the project directory (will be writable).
 * @param homeDir     - Home directory override, used for finding Claude Code
 *                      settings. Defaults to os.homedir(). Exposed for testing.
 */
export function buildSandboxConfig(
  projectRoot: string,
  homeDir: string = homedir(),
): SandboxConfig {
  // Escape hatch: disable the entire sandbox when explicitly requested.
  if (process.env.CONTEXT_MODE_NO_SANDBOX === "1") {
    return {
      disabled: true,
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      network: { allowedDomains: [], deniedDomains: [] },
    };
  }

  return {
    disabled: false,
    filesystem: {
      denyRead: [...SENSITIVE_READ_PATHS],
      allowWrite: [projectRoot, "/tmp"],
      denyWrite: [...PROTECTED_WRITE_PATTERNS],
    },
    network: {
      allowedDomains: resolveAllowedDomains(homeDir),
      // No denied domains for now — allowedDomains acts as an allowlist.
      deniedDomains: [],
    },
  };
}
