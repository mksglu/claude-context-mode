/**
 * adapters/vscode-copilot/config — Thin re-exports from VSCodeCopilotAdapter.
 *
 * This module exists for backward compatibility. All logic lives in the
 * adapter class (index.ts). New code should use getAdapter() from detect.ts.
 */

export { VSCodeCopilotAdapter } from "./index.js";
export { HOOK_TYPES, HOOK_SCRIPTS, REQUIRED_HOOKS, OPTIONAL_HOOKS } from "./hooks.js";
