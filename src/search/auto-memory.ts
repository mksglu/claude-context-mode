/**
 * Auto-memory search — searches agent instruction and memory files for
 * persisted decisions, preferences, and context from prior sessions.
 *
 * Returns results in a format compatible with the unified search pipeline.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEBUG = process.env.DEBUG?.includes("context-mode");

export interface AutoMemoryResult {
  title: string;
  content: string;
  source: string;
  origin: "auto-memory";
  timestamp?: string;
}

/**
 * Search auto-memory files (CLAUDE.md, QWEN.md, AGENTS.md, MEMORY.md, etc.)
 * for content matching any of the given queries.
 *
 * Scans:
 *   1. Project-level: <projectDir>/{instructionFiles}
 *   2. User-level: <configDir>/{instructionFiles}
 *   3. User memory: <configDir>/{memory,memories}/*.md
 *
 * @param queries  Array of search terms
 * @param limit    Max results to return
 * @param projectDir  Project directory path
 * @param configDir   Config directory (e.g. ~/.claude, ~/.qwen)
 * @param memoryFileNames  Instruction file names to scan (default: ["CLAUDE.md"])
 * @returns Matching auto-memory results
 */
export function searchAutoMemory(
  queries: string[],
  limit: number = 5,
  projectDir?: string,
  configDir?: string,
  memoryFileNames: string[] = ["CLAUDE.md"],
): AutoMemoryResult[] {
  const results: AutoMemoryResult[] = [];
  const effectiveConfigDir = configDir || join(homedir(), ".claude");

  // Collect candidate files
  const candidates: Array<{ path: string; label: string }> = [];
  const seen = new Set<string>();

  const addCandidate = (path: string, label: string): void => {
    if (seen.has(path) || !existsSync(path)) return;
    seen.add(path);
    candidates.push({ path, label });
  };

  const addMemoryDir = (dir: string, labelPrefix: string): void => {
    if (!existsSync(dir)) return;
    try {
      const files = readdirSync(dir).filter(f => f.endsWith(".md"));
      for (const file of files) {
        addCandidate(join(dir, file), `${labelPrefix}/${file}`);
      }
    } catch (e) {
      if (DEBUG) process.stderr.write(`[ctx] auto-memory dir scan failed: ${e}\n`);
    }
  };

  // 1. Project-level instruction files
  if (projectDir) {
    for (const file of memoryFileNames) {
      addCandidate(join(projectDir, file), `project/${file}`);
    }
  }

  // 2. User-level instruction files
  for (const file of memoryFileNames) {
    addCandidate(join(effectiveConfigDir, file), `user/${file}`);
  }

  // 3. User memory directories. Codex uses "memories"; Claude/Qwen use "memory".
  for (const dirName of ["memory", "memories"]) {
    addMemoryDir(join(effectiveConfigDir, dirName), dirName);
  }

  // Search each candidate file for matching queries
  for (const candidate of candidates) {
    if (results.length >= limit) break;

    try {
      // Skip files larger than 1MB to avoid memory issues
      try {
        if (statSync(candidate.path).size > 1_000_000) continue;
      } catch { continue; }
      const content = readFileSync(candidate.path, "utf-8");
      const contentLower = content.toLowerCase();

      for (const query of queries) {
        if (results.length >= limit) break;

        const queryLower = query.toLowerCase();
        // Split query into terms, match if any term is found
        const terms = queryLower.split(/\s+/).filter(t => t.length >= 3);
        const matched = terms.some(term => {
          try {
            return new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, "i").test(content);
          } catch {
            return contentLower.includes(term); // fallback for invalid regex
          }
        });

        if (matched) {
          // Extract a relevant section around the first match
          const firstTermIdx = terms.reduce((best, term) => {
            const idx = contentLower.indexOf(term);
            return idx >= 0 && (best < 0 || idx < best) ? idx : best;
          }, -1);

          let start = Math.max(0, firstTermIdx - 200);
          let end = Math.min(content.length, firstTermIdx + 500);
          const prevBlank = content.lastIndexOf("\n\n", start);
          const nextBlank = content.indexOf("\n\n", end);
          if (prevBlank >= 0) start = prevBlank + 2;
          if (nextBlank >= 0) end = nextBlank;
          const snippet = content.slice(start, end).trim();

          results.push({
            title: `[auto-memory] ${candidate.label}`,
            content: snippet,
            source: candidate.label,
            origin: "auto-memory",
            timestamp: statSync(candidate.path).mtime.toISOString(),
          });
          break; // one result per file per query batch
        }
      }
    } catch (e) {
      if (DEBUG) process.stderr.write(`[ctx] auto-memory file read failed: ${e}\n`);
    }
  }

  return results.slice(0, limit);
}
