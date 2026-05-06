export interface ExitClassification {
  isError: boolean;
  output: string;
}

type Params = {
  language: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  command?: string;
  maxOutputLength?: number;
};

const SOFT_FAIL_CODES = new Set([1]);
const SOFT_FAIL_COMMANDS = ["grep", "diff", "test"];

function isShellSoftFailure({
  language,
  exitCode,
  stdout,
  command,
}: Params): boolean {
  if (language !== "shell") return false;

  const hasOutput = stdout.trim().length > 0;
  const knownCommand =
    command && SOFT_FAIL_COMMANDS.some(cmd => command.includes(cmd));

  return SOFT_FAIL_CODES.has(exitCode) && (hasOutput || knownCommand);
}

function truncate(text: string, limit?: number): string {
  if (!limit || text.length <= limit) return text;
  return text.slice(0, limit) + "\n... (truncated)";
}

export function classifyNonZeroExit(params: Params): ExitClassification {
  const { exitCode, stdout, stderr, maxOutputLength } = params;

  const soft = isShellSoftFailure(params);

  if (soft) {
    return {
      isError: false,
      output: truncate(stdout, maxOutputLength),
    };
  }

  const safeStdout = stdout.trim() || "[no stdout]";
  const safeStderr = stderr.trim() || "[no stderr]";

  return {
    isError: true,
    output: truncate(
      `Exit code: ${exitCode}\n\nstdout:\n${safeStdout}\n\nstderr:\n${safeStderr}`,
      maxOutputLength
    ),
  };
    }
