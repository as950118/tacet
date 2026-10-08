import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const SOURCE = /\.(ts|tsx|mts|cts|vue)$/;

/**
 * TypeScript files under `dir` changed since `ref` (committed, staged, unstaged
 * and untracked), relative to `dir`. Deleted files are included so their
 * index entries can be dropped.
 */
export function changedSourceFiles(dir: string, ref: string): string[] {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  let tracked: string[];
  try {
    tracked = git("diff", "--name-only", "--relative", ref);
  } catch (err) {
    throw new Error(`git diff against "${ref}" failed in ${dir}: ${(err as Error).message}`);
  }
  const untracked = git("ls-files", "--others", "--exclude-standard");
  return [...new Set([...tracked, ...untracked])].filter((f) => SOURCE.test(f) && !f.endsWith(".d.ts")).sort();
}

function repoRoot(dir: string): string {
  try {
    return realpathSync(
      execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
    );
  } catch {
    throw new Error(`${dir} is not inside a git repository`);
  }
}

function repoRelative(dir: string): { root: string; rel: string } {
  const root = repoRoot(dir);
  const rel = relative(root, realpathSync(resolve(dir))).split(sep).join("/");
  return { root, rel: rel || "." };
}

/** Whether anything under `dir` differs between `base` and `head` (or the working tree when head is omitted). */
export function hasChangesBetween(dir: string, base: string, head?: string): boolean {
  const { root, rel } = repoRelative(dir);
  const result = spawnSync("git", ["-C", root, "diff", "--quiet", base, ...(head ? [head] : []), "--", rel]);
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  throw new Error(`git diff ${base} ${head ?? ""} failed: ${result.stderr.toString().trim()}`);
}

/**
 * Writes `dir` as it was at `ref` into `target` (via `git archive`, so the
 * working tree is never touched) and returns the materialized directory.
 */
export function materializeAtRef(dir: string, ref: string, target: string): string {
  const { root, rel } = repoRelative(dir);
  const archive = spawnSync("git", ["-C", root, "archive", "--format=tar", ref, "--", rel], {
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (archive.status !== 0) {
    throw new Error(`Cannot read ${rel} at ${ref}: ${archive.stderr.toString().trim()}`);
  }
  mkdirSync(target, { recursive: true });
  const tar = spawnSync("tar", ["-x", "-C", target], { input: archive.stdout });
  if (tar.status !== 0) throw new Error(`Extracting ${rel}@${ref} failed: ${tar.stderr.toString().trim()}`);
  return join(target, rel);
}
