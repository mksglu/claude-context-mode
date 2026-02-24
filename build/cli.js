#!/usr/bin/env node
/**
 * context-mode CLI
 *
 * Usage:
 *   context-mode          → Start MCP server (stdio)
 *   context-mode setup    → Interactive setup (detect runtimes, install Bun)
 *   context-mode doctor   → Diagnose runtime issues
 */
import * as p from "@clack/prompts";
import color from "picocolors";
import { execSync } from "node:child_process";
import { detectRuntimes, getRuntimeSummary, hasBunRuntime, getAvailableLanguages, } from "./runtime.js";
const args = process.argv.slice(2);
if (args[0] === "setup") {
    setup();
}
else if (args[0] === "doctor") {
    doctor();
}
else {
    // Default: start MCP server
    import("./server.js");
}
async function setup() {
    console.clear();
    p.intro(color.bgCyan(color.black(" context-mode setup ")));
    const s = p.spinner();
    // Step 1: Detect runtimes
    s.start("Detecting installed runtimes");
    const runtimes = detectRuntimes();
    const available = getAvailableLanguages(runtimes);
    s.stop("Detected " + available.length + " languages");
    // Show what's available
    p.note(getRuntimeSummary(runtimes), "Detected Runtimes");
    // Step 2: Check Bun
    if (!hasBunRuntime()) {
        p.log.warn(color.yellow("Bun is not installed.") +
            " JS/TS will run with Node.js (3-5x slower).");
        const installBun = await p.confirm({
            message: "Would you like to install Bun for faster execution?",
            initialValue: true,
        });
        if (p.isCancel(installBun)) {
            p.cancel("Setup cancelled.");
            process.exit(0);
        }
        if (installBun) {
            s.start("Installing Bun");
            try {
                execSync("curl -fsSL https://bun.sh/install | bash", {
                    stdio: "pipe",
                    timeout: 60000,
                });
                s.stop(color.green("Bun installed successfully!"));
                // Re-detect runtimes
                const newRuntimes = detectRuntimes();
                if (hasBunRuntime()) {
                    p.log.success("JavaScript and TypeScript will now use Bun " +
                        color.dim("(3-5x faster)"));
                }
                p.note(getRuntimeSummary(newRuntimes), "Updated Runtimes");
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                s.stop(color.red("Failed to install Bun"));
                p.log.error("Installation failed: " +
                    message +
                    "\nYou can install manually: curl -fsSL https://bun.sh/install | bash");
                p.log.info(color.dim("Continuing with Node.js — everything will still work."));
            }
        }
        else {
            p.log.info(color.dim("No problem! Using Node.js. You can install Bun later: curl -fsSL https://bun.sh/install | bash"));
        }
    }
    else {
        p.log.success(color.green("Bun detected!") +
            " JS/TS will run at maximum speed.");
    }
    // Step 3: Check optional runtimes
    const missing = [];
    if (!runtimes.python)
        missing.push("Python (python3)");
    if (!runtimes.ruby)
        missing.push("Ruby (ruby)");
    if (!runtimes.go)
        missing.push("Go (go)");
    if (!runtimes.php)
        missing.push("PHP (php)");
    if (!runtimes.r)
        missing.push("R (Rscript)");
    if (missing.length > 0) {
        p.log.info(color.dim("Optional runtimes not found: " + missing.join(", ")));
        p.log.info(color.dim("Install them to enable additional language support in context-mode."));
    }
    // Step 4: Installation instructions
    const installMethod = await p.select({
        message: "How would you like to configure context-mode?",
        options: [
            {
                value: "claude-code",
                label: "Claude Code (recommended)",
                hint: "claude mcp add",
            },
            {
                value: "manual",
                label: "Show manual configuration",
                hint: ".mcp.json",
            },
            { value: "skip", label: "Skip — I'll configure later" },
        ],
    });
    if (p.isCancel(installMethod)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
    }
    const serverPath = new URL("./server.js", import.meta.url).pathname;
    if (installMethod === "claude-code") {
        s.start("Adding to Claude Code");
        try {
            execSync(`claude mcp add context-mode -- node ${serverPath}`, { stdio: "pipe", timeout: 10000 });
            s.stop(color.green("Added to Claude Code!"));
        }
        catch {
            s.stop(color.yellow("Could not add automatically"));
            p.log.info("Run manually:\n" +
                color.cyan(`  claude mcp add context-mode -- node ${serverPath}`));
        }
    }
    else if (installMethod === "manual") {
        p.note(JSON.stringify({
            mcpServers: {
                "context-mode": {
                    command: "node",
                    args: [serverPath],
                },
            },
        }, null, 2), "Add to your .mcp.json or Claude Code settings");
    }
    p.outro(color.green("Setup complete!") +
        " " +
        color.dim(available.length + " languages ready."));
}
async function doctor() {
    console.clear();
    p.intro(color.bgMagenta(color.white(" context-mode doctor ")));
    const s = p.spinner();
    s.start("Running diagnostics");
    const runtimes = detectRuntimes();
    const available = getAvailableLanguages(runtimes);
    s.stop("Diagnostics complete");
    // Runtime check
    p.note(getRuntimeSummary(runtimes), "Runtimes");
    // Speed tier
    if (hasBunRuntime()) {
        p.log.success(color.green("Performance: FAST") +
            " — Bun detected for JS/TS execution");
    }
    else {
        p.log.warn(color.yellow("Performance: NORMAL") +
            " — Using Node.js (install Bun for 3-5x speed boost)");
    }
    // Language coverage
    const total = 10;
    const pct = ((available.length / total) * 100).toFixed(0);
    p.log.info(`Language coverage: ${available.length}/${total} (${pct}%)` +
        color.dim(` — ${available.join(", ")}`));
    // Server test
    p.log.step("Testing server initialization...");
    try {
        const { PolyglotExecutor } = await import("./executor.js");
        const executor = new PolyglotExecutor({ runtimes });
        const result = await executor.execute({
            language: "javascript",
            code: 'console.log("ok");',
            timeout: 5000,
        });
        if (result.exitCode === 0 && result.stdout.trim() === "ok") {
            p.log.success(color.green("Server test: PASS"));
        }
        else {
            p.log.error(color.red("Server test: FAIL") + ` — exit ${result.exitCode}`);
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        p.log.error(color.red("Server test: FAIL") + ` — ${message}`);
    }
    p.outro(available.length >= 4
        ? color.green("Everything looks good!")
        : color.yellow("Some runtimes missing — install them for full coverage"));
}
