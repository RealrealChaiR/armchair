# armchair

Terminal-based dev tools written in TypeScript using [Ink](https://github.com/vadimdemedes/ink).

## Installation

Requires [pnpm](https://pnpm.io/installation) and Node.js.

```bash
pnpm add -g github:RealrealChaiR/armchair --allow-build=armchair
```

## Upgrading

```bash
pnpm add -g github:RealrealChaiR/armchair --allow-build=armchair
```

Same command — pnpm will fetch the latest commit and rebuild.

## Development

```bash
pnpm install
pnpm dev
```

### Scripts

- `pnpm dev` - Run in development mode
- `pnpm build` - Build to `dist/`
- `pnpm lint` / `pnpm lint:fix` - ESLint
- `pnpm format` / `pnpm format:check` - Prettier
- `pnpm typecheck` - TypeScript type check

## Tech Stack

- **Ink** — React renderer for terminals
- **React** — UI framework
- **TypeScript** — Type safety
- **node-pty** — PTY process management
- **tsup** — Bundler
