import { access, copyFile } from "node:fs/promises";
import * as path from "node:path";

import { run } from "./exec.js";

export async function getMainWorktreePath(): Promise<string> {
  const { stdout } = await run("git worktree list --porcelain");
  const line = stdout.split("\n").find((l) => l.startsWith("worktree "));
  if (!line) {
    throw new Error("Could not determine main worktree path");
  }
  return line.slice("worktree ".length);
}

export async function checkRemoteBranch(name: string): Promise<string | null> {
  for (const remote of ["upstream", "origin"]) {
    try {
      const { stdout } = await run(`git ls-remote --heads ${remote} ${name}`);
      if (stdout.length > 0) {
        return remote;
      }
    } catch {
      // remote doesn't exist, try next
    }
  }
  return null;
}

export async function addWorktree(
  name: string,
  destPath: string,
  trackRemote?: string,
): Promise<void> {
  if (trackRemote) {
    await run(
      `git worktree add --track -b ${name} ${destPath} ${trackRemote}/${name}`,
    );
  } else {
    await run(`git worktree add -b ${name} ${destPath}`);
  }
}

export async function copyEnvFile(
  srcDir: string,
  destDir: string,
): Promise<boolean> {
  const src = path.join(srcDir, ".env");
  try {
    await access(src);
    await copyFile(src, path.join(destDir, ".env"));
    return true;
  } catch {
    return false;
  }
}
