import { Box, Text, useInput, useStdin } from "ink";
import { useState } from "react";

import { WorktreeManager } from "./commands/worktree/manager.js";
import { Footer } from "./components/Footer.js";
import { useQuit } from "./hooks/useQuit.js";

const COMMANDS = [
  {
    label: "worktree manager",
    description: "Manage and switch between worktrees",
  },
];

type AppScreen = { type: "menu"; index: number } | { type: "worktree-manager" };

export function App({ startAtManager = false }: { startAtManager?: boolean }) {
  const { isRawModeSupported } = useStdin();
  const [screen, setScreen] = useState<AppScreen>(
    startAtManager ? { type: "worktree-manager" } : { type: "menu", index: 0 },
  );

  useQuit();

  useInput(
    (_, key) => {
      if (screen.type !== "menu") return;
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
        setScreen({ type: "worktree-manager" });
      }
    },
    { isActive: isRawModeSupported === true },
  );

  if (screen.type === "worktree-manager") {
    return (
      <WorktreeManager onBack={() => setScreen({ type: "menu", index: 0 })} />
    );
  }

  return (
    <Box flexDirection="column" padding={1} gap={1}>
      <Box gap={1}>
        <Text bold color="cyan">
          armchair
        </Text>
        <Text dimColor>— terminal dev tools</Text>
      </Box>
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
      <Footer hints="↑↓ select  Enter confirm  q quit" />
    </Box>
  );
}
