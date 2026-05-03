import { run } from "./exec.js";

export type PRInfo = { number: number; url: string };

export async function getPRForBranch(
  branch: string,
  worktreePath: string,
): Promise<PRInfo | null> {
  try {
    const { stdout } = await run(
      `gh pr view ${branch} --json number,url`,
      { cwd: worktreePath },
    );
    const data = JSON.parse(stdout) as PRInfo;
    return data;
  } catch {
    return null;
  }
}

export function hyperlink(url: string, text: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}
