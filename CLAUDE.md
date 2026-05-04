# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev          # Run with tsx (no build needed)
pnpm build        # Bundle to dist/index.js via tsup
pnpm lint         # ESLint
pnpm lint:fix     # ESLint --fix
pnpm format       # Prettier --write
pnpm typecheck    # tsc --noEmit
```

No test suite exists yet.

## Architecture

Armchair is a CLI tool (`armchair` binary) built with **Ink v7** (React renderer for terminals). The entry point is `src/index.tsx`, which parses `process.argv` and either renders the main `<App />` or runs a sub-command directly (e.g. `armchair worktree add <name>` renders `<WorktreeAdd />`).

### Screen state machine

Navigation is a discriminated union rendered in a single root component. `app.tsx` owns the top-level `AppScreen` union and renders the correct component per state. `manager2.tsx` has its own `ManagerScreen` union covering all worktree manager sub-screens (`list`, `loading`, `cards`, `app-select`, `add-input`, `add-run`, `confirm-delete`, `claude-session`). All navigation is `useState` + `useInput`.

### PTY processes

Two independent PTY managers live in `src/utils/`:
- **`processes.ts`** — runs `pnpm dev` per app directory, keyed by `appDir`
- **`claude-sessions.ts`** — runs the `claude` CLI per worktree, keyed by `worktreePath`. Uses `@xterm/headless` to maintain a virtual terminal buffer. Import as `import pkg from "@xterm/headless"; const { Terminal } = pkg` (CJS module).

Both follow the same pattern: a module-level `Map`, an idempotent `start`/`startSession`, and callbacks that feed React `setState`.

### Step-based commands

Long-running commands (e.g. `WorktreeAdd`) use a `StepState[]` array with `"pending" | "running" | "done" | "error"` statuses, rendered with `stepIcon`/`stepColor` helpers. Execute logic runs inside a `useCallback` guarded by a `useRef` to prevent double-invocation in strict mode.

### Key utilities

| File | Purpose |
|------|---------|
| `utils/exec.ts` | `run(cmd, { cwd? })` — promisified `exec` |
| `utils/worktree.ts` | `listWorktrees`, `getPrimaryRemote` (upstream → origin), `addWorktree`, `deleteWorktree` |
| `utils/workspace.ts` | Discovers apps with `dev` scripts from `pnpm-workspace.yaml` |
| `utils/armchair-config.ts` | Per-worktree JSON config at `~/.config/armchair/config.json` |
| `utils/github.ts` | `getPRForBranch` via `gh` CLI, `hyperlink(url, text)` for OSC 8 terminal links |

### CI status on cards

PR info is fetched in parallel via `gh pr view <branch> --json number,url` after `listWorktrees()` resolves and stored in `prInfo: Record<string, PRInfo | null>` state.

### Claude session status detection

When Claude's PTY output is written to the `@xterm/headless` buffer, `readScreen()` checks whether the cursor row starts with `❯` to determine `status: "waiting" | "active"`. A `notifiedPaths: Set<string>` state tracks worktrees where Claude transitioned to `waiting` while the user wasn't viewing that session.

## Patterns

- Layout props (`flexDirection`, `gap`, `borderStyle`) go on `<Box>`. Style props (`color`, `bold`, `dimColor`) go on `<Text>`.
- `borderStyle="round"` for cards; `borderColor` driven by selection/running state.
- `useStdout().stdout.columns` for responsive grid column count (`CARD_WIDTH = 32`).
- All imports use `.js` extensions (ESM with `moduleResolution: Bundler`).
