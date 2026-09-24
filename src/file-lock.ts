// Serialize short, synchronous initialization across MCP processes.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export function withFileLock<T>(path: string, work: () => T, timeoutMs = 10_000): T {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(path);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`PROJECT_BUSY: initialization lock ${path} did not clear. Retry after the other MCP process finishes. If its owner process has exited, remove this abandoned lock directory and retry.`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    return work();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}
