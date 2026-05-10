import { homedir } from "node:os";
import { resolve } from "node:path";

export function resolveCodexConfigDir(): string {
  const envVal = process.env.CODEX_HOME;
  if (envVal) {
    if (envVal.startsWith("~")) {
      return resolve(homedir(), envVal.replace(/^~[/\\]?/, ""));
    }
    return resolve(envVal);
  }
  return resolve(homedir(), ".codex");
}
