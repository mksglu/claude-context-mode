import { createRoutingBlock as _createRoutingBlock, createReadGuidance as _createReadGuidance, createGrepGuidance as _createGrepGuidance, createBashGuidance as _createBashGuidance } from "../build/routing-block.js";
import { createToolNamer } from "../build/tool-naming.js";

export const createRoutingBlock = _createRoutingBlock;
export const createReadGuidance = _createReadGuidance;
export const createGrepGuidance = _createGrepGuidance;
export const createBashGuidance = _createBashGuidance;

const _t = createToolNamer("claude-code");
export const ROUTING_BLOCK = _createRoutingBlock(_t);
export const READ_GUIDANCE = _createReadGuidance(_t);
export const GREP_GUIDANCE = _createGrepGuidance(_t);
export const BASH_GUIDANCE = _createBashGuidance(_t);
