import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const repoRoot = process.cwd();

function waitForOutput(
  proc: ChildProcessWithoutNullStreams,
  needle: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let buffer = "";
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes(needle)) finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", () => finish(buffer.includes(needle)));
  });
}

describe("start.mjs startup order", () => {
  const cleanup: string[] = [];
  const procs: ChildProcessWithoutNullStreams[] = [];

  afterEach(() => {
    while (procs.length) {
      const proc = procs.pop();
      if (proc && !proc.killed) proc.kill("SIGTERM");
    }
    while (cleanup.length) {
      const p = cleanup.pop();
      if (p) rmSync(p, { recursive: true, force: true });
    }
  });

  it("does not wait for dependency bootstrap before starting the MCP server bundle", async () => {
    const root = mkdtempSync(join(tmpdir(), "ctx-start-order-"));
    cleanup.push(root);
    mkdirSync(join(root, "hooks"), { recursive: true });
    mkdirSync(join(root, "node_modules", "turndown"), { recursive: true });
    mkdirSync(join(root, "node_modules", "turndown-plugin-gfm"), { recursive: true });
    mkdirSync(join(root, "node_modules", "@mixmark-io", "domino"), { recursive: true });
    mkdirSync(join(root, "home"), { recursive: true });

    copyFileSync(join(repoRoot, "start.mjs"), join(root, "start.mjs"));
    writeFileSync(
      join(root, "hooks", "ensure-deps.mjs"),
      "await new Promise((resolve) => setTimeout(resolve, 5000));\nconsole.error('__ENSURE_DEPS_DONE__');\n",
    );
    writeFileSync(
      join(root, "server.bundle.mjs"),
      "console.log('__SERVER_BUNDLE_STARTED__');\nsetInterval(() => {}, 1000);\n",
    );

    const proc = spawn(process.execPath, [join(root, "start.mjs")], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: join(root, "home"),
        VITEST: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(proc);

    await expect(waitForOutput(proc, "__SERVER_BUNDLE_STARTED__", 3000)).resolves.toBe(true);
  });
});
