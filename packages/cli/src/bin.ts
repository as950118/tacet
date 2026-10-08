#!/usr/bin/env node
import { relaunchWithLargerHeap } from "./heap.js";
import { buildProgram } from "./program.js";

if (!relaunchWithLargerHeap()) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}
