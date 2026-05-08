/**
 * Classify non-zero exit codes for ctx_execute / ctx_execute_file.
 *
 * Shell commands like `grep` exit 1 for "no matches" — not a real error.
 * We treat exit code 1 as a soft failure when:
 *   - language is "shell"
 *   - exit code is exactly 1
 *   - stdout has non-whitespace content
 */
export interface ExitClassification {
  isError: boolean;
  output: string;
}

export function classifyNonZeroExit(params: {
  language: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}): ExitClassification {
  const { language, exitCode, stdout, stderr } = params;
  const isSoftFail =
    language === "shell" &&
    exitCode === 1 &&
    stdout.trim().length > 0;

  return {
    isError: !isSoftFail,
    output: isSoftFail
      ? stdout
      : `Exit code: ${exitCode}\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}`,
  };
}
