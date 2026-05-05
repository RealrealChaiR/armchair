import { render } from "ink";

import { App } from "./app.js";
import { WorktreeAdd } from "./commands/worktree/add.js";
import { consumeSession } from "./utils/session-bridge.js";
import {
  onSessionExit,
  resizeSession,
  setPassthroughWriter,
  writeToSession,
} from "./utils/claude-sessions.js";

const [, , command, subcommand, name] = process.argv;

if (command === "worktree" && subcommand === "add" && name) {
  render(<WorktreeAdd name={name} />);
} else {
  main().catch(console.error);
}

async function main() {
  let returnToManager = false;
  while (true) {
    const { waitUntilExit } = render(<App startAtManager={returnToManager} />);
    returnToManager = false;
    await waitUntilExit();

    const session = consumeSession();
    if (!session) break;

    await runClaudePassthrough(session.path);
    returnToManager = true; // go straight back to the worktree grid
  }
}

async function runClaudePassthrough(worktreePath: string): Promise<void> {
  return new Promise((resolve) => {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;

    // Enable passthrough before resize so the redraw lands on stdout
    setPassthroughWriter(worktreePath, (data) => process.stdout.write(data));

    // Clear screen, then force Claude to redraw via SIGWINCH (brief resize delta)
    process.stdout.write("\x1b[2J\x1b[H");
    resizeSession(worktreePath, cols, rows);
    setTimeout(() => resizeSession(worktreePath, cols + 1, rows), 16);
    setTimeout(() => resizeSession(worktreePath, cols, rows), 32);

    process.stdin.setRawMode(true);
    process.stdin.resume();

    let escTimeout: ReturnType<typeof setTimeout> | null = null;
    let finished = false;

    const stdinHandler = (chunk: Buffer) => {
      const str = chunk.toString();
      if (str === "\x1b") {
        if (escTimeout) clearTimeout(escTimeout);
        escTimeout = setTimeout(() => { escTimeout = null; done(); }, 50);
        return;
      }
      if (escTimeout) {
        clearTimeout(escTimeout);
        escTimeout = null;
        writeToSession(worktreePath, "\x1b" + str);
        return;
      }
      writeToSession(worktreePath, str);
    };

    const resizeHandler = () =>
      resizeSession(worktreePath, process.stdout.columns ?? 80, process.stdout.rows ?? 24);

    process.stdin.on("data", stdinHandler);
    process.stdout.on("resize", resizeHandler);
    const unsubExit = onSessionExit(worktreePath, done);

    function done() {
      if (finished) return;
      finished = true;
      if (escTimeout) { clearTimeout(escTimeout); escTimeout = null; }
      process.stdin.removeListener("data", stdinHandler);
      process.stdout.removeListener("resize", resizeHandler);
      unsubExit();
      setPassthroughWriter(worktreePath, null);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[2J\x1b[H");
      resolve();
    }
  });
}
