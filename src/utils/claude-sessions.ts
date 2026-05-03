import * as pty from "node-pty";
import type { IPty } from "node-pty";
import pkg from "@xterm/headless";
const { Terminal } = pkg;

type Entry = { proc: IPty; term: Terminal };

export type SessionStatus = "waiting" | "active";
export type ScreenState = { rows: string[]; cursorRow: number; cursorCol: number; status: SessionStatus };

const sessions = new Map<string, Entry>();
let exitHandlerRegistered = false;

function readScreen(term: Terminal): ScreenState {
  const rows: string[] = [];
  for (let i = 0; i < term.rows; i++) {
    // Don't trim — cursor position may be past visible characters
    rows.push(term.buffer.active.getLine(i)?.translateToString(false) ?? "");
  }
  // Drop trailing blank rows (but keep up to cursor row)
  const cursorRow = term.buffer.active.cursorY;
  const cursorCol = term.buffer.active.cursorX;
  let last = rows.length - 1;
  while (last > cursorRow && rows[last]?.trim() === "") last--;
  // Claude shows ❯ at the start of the input line when waiting for user input
  const cursorLine = rows[cursorRow] ?? "";
  const status: SessionStatus = cursorLine.trimStart().startsWith("❯") ? "waiting" : "active";
  return { rows: rows.slice(0, last + 1), cursorRow, cursorCol, status };
}

export function startSession(
  worktreePath: string,
  cols: number,
  rows: number,
  onScreen: (screen: ScreenState) => void,
): void {
  if (sessions.has(worktreePath)) return;

  if (!exitHandlerRegistered) {
    process.on("exit", killAllSessions);
    exitHandlerRegistered = true;
  }

  const term = new Terminal({ cols, rows, allowProposedApi: true });

  const proc = pty.spawn("claude", [], {
    name: "xterm-color",
    cols,
    rows,
    cwd: worktreePath,
    env: process.env as Record<string, string>,
  });

  sessions.set(worktreePath, { proc, term });

  proc.onData((data) => {
    term.write(data, () => onScreen(readScreen(term)));
  });

  proc.onExit(() => {
    term.dispose();
    sessions.delete(worktreePath);
  });
}

export function getSessionScreen(worktreePath: string): ScreenState {
  const entry = sessions.get(worktreePath);
  return entry ? readScreen(entry.term) : { rows: [], cursorRow: 0, cursorCol: 0 };
}

export function isSessionRunning(worktreePath: string): boolean {
  return sessions.has(worktreePath);
}

export function writeToSession(worktreePath: string, data: string): void {
  sessions.get(worktreePath)?.proc.write(data);
}

export function killSession(worktreePath: string): void {
  const entry = sessions.get(worktreePath);
  if (entry) {
    entry.proc.kill();
    entry.term.dispose();
    sessions.delete(worktreePath);
  }
}

export function killAllSessions(): void {
  for (const { proc, term } of sessions.values()) {
    proc.kill();
    term.dispose();
  }
  sessions.clear();
}
