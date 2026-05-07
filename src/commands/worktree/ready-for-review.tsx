import { mkdir, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { WorktreeInfo } from "../../utils/worktree.js";
import { Box, Text, useInput, useStdin, useStdout } from "ink";
import { useEffect, useReducer, useRef, useState } from "react";

import { Footer } from "../../components/Footer.js";
import {
  loadGlobalConfig,
  saveGlobalConfig,
} from "../../utils/armchair-config.js";
import { claudeRun } from "../../utils/claude-run.js";
import { run, runLines, stripAnsi } from "../../utils/exec.js";
import { getPrimaryRemote } from "../../utils/worktree.js";

// ─── types ───────────────────────────────────────────────────────────────────

type StepStatus =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "skipped"
  | "waiting";

type StepState = {
  label: string;
  status: StepStatus;
  detail?: string;
  outputLines?: string[];
};

type Phase =
  | { type: "running" }
  | { type: "done"; prUrl?: string }
  | { type: "error"; message: string };

type ReviewFinding = {
  id: number;
  severity: "high" | "medium" | "low";
  file: string;
  line?: number;
  description: string;
  howToFix: string;
};

type PendingInput =
  | { type: "keys"; prompt: string; options: { key: string; label: string }[] }
  | {
      type: "multiselect";
      prompt: string;
      items: ReviewFinding[];
      checked: Set<number>;
      selectedIndex: number;
    }
  | { type: "text-input"; prompt: string; value: string };

export type ReviewStatus = "reviewing" | "needs-input" | "reviewed";

type Props = {
  worktree: WorktreeInfo;
  isVisible: boolean;
  onDone: () => void;
  onStatusChange: (status: ReviewStatus | null) => void;
  onPRChange?: () => void;
};

// ─── helpers ─────────────────────────────────────────────────────────────────

function stepIcon(status: StepStatus): string {
  if (status === "running" || status === "waiting") return "●";
  if (status === "done") return "✓";
  if (status === "error") return "✗";
  if (status === "skipped") return "–";
  return "○";
}

function stepColor(
  status: StepStatus,
): "blue" | "yellow" | "green" | "red" | "gray" {
  if (status === "running") return "blue";
  if (status === "waiting") return "yellow";
  if (status === "done") return "green";
  if (status === "error") return "red";
  if (status === "skipped") return "gray";
  return "gray";
}

async function writeTmp(content: string): Promise<string> {
  const dir = path.join(os.homedir(), ".cache", "armchair");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `tmp-${Date.now()}.txt`);
  await writeFile(file, content);
  return file;
}

// Strip wrapping code fences and surrounding whitespace from an LLM response
// so the commit subject doesn't end up as "```".
function sanitizeCommitMessage(raw: string): string {
  let msg = raw.replace(/\r\n/g, "\n").trim();
  // Remove a single fenced block wrapping the entire message
  // (```optional-lang\n…\n```)
  const fenceMatch = msg.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fenceMatch) msg = fenceMatch[1]!.trim();
  // Defensively strip any stray fence lines that remain
  msg = msg
    .split("\n")
    .filter((line) => !/^\s*```[a-zA-Z0-9_-]*\s*$/.test(line))
    .join("\n")
    .trim();
  return msg;
}

// ─── pipeline store ──────────────────────────────────────────────────────────
// State lives at module level so it survives Ink unmount/remount cycles (e.g.
// when the user enters a passthrough session and returns to the manager).

type PipelineStore = {
  worktree: WorktreeInfo;
  steps: StepState[];
  phase: Phase;
  pendingInput: PendingInput | null;
  executing: boolean;
  resolveInput: ((key: string) => void) | null;
  resolveMultiselect: ((ids: number[]) => void) | null;
  resolveTextInput: ((value: string) => void) | null;
  onPRChangeRef: { current: (() => void) | undefined };
  subscribers: Set<() => void>;
};

const pipelineStores = new Map<string, PipelineStore>();

function getOrCreateStore(worktree: WorktreeInfo): PipelineStore {
  if (!pipelineStores.has(worktree.path)) {
    pipelineStores.set(worktree.path, {
      worktree,
      steps: INITIAL_STEPS.map((s) => ({ ...s })),
      phase: { type: "running" },
      pendingInput: null,
      executing: false,
      resolveInput: null,
      resolveMultiselect: null,
      resolveTextInput: null,
      onPRChangeRef: { current: undefined },
      subscribers: new Set(),
    });
  }
  return pipelineStores.get(worktree.path)!;
}

function notifyStore(path: string): void {
  const store = pipelineStores.get(path);
  if (store) for (const sub of store.subscribers) sub();
}

function pipelineUpdateStep(path: string, i: number, patch: Partial<StepState>): void {
  const store = pipelineStores.get(path);
  if (!store) return;
  store.steps = store.steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s));
  notifyStore(path);
}

function pipelineAppendOutput(path: string, i: number, line: string): void {
  const store = pipelineStores.get(path);
  if (!store) return;
  store.steps = store.steps.map((s, idx) =>
    idx === i
      ? { ...s, outputLines: [...(s.outputLines ?? []).slice(-49), line] }
      : s,
  );
  notifyStore(path);
}

function pipelineSetPhase(path: string, phase: Phase): void {
  const store = pipelineStores.get(path);
  if (!store) return;
  store.phase = phase;
  if (phase.type !== "running") store.executing = false;
  notifyStore(path);
}

function pipelineSetPendingInput(path: string, input: PendingInput | null): void {
  const store = pipelineStores.get(path);
  if (!store) return;
  store.pendingInput = input;
  notifyStore(path);
}

function killPipeline(path: string): void {
  const store = pipelineStores.get(path);
  if (!store) return;
  // Unblock pending user-input promises so the async chain drains cleanly
  const { resolveInput, resolveMultiselect, resolveTextInput } = store;
  store.resolveInput = null;
  store.resolveMultiselect = null;
  store.resolveTextInput = null;
  resolveInput?.("__killed__");
  resolveMultiselect?.([]);
  resolveTextInput?.("");
  store.phase = { type: "error", message: "Cancelled" };
  store.pendingInput = null;
  store.executing = false;
  notifyStore(path);
  // Remove store so the remaining async work drains as no-ops and next 'r' starts fresh
  pipelineStores.delete(path);
}

function pipelineAskUser(
  path: string,
  prompt: string,
  options: { key: string; label: string }[],
): Promise<string> {
  return new Promise((resolve) => {
    const store = pipelineStores.get(path)!;
    store.resolveInput = resolve;
    pipelineSetPendingInput(path, { type: "keys", prompt, options });
  });
}

function pipelineAskMultiselect(path: string, prompt: string, items: ReviewFinding[]): Promise<number[]> {
  return new Promise((resolve) => {
    const store = pipelineStores.get(path)!;
    store.resolveMultiselect = resolve;
    const preChecked = new Set(items.filter((f) => f.severity === "high").map((f) => f.id));
    pipelineSetPendingInput(path, {
      type: "multiselect",
      prompt,
      items,
      checked: preChecked,
      selectedIndex: 0,
    });
  });
}

function pipelineAskTextInput(path: string, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const store = pipelineStores.get(path)!;
    store.resolveTextInput = resolve;
    pipelineSetPendingInput(path, { type: "text-input", prompt, value: "" });
  });
}

// ─── pipeline runner (module-level so it outlives component unmounts) ────────

async function runPipeline(path: string): Promise<void> {
  const store = pipelineStores.get(path)!;
  const cwd = path;
  const updateStep = (i: number, patch: Partial<StepState>) => pipelineUpdateStep(path, i, patch);
  const appendOutput = (i: number, line: string) => pipelineAppendOutput(path, i, line);
  const setPhase = (p: Phase) => pipelineSetPhase(path, p);
  const askUser = (prompt: string, options: { key: string; label: string }[]) =>
    pipelineAskUser(path, prompt, options);
  const askMultiselect = (prompt: string, items: ReviewFinding[]) =>
    pipelineAskMultiselect(path, prompt, items);
  const askTextInput = (prompt: string) => pipelineAskTextInput(path, prompt);

    // ── step 0: rebase ──────────────────────────────────────────────────────
    updateStep(0, { status: "running" });
    try {
      const remote = (await getPrimaryRemote(cwd)) ?? "origin";
      updateStep(0, { label: `Fetching from ${remote}`, status: "running" });
      await runLines(`git fetch ${remote}`, { cwd }, (l) => appendOutput(0, l));
      updateStep(0, {
        label: `Rebasing onto ${remote}/main`,
        status: "running",
      });

      // Commit any unstaged/untracked changes so the rebase has a clean working tree
      const { stdout: statusOut } = await run("git status --porcelain", {
        cwd,
      });
      if (statusOut.trim()) {
        updateStep(0, {
          label: "Committing uncommitted changes before rebase",
          status: "running",
        });
        await run("git add -A", { cwd });
        await run(`git commit -m "wip: pre-rebase checkpoint [armchair]"`, {
          cwd,
        });
      }

      let rebased = false;
      try {
        await runLines(`git rebase ${remote}/main`, { cwd }, (l) =>
          appendOutput(0, l),
        );
        rebased = true;
      } catch {
        // conflict — let claude resolve
        for (let attempt = 1; attempt <= 3 && !rebased; attempt++) {
          updateStep(0, {
            label: `Resolving conflicts (attempt ${attempt}/3)`,
            status: "running",
          });
          await claudeRun(
            `You are in git worktree ${cwd} in the middle of a rebase conflict.
1. Run git status to identify conflicted files.
2. Read each conflicted file.
3. Resolve all conflicts using best judgment — keep the intent of both sides.
4. Stage resolved files with git add.
5. Run git rebase --continue.
Repeat until the rebase completes. Do not abort.`,
            cwd,
            (l) => appendOutput(0, l),
          );
          const { stdout } = await run("git status", { cwd });
          if (!stdout.includes("rebase")) rebased = true;
        }
        if (!rebased) {
          await run("git rebase --abort", { cwd }).catch(() => {});
          throw new Error("Rebase failed after 3 attempts — aborted");
        }
      }
      updateStep(0, { label: `Rebased onto ${remote}/main`, status: "done" });
    } catch (err) {
      updateStep(0, { status: "error", detail: String(err) });
      setPhase({ type: "error", message: String(err) });
      return;
    }

    // ── step 1: review ──────────────────────────────────────────────────────
    updateStep(1, { status: "running" });
    try {
      const remote = (await getPrimaryRemote(cwd)) ?? "origin";

      // Human-readable review — streams to outputLines
      const reviewText = await claudeRun(
        `Get the diff: git diff ${remote}/main...HEAD -- . ':(exclude)pnpm-lock.yaml'
Get the list of changed files: git diff --name-only ${remote}/main...HEAD

For each changed file, read the full file if it is small (< 200 lines); otherwise read only the changed sections.

Look for:
- Bugs, logic errors, off-by-one errors
- Security issues (injection, unvalidated input at system boundaries, hardcoded secrets)
- CLAUDE.md violations
- N+1 queries or missing relations
- Missing input validation
- Missing loading states

Classify each finding:
- high — must fix before proceeding (bug, security, hard rule)
- medium — should fix (code smell, style)
- low — informational only

Present all findings grouped by severity. For each include: file path, line number if applicable, description, and how to fix it.`,
        cwd,
        (l) => appendOutput(1, l),
      );

      // Extract structured findings
      updateStep(1, { label: "Parsing review findings…", status: "running" });
      const jsonText = await claudeRun(
        `Extract the code review findings below into JSON. Return ONLY valid JSON, no other text.

Schema: {"findings":[{"id":1,"severity":"high"|"medium"|"low","file":"path/to/file.ts","line":42,"description":"what is wrong","howToFix":"exact fix needed"}]}

If there are no findings return: {"findings":[]}

Review:
${reviewText}`,
        cwd,
      );

      let findings: ReviewFinding[] = [];
      try {
        // Strip markdown code fences if Claude wrapped the response
        const stripped = jsonText
          .trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/, "");
        // Extract the first JSON object in case there's surrounding text
        const match = stripped.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(match ? match[0] : stripped) as {
          findings: ReviewFinding[];
        };
        findings = parsed.findings ?? [];
      } catch {
        updateStep(1, {
          label: "Could not parse review findings — check output",
          status: "error",
        });
        setPhase({
          type: "error",
          message: "JSON parse failed on review output",
        });
        return;
      }

      if (findings.length === 0) {
        updateStep(1, { label: "AI review — no issues found", status: "done" });
      } else {
        updateStep(1, {
          label: `${findings.length} issue(s) found — select fixes`,
          status: "waiting",
        });
        const selectedIds = await askMultiselect(
          `Select issues to fix (${findings.length} found)`,
          findings,
        );

        if (selectedIds.length === 0) {
          updateStep(1, {
            label: "AI review complete — no fixes selected",
            status: "done",
          });
        } else {
          const selected = findings.filter((f) => selectedIds.includes(f.id));

          // Parallel fix agents — each describes the fix without applying it
          updateStep(1, {
            label: `Running ${selected.length} fix agent(s) in parallel…`,
            status: "running",
          });
          const suggestions = await Promise.all(
            selected.map(
              async ({ id, severity, file, line, description, howToFix }) => {
                const suggestion = await claudeRun(
                  `You are a focused fix-analysis agent. Describe the exact change needed for ONE issue. Do NOT modify any files yet.

Issue #${id} (${severity})
File: ${file}${line ? `\nLine: ${line}` : ""}
Problem: ${description}
Approach: ${howToFix}

Read the file, then respond in exactly this format:
FILE: <path>
BEFORE: <exact lines to replace>
AFTER: <replacement lines>
REASON: <one sentence>`,
                  cwd,
                  (l) => appendOutput(1, l),
                );
                return { id, suggestion };
              },
            ),
          );

          // Orchestration agent merges all suggestions and applies them
          updateStep(1, {
            label: "Orchestrating and applying fixes…",
            status: "running",
          });
          const suggestionBlock = suggestions
            .map(({ id, suggestion }) => `=== Fix #${id} ===\n${suggestion}`)
            .join("\n\n");

          await claudeRun(
            `You are an orchestration agent. Apply all of the following fix specifications to the actual files.

Rules:
- Apply every fix
- If two fixes touch the same region and conflict, apply the one for the higher-severity issue
- Ensure the result is syntactically valid
- Do not add explanatory comments

${suggestionBlock}`,
            cwd,
            (l) => appendOutput(1, l),
          );

          updateStep(1, {
            label: `Applied ${selected.length} fix(es)`,
            status: "done",
          });
        }
      }
    } catch (err) {
      updateStep(1, { status: "error", detail: String(err) });
      setPhase({ type: "error", message: String(err) });
      return;
    }

    // ── steps 2, 3, 4: tests / docs / linters (parallel) ────────────────────
    // Pre-flight: resolve unconfigured commands sequentially before fanning out,
    // since both use askTextInput and can't overlap.
    let testCmd: string | undefined;
    {
      const cfg = await loadGlobalConfig();
      testCmd = cfg.testCommand;
      if (!testCmd) {
        updateStep(2, { label: "Test command not configured", status: "waiting" });
        const input = await askTextInput("Enter the test command (e.g. pnpm test):");
        if (input) {
          testCmd = input;
          await saveGlobalConfig({ testCommand: input });
        } else {
          updateStep(2, { label: "Tests skipped", status: "skipped" });
        }
      }
    }

    let lintCmds: string[];
    {
      const cfg = await loadGlobalConfig();
      lintCmds = cfg.lintCommands ?? [];
      if (lintCmds.length === 0) {
        updateStep(4, { label: "Lint commands not configured", status: "waiting" });
        const input = await askTextInput(
          "Enter lint commands, comma-separated (e.g. pnpm lint, pnpm typecheck):",
        );
        if (input) {
          lintCmds = input.split(",").map((s) => s.trim()).filter(Boolean);
          await saveGlobalConfig({ lintCommands: lintCmds });
        } else {
          updateStep(4, { label: "Lint skipped", status: "skipped" });
        }
      }
    }

    const runTests = async () => {
      if (!testCmd) return;
      updateStep(2, { label: `Running ${testCmd}`, status: "running" });
      try {
        let testsPassed = false;
        for (let attempt = 0; attempt < 3 && !testsPassed; attempt++) {
          try {
            await runLines(testCmd, { cwd }, (l) => appendOutput(2, l));
            testsPassed = true;
          } catch (testErr) {
            if (attempt === 2) throw testErr;
            const rawOutput = stripAnsi(String(testErr));
            updateStep(2, {
              label: `Fixing tests (attempt ${attempt + 1}/3)`,
              status: "running",
            });
            const diagnosis = await claudeRun(
              `The test command '${testCmd}' exited with a non-zero code. Output:

${rawOutput}

First determine if tests are actually failing or if the exit is spurious (all tests passed but the runner exited non-zero due to coverage thresholds, post-test hooks, etc.).

If all tests are passing respond with exactly: TESTS_PASSING
If tests are genuinely failing, fix the source code or tests. Only modify test files if the test itself is wrong. Run the tests after fixing to confirm they pass.`,
              cwd,
              (l) => appendOutput(2, l),
            );
            if (diagnosis.includes("TESTS_PASSING")) {
              testsPassed = true;
            } else {
              updateStep(2, { label: `Re-running ${testCmd}`, status: "running" });
            }
          }
        }
        updateStep(2, { label: "Tests passed", status: "done" });
      } catch (err) {
        updateStep(2, { status: "error", detail: String(err) });
        throw err;
      }
    };

    const runDocs = async () => {
      updateStep(3, { status: "running" });
      try {
        const remote = (await getPrimaryRemote(cwd)) ?? "origin";
        const docAnalysis = await claudeRun(
          `Get the list of changed files: git diff --name-only ${remote}/main...HEAD

For each changed file check:
- Is there a corresponding entry within docs/?
- Are there any JSDoc/TSDoc comments on exported functions that are now stale?
- Are there any README or setup docs that reference changed behaviour?

If no gaps are found, respond with exactly: NO_GAPS

If gaps exist, list them with specific file paths and what needs updating. Be concise.`,
          cwd,
          (l) => appendOutput(3, l),
        );

        if (docAnalysis.includes("NO_GAPS")) {
          updateStep(3, { label: "Documentation up to date", status: "done" });
        } else {
          updateStep(3, {
            status: "waiting",
            outputLines: docAnalysis.split("\n").slice(0, 20),
          });
          const choice = await askUser(
            "Documentation gaps found. Which source is correct?",
            [
              { key: "c", label: "c — code is correct, update the docs" },
              { key: "d", label: "d — docs are correct, update the code" },
              { key: "s", label: "s — skip documentation step" },
            ],
          );

          if (choice === "s") {
            updateStep(3, { label: "Documentation skipped", status: "skipped" });
          } else {
            updateStep(3, { label: "Updating documentation…", status: "running" });
            await claudeRun(
              `Update the documentation based on the user's decision.
User says: ${choice === "c" ? "the code is correct — update the docs to match the code" : "the docs are correct — update the code to match the docs"}.

Gaps identified:
${docAnalysis}

Apply the changes now.`,
              cwd,
              (l) => appendOutput(3, l),
            );

            updateStep(3, { status: "waiting" });
            const approval = await askUser("Approve documentation changes?", [
              { key: "y", label: "y — approve and continue" },
              { key: "n", label: "n — revert doc changes" },
            ]);

            if (approval === "n") {
              await run(`git checkout -- .`, { cwd });
              updateStep(3, { label: "Doc changes reverted", status: "skipped" });
            } else {
              updateStep(3, { label: "Documentation updated", status: "done" });
            }
          }
        }
      } catch (err) {
        updateStep(3, { status: "error", detail: String(err) });
        throw err;
      }
    };

    const runLint = async () => {
      if (lintCmds.length === 0) return;
      try {
        for (const lintCmd of lintCmds) {
          updateStep(4, { label: `Running ${lintCmd}`, status: "running" });
          let passed = false;
          for (let attempt = 0; attempt < 3 && !passed; attempt++) {
            try {
              await runLines(lintCmd, { cwd }, (l) => appendOutput(4, l));
              passed = true;
            } catch (lintErr) {
              if (attempt === 2)
                throw new Error(
                  `${lintCmd} failed after 3 attempts:\n${stripAnsi(String(lintErr))}`,
                );
              updateStep(4, {
                label: `Fixing lint errors (attempt ${attempt + 1}/3)`,
                status: "running",
              });
              await claudeRun(
                `The linter failed with this output:

${stripAnsi(String(lintErr))}

Fix the issues. Do not add eslint-disable comments unless it is a genuine false positive — if you do, explain why in the comment. Re-run the command after fixing.`,
                cwd,
                (l) => appendOutput(4, l),
              );
              updateStep(4, { label: `Re-running ${lintCmd}`, status: "running" });
            }
          }
        }
        updateStep(4, { label: "All linters passed", status: "done" });
      } catch (err) {
        updateStep(4, { status: "error", detail: String(err) });
        throw err;
      }
    };

    const parallelResults = await Promise.allSettled([runTests(), runDocs(), runLint()]);
    const firstFailure = parallelResults.find((r) => r.status === "rejected");
    if (firstFailure) {
      setPhase({ type: "error", message: String((firstFailure as PromiseRejectedResult).reason) });
      return;
    }

    // ── step 5: squash + commit + push ──────────────────────────────────────
    updateStep(5, { status: "running" });
    try {
      const remote = (await getPrimaryRemote(cwd)) ?? "origin";
      await run("git add -A", { cwd });

      const { stdout: branchDiff } = await run(`git diff ${remote}/main`, {
        cwd,
      });

      if (!branchDiff.trim()) {
        updateStep(5, { label: "Nothing to commit", status: "skipped" });
      } else {
        updateStep(5, {
          label: "Writing squashed commit message…",
          status: "running",
        });
        const rawMsg = await claudeRun(
          `Write a git commit message for the full set of changes on this branch.

Format:
- Line 1: a concise subject (≤ 72 chars, imperative mood, no trailing period). Follow conventional commits if appropriate.
- Line 2: blank
- Lines 3+: a body describing what changed and why, wrapped at ~72 chars per line.

Output rules — these are strict:
- Output the raw commit message text only.
- Do NOT wrap the message in triple backticks, single backticks, quotes, or any other code fence.
- Do NOT prefix with "Subject:", "Title:", "Body:", or any commentary.
- The very first character of your reply must be the first character of the subject line.

Diff:
${branchDiff}`,
          cwd,
        );
        const msg = sanitizeCommitMessage(rawMsg);
        if (!msg) {
          throw new Error("Claude returned an empty commit message");
        }

        // Reset to main keeping everything staged, then commit as one.
        await run(`git reset --soft ${remote}/main`, { cwd });
        const msgFile = await writeTmp(msg);
        try {
          await run(`git commit -F ${msgFile}`, { cwd });
        } finally {
          await unlink(msgFile).catch(() => {});
        }

        updateStep(5, { label: "Pushing to origin…", status: "running" });
        await runLines(
          `git push --force-with-lease ${remote} HEAD`,
          { cwd },
          (l) => appendOutput(5, l),
        );
        updateStep(5, { label: "Squashed & pushed", status: "done" });
      }
    } catch (err) {
      updateStep(5, { status: "error", detail: String(err) });
      setPhase({ type: "error", message: String(err) });
      return;
    }

    // ── step 6: open / update PR ────────────────────────────────────────────
    updateStep(6, { status: "running" });
    let prUrl = "";
    try {
      let existingPr: { number: number; url: string; body: string } | null =
        null;
      try {
        const { stdout } = await run("gh pr view --json number,url,body", {
          cwd,
        });
        existingPr = JSON.parse(stdout) as typeof existingPr;
      } catch {
        // no existing PR
      }

      if (!existingPr) {
        updateStep(6, { label: "Creating PR…", status: "running" });
        const { stdout } = await run(
          `gh pr create --base main --fill --draft`,
          { cwd },
        );
        prUrl = stdout.trim().split("\n").pop() ?? "";
        updateStep(6, {
          label: `Draft PR opened — ${prUrl}`,
          status: "done",
        });
        store.onPRChangeRef.current?.();
      } else {
        prUrl = existingPr.url;
        store.onPRChangeRef.current?.();
        updateStep(6, {
          label: "Reviewing PR description…",
          status: "running",
        });
        const { stdout: log } = await run("git log --oneline -10", { cwd });
        const suggestion = await claudeRun(
          `Review this PR description against the current branch changes. If it accurately reflects what the PR does, return exactly: NO_CHANGES

If improvements are needed, return the complete updated PR body in markdown.

Output rules — these are strict:
- Output the updated PR body only. No preamble, no analysis, no commentary.
- Do NOT prefix with any explanation of what changed or why.
- The very first character of your reply must be the first character of the PR body.

Current description:
${existingPr.body}

Recent commits:
${log}`,
          cwd,
          (l) => appendOutput(6, l),
        );

        if (!suggestion.includes("NO_CHANGES")) {
          const bodyFile = await writeTmp(suggestion);
          try {
            await run(`gh pr edit --body-file ${bodyFile}`, { cwd });
          } finally {
            await unlink(bodyFile).catch(() => {});
          }
          updateStep(6, { label: "PR description updated", status: "done" });
        } else {
          updateStep(6, { label: "PR description looks good", status: "done" });
        }
      }
    } catch (err) {
      updateStep(6, { status: "error", detail: String(err) });
      setPhase({ type: "error", message: String(err) });
      return;
    }

    setPhase({ type: "done", prUrl });
}

// ─── component ───────────────────────────────────────────────────────────────

const INITIAL_STEPS: StepState[] = [
  { label: "Rebase onto main", status: "pending" },
  { label: "AI code review", status: "pending" },
  { label: "Run tests", status: "pending" },
  { label: "Check documentation", status: "pending" },
  { label: "Run linters", status: "pending" },
  { label: "Commit & push", status: "pending" },
  { label: "Open / update PR", status: "pending" },
];

export function ReadyForReview({
  worktree,
  isVisible,
  onDone,
  onStatusChange,
  onPRChange,
}: Props) {
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const path = worktree.path;

  // Ensure store exists and keep the PR-change callback current
  const store = getOrCreateStore(worktree);
  store.onPRChangeRef.current = onPRChange;

  // Force re-render whenever the store notifies
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    store.subscribers.add(rerender);
    rerender();
    return () => { store.subscribers.delete(rerender); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const { steps, phase, pendingInput } = store;

  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  // Report review status to the parent grid whenever it changes
  useEffect(() => {
    const status: ReviewStatus | null =
      phase.type === "done"
        ? "reviewed"
        : phase.type === "error"
          ? null
          : pendingInput?.type === "multiselect"
            ? "needs-input"
            : "reviewing";
    onStatusChangeRef.current(status);
    // onStatusChangeRef is a ref — intentionally omitted from deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.type, pendingInput?.type]);

  // Keep the multiselect cursor within the visible scroll window
  const termRows = stdout?.rows ?? 24;
  const maxVisibleItems = Math.max(3, Math.floor((termRows - 22) / 3));
  const [multiselectScrollOffset, setMultiselectScrollOffset] = useState(0);
  const multiselectSelectedIndex =
    pendingInput?.type === "multiselect" ? pendingInput.selectedIndex : -1;
  useEffect(() => {
    if (multiselectSelectedIndex < 0) return;
    setMultiselectScrollOffset((prev) => {
      if (multiselectSelectedIndex < prev) return multiselectSelectedIndex;
      if (multiselectSelectedIndex >= prev + maxVisibleItems) {
        return multiselectSelectedIndex - maxVisibleItems + 1;
      }
      return prev;
    });
  }, [multiselectSelectedIndex, maxVisibleItems]);

  useInput(
    (input, key) => {
      if (input === "k" && phase.type === "running") {
        killPipeline(path);
        return;
      }
      if (pendingInput?.type === "multiselect") {
        if (key.upArrow) {
          pipelineSetPendingInput(path, pendingInput.type === "multiselect"
            ? { ...pendingInput, selectedIndex: Math.max(0, pendingInput.selectedIndex - 1) }
            : pendingInput);
        } else if (key.downArrow) {
          pipelineSetPendingInput(path, pendingInput.type === "multiselect"
            ? { ...pendingInput, selectedIndex: Math.min(pendingInput.items.length - 1, pendingInput.selectedIndex + 1) }
            : pendingInput);
        } else if (input === " ") {
          if (pendingInput.type === "multiselect") {
            const id = pendingInput.items[pendingInput.selectedIndex]?.id;
            if (id !== undefined) {
              const checked = new Set(pendingInput.checked);
              if (checked.has(id)) checked.delete(id); else checked.add(id);
              pipelineSetPendingInput(path, { ...pendingInput, checked });
            }
          }
        } else if (input === "a") {
          if (pendingInput.type === "multiselect") {
            const allSelected = pendingInput.checked.size === pendingInput.items.length;
            pipelineSetPendingInput(path, {
              ...pendingInput,
              checked: allSelected ? new Set() : new Set(pendingInput.items.map((i) => i.id)),
            });
          }
        } else if (key.return) {
          const resolve = store.resolveMultiselect;
          const ids = pendingInput.type === "multiselect" ? [...pendingInput.checked] : [];
          store.resolveMultiselect = null;
          pipelineSetPendingInput(path, null);
          resolve?.(ids);
        }
        return;
      }
      if (pendingInput?.type === "text-input") {
        if (key.return) {
          const resolve = store.resolveTextInput;
          const value = pendingInput.value;
          store.resolveTextInput = null;
          pipelineSetPendingInput(path, null);
          resolve?.(value);
        } else if (key.escape) {
          const resolve = store.resolveTextInput;
          store.resolveTextInput = null;
          pipelineSetPendingInput(path, null);
          resolve?.("");
        } else if (key.backspace || key.delete) {
          pipelineSetPendingInput(path, { ...pendingInput, value: pendingInput.value.slice(0, -1) });
        } else if (input && !key.ctrl && !key.meta) {
          pipelineSetPendingInput(path, { ...pendingInput, value: pendingInput.value + input });
        }
        return;
      }
      if (pendingInput?.type === "keys" && store.resolveInput) {
        const opt = pendingInput.options.find((o) => o.key === input);
        if (opt) {
          const resolve = store.resolveInput;
          store.resolveInput = null;
          pipelineSetPendingInput(path, null);
          resolve(opt.key);
        }
        return;
      }
    },
    { isActive: isRawModeSupported === true && isVisible },
  );

  // ─── pipeline ───────────────────────────────────────────────────────────────

  // ─── pipeline ───────────────────────────────────────────────────────────────

  useEffect(() => {
    if (store.executing) return;
    store.executing = true;
    void runPipeline(path).catch((err) =>
      pipelineSetPhase(path, { type: "error", message: String(err) }),
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // ─── end pipeline ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (phase.type === "done" && isVisible) {
      const t = setTimeout(onDone, 2000);
      return () => clearTimeout(t);
    }
  }, [phase.type, isVisible, onDone]);


  // ─── render ────────────────────────────────────────────────────────────────

  if (!isVisible) return null;

  return (
    <Box flexDirection="column" padding={1} gap={1}>
      <Box gap={1}>
        <Text bold color="cyan">
          armchair
        </Text>
        <Text dimColor>— ready for review</Text>
        <Text color="cyan">{worktree.branch}</Text>
      </Box>

      <Box flexDirection="column" gap={0}>
        {steps.map((step, i) => (
          <Box key={i} flexDirection="column">
            <Box gap={1}>
              <Text color={stepColor(step.status)}>
                {stepIcon(step.status)}
              </Text>
              <Text dimColor={step.status === "pending"}>{step.label}</Text>
              {step.detail && <Text color="red"> — {step.detail}</Text>}
            </Box>
            {step.status === "running" &&
              (!step.outputLines || step.outputLines.length === 0) && (
                <Box paddingLeft={2}>
                  <Text dimColor>working…</Text>
                </Box>
              )}
            {step.outputLines &&
              step.outputLines.length > 0 &&
              step.status !== "pending" && (
                <Box flexDirection="column" paddingLeft={2}>
                  {step.outputLines.slice(-10).map((line, j) => (
                    <Text key={j} dimColor wrap="truncate">
                      {line}
                    </Text>
                  ))}
                </Box>
              )}
          </Box>
        ))}
      </Box>

      {pendingInput?.type === "multiselect" &&
        (() => {
          const items = pendingInput.items;
          const start = Math.min(
            multiselectScrollOffset,
            Math.max(0, items.length - maxVisibleItems),
          );
          const end = Math.min(items.length, start + maxVisibleItems);
          const hiddenAbove = start;
          const hiddenBelow = items.length - end;
          const visible = items.slice(start, end);
          return (
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor="yellow"
              paddingX={1}
              gap={0}
            >
              <Text color="yellow">{pendingInput.prompt}</Text>
              {hiddenAbove > 0 && (
                <Text dimColor>↑ {hiddenAbove} more above</Text>
              )}
              <Box flexDirection="column">
                {visible.map((item, visibleIdx) => {
                  const idx = start + visibleIdx;
                  const sel = idx === pendingInput.selectedIndex;
                  const checked = pendingInput.checked.has(item.id);
                  const sevColor =
                    item.severity === "high"
                      ? "red"
                      : item.severity === "medium"
                        ? "yellow"
                        : "gray";
                  return (
                    <Box key={item.id} gap={1}>
                      <Box width={1} flexShrink={0}>
                        <Text color={sel ? "cyan" : undefined} bold={sel}>
                          {sel ? ">" : " "}
                        </Text>
                      </Box>
                      <Box width={3} flexShrink={0}>
                        <Text color={checked ? "green" : "gray"}>
                          {checked ? "[x]" : "[ ]"}
                        </Text>
                      </Box>
                      <Box width={6} flexShrink={0}>
                        <Text color={sevColor}>{item.severity}</Text>
                      </Box>
                      <Box flexGrow={1} flexShrink={1} flexDirection="column">
                        <Text>{item.description}</Text>
                        <Text dimColor wrap="truncate-middle">
                          {item.file}
                          {item.line ? `:${item.line}` : ""}
                        </Text>
                      </Box>
                    </Box>
                  );
                })}
              </Box>
              {hiddenBelow > 0 && (
                <Text dimColor>↓ {hiddenBelow} more below</Text>
              )}
              <Text dimColor>
                ↑↓ navigate Space toggle a toggle all Enter confirm
              </Text>
            </Box>
          );
        })()}

      {pendingInput?.type === "keys" && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          gap={0}
        >
          <Text color="yellow">{pendingInput.prompt}</Text>
          <Box gap={3}>
            {pendingInput.options.map((o) => (
              <Box key={o.key} gap={1}>
                <Text color="cyan" bold>
                  {o.key}
                </Text>
                <Text>{o.label.replace(/^[a-z] — /, "")}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {pendingInput?.type === "text-input" && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          gap={0}
        >
          <Text color="yellow">{pendingInput.prompt}</Text>
          <Box gap={0}>
            <Text color="cyan">{pendingInput.value}</Text>
            <Text inverse> </Text>
          </Box>
          <Text dimColor>Enter to save Esc to skip</Text>
        </Box>
      )}

      {phase.type === "done" && (
        <Box gap={1}>
          <Text color="green">✓ Ready for review!</Text>
          {phase.prUrl && <Text dimColor>{phase.prUrl}</Text>}
        </Box>
      )}
      {phase.type === "error" && (
        <Text color="red">✗ Stopped: {phase.message}</Text>
      )}

      <Footer
        hints={
          phase.type === "running"
            ? pendingInput?.type === "multiselect"
              ? "↑↓ navigate  Space toggle  a toggle all  Enter confirm"
              : pendingInput?.type === "keys"
                ? "waiting for your input above"
                : pendingInput?.type === "text-input"
                  ? "type command  Enter save  Esc skip"
                  : "k kill  Esc back"
            : "Esc back"
        }
      />
    </Box>
  );
}
