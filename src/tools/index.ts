/**
 * Barrel file for tool registration modules.
 *
 * Exports all register functions for centralized imports.
 * Each tool module exports a registerXxxTool(server, deps) function.
 */

export { registerDoctorTool } from "./doctor.js";
export { registerUpgradeTool } from "./upgrade.js";
export { registerStatsTool } from "./stats.js";
export { registerIndexTool } from "./ctx-index.js";
export { registerSearchTool } from "./search.js";
export { registerFetchAndIndexTool } from "./fetch-and-index.js";
export { registerExecuteTool } from "./execute.js";
export { registerExecuteFileTool } from "./execute-file.js";
export { registerBatchExecuteTool } from "./batch-execute.js";

// Re-export tool deps types for convenience
export type { ToolDeps as DoctorDeps } from "./doctor.js";
export type { ToolDeps as UpgradeDeps } from "./upgrade.js";
export type { ToolDeps as StatsDeps } from "./stats.js";
export type { ToolDeps as IndexDeps } from "./ctx-index.js";
export type { ToolDeps as SearchDeps } from "./search.js";
export type { ToolDeps as FetchAndIndexDeps } from "./fetch-and-index.js";
export type { ToolDeps as ExecuteDeps } from "./execute.js";
export type { ToolDeps as ExecuteFileDeps } from "./execute-file.js";
export type { ToolDeps as BatchExecuteDeps } from "./batch-execute.js";

// Utility helper
export { errorMessage } from "./tool-utils.js";
