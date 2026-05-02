import { Box, Text, useInput, useStdin } from "ink";
import { useState } from "react";

import { WorktreeAdd } from "./commands/worktree/add.js";
import { WorktreeManager } from "./commands/worktree/manager.js";
import { Footer } from "./components/Footer.js";
import { useQuit } from "./hooks/useQuit.js";

const COMMANDS = [
  {
    label: "worktree add",
    description: "Create a worktree, copy .env, and run pnpm install",
    param: { name: "name", label: "Branch name" } as { name: string; label: string } | null,
  },
  {
    label: "worktree manager",
    description: "Manage and switch between worktrees",
    param: null as { name: string; label: string } | null,
  },
];

type AppScreen =
  | { type: "menu"; index: number }
  | { type: "input"; commandIndex: number; value: string }
  | { type: "run"; name: string }
  | { type: "worktree-manager" };

export function App() {
  const { isRawModeSupported } = useStdin();
  const [screen, setScreen] = useState<AppScreen>({ type: "menu", index: 0 });

  useQuit(screen.type !== "input");

  useInput(
    (input, key) => {
      if (screen.type === "menu") {
        if (key.upArrow) {
          setScreen((s) =>
            s.type === "menu" ? { ...s, index: Math.max(0, s.index - 1) } : s,
          );
        } else if (key.downArrow) {
          setScreen((s) =>
            s.type === "menu"
              ? { ...s, index: Math.min(COMMANDS.length - 1, s.index + 1) }
              : s,
          );
        } else if (key.return) {
          const cmd = COMMANDS[screen.index];
          if (cmd?.param) {
            setScreen({ type: "input", commandIndex: screen.index, value: "" });
          } else {
            setScreen({ type: "worktree-manager" });
          }
        }
      } else if (screen.type === "input") {
        if (key.escape) {
          setScreen({ type: "menu", index: screen.commandIndex });
        } else if (key.return) {
          if (screen.value.trim()) {
            setScreen({ type: "run", name: screen.value.trim() });
          }
        } else if (key.backspace || key.delete) {
          setScreen((s) =>
            s.type === "input" ? { ...s, value: s.value.slice(0, -1) } : s,
          );
        } else if (input && !key.ctrl && !key.meta) {
          setScreen((s) =>
            s.type === "input" ? { ...s, value: s.value + input } : s,
          );
        }
      }
    },
    { isActive: isRawModeSupported === true },
  );

  if (screen.type === "run") {
    return (
      <WorktreeAdd
        name={screen.name}
        onDone={() => setScreen({ type: "menu", index: 0 })}
      />
    );
  }

  if (screen.type === "worktree-manager") {
    return (
      <WorktreeManager onBack={() => setScreen({ type: "menu", index: 0 })} />
    );
  }

  const activeCmd =
    screen.type === "input" ? COMMANDS[screen.commandIndex] : undefined;

  return (
    <Box flexDirection="column" padding={1} gap={1}>
      <Box gap={1}>
        <Text bold color="cyan">
          armchair
        </Text>
        <Text dimColor>— terminal dev tools</Text>
      </Box>

      {screen.type === "menu" && (
        <Box flexDirection="column" gap={0}>
          {COMMANDS.map(({ label, description }, i) => {
            const selected = i === screen.index;
            return (
              <Box key={label} gap={2}>
                <Text color={selected ? "green" : undefined} bold={selected}>
                  {selected ? ">" : " "} {label}
                </Text>
                <Text dimColor>{description}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      {screen.type === "input" && activeCmd?.param && (
        <Box flexDirection="column" gap={1}>
          <Text bold>{activeCmd.label}</Text>
          <Box gap={1}>
            <Text dimColor>{activeCmd.param.label}:</Text>
            <Text color="cyan">{screen.value}</Text>
            <Text>_</Text>
          </Box>
        </Box>
      )}

      <Footer
        hints={
          screen.type === "menu"
            ? "↑↓ select  Enter confirm  q quit"
            : "Backspace edit  Enter run  Esc back"
        }
      />
    </Box>
  );
}
