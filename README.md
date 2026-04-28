# armchair

Terminal-based dev tools written in TypeScript using [Ink](https://github.com/vadimdemedes/ink).

## Getting Started

```bash
pnpm install
pnpm dev
```

## Available Scripts

- `pnpm dev` - Run the CLI in development mode (with hot reload)
- `pnpm build` - Build the CLI to JavaScript
- `pnpm lint` - Check code with ESLint
- `pnpm lint:fix` - Fix lint errors
- `pnpm format` - Format code with Prettier
- `pnpm format:check` - Check code formatting
- `pnpm typecheck` - Check TypeScript types

## Project Structure

```
src/
├── index.tsx      # Entry point
├── app.tsx        # Root component
└── ...            # Feature components
```

## Tech Stack

- **Ink** - React renderer for CLI
- **React** - UI framework
- **TypeScript** - Type safety
- **Babel** - JSX transpilation
- **ESLint** - Code linting
- **Prettier** - Code formatting
