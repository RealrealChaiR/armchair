import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";

import { Footer } from "../../components/Footer.js";
import { useQuit } from "../../hooks/useQuit.js";
import { run, runLines } from "../../utils/exec.js";

type StepStatus = "pending" | "running" | "done" | "error";
type StepState = { label: string; status: StepStatus; detail?: string };
type Phase =
  | { type: "form" }
  | { type: "running" }
  | { type: "done" }
  | { type: "error"; message: string };

function stepIcon(s: StepStatus): string {
  if (s === "running") return "●";
  if (s === "done") return "✓";
  if (s === "error") return "✗";
  return "○";
}

function stepColor(s: StepStatus): "blue" | "green" | "red" | "gray" {
  if (s === "running") return "blue";
  if (s === "done") return "green";
  if (s === "error") return "red";
  return "gray";
}

function inferName(remote: string): string {
  return (
    remote
      .replace(/\.git$/, "")
      .split(/[/:]/)
      .filter(Boolean)
      .pop() ?? ""
  );
}

type Props = { onDone?: () => void };

export function WorktreeCreate({ onDone }: Props) {
  useQuit();
  const [phase, setPhase] = useState<Phase>({ type: "form" });
  const [remote, setRemote] = useState("");
  const [name, setName] = useState("");
  const [activeField, setActiveField] = useState<0 | 1>(0);
  const autoName = useRef("");
  const submitted = useRef<{ remote: string; name: string } | null>(null);
  const executing = useRef(false);
  const [steps, setSteps] = useState<StepState[]>([
    { label: "Cloning bare repo", status: "pending" },
    { label: "Configuring git", status: "pending" },
    { label: "Fetching origin", status: "pending" },
    { label: "Adding main worktree", status: "pending" },
  ]);

  const updateStep = useCallback((index: number, patch: Partial<StepState>) => {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }, []);

  useInput((input, key) => {
    if (phase.type !== "form") return;

    if (key.tab || key.downArrow) {
      setActiveField((f) => (f === 0 ? 1 : 0));
      return;
    }
    if (key.upArrow) {
      setActiveField((f) => (f === 1 ? 0 : 1));
      return;
    }
    if (key.return) {
      if (remote.trim() && name.trim()) {
        submitted.current = { remote: remote.trim(), name: name.trim() };
        setPhase({ type: "running" });
      }
      return;
    }

    const isBackspace = key.backspace || key.delete;
    if (activeField === 0) {
      const next = isBackspace
        ? remote.slice(0, -1)
        : input && !key.ctrl && !key.meta
          ? remote + input
          : null;
      if (next === null) return;
      setRemote(next);
      const inferred = inferName(next);
      if (!name || name === autoName.current) {
        setName(inferred);
        autoName.current = inferred;
      }
    } else {
      if (isBackspace) {
        setName((n) => n.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setName((n) => n + input);
      }
    }
  });

  useEffect(() => {
    if (phase.type !== "running" || executing.current || !submitted.current) return;
    executing.current = true;
    const { remote: r, name: n } = submitted.current;
    const projectDir = path.join(process.cwd(), n);

    async function execute() {
      updateStep(0, { status: "running", label: `Cloning ${r}` });
      try {
        await fs.mkdir(projectDir, { recursive: true });
        await runLines(
          `git clone --bare ${JSON.stringify(r)} .bare`,
          { cwd: projectDir },
          (line) => updateStep(0, { detail: line }),
        );
        updateStep(0, { status: "done", label: "Cloned bare repo", detail: undefined });
      } catch (err) {
        updateStep(0, { status: "error", detail: String(err) });
        setPhase({ type: "error", message: String(err) });
        return;
      }

      updateStep(1, { status: "running" });
      try {
        await fs.writeFile(path.join(projectDir, ".git"), "gitdir: ./.bare\n");
        await run(
          `git config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"`,
          { cwd: projectDir },
        );
        updateStep(1, { status: "done" });
      } catch (err) {
        updateStep(1, { status: "error", detail: String(err) });
        setPhase({ type: "error", message: String(err) });
        return;
      }

      updateStep(2, { status: "running" });
      try {
        await run("git fetch origin", { cwd: projectDir });
        updateStep(2, { status: "done" });
      } catch (err) {
        updateStep(2, { status: "error", detail: String(err) });
        setPhase({ type: "error", message: String(err) });
        return;
      }

      updateStep(3, { status: "running" });
      try {
        await run("git worktree add main", { cwd: projectDir });
        updateStep(3, { status: "done" });
      } catch (err) {
        updateStep(3, { status: "error", detail: String(err) });
        setPhase({ type: "error", message: String(err) });
        return;
      }

      setPhase({ type: "done" });
    }

    void execute().catch((err) =>
      setPhase({ type: "error", message: String(err) }),
    );
  }, [phase.type, updateStep]);

  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (phase.type === "done") {
      const t = setTimeout(() => onDoneRef.current?.(), 1500);
      return () => clearTimeout(t);
    }
  }, [phase.type]);

  if (phase.type === "form") {
    const fields: { label: string; value: string }[] = [
      { label: "Remote URL", value: remote },
      { label: "Project name", value: name },
    ];
    const canSubmit = remote.trim() && name.trim();
    return (
      <Box flexDirection="column" padding={1} gap={1}>
        <Text bold>worktree create</Text>
        <Box flexDirection="column">
          {fields.map(({ label, value }, i) => {
            const active = i === activeField;
            return (
              <Box key={label} gap={1}>
                <Box width={14}>
                  <Text color={active ? "green" : undefined} bold={active}>
                    {label}
                  </Text>
                </Box>
                <Text color="green">{active ? "▸" : " "}</Text>
                <Text>
                  {value}
                  {active && <Text color="green">█</Text>}
                </Text>
              </Box>
            );
          })}
        </Box>
        <Footer
          hints={`Tab next field${canSubmit ? "  Enter start" : ""}  q quit`}
        />
      </Box>
    );
  }

  const displayName = submitted.current?.name ?? name;
  return (
    <Box flexDirection="column" padding={1} gap={1}>
      <Box gap={1}>
        <Text bold>worktree create</Text>
        <Text color="cyan" bold>
          {displayName}
        </Text>
      </Box>
      <Box flexDirection="column">
        {steps.map((step, i) => (
          <Box key={i} gap={1}>
            <Text color={stepColor(step.status)}>{stepIcon(step.status)}</Text>
            <Text dimColor={step.status === "pending"}>{step.label}</Text>
            {step.detail !== undefined && (
              <Text dimColor>{step.detail}</Text>
            )}
          </Box>
        ))}
      </Box>
      {phase.type === "done" && (
        <Text color="green">Done! Created at ./{displayName}</Text>
      )}
      {phase.type === "error" && (
        <Text color="red">{phase.message}</Text>
      )}
      <Footer />
    </Box>
  );
}
