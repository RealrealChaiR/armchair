# CLAUDE.md

## Non-obvious constraints

- All imports must use `.js` extensions (ESM + `moduleResolution: Bundler` in tsconfig)
- `@xterm/headless` is CJS: `import pkg from "@xterm/headless"; const { Terminal } = pkg`
- No test suite
