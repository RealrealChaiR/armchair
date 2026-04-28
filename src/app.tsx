import { Box, Text } from "ink";

const COMMANDS = [
  {
    usage: "worktree add <name>",
    description: "Create a worktree, copy .env, and run pnpm install",
  },
] as const;

export function App() {
  return (
    <Box flexDirection="column" padding={1} gap={1}>
      <Box gap={1}>
        <Text bold color="cyan">
          armchair
        </Text>
        <Text dimColor>— terminal dev tools</Text>
      </Box>
      <Box flexDirection="column">
        <Text bold>Commands:</Text>
        {COMMANDS.map(({ usage, description }) => (
          <Box key={usage} paddingLeft={2} gap={3}>
            <Text color="cyan">{usage}</Text>
            <Text dimColor>{description}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
