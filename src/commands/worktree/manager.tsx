import * as path from "node:path";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import { useCallback, useEffect, useState } from "react";

import { WorktreeAdd } from "./add.js";
import { Footer } from "../../components/Footer.js";
import { loadConfig, saveConfig } from "../../utils/armchair-config.js";
import {
  getOutput,
  getRunningAppsForWorktree,
  isRunning,
  killAll,
  killAppsNotInWorktree,
  start,
  writeToProcess,
} from "../../utils/processes.js";
import { type AppInfo, discoverApps } from "../../utils/workspace.js";
import {
  type WorktreeInfo,
  deleteWorktree,
  listWorktrees,
} from "../../utils/worktree.js";

// ─── screen types ───────────────────────────────────────────────────────────

type ManagerScreen =
  | { type: "list"; worktrees: WorktreeInfo[]; selectedIndex: number }
  | { type: "loading" }
  | { type: "error"; message: string }
  | {
      type: "app-select";
      worktreePath: string;
      apps: AppInfo[];
      selectedIndex: number;
      checked: Set<string>;
    }
  | { type: "cards"; worktreePath: string; selectedCardIndex: number; fullWidth: boolean }
  | { type: "confirm-delete"; worktree: WorktreeInfo; worktrees: WorktreeInfo[]; selectedIndex: number }
  | { type: "add-input"; value: string }
  | { type: "add-run"; name: string };

type Props = { onBack: () => void };

// ─── main component ──────────────────────────────────────────────────────────

export function WorktreeManager({ onBack }: Props) {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const [screen, setScreen] = useState<ManagerScreen>({ type: "loading" });
  const [appOutputs, setAppOutputs] = useState<Record<string, string[]>>({});
  // Lines from the bottom to offset the view (0 = newest, higher = older)
  const [scrollOffsets, setScrollOffsets] = useState<Record<string, number>>({});

  useEffect(() => {
    listWorktrees()
      .then((all) => {
        const worktrees = all.filter((w) => !w.isBare);
        setScreen({ type: "list", worktrees, selectedIndex: 0 });
      })
      .catch((err) =>
        setScreen({ type: "error", message: String(err) }),
      );
  }, []);

  const startApps = useCallback(
    (worktreePath: string, appDirs: string[], apps: AppInfo[]) => {
      killAppsNotInWorktree(worktreePath);
      const nameFor = (dir: string) =>
        apps.find((a) => a.dir === dir)?.name ?? path.basename(dir);

      // Seed output state from any already-running processes
      const initial: Record<string, string[]> = {};
      for (const dir of appDirs) {
        initial[dir] = getOutput(dir);
      }
      setAppOutputs(initial);

      for (const dir of appDirs) {
        start(dir, nameFor(dir), (line) => {
          setAppOutputs((prev) => ({
            ...prev,
            [dir]: [...(prev[dir] ?? []).slice(-499), line],
          }));
        });
      }

      setScreen({ type: "cards", worktreePath, selectedCardIndex: 0, fullWidth: false });
    },
    [],
  );

  const handleWorktreeSelect = useCallback(
    async (worktree: WorktreeInfo) => {
      const config = await loadConfig(worktree.path);
      if (config && config.appDirs.length > 0) {
        // Discover apps so we have names for the cards
        const apps = await discoverApps(worktree.path);
        startApps(worktree.path, config.appDirs, apps);
        return;
      }
      const apps = await discoverApps(worktree.path);
      if (apps.length === 0) {
        // No workspace apps found — start whole worktree
        startApps(worktree.path, [worktree.path], [
          { name: path.basename(worktree.path), dir: worktree.path },
        ]);
        return;
      }
      setScreen({
        type: "app-select",
        worktreePath: worktree.path,
        apps,
        selectedIndex: 0,
        checked: new Set(),
      });
    },
    [startApps],
  );

  useInput(
    (input, key) => {
      // q quits everywhere except cards (PTY input) and add-input (text input)
      if (input === "q" && screen.type !== "cards" && screen.type !== "add-input") {
        killAll();
        exit();
        return;
      }

      if (screen.type === "list") {
        if (key.escape) {
          killAll();
          onBack();
        } else if (key.upArrow) {
          setScreen((s) =>
            s.type === "list"
              ? { ...s, selectedIndex: Math.max(0, s.selectedIndex - 1) }
              : s,
          );
        } else if (key.downArrow) {
          setScreen((s) =>
            s.type === "list"
              ? {
                  ...s,
                  selectedIndex: Math.min(
                    s.worktrees.length - 1,
                    s.selectedIndex + 1,
                  ),
                }
              : s,
          );
        } else if (key.return) {
          const wt = screen.worktrees[screen.selectedIndex];
          if (wt) void handleWorktreeSelect(wt);
        } else if (input === "d") {
          const wt = screen.worktrees[screen.selectedIndex];
          if (wt) {
            setScreen({
              type: "confirm-delete",
              worktree: wt,
              worktrees: screen.worktrees,
              selectedIndex: screen.selectedIndex,
            });
          }
        } else if (input === "a") {
          setScreen({ type: "add-input", value: "" });
        } else if (input === "c") {
          const wt = screen.worktrees[screen.selectedIndex];
          if (wt) {
            void Promise.all([discoverApps(wt.path), loadConfig(wt.path)]).then(
              ([apps, config]) => {
                setScreen({
                  type: "app-select",
                  worktreePath: wt.path,
                  apps,
                  selectedIndex: 0,
                  checked: new Set(config?.appDirs ?? []),
                });
              },
            );
          }
        }
      } else if (screen.type === "confirm-delete") {
        if (key.escape || input === "n" || input === "N") {
          setScreen({
            type: "list",
            worktrees: screen.worktrees,
            selectedIndex: screen.selectedIndex,
          });
        } else if (input === "y" || input === "Y") {
          const { worktree, worktrees, selectedIndex } = screen;
          void deleteWorktree(worktree.path, worktree.branch).then(() => {
            const updated = worktrees.filter((w) => w.path !== worktree.path);
            setScreen({
              type: "list",
              worktrees: updated,
              selectedIndex: Math.min(selectedIndex, Math.max(0, updated.length - 1)),
            });
          });
        }
      } else if (screen.type === "add-input") {
        if (key.escape) {
          listWorktrees()
            .then((all) => {
              const worktrees = all.filter((w) => !w.isBare);
              setScreen({ type: "list", worktrees, selectedIndex: 0 });
            })
            .catch(() => onBack());
        } else if (key.return) {
          if (screen.value.trim()) {
            setScreen({ type: "add-run", name: screen.value.trim() });
          }
        } else if (key.backspace || key.delete) {
          setScreen((s) =>
            s.type === "add-input" ? { ...s, value: s.value.slice(0, -1) } : s,
          );
        } else if (input && !key.ctrl && !key.meta) {
          setScreen((s) =>
            s.type === "add-input" ? { ...s, value: s.value + input } : s,
          );
        }
      } else if (screen.type === "app-select") {
        if (key.escape) {
          listWorktrees()
            .then((all) => {
              const worktrees = all.filter((w) => !w.isBare);
              setScreen({ type: "list", worktrees, selectedIndex: 0 });
            })
            .catch(() => onBack());
        } else if (key.upArrow) {
          setScreen((s) =>
            s.type === "app-select"
              ? { ...s, selectedIndex: Math.max(0, s.selectedIndex - 1) }
              : s,
          );
        } else if (key.downArrow) {
          setScreen((s) =>
            s.type === "app-select"
              ? {
                  ...s,
                  selectedIndex: Math.min(
                    s.apps.length - 1,
                    s.selectedIndex + 1,
                  ),
                }
              : s,
          );
        } else if (input === " ") {
          setScreen((s) => {
            if (s.type !== "app-select") return s;
            const app = s.apps[s.selectedIndex];
            if (!app) return s;
            const checked = new Set(s.checked);
            if (checked.has(app.dir)) checked.delete(app.dir);
            else checked.add(app.dir);
            return { ...s, checked };
          });
        } else if (key.return) {
          if (screen.checked.size === 0) return;
          const appDirs = [...screen.checked];
          void saveConfig(screen.worktreePath, { appDirs }).then(() => {
            startApps(screen.worktreePath, appDirs, screen.apps);
          });
        }
      } else if (screen.type === "cards") {
        if (key.escape) {
          listWorktrees()
            .then((all) => {
              const worktrees = all.filter((w) => !w.isBare);
              setScreen({ type: "list", worktrees, selectedIndex: 0 });
            })
            .catch(() => onBack());
          return;
        }

        const runningApps = getRunningAppsForWorktree(screen.worktreePath);

        if (key.leftArrow) {
          setScreen((s) =>
            s.type === "cards"
              ? { ...s, selectedCardIndex: Math.max(0, s.selectedCardIndex - 1) }
              : s,
          );
          return;
        }
        if (key.rightArrow) {
          setScreen((s) =>
            s.type === "cards"
              ? {
                  ...s,
                  selectedCardIndex: Math.min(
                    runningApps.length - 1,
                    s.selectedCardIndex + 1,
                  ),
                }
              : s,
          );
          return;
        }

        const focused = runningApps[screen.selectedCardIndex];
        if (!focused) return;

        if (key.upArrow) {
          const lines = appOutputs[focused.appDir] ?? [];
          setScrollOffsets((prev) => ({
            ...prev,
            [focused.appDir]: Math.min(
              Math.max(0, lines.length - VISIBLE_LINES),
              (prev[focused.appDir] ?? 0) + 3,
            ),
          }));
          return;
        }
        if (key.downArrow) {
          setScrollOffsets((prev) => ({
            ...prev,
            [focused.appDir]: Math.max(0, (prev[focused.appDir] ?? 0) - 3),
          }));
          return;
        }

        if (input === "f") {
          setScreen((s) => s.type === "cards" ? { ...s, fullWidth: !s.fullWidth } : s);
          return;
        }

        // Forward everything else to the focused card's PTY
        const raw = keyToRaw(input, key);
        if (raw !== null) writeToProcess(focused.appDir, raw);
      }
    },
    { isActive: isRawModeSupported === true },
  );

  // ─── render ───────────────────────────────────────────────────────────────

  if (screen.type === "loading") {
    return (
      <Box flexDirection="column" padding={1} gap={1}>
        <Header />
        <Text dimColor>Loading worktrees…</Text>
      </Box>
    );
  }

  if (screen.type === "error") {
    return (
      <Box flexDirection="column" padding={1} gap={1}>
        <Header />
        <Text color="red">{screen.message}</Text>
        <Footer hints="q quit" />
      </Box>
    );
  }

  if (screen.type === "list") {
    return (
      <Box flexDirection="column" padding={1} gap={1}>
        <Header />
        <Box flexDirection="column" gap={0}>
          {screen.worktrees.map((wt, i) => {
            const selected = i === screen.selectedIndex;
            const running = getRunningAppsForWorktree(wt.path).length > 0;
            return (
              <Box key={wt.path} gap={2}>
                <Text color={selected ? "green" : undefined} bold={selected}>
                  {selected ? ">" : " "} {wt.branch}
                </Text>
                <Text dimColor>{path.basename(wt.path)}</Text>
                <Text color={running ? "green" : "gray"}>
                  {running ? "● running" : "○ stopped"}
                </Text>
              </Box>
            );
          })}
        </Box>
        <Footer hints="↑↓ navigate  Enter start  a add  c config  d delete  Esc back  q quit" />
      </Box>
    );
  }

  if (screen.type === "app-select") {
    return (
      <Box flexDirection="column" padding={1} gap={1}>
        <Header sub={`select apps — ${path.basename(screen.worktreePath)}`} />
        <Box flexDirection="column" gap={0}>
          {screen.apps.map((app, i) => {
            const selected = i === screen.selectedIndex;
            const checked = screen.checked.has(app.dir);
            return (
              <Box key={app.dir} gap={1}>
                <Text color={selected ? "green" : undefined} bold={selected}>
                  {selected ? ">" : " "}
                </Text>
                <Text color={checked ? "green" : "gray"}>
                  {checked ? "[x]" : "[ ]"}
                </Text>
                <Text bold={selected}>{app.name}</Text>
              </Box>
            );
          })}
        </Box>
        <Footer hints="↑↓ navigate  Space toggle  Enter start  Esc back" />
      </Box>
    );
  }

  if (screen.type === "add-run") {
    return (
      <WorktreeAdd
        name={screen.name}
        onDone={() => {
          listWorktrees()
            .then((all) => {
              const worktrees = all.filter((w) => !w.isBare);
              setScreen({ type: "list", worktrees, selectedIndex: 0 });
            })
            .catch(() => onBack());
        }}
      />
    );
  }

  if (screen.type === "add-input") {
    return (
      <Box flexDirection="column" padding={1} gap={1}>
        <Header sub="worktree add" />
        <Box gap={1}>
          <Text dimColor>Branch name:</Text>
          <Text color="cyan">{screen.value}</Text>
          <Text>_</Text>
        </Box>
        <Footer hints="Backspace edit  Enter create  Esc back" />
      </Box>
    );
  }

  if (screen.type === "confirm-delete") {
    return (
      <Box flexDirection="column" padding={1} gap={1}>
        <Header />
        <Box flexDirection="column" gap={1}>
          <Text>
            Delete worktree{" "}
            <Text bold color="cyan">
              {screen.worktree.branch}
            </Text>
            ?
          </Text>
          <Text dimColor>
            This will remove the worktree directory and delete the branch from git.
          </Text>
          <Box gap={1}>
            <Text color="red" bold>
              [y]
            </Text>
            <Text>Yes, delete it</Text>
            <Text dimColor>  </Text>
            <Text color="green" bold>
              [n]
            </Text>
            <Text>No, keep it</Text>
          </Box>
        </Box>
        <Footer hints="y delete  n / Esc cancel" />
      </Box>
    );
  }

  // cards screen
  const runningApps = getRunningAppsForWorktree(screen.worktreePath);
  const focusedApp = runningApps[screen.selectedCardIndex];

  return (
    <Box flexDirection="column" padding={1} gap={1}>
      <Header sub={path.basename(screen.worktreePath)} />
      {runningApps.length === 0 ? (
        <Text dimColor>Starting apps…</Text>
      ) : screen.fullWidth ? (
        <>
          {/* Tab bar */}
          <Box flexDirection="row" gap={2}>
            {runningApps.map(({ appDir, displayName }, i) => {
              const focused = i === screen.selectedCardIndex;
              const running = isRunning(appDir);
              return (
                <Box key={appDir} gap={1}>
                  <Text bold={focused} color={focused ? "cyan" : "gray"}>
                    {focused ? "▶" : " "} {displayName}
                  </Text>
                  <Text color={running ? "green" : "red"}>
                    {running ? "●" : "✗"}
                  </Text>
                </Box>
              );
            })}
          </Box>
          {/* Focused card — full width */}
          {focusedApp && (() => {
            const { appDir, displayName } = focusedApp;
            const allLines = appOutputs[appDir] ?? getOutput(appDir);
            const running = isRunning(appDir);
            const offset = scrollOffsets[appDir] ?? 0;
            const end = Math.max(0, allLines.length - offset);
            const start = Math.max(0, end - VISIBLE_LINES);
            const visibleLines = allLines.slice(start, end);
            const hasMore = start > 0;
            return (
              <Box
                flexDirection="column"
                borderStyle="single"
                borderColor="cyan"
                paddingX={1}
              >
                <Box gap={1}>
                  <Text bold color="cyan">{displayName}</Text>
                  <Text color={running ? "green" : "red"}>
                    {running ? "●" : "✗"}
                  </Text>
                  {offset > 0 && <Text dimColor>↑ scrolled</Text>}
                </Box>
                {hasMore && <Text dimColor>  ↑ more above</Text>}
                {visibleLines.length === 0 ? (
                  <Text dimColor>waiting for output…</Text>
                ) : (
                  visibleLines.map((line, idx) => (
                    <Text key={idx}>{line}</Text>
                  ))
                )}
              </Box>
            );
          })()}
        </>
      ) : (
        <Box flexDirection="row" gap={1}>
          {runningApps.map(({ appDir, displayName }, i) => {
            const allLines = appOutputs[appDir] ?? getOutput(appDir);
            const running = isRunning(appDir);
            const focused = i === screen.selectedCardIndex;
            const offset = scrollOffsets[appDir] ?? 0;
            const end = Math.max(0, allLines.length - offset);
            const start = Math.max(0, end - VISIBLE_LINES);
            const visibleLines = allLines.slice(start, end);
            const hasMore = start > 0;
            return (
              <Box
                key={appDir}
                flexDirection="column"
                flexGrow={1}
                minWidth={35}
                borderStyle="single"
                borderColor={focused ? "cyan" : "gray"}
                paddingX={1}
              >
                <Box gap={1}>
                  <Text bold color={focused ? "cyan" : undefined}>
                    {displayName}
                  </Text>
                  <Text color={running ? "green" : "red"}>
                    {running ? "●" : "✗"}
                  </Text>
                  {offset > 0 && <Text dimColor>↑ scrolled</Text>}
                </Box>
                {hasMore && <Text dimColor>  ↑ more above</Text>}
                {visibleLines.length === 0 ? (
                  <Text dimColor>waiting for output…</Text>
                ) : (
                  visibleLines.map((line, idx) => (
                    <Text key={idx} wrap="truncate">{line}</Text>
                  ))
                )}
              </Box>
            );
          })}
        </Box>
      )}
      <Footer hints={`←→ switch card  ↑↓ scroll  f ${screen.fullWidth ? "side-by-side" : "full-width"}  Esc back`} />
    </Box>
  );
}

const VISIBLE_LINES = 40;

// ─── key forwarding ──────────────────────────────────────────────────────────

function keyToRaw(input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]): string | null {
  // up/down are used for scrolling, not forwarded to PTY
  if (key.return) return "\r";
  if (key.backspace) return "\x7f";
  if (key.delete) return "\x1b[3~";
  if (key.tab) return "\t";
  if (key.ctrl && input === "c") return "\x03";
  if (key.ctrl && input === "z") return "\x1a";
  if (key.ctrl && input === "l") return "\x0c";
  if (key.ctrl && input) return String.fromCharCode(input.charCodeAt(0) - 96);
  if (input) return input;
  return null;
}

// ─── shared sub-components ───────────────────────────────────────────────────

function Header({ sub }: { sub?: string }) {
  return (
    <Box gap={1}>
      <Text bold color="cyan">
        armchair
      </Text>
      <Text dimColor>— {sub ?? "worktree manager"}</Text>
    </Box>
  );
}
