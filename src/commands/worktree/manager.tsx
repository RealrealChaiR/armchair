import { spawn } from "node:child_process";
import * as path from "node:path";
import type { GlobalConfig } from "../../utils/armchair-config.js";
import type { ScreenState } from "../../utils/claude-sessions.js";
import type { CIStatus, PRInfo } from "../../utils/github.js";
import type { AppInfo } from "../../utils/workspace.js";
import type { WorktreeInfo } from "../../utils/worktree.js";
import type { ReviewStatus } from "./ready-for-review.js";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";

import { Footer } from "../../components/Footer.js";
import {
  loadGlobalConfig,
  saveGlobalConfig,
} from "../../utils/armchair-config.js";
import { killAllChildren } from "../../utils/child-registry.js";
import {
  acknowledgeSession,
  getRunningSessionPaths,
  isSessionRunning,
  killAllSessions,
  killSession,
  startSession,
  subscribeToSession,
} from "../../utils/claude-sessions.js";
import { run } from "../../utils/exec.js";
import { getCIStatus, getPRForBranch, hyperlink } from "../../utils/github.js";
import {
  getOutput,
  getRunningAppsForWorktree,
  isRunning,
  killAll,
  killAppsNotInWorktree,
  start,
  writeToProcess,
} from "../../utils/processes.js";
import { requestSession } from "../../utils/session-bridge.js";
import { discoverApps } from "../../utils/workspace.js";
import {
  deleteWorktree,
  getPrimaryRemote,
  listWorktrees,
} from "../../utils/worktree.js";
import { WorktreeAdd } from "./add.js";
import { ReadyForReview } from "./ready-for-review.js";

// ─── screen types ───────────────────────────────────────────────────────────

type ManagerScreen =
  | { type: "list"; worktrees: WorktreeInfo[]; selectedIndex: number }
  | { type: "loading" }
  | { type: "error"; message: string }
  | {
      type: "config-menu";
      worktreePath: string;
      apps: AppInfo[];
      selectedIndex: number;
    }
  | {
      type: "config-app-select";
      worktreePath: string;
      apps: AppInfo[];
      selectedIndex: number;
      checked: Set<string>;
    }
  | {
      type: "config-text";
      field: "test" | "lint";
      value: string;
      worktreePath: string;
      apps: AppInfo[];
    }
  | {
      type: "cards";
      worktreePath: string;
      selectedCardIndex: number;
      fullWidth: boolean;
    }
  | {
      type: "confirm-delete";
      worktree: WorktreeInfo;
      worktrees: WorktreeInfo[];
      selectedIndex: number;
    }
  | { type: "add-input"; value: string }
  | { type: "add-run"; name: string }
  | { type: "ready-for-review" };

type Props = { onBack: () => void };

// ─── main component ──────────────────────────────────────────────────────────

const CARD_WIDTH = 32;

export function WorktreeManager({ onBack }: Props) {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const [screen, setScreen] = useState<ManagerScreen>({ type: "loading" });
  const [appOutputs, setAppOutputs] = useState<Record<string, string[]>>({});
  const [claudeScreens, setClaudeScreens] = useState<
    Record<string, ScreenState>
  >({});
  const [prInfo, setPrInfo] = useState<Record<string, PRInfo | null>>({});
  const [ciStatus, setCiStatus] = useState<Record<string, CIStatus>>({});
  const [activeReview, setActiveReview] = useState<WorktreeInfo | null>(null);
  const [reviewStatus, setReviewStatus] = useState<
    Record<string, ReviewStatus | null>
  >({});
  const [reviewHeads, setReviewHeads] = useState<Record<string, string>>({});
  const [globalConfig, setGlobalConfig] = useState<GlobalConfig>({});
  const [scrollOffsets, setScrollOffsets] = useState<Record<string, number>>(
    {},
  );
  const subscribersRef = useRef<Map<string, () => void>>(new Map());

  const subscribeIfNeeded = useCallback((path: string) => {
    if (subscribersRef.current.has(path)) return;
    const unsub = subscribeToSession(path, (state) => {
      setClaudeScreens((prev) => ({ ...prev, [path]: state }));
    });
    subscribersRef.current.set(path, unsub);
  }, []);

  useEffect(() => {
    const subs = subscribersRef.current;
    for (const path of getRunningSessionPaths()) subscribeIfNeeded(path);
    return () => {
      for (const unsub of subs.values()) unsub();
      subs.clear();
    };
  }, [subscribeIfNeeded]);

  useEffect(() => {
    listWorktrees()
      .then((all) => {
        const worktrees = all.filter((w) => !w.isBare);
        setScreen({ type: "list", worktrees, selectedIndex: 0 });
        // Fetch PRs in parallel, updating state as each resolves
        for (const wt of worktrees) {
          void getPRForBranch(wt.branch, wt.path).then((pr) => {
            setPrInfo((prev) => ({ ...prev, [wt.path]: pr }));
          });
          void getCIStatus(wt.branch, wt.path).then((ci) => {
            setCiStatus((prev) => ({ ...prev, [wt.path]: ci }));
          });
          // Clear stale "reviewed" badge if HEAD has moved since the review
          void run("git rev-parse HEAD", { cwd: wt.path })
            .then(({ stdout: head }) => {
              setReviewHeads((rh) => {
                const stored = rh[wt.path];
                if (stored && stored !== head) {
                  setReviewStatus((prev) =>
                    prev[wt.path] === "reviewed"
                      ? { ...prev, [wt.path]: null }
                      : prev,
                  );
                }
                return { ...rh, [wt.path]: head };
              });
            })
            .catch(() => {});
        }
      })
      .catch((err) => setScreen({ type: "error", message: String(err) }));
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

      setScreen({
        type: "cards",
        worktreePath,
        selectedCardIndex: 0,
        fullWidth: false,
      });
    },
    [],
  );

  const handleWorktreeSelect = useCallback(
    async (worktree: WorktreeInfo) => {
      const [cfg, apps] = await Promise.all([
        loadGlobalConfig(),
        discoverApps(worktree.path),
      ]);
      if (cfg.appRelDirs && cfg.appRelDirs.length > 0) {
        const appDirs = cfg.appRelDirs.map((rel) =>
          path.join(worktree.path, rel),
        );
        startApps(worktree.path, appDirs, apps);
        return;
      }
      if (apps.length === 0) {
        // No workspace apps found — start whole worktree
        startApps(
          worktree.path,
          [worktree.path],
          [{ name: path.basename(worktree.path), dir: worktree.path }],
        );
        return;
      }
      setGlobalConfig(cfg);
      setScreen({
        type: "config-menu",
        worktreePath: worktree.path,
        apps,
        selectedIndex: 0,
      });
    },
    [startApps],
  );

  useInput(
    (input, key) => {
      // q quits everywhere except cards (PTY input), add-input (text input), config-text, and ready-for-review
      if (
        input === "q" &&
        screen.type !== "cards" &&
        screen.type !== "add-input" &&
        screen.type !== "ready-for-review" &&
        screen.type !== "config-text"
      ) {
        killAll();
        killAllSessions();
        killAllChildren();
        exit();
        process.exit(0);
      }

      if (screen.type === "list") {
        const cols = Math.max(
          1,
          Math.floor((stdout?.columns ?? 80) / (CARD_WIDTH + 1)),
        );
        if (key.escape) {
          killAll();
          onBack();
        } else if (key.upArrow) {
          setScreen((s) =>
            s.type === "list"
              ? { ...s, selectedIndex: Math.max(0, s.selectedIndex - cols) }
              : s,
          );
        } else if (key.downArrow) {
          setScreen((s) =>
            s.type === "list"
              ? {
                  ...s,
                  selectedIndex: Math.min(
                    s.worktrees.length - 1,
                    s.selectedIndex + cols,
                  ),
                }
              : s,
          );
        } else if (key.leftArrow) {
          setScreen((s) =>
            s.type === "list"
              ? { ...s, selectedIndex: Math.max(0, s.selectedIndex - 1) }
              : s,
          );
        } else if (key.rightArrow) {
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
          if (wt) {
            void getPrimaryRemote(wt.path).then((remote) => {
              const ref = `${remote ?? "origin"}/main`;
              startSession(
                wt.path,
                process.stdout.columns ?? 80,
                process.stdout.rows ?? 24,
              );
              subscribeIfNeeded(wt.path);
              acknowledgeSession(wt.path);
              requestSession(
                wt.path,
                `Analyse all changes on this branch. Run \`git diff --stat ${ref}\` for committed changes, \`git diff --staged\` for staged changes, and \`git diff\` for unstaged changes. Then give me a concise summary of what has changed.`,
              );
              exit();
            });
          }
        } else if (input === "s") {
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
            void Promise.all([discoverApps(wt.path), loadGlobalConfig()]).then(
              ([apps, cfg]) => {
                setGlobalConfig(cfg);
                setScreen({
                  type: "config-menu",
                  worktreePath: wt.path,
                  apps,
                  selectedIndex: 0,
                });
              },
            );
          }
        } else if (input === "r") {
          const wt = screen.worktrees[screen.selectedIndex];
          if (wt) {
            setActiveReview(wt);
            setScreen({ type: "ready-for-review" });
          }
        } else if (input === "o") {
          const wt = screen.worktrees[screen.selectedIndex];
          if (wt) {
            void (async () => {
              const cwd = wt.path;
              const remote = (await getPrimaryRemote(cwd)) ?? "origin";
              await run(`git fetch ${remote}`, { cwd });
              const [
                { stdout: branchDiff },
                { stdout: staged },
                { stdout: unstaged },
              ] = await Promise.all([
                run(`git diff --name-only ${remote}/main...HEAD`, { cwd }),
                run("git diff --cached --name-only", { cwd }),
                run("git diff --name-only", { cwd }),
              ]);
              const files = [
                ...new Set(
                  [
                    ...branchDiff.split("\n"),
                    ...staged.split("\n"),
                    ...unstaged.split("\n"),
                  ].filter(Boolean),
                ),
              ].map((f) => path.join(cwd, f));
              if (files.length > 0) {
                spawn("code", files, {
                  detached: true,
                  stdio: "ignore",
                }).unref();
              }
            })();
          }
        }
      } else if (screen.type === "ready-for-review") {
        if (key.escape) {
          listWorktrees()
            .then((all) => {
              const worktrees = all.filter((w) => !w.isBare);
              setScreen({ type: "list", worktrees, selectedIndex: 0 });
            })
            .catch(() => onBack());
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
            killSession(worktree.path);
            const updated = worktrees.filter((w) => w.path !== worktree.path);
            setScreen({
              type: "list",
              worktrees: updated,
              selectedIndex: Math.min(
                selectedIndex,
                Math.max(0, updated.length - 1),
              ),
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
      } else if (screen.type === "config-menu") {
        if (key.escape) {
          listWorktrees()
            .then((all) => {
              const worktrees = all.filter((w) => !w.isBare);
              setScreen({ type: "list", worktrees, selectedIndex: 0 });
            })
            .catch(() => onBack());
        } else if (key.upArrow) {
          setScreen((s) =>
            s.type === "config-menu"
              ? { ...s, selectedIndex: Math.max(0, s.selectedIndex - 1) }
              : s,
          );
        } else if (key.downArrow) {
          setScreen((s) =>
            s.type === "config-menu"
              ? { ...s, selectedIndex: Math.min(2, s.selectedIndex + 1) }
              : s,
          );
        } else if (key.return) {
          const { worktreePath, apps, selectedIndex } = screen;
          if (selectedIndex === 0) {
            const preChecked = new Set(
              (globalConfig.appRelDirs ?? []).map((rel) =>
                path.join(worktreePath, rel),
              ),
            );
            setScreen({
              type: "config-app-select",
              worktreePath,
              apps,
              selectedIndex: 0,
              checked: preChecked,
            });
          } else if (selectedIndex === 1) {
            setScreen({
              type: "config-text",
              field: "test",
              value: globalConfig.testCommand ?? "",
              worktreePath,
              apps,
            });
          } else {
            setScreen({
              type: "config-text",
              field: "lint",
              value: (globalConfig.lintCommands ?? []).join(", "),
              worktreePath,
              apps,
            });
          }
        }
      } else if (screen.type === "config-app-select") {
        if (key.escape) {
          setScreen({
            type: "config-menu",
            worktreePath: screen.worktreePath,
            apps: screen.apps,
            selectedIndex: 0,
          });
        } else if (key.upArrow) {
          setScreen((s) =>
            s.type === "config-app-select"
              ? { ...s, selectedIndex: Math.max(0, s.selectedIndex - 1) }
              : s,
          );
        } else if (key.downArrow) {
          setScreen((s) =>
            s.type === "config-app-select"
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
            if (s.type !== "config-app-select") return s;
            const app = s.apps[s.selectedIndex];
            if (!app) return s;
            const checked = new Set(s.checked);
            if (checked.has(app.dir)) checked.delete(app.dir);
            else checked.add(app.dir);
            return { ...s, checked };
          });
        } else if (input === "a") {
          setScreen((s) => {
            if (s.type !== "config-app-select") return s;
            const allChecked = s.checked.size === s.apps.length;
            return {
              ...s,
              checked: allChecked
                ? new Set()
                : new Set(s.apps.map((a) => a.dir)),
            };
          });
        } else if (key.return) {
          const appRelDirs = [...screen.checked].map((dir) =>
            path.relative(screen.worktreePath, dir),
          );
          void saveGlobalConfig({ appRelDirs }).then(async () => {
            const cfg = await loadGlobalConfig();
            setGlobalConfig(cfg);
            setScreen({
              type: "config-menu",
              worktreePath: screen.worktreePath,
              apps: screen.apps,
              selectedIndex: 0,
            });
          });
        }
      } else if (screen.type === "config-text") {
        if (key.escape) {
          setScreen({
            type: "config-menu",
            worktreePath: screen.worktreePath,
            apps: screen.apps,
            selectedIndex: screen.field === "test" ? 1 : 2,
          });
        } else if (key.return) {
          const { field, value, worktreePath, apps } = screen;
          const save = async () => {
            if (field === "test") {
              await saveGlobalConfig({
                testCommand: value.trim() || undefined,
              });
            } else {
              const cmds = value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              await saveGlobalConfig({
                lintCommands: cmds.length > 0 ? cmds : undefined,
              });
            }
            const cfg = await loadGlobalConfig();
            setGlobalConfig(cfg);
            setScreen({
              type: "config-menu",
              worktreePath,
              apps,
              selectedIndex: field === "test" ? 1 : 2,
            });
          };
          void save();
        } else if (key.backspace || key.delete) {
          setScreen((s) =>
            s.type === "config-text"
              ? { ...s, value: s.value.slice(0, -1) }
              : s,
          );
        } else if (input && !key.ctrl && !key.meta) {
          setScreen((s) =>
            s.type === "config-text" ? { ...s, value: s.value + input } : s,
          );
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
              ? {
                  ...s,
                  selectedCardIndex: Math.max(0, s.selectedCardIndex - 1),
                }
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
          setScreen((s) =>
            s.type === "cards" ? { ...s, fullWidth: !s.fullWidth } : s,
          );
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

  // renderScreen returns JSX for all screens except ready-for-review (handled via always-mounted below)
  function renderScreen() {
    if (screen.type === "ready-for-review") return null;

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
      const cols = Math.max(
        1,
        Math.floor((stdout?.columns ?? 80) / (CARD_WIDTH + 1)),
      );
      const rows: WorktreeInfo[][] = [];
      for (let i = 0; i < screen.worktrees.length; i += cols) {
        rows.push(screen.worktrees.slice(i, i + cols));
      }
      return (
        <Box flexDirection="column" padding={1} gap={1}>
          <Header />
          <Box flexDirection="column" gap={1}>
            {rows.map((row, rowIdx) => (
              <Box key={rowIdx} flexDirection="row" gap={1}>
                {row.map((wt, colIdx) => {
                  const i = rowIdx * cols + colIdx;
                  const selected = i === screen.selectedIndex;
                  const running = getRunningAppsForWorktree(wt.path).length > 0;
                  const borderColor = selected
                    ? "blue"
                    : running
                      ? "green"
                      : "gray";
                  const hasSession = isSessionRunning(wt.path);
                  const sessionState = claudeScreens[wt.path];
                  const claudeStatus = !hasSession
                    ? null
                    : sessionState?.notified
                      ? "notified"
                      : sessionState?.status === "waiting"
                        ? "waiting"
                        : "idle";
                  const revStatus = reviewStatus[wt.path] ?? null;
                  return (
                    <Box
                      key={wt.path}
                      flexDirection="column"
                      width={CARD_WIDTH}
                      borderStyle="round"
                      borderColor={borderColor}
                      paddingX={1}
                      gap={0}
                    >
                      <Box justifyContent="space-between">
                        <Box flexShrink={1}>
                          <Text bold={selected} wrap="truncate">
                            {wt.branch}
                          </Text>
                        </Box>
                        {prInfo[wt.path] &&
                          (() => {
                            const pr = prInfo[wt.path]!;
                            const ci = ciStatus[wt.path];
                            let prefix = "";
                            if (pr.state === "MERGED") {
                              prefix = "🫂 ";
                            } else {
                              if (ci === "passing") prefix += "✅";
                              else if (ci === "failing") prefix += "❌";
                              else if (ci === "running") prefix += "🟡";
                              prefix += pr.commentCount > 0 ? "💬" : " ";
                            }
                            const label = prefix
                              ? `${prefix} #${pr.number}`
                              : `#${pr.number}`;
                            return (
                              <Box flexShrink={0} marginLeft={1}>
                                <Text color="cyan">
                                  {hyperlink(pr.url, label)}
                                </Text>
                              </Box>
                            );
                          })()}
                      </Box>
                      {running && <Text color="green">● Running</Text>}
                      {claudeStatus === "idle" && (
                        <Text color="green" dimColor>
                          ○ Ready
                        </Text>
                      )}
                      {claudeStatus === "waiting" && (
                        <Text color="yellow">🔔 Awaiting Input</Text>
                      )}
                      {claudeStatus === "notified" && (
                        <Text color="red" bold>
                          ● View Updates
                        </Text>
                      )}
                      {revStatus === "reviewing" && (
                        <Text color="yellow">🟡 (r)eviewing…</Text>
                      )}
                      {revStatus === "needs-input" && (
                        <Text color="yellow">🔔 (r)eview Needs Input</Text>
                      )}
                      {revStatus === "reviewed" && (
                        <Text color="green">✓ (r)eviewed</Text>
                      )}
                    </Box>
                  );
                })}
              </Box>
            ))}
          </Box>
          <Footer hints="↑↓←→ navigate  Enter claude  s start  r review  o open  a add  c config  d delete  Esc back  q quit" />
        </Box>
      );
    }

    if (screen.type === "config-menu") {
      const cfg = globalConfig;
      const appDisplay =
        (cfg.appRelDirs ?? []).length > 0
          ? cfg
              .appRelDirs!.map(
                (rel) =>
                  screen.apps.find(
                    (a) => a.dir === path.join(screen.worktreePath, rel),
                  )?.name ?? rel,
              )
              .join(", ")
          : "(none)";
      const testDisplay = cfg.testCommand || "(not set)";
      const lintDisplay = (cfg.lintCommands ?? []).join(", ") || "(not set)";
      const items = [
        { label: "Apps (s)", value: appDisplay },
        { label: "Test (r)", value: testDisplay },
        { label: "Lint (r)", value: lintDisplay },
      ];
      return (
        <Box flexDirection="column" padding={1} gap={1}>
          <Header sub="config" />
          <Box flexDirection="column" gap={0}>
            {items.map((item, i) => {
              const sel = i === screen.selectedIndex;
              return (
                <Box key={i} gap={2}>
                  <Text color={sel ? "cyan" : undefined} bold={sel}>
                    {sel ? ">" : " "}
                  </Text>
                  <Box width={12}>
                    <Text bold={sel}>{item.label}</Text>
                  </Box>
                  <Text color={sel ? undefined : "gray"}>{item.value}</Text>
                </Box>
              );
            })}
          </Box>
          <Footer hints="↑↓ navigate  Enter edit  Esc back" />
        </Box>
      );
    }

    if (screen.type === "config-app-select") {
      return (
        <Box flexDirection="column" padding={1} gap={1}>
          <Header sub="config / apps (s)" />
          <Box flexDirection="column" gap={0}>
            {screen.apps.map((app, i) => {
              const sel = i === screen.selectedIndex;
              const checked = screen.checked.has(app.dir);
              return (
                <Box key={app.dir} gap={1}>
                  <Text color={sel ? "cyan" : undefined} bold={sel}>
                    {sel ? ">" : " "}
                  </Text>
                  <Text color={checked ? "green" : "gray"}>
                    {checked ? "[x]" : "[ ]"}
                  </Text>
                  <Text bold={sel}>{app.name}</Text>
                </Box>
              );
            })}
          </Box>
          <Footer hints="↑↓ navigate  Space toggle  a all  Enter save  Esc back" />
        </Box>
      );
    }

    if (screen.type === "config-text") {
      const label =
        screen.field === "test" ? "test command (r)" : "lint commands (r)";
      const hint = screen.field === "lint" ? "comma-separated  " : "";
      return (
        <Box flexDirection="column" padding={1} gap={1}>
          <Header sub={`config / ${label}`} />
          <Box gap={0}>
            <Text color="cyan">{screen.value}</Text>
            <Text inverse> </Text>
          </Box>
          <Footer hints={`${hint}Enter save  Esc cancel`} />
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
              This will remove the worktree directory and delete the branch from
              git.
            </Text>
            <Box gap={1}>
              <Text color="red" bold>
                [y]
              </Text>
              <Text>Yes, delete it</Text>
              <Text dimColor> </Text>
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
    if (screen.type !== "cards") return null;
    const runningApps = getRunningAppsForWorktree(screen.worktreePath);
    const focusedApp = runningApps[screen.selectedCardIndex];
    return (
      <Box flexDirection="column" padding={1} gap={1}>
        <Header sub={path.basename(screen.worktreePath)} />
        {runningApps.length === 0 ? (
          <Text dimColor>Starting apps…</Text>
        ) : screen.fullWidth ? (
          <>
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
            {focusedApp &&
              (() => {
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
                      <Text bold color="cyan">
                        {displayName}
                      </Text>
                      <Text color={running ? "green" : "red"}>
                        {running ? "●" : "✗"}
                      </Text>
                      {offset > 0 && <Text dimColor>↑ scrolled</Text>}
                    </Box>
                    {hasMore && <Text dimColor> ↑ more above</Text>}
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
                  {hasMore && <Text dimColor> ↑ more above</Text>}
                  {visibleLines.length === 0 ? (
                    <Text dimColor>waiting for output…</Text>
                  ) : (
                    visibleLines.map((line, idx) => (
                      <Text key={idx} wrap="truncate">
                        {line}
                      </Text>
                    ))
                  )}
                </Box>
              );
            })}
          </Box>
        )}
        <Footer
          hints={`←→ switch card  ↑↓ scroll  f ${screen.fullWidth ? "side-by-side" : "full-width"}  Esc back`}
        />
      </Box>
    );
  }

  // ReadyForReview is always mounted when active so its state survives navigation.
  // renderScreen() returns null for "ready-for-review", keeping display clean.
  return (
    <>
      {activeReview !== null && (
        <ReadyForReview
          worktree={activeReview}
          isVisible={screen.type === "ready-for-review"}
          onStatusChange={(status) => {
            setReviewStatus((prev) => ({
              ...prev,
              [activeReview.path]: status,
            }));
            if (status === "reviewed") {
              void run("git rev-parse HEAD", { cwd: activeReview.path })
                .then(({ stdout: head }) => {
                  setReviewHeads((prev) => ({
                    ...prev,
                    [activeReview.path]: head,
                  }));
                })
                .catch(() => {});
            }
          }}
          onPRChange={() => {
            const wt = activeReview;
            void getPRForBranch(wt.branch, wt.path).then((pr) => {
              setPrInfo((prev) => ({ ...prev, [wt.path]: pr }));
            });
          }}
          onDone={() => {
            const wt = activeReview;
            setActiveReview(null);
            void getPRForBranch(wt.branch, wt.path).then((pr) => {
              setPrInfo((prev) => ({ ...prev, [wt.path]: pr }));
            });
            void getCIStatus(wt.branch, wt.path).then((ci) => {
              setCiStatus((prev) => ({ ...prev, [wt.path]: ci }));
            });
            listWorktrees()
              .then((all) => {
                const worktrees = all.filter((w) => !w.isBare);
                setScreen({ type: "list", worktrees, selectedIndex: 0 });
              })
              .catch(() => onBack());
          }}
        />
      )}
      {renderScreen()}
    </>
  );
}

const VISIBLE_LINES = 40;

// ─── key forwarding ──────────────────────────────────────────────────────────

type InkKey = Parameters<Parameters<typeof useInput>[0]>[1];

function keyToRaw(input: string, key: InkKey): string | null {
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
