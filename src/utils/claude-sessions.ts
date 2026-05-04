import * as pty from "node-pty";
import type { IPty } from "node-pty";
import pkg from "@xterm/headless";
const { Terminal } = pkg;

export type SessionStatus = "waiting" | "active";
export type ScreenState = {
  rows: string[];
  cursorRow: number;
  cursorCol: number;
  status: SessionStatus;
  notified: boolean;
};

type Subscriber = (s: ScreenState) => void;

type Entry = {
  proc: IPty;
  term: typeof Terminal.prototype;
  subscribers: Set<Subscriber>;
  passthroughWriter: ((d: string) => void) | null;
  lastStatus: SessionStatus;
  notified: boolean;
};

const sessions = new Map<string, Entry>();
let exitHandlerRegistered = false;

function snapshot(entry: Entry): ScreenState {
  const term = entry.term;
  const rows: string[] = [];
  for (let i = 0; i < term.rows; i++) {
    rows.push(term.buffer.active.getLine(i)?.translateToString(false) ?? "");
  }
  const cursorRow = term.buffer.active.cursorY;
  const cursorCol = term.buffer.active.cursorX;
  let last = rows.length - 1;
  while (last > cursorRow && rows[last]?.trim() === "") last--;
  // Claude's spinner line ("✶ Crafting… (… esc to interrupt)") is only
  // present while a turn is in flight. Its absence means we're back at
  // the input prompt. Looking for the prompt glyph itself is fragile —
  // recent Claude versions use ">" inside a bordered box rather than "❯".
  const visible = rows.slice(0, last + 1);
  const isBusy = visible.some((line) => line.includes("esc to interrupt"));
  const status: SessionStatus = isBusy ? "active" : "waiting";
  return {
    rows: visible,
    cursorRow,
    cursorCol,
    status,
    notified: entry.notified,
  };
}

function emit(entry: Entry): void {
  const state = snapshot(entry);
  for (const sub of entry.subscribers) sub(state);
}

export function startSession(worktreePath: string, cols: number, rows: number): void {
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

  const entry: Entry = {
    proc,
    term,
    subscribers: new Set(),
    passthroughWriter: null,
    lastStatus: "active",
    notified: false,
  };
  sessions.set(worktreePath, entry);

  proc.onData((data) => {
    term.write(data, () => {
      const state = snapshot(entry);
      // Flag "you have unread output" when claude finishes a turn while
      // the user isn't actively viewing this session via passthrough.
      if (
        state.status === "waiting" &&
        entry.lastStatus !== "waiting" &&
        !entry.passthroughWriter
      ) {
        entry.notified = true;
      }
      entry.lastStatus = state.status;
      entry.passthroughWriter?.(data);
      emit(entry);
    });
  });

  proc.onExit(() => {
    term.dispose();
    sessions.delete(worktreePath);
  });
}

export function subscribeToSession(worktreePath: string, cb: Subscriber): () => void {
  const entry = sessions.get(worktreePath);
  if (!entry) return () => {};
  entry.subscribers.add(cb);
  cb(snapshot(entry));
  return () => {
    entry.subscribers.delete(cb);
  };
}

export function acknowledgeSession(worktreePath: string): void {
  const entry = sessions.get(worktreePath);
  if (!entry || !entry.notified) return;
  entry.notified = false;
  emit(entry);
}

export function getRunningSessionPaths(): string[] {
  return [...sessions.keys()];
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
    ? snapshot(entry)
    : { rows: [], cursorRow: 0, cursorCol: 0, status: "active", notified: false };
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
