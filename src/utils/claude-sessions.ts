import * as pty from "node-pty";
import type { IPty } from "node-pty";
import pkg from "@xterm/headless";
const { Terminal } = pkg;

export type SessionStatus = "waiting" | "active";
export type ScreenState = { rows: string[]; cursorRow: number; cursorCol: number; status: SessionStatus };

type Entry = {
  proc: IPty;
  term: typeof Terminal.prototype;
  onScreen: (s: ScreenState) => void;
  passthroughWriter: ((d: string) => void) | null;
  lastStatus: SessionStatus;
};

const sessions = new Map<string, Entry>();
let exitHandlerRegistered = false;

function readScreen(term: typeof Terminal.prototype): ScreenState {
  const rows: string[] = [];
  for (let i = 0; i < term.rows; i++) {
    rows.push(term.buffer.active.getLine(i)?.translateToString(false) ?? "");
  }
  const cursorRow = term.buffer.active.cursorY;
  const cursorCol = term.buffer.active.cursorX;
  let last = rows.length - 1;
  while (last > cursorRow && rows[last]?.trim() === "") last--;
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
  const existing = sessions.get(worktreePath);
  if (existing) {
    // Update callback so re-mounted Ink components get live updates
    existing.onScreen = onScreen;
    return;
  }

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

  const entry: Entry = { proc, term, onScreen, passthroughWriter: null, lastStatus: "active" };
  sessions.set(worktreePath, entry);

  proc.onData((data) => {
    term.write(data, () => {
      const screen = readScreen(entry.term);
      entry.lastStatus = screen.status;
      entry.passthroughWriter?.(data);
      entry.onScreen(screen);
    });
  });

  proc.onExit(() => {
    term.dispose();
    sessions.delete(worktreePath);
  });
}

export function setPassthroughWriter(
  worktreePath: string,
  writer: ((d: string) => void) | null,
): void {
  const entry = sessions.get(worktreePath);
  if (entry) entry.passthroughWriter = writer;
}

export function resizeSession(worktreePath: string, cols: number, rows: number): void {
  sessions.get(worktreePath)?.proc.resize(cols, rows);
}

export function onSessionExit(worktreePath: string, cb: () => void): () => void {
  const entry = sessions.get(worktreePath);
  if (!entry) { cb(); return () => {}; }
  const d = entry.proc.onExit(cb);
  return () => d.dispose();
}

export function getSessionScreen(worktreePath: string): ScreenState {
  const entry = sessions.get(worktreePath);
  return entry
    ? readScreen(entry.term)
    : { rows: [], cursorRow: 0, cursorCol: 0, status: "active" };
}

export function getSessionStatus(worktreePath: string): SessionStatus {
  return sessions.get(worktreePath)?.lastStatus ?? "active";
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
