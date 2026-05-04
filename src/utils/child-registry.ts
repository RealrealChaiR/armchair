import type { ChildProcess } from "node:child_process";

const children = new Set<ChildProcess>();

export function registerChild(proc: ChildProcess): void {
  children.add(proc);
  proc.on("close", () => children.delete(proc));
}

export function killAllChildren(): void {
  for (const proc of children) {
    try { proc.kill("SIGTERM"); } catch {}
  }
  children.clear();
}

process.on("exit", killAllChildren);
