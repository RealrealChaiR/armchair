import { render } from "ink";

import { App } from "./app.js";
import { WorktreeAdd } from "./commands/worktree/add.js";

const [, , command, subcommand, name] = process.argv;

if (command === "worktree" && subcommand === "add" && name) {
  render(<WorktreeAdd name={name} />);
} else {
  render(<App />);
}
