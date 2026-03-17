/**
 * ctx_execute — Execute code in a sandboxed subprocess.
 *
 * Only stdout enters context — raw data stays in the subprocess.
 * Supports intent-driven search for large outputs.
 * Instruments JS/TS code to track network I/O bytes consumed in sandbox.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PolyglotExecutor } from "../executor.js";
import type { ContentStore } from "../store.js";
import type { ToolResult, SessionStats } from "../server/session-stats.js";
import {
  checkDenyPolicy,
  checkNonShellDenyPolicy,
} from "../server/security-wrapper.js";
import { intentSearch, INTENT_SEARCH_THRESHOLD } from "../server/intent-search.js";
import { classifyNonZeroExit } from "../exit-classify.js";
import { hasBunRuntime, getAvailableLanguages, detectRuntimes } from "../runtime.js";
import { errorMessage } from "./tool-utils.js";

export interface ToolDeps {
  trackResponse: (toolName: string, response: ToolResult) => ToolResult;
  trackIndexed: (bytes: number) => void;
  getStore: () => ContentStore;
  executor: PolyglotExecutor;
  sessionStats: SessionStats;
}

export function registerExecuteTool(server: McpServer, deps: ToolDeps): void {
  const { trackResponse, trackIndexed, getStore, executor, sessionStats } = deps;

  // Build description dynamically based on detected runtimes
  const runtimes = detectRuntimes();
  const available = getAvailableLanguages(runtimes);
  const langList = available.join(", ");
  const bunNote = hasBunRuntime()
    ? " (Bun detected \u2014 JS/TS runs 3-5x faster)"
    : "";

  server.registerTool(
    "ctx_execute",
    {
      title: "Execute Code",
      description: `MANDATORY: Use for any command where output exceeds 20 lines. Execute code in a sandboxed subprocess. Only stdout enters context \u2014 raw data stays in the subprocess.${bunNote} Available: ${langList}.\n\nPREFER THIS OVER BASH for: API calls (gh, curl, aws), test runners (npm test, pytest), git queries (git log, git diff), data processing, and ANY CLI command that may produce large output. Bash should only be used for file mutations, git writes, and navigation.`,
      inputSchema: z.object({
        language: z
          .enum([
            "javascript",
            "typescript",
            "python",
            "shell",
            "ruby",
            "go",
            "rust",
            "php",
            "perl",
            "r",
            "elixir",
          ])
          .describe("Runtime language"),
        code: z
          .string()
          .describe(
            "Source code to execute. Use console.log (JS/TS), print (Python/Ruby/Perl/R), echo (Shell), echo (PHP), fmt.Println (Go), or IO.puts (Elixir) to output a summary to context.",
          ),
        timeout: z
          .number()
          .optional()
          .default(30000)
          .describe("Max execution time in ms"),
        background: z
          .boolean()
          .optional()
          .default(false)
          .describe("Keep process running after timeout (for servers/daemons). Returns partial output without killing the process. IMPORTANT: Do NOT add setTimeout/self-close timers in background scripts \u2014 the process must stay alive until the timeout detaches it. For server+fetch patterns, prefer putting both server and fetch in ONE ctx_execute call instead of using background."),
        intent: z
          .string()
          .optional()
          .describe(
            "What you're looking for in the output. When provided and output is large (>5KB), " +
            "indexes output into knowledge base and returns section titles + previews \u2014 not full content. " +
            "Use search(queries: [...]) to retrieve specific sections. Example: 'failing tests', 'HTTP 500 errors'." +
            "\n\nTIP: Use specific technical terms, not just concepts. Check 'Searchable terms' in the response for available vocabulary.",
          ),
      }),
    },
    async ({ language, code, timeout, background, intent }) => {
      // Security: deny-only firewall
      const tr = (tn: string, r: ToolResult) => trackResponse(tn, r);
      if (language === "shell") {
        const denied = checkDenyPolicy(code, "execute", tr);
        if (denied) return denied;
      } else {
        const denied = checkNonShellDenyPolicy(code, language, "execute", tr);
        if (denied) return denied;
      }

      try {
        // For JS/TS: wrap in async IIFE with fetch + http/https interceptors to track network bytes
        let instrumentedCode = code;
        if (language === "javascript" || language === "typescript") {
          // Wrap user code in a closure that shadows CJS require with http/https interceptor.
          // globalThis.require does NOT work because CJS require is module-scoped, not global.
          // The closure approach (function(__cm_req){ var require=...; })(require) correctly
          // shadows the CJS require for all code inside, including __cm_main().
          instrumentedCode = `
let __cm_net=0;
// Report network bytes on process exit — works with both promise and callback patterns.
// process.on('exit') fires after all I/O completes, unlike .finally() which fires
// when __cm_main() resolves (immediately for callback-based http.get without await).
process.on('exit',()=>{if(__cm_net>0)try{process.stderr.write('__CM_NET__:'+__cm_net+'\\n')}catch{}});
;(function(__cm_req){
// Intercept globalThis.fetch
const __cm_f=globalThis.fetch;
globalThis.fetch=async(...a)=>{const r=await __cm_f(...a);
try{const cl=r.clone();const b=await cl.arrayBuffer();__cm_net+=b.byteLength}catch{}
return r};
// Shadow CJS require with http/https network tracking.
const __cm_hc=new Map();
const __cm_hm=new Set(['http','https','node:http','node:https']);
function __cm_wf(m,origFn){return function(...a){
  const li=a.length-1;
  if(li>=0&&typeof a[li]==='function'){const oc=a[li];a[li]=function(res){
    res.on('data',function(c){__cm_net+=c.length});oc(res);};}
  const req=origFn.apply(m,a);
  const oOn=req.on.bind(req);
  req.on=function(ev,cb,...r){
    if(ev==='response'){return oOn(ev,function(res){
      res.on('data',function(c){__cm_net+=c.length});cb(res);
    },...r);}
    return oOn(ev,cb,...r);
  };
  return req;
}}
var require=__cm_req?function(id){
  const m=__cm_req(id);
  if(!__cm_hm.has(id))return m;
  const k=id.replace('node:','');
  if(__cm_hc.has(k))return __cm_hc.get(k);
  const w=Object.create(m);
  if(typeof m.get==='function')w.get=__cm_wf(m,m.get);
  if(typeof m.request==='function')w.request=__cm_wf(m,m.request);
  __cm_hc.set(k,w);return w;
}:__cm_req;
if(__cm_req){if(__cm_req.resolve)require.resolve=__cm_req.resolve;
if(__cm_req.cache)require.cache=__cm_req.cache;}
async function __cm_main(){
${code}
}
__cm_main().catch(e=>{console.error(e);process.exitCode=1});${background ? '\nsetInterval(()=>{},2147483647);' : ''}
})(typeof require!=='undefined'?require:null);`;
        }
        const result = await executor.execute({ language, code: instrumentedCode, timeout, background });

        // Parse sandbox network metrics from stderr
        const netMatch = result.stderr?.match(/__CM_NET__:(\d+)/);
        if (netMatch) {
          sessionStats.bytesSandboxed += parseInt(netMatch[1]);
          // Clean the metric line from stderr
          result.stderr = result.stderr.replace(/\n?__CM_NET__:\d+\n?/g, "");
        }

        if (result.timedOut) {
          const partialOutput = result.stdout?.trim();
          if (result.backgrounded && partialOutput) {
            // Background mode: process is still running, return partial output as success
            return trackResponse("ctx_execute", {
              content: [
                {
                  type: "text" as const,
                  text: `${partialOutput}\n\n_(process backgrounded after ${timeout}ms \u2014 still running)_`,
                },
              ],
            });
          }
          if (partialOutput) {
            // Timeout with partial output — return as success with note
            return trackResponse("ctx_execute", {
              content: [
                {
                  type: "text" as const,
                  text: `${partialOutput}\n\n_(timed out after ${timeout}ms \u2014 partial output shown above)_`,
                },
              ],
            });
          }
          return trackResponse("ctx_execute", {
            content: [
              {
                type: "text" as const,
                text: `Execution timed out after ${timeout}ms\n\nstderr:\n${result.stderr}`,
              },
            ],
            isError: true,
          });
        }

        if (result.exitCode !== 0) {
          const { isError, output } = classifyNonZeroExit({
            language, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
          });
          if (intent && intent.trim().length > 0 && Buffer.byteLength(output) > INTENT_SEARCH_THRESHOLD) {
            trackIndexed(Buffer.byteLength(output));
            return trackResponse("ctx_execute", {
              content: [
                { type: "text" as const, text: intentSearch(output, intent, isError ? `execute:${language}:error` : `execute:${language}`, getStore, trackIndexed) },
              ],
              isError,
            });
          }
          return trackResponse("ctx_execute", {
            content: [
              { type: "text" as const, text: output },
            ],
            isError,
          });
        }

        const stdout = result.stdout || "(no output)";

        // Intent-driven search: if intent provided and output is large enough
        if (intent && intent.trim().length > 0 && Buffer.byteLength(stdout) > INTENT_SEARCH_THRESHOLD) {
          trackIndexed(Buffer.byteLength(stdout));
          return trackResponse("ctx_execute", {
            content: [
              { type: "text" as const, text: intentSearch(stdout, intent, `execute:${language}`, getStore, trackIndexed) },
            ],
          });
        }

        return trackResponse("ctx_execute", {
          content: [
            { type: "text" as const, text: stdout },
          ],
        });
      } catch (err: unknown) {
        const message = errorMessage(err);
        return trackResponse("ctx_execute", {
          content: [
            { type: "text" as const, text: `Runtime error: ${message}` },
          ],
          isError: true,
        });
      }
    },
  );
}
