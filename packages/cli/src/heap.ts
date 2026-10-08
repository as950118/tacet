import { spawnSync } from "node:child_process";
import { totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";

const MB = 1024 * 1024;
const MAX_HEAP_MB = 16384;

/**
 * Analyzing a large frontend keeps the whole TypeScript program and its type checker in memory, which can
 * exceed Node's default heap limit (~4 GB). Unless the heap size was chosen explicitly, re-runs this process
 * with a limit of 3/4 of the machine's memory (at most 16 GB). Returns true when it did; the caller must
 * then exit, because the child already did the work.
 */
export function relaunchWithLargerHeap(): boolean {
  const explicit = [...process.execArgv, process.env.NODE_OPTIONS ?? ""].some((arg) => arg.includes("max-old-space-size"));
  if (explicit || process.env.TACET_HEAP_RELAUNCHED) return false;
  const targetMb = Math.min(MAX_HEAP_MB, Math.floor((totalmem() * 0.75) / MB));
  if (getHeapStatistics().heap_size_limit / MB >= targetMb * 0.9) return false;

  const child = spawnSync(
    process.execPath,
    [`--max-old-space-size=${targetMb}`, ...process.execArgv, ...process.argv.slice(1)],
    { stdio: "inherit", env: { ...process.env, TACET_HEAP_RELAUNCHED: "1" } },
  );
  if (child.error) return false;
  process.exitCode = child.status ?? 1;
  return true;
}
