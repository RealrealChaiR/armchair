import { access, copyFile } from "node:fs/promises";
import * as path from "node:path";

import { run } from "./exec.js";

export type WorktreeInfo = { path: string; branch: string; isBare: boolean };

export async function listWorktrees(): Promise<WorktreeInfo[]> {
  const { stdout } = await run("git worktree list --porcelain");
  const entries = stdout.split("\n\n");
  const result: WorktreeInfo[] = [];
  for (const entry of entries) {
    const lines = entry.trim().split("\n");
    const worktreeLine = lines.find((l) => l.startsWith("worktree "));
    const branchLine = lines.find((l) => l.startsWith("branch "));
    const isBare = lines.some((l) => l === "bare");
    if (!worktreeLine) continue;
    const worktreePath = worktreeLine.slice("worktree ".length);
    const rawBranch = branchLine?.slice("branch ".length) ?? "";
    const branch = rawBranch.startsWith("refs/heads/")
      ? rawBranch.slice("refs/heads/".length)
      : rawBranch || "(detached)";
    result.push({ path: worktreePath, branch, isBare });
  }
  return result;
}

export async function getMainWorktreePath(): Promise<string> {
  const { stdout } = await run("git worktree list --porcelain");
  const line = stdout.split("\n").find((l) => l.startsWith("worktree "));
  if (!line) {
    throw new Error("Could not determine main worktree path");
  }
  const worktreePath = line.slice("worktree ".length);
  // Bare repos are conventionally stored in a .bare subdirectory; worktrees
  // should be siblings of .bare, not children of it.
  if (path.basename(worktreePath) === ".bare") {
    return path.dirname(worktreePath);
  }
  return worktreePath;
}

export async function getMainBranchWorktreePath(): Promise<string | null> {
  const { stdout } = await run("git worktree list --porcelain");
  const entries = stdout.split("\n\n");
  for (const entry of entries) {
    const lines = entry.trim().split("\n");
    const worktreeLine = lines.find((l) => l.startsWith("worktree "));
    const branchLine = lines.find((l) => l.startsWith("branch "));
    if (!worktreeLine || !branchLine) continue;
    const branch = branchLine.slice("branch ".length);
    if (branch === "refs/heads/main") {
      return worktreeLine.slice("worktree ".length);
    }
  }
  return null;
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
