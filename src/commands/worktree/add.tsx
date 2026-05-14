import * as path from "node:path";
import { Box, Text } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";

import { Footer } from "../../components/Footer.js";
import { useQuit } from "../../hooks/useQuit.js";
import { run } from "../../utils/exec.js";
import {
  addWorktree,
  copyEnvFile,
  fetchAndUpdateMain,
  getMainBranchWorktreePath,
  getMainWorktreePath,
  getPrimaryRemote,
  hasRemoteTrackingBranch,
} from "../../utils/worktree.js";

type StepStatus = "pending" | "running" | "done" | "error";

type StepState = {
  label: string;
  status: StepStatus;
  detail?: string;
};

type Phase = { type: "running" } | { type: "done" } | { type: "error"; message: string };

function stepIcon(status: StepStatus): string {
  if (status === "running") return "●";
  if (status === "done") return "✓";
  if (status === "error") return "✗";
  return "○";
}

function stepColor(status: StepStatus): "blue" | "green" | "red" | "gray" {
  if (status === "running") return "blue";
  if (status === "done") return "green";
  if (status === "error") return "red";
  return "gray";
}

type Props = { name: string; onDone?: () => void };

export function WorktreeAdd({ name, onDone }: Props) {
  useQuit();
  const [phase, setPhase] = useState<Phase>({ type: "running" });
  const [steps, setSteps] = useState<StepState[]>([
    { label: "Fetching from remote", status: "pending" },
    { label: "Updating main", status: "pending" },
    { label: "Creating worktree", status: "pending" },
    { label: "Copying .env", status: "pending" },
    { label: "Installing dependencies", status: "pending" },
  ]);
  const executing = useRef(false);

  const updateStep = useCallback((index: number, patch: Partial<StepState>) => {
    setSteps((prev) =>
      prev.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    );
  }, []);

  const execute = useCallback(async () => {
    if (executing.current) return;
    executing.current = true;

    let mainPath: string;
    let destPath: string;

    // ── step 0: fetch from remote ──────────────────────────────────────────
    updateStep(0, { status: "running" });
    let remote: string | null = null;
    try {
      remote = await getPrimaryRemote();
      if (!remote) {
        updateStep(0, { status: "done", label: "No remote found, skipped" });
      } else {
        updateStep(0, { label: `Fetching from ${remote}`, status: "running" });
        const mainBranchPath = await getMainBranchWorktreePath();
        await fetchAndUpdateMain(remote, mainBranchPath ?? process.cwd());
        updateStep(0, { label: `Fetched from ${remote}`, status: "done" });
      }
    } catch (err) {
      updateStep(0, { status: "error", detail: String(err) });
      setPhase({ type: "error", message: String(err) });
      return;
    }

    // ── step 1: update main ────────────────────────────────────────────────
    // Already done inside fetchAndUpdateMain above; mark done or skipped.
    updateStep(1, {
      status: "done",
      label: remote ? "main updated to latest" : "No remote, skipped",
    });

    // ── step 2: create worktree ────────────────────────────────────────────
    updateStep(2, { status: "running" });
    try {
      mainPath = await getMainWorktreePath();
      destPath = path.join(mainPath, name);
      updateStep(2, {
        label: `Creating worktree at ${path.relative(process.cwd(), destPath)}`,
      });
      const trackingRemote =
        remote && (await hasRemoteTrackingBranch(remote, name))
          ? remote
          : undefined;
      await addWorktree(name, destPath, trackingRemote);
      updateStep(2, {
        status: "done",
        label: trackingRemote
          ? `Created worktree from ${trackingRemote}/${name}`
          : `Created worktree at ${path.relative(process.cwd(), destPath)}`,
      });
    } catch (err) {
      updateStep(2, { status: "error", detail: String(err) });
      setPhase({ type: "error", message: String(err) });
      return;
    }

    // ── step 3: copy .env ──────────────────────────────────────────────────
    updateStep(3, { status: "running" });
    try {
      const mainBranchPath = await getMainBranchWorktreePath();
      const copied = mainBranchPath
        ? await copyEnvFile(mainBranchPath, destPath)
        : false;
      updateStep(3, {
        status: "done",
        label: copied ? "Copied .env" : ".env not found, skipped",
      });
    } catch (err) {
      updateStep(3, { status: "error", detail: String(err) });
      setPhase({ type: "error", message: String(err) });
      return;
    }

    // ── step 4: pnpm install ───────────────────────────────────────────────
    updateStep(4, { status: "running" });
    try {
      await run("pnpm install", { cwd: destPath });
      updateStep(4, { status: "done" });
    } catch (err) {
      updateStep(4, { status: "error", detail: String(err) });
      setPhase({ type: "error", message: String(err) });
      return;
    }

    setPhase({ type: "done" });
  }, [name, updateStep]);

  useEffect(() => {
    void execute();
  }, [execute]);

  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (phase.type === "done") {
      const t = setTimeout(() => onDoneRef.current?.(), 1000);
      return () => clearTimeout(t);
    }
  }, [phase.type]);

  return (
    <Box flexDirection="column" padding={1} gap={1}>
      <Box gap={1}>
        <Text bold>worktree add</Text>
        <Text color="cyan" bold>
          {name}
        </Text>
      </Box>

      <Box flexDirection="column">
        {steps.map((step, i) => (
          <Box key={i} gap={1}>
            <Text color={stepColor(step.status)}>
              {stepIcon(step.status)}
            </Text>
            <Text dimColor={step.status === "pending"}>{step.label}</Text>
            {step.detail !== undefined && (
              <Text color="red">{step.detail}</Text>
            )}
          </Box>
        ))}
      </Box>

      {phase.type === "done" && <Text color="green">Done!</Text>}
      <Footer />
    </Box>
  );
}
