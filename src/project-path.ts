import { isAbsolute, resolve } from "node:path";

/**
 * Project directory detection across supported platforms.
 *
 * Priority:
 *   1. Platform-specific env var (set by host IDE before MCP server spawn)
 *   2. CONTEXT_MODE_PROJECT_DIR (set by start.mjs for ALL platforms — universal)
 *   3. process.cwd() (last resort)
 */
export function getProjectDir(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  return env.CLAUDE_PROJECT_DIR
    || env.GEMINI_PROJECT_DIR
    || env.VSCODE_CWD
    || env.OPENCODE_PROJECT_DIR
    || env.PI_PROJECT_DIR
    || env.CONTEXT_MODE_PROJECT_DIR
    || cwd;
}

export function resolveProjectPath(filePath: string, projectDir = getProjectDir()): string {
  return isAbsolute(filePath) ? filePath : resolve(projectDir, filePath);
}
