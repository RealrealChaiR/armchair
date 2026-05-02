import * as pty from "node-pty";
import type { IPty } from "node-pty";

type Entry = { proc: IPty; output: string[]; displayName: string };

const processes = new Map<string, Entry>();
let exitHandlerRegistered = false;

// Strip ANSI escape sequences so raw PTY output renders cleanly in Ink.
function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[mGKHFJA-Za-z]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");
}

export function start(
  appDir: string,
  displayName: string,
  onOutput: (line: string) => void,
): void {
  if (processes.has(appDir)) return;

  if (!exitHandlerRegistered) {
    process.on("exit", killAll);
    process.on("SIGINT", () => { killAll(); process.exit(0); });
    process.on("SIGTERM", () => { killAll(); process.exit(0); });
    exitHandlerRegistered = true;
  }

  const proc = pty.spawn("pnpm", ["dev"], {
    name: "xterm-color",
    cols: 220,
    rows: 50,
    cwd: appDir,
    env: process.env as Record<string, string>,
  });

  const entry: Entry = { proc, output: [], displayName };
  processes.set(appDir, entry);

  proc.onData((data) => {
    const lines = stripAnsi(data).split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      entry.output = [...entry.output.slice(-499), line];
      onOutput(line);
    }
  });

  proc.onExit(() => processes.delete(appDir));
}

export function killAppsNotInWorktree(worktreePath: string): void {
  for (const [appDir, { proc }] of processes) {
    if (!appDir.startsWith(worktreePath)) {
      proc.kill();
      processes.delete(appDir);
    }
  }
}

export function killAll(): void {
  for (const { proc } of processes.values()) {
    proc.kill();
  }
  processes.clear();
}

export function isRunning(appDir: string): boolean {
  return processes.has(appDir);
}

export function getOutput(appDir: string): string[] {
  return processes.get(appDir)?.output ?? [];
}

export function writeToProcess(appDir: string, data: string): void {
  processes.get(appDir)?.proc.write(data);
}

export function getRunningAppsForWorktree(
  worktreePath: string,
): { appDir: string; displayName: string }[] {
  const result: { appDir: string; displayName: string }[] = [];
  for (const [appDir, { displayName }] of processes) {
    if (appDir.startsWith(worktreePath)) {
      result.push({ appDir, displayName });
    }
  }
  return result;
}
