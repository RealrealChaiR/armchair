import * as path from "node:path";
import { Box, Text, useInput, useStdin } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";

import { Footer } from "../../components/Footer.js";
import { useQuit } from "../../hooks/useQuit.js";
import { run } from "../../utils/exec.js";
import {
  addWorktree,
  checkRemoteBranch,
  copyEnvFile,
  getMainBranchWorktreePath,
  getMainWorktreePath,
} from "../../utils/worktree.js";

type StepStatus = "pending" | "running" | "done" | "error";

type StepState = {
  label: string;
  status: StepStatus;
  detail?: string;
};

type Phase =
  | { type: "checking" }
  | { type: "confirm"; remote: string }
  | { type: "running" }
  | { type: "done" }
  | { type: "error"; message: string };

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
  const { isRawModeSupported } = useStdin();
  const [phase, setPhase] = useState<Phase>({ type: "checking" });
  const [steps, setSteps] = useState<StepState[]>([
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

  const execute = useCallback(
    async (trackRemote: string | null) => {
      if (executing.current) {
        return;
      }
      executing.current = true;
      setPhase({ type: "running" });

      let mainPath: string;
      let destPath: string;

      updateStep(0, { status: "running" });
      try {
        mainPath = await getMainWorktreePath();
        destPath = path.join(mainPath, name);
        updateStep(0, {
          label: `Creating worktree at ${path.relative(process.cwd(), destPath)}`,
        });
        await addWorktree(name, destPath, trackRemote ?? undefined);
        updateStep(0, { status: "done" });
      } catch (err) {
        updateStep(0, { status: "error", detail: String(err) });
        setPhase({ type: "error", message: String(err) });
        return;
      }

      updateStep(1, { status: "running" });
      try {
        const mainBranchPath = await getMainBranchWorktreePath();
        const copied = mainBranchPath
          ? await copyEnvFile(mainBranchPath, destPath)
          : false;
        updateStep(1, {
          status: "done",
          label: copied ? "Copied .env" : ".env not found, skipped",
        });
      } catch (err) {
        updateStep(1, { status: "error", detail: String(err) });
        setPhase({ type: "error", message: String(err) });
        return;
      }

      updateStep(2, { status: "running" });
      try {
        await run("pnpm install", { cwd: destPath });
        updateStep(2, { status: "done" });
      } catch (err) {
        updateStep(2, { status: "error", detail: String(err) });
        setPhase({ type: "error", message: String(err) });
        return;
      }

      setPhase({ type: "done" });
    },
    [name, updateStep],
  );

  useEffect(() => {
    async function check() {
      try {
        const remote = await checkRemoteBranch(name);
        if (remote) {
          setPhase({ type: "confirm", remote });
        } else {
          await execute(null);
        }
      } catch (err) {
        setPhase({ type: "error", message: String(err) });
      }
    }
    void check();
  }, [name, execute]);

  useEffect(() => {
    if (phase.type === "done" && onDone) {
      const t = setTimeout(onDone, 1000);
      return () => clearTimeout(t);
    }
  }, [phase.type, onDone]);

  useInput((input, key) => {
    if (phase.type !== "confirm") {
      return;
    }
    const { remote } = phase;
    if (input === "y" || input === "Y" || key.return) {
      void execute(remote);
    } else if (input === "n" || input === "N") {
      void execute(null);
    }
  }, { isActive: isRawModeSupported === true });

  const showSteps =
    phase.type === "running" || phase.type === "done" || phase.type === "error";

  return (
    <Box flexDirection="column" padding={1} gap={1}>
      <Box gap={1}>
        <Text bold>worktree add</Text>
        <Text color="cyan" bold>
          {name}
        </Text>
      </Box>

      {phase.type === "checking" && (
        <Text dimColor>Checking for remote branch…</Text>
      )}

      {phase.type === "confirm" && (
        <Box gap={1}>
          <Text>
            Remote branch found on <Text color="yellow">{phase.remote}</Text>.
            Track it?
          </Text>
          <Text dimColor>[Y/n]</Text>
        </Box>
      )}

      {showSteps && (
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
      )}

      {phase.type === "done" && <Text color="green">Done!</Text>}
      <Footer />
    </Box>
  );
}
