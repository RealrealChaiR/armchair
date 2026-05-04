import { run } from "./exec.js";

export type PRInfo = { number: number; url: string; state: "OPEN" | "CLOSED" | "MERGED"; commentCount: number };

export async function getPRForBranch(
  branch: string,
  worktreePath: string,
): Promise<PRInfo | null> {
  try {
    const { stdout } = await run(
      `gh pr view ${branch} --json number,url,state,comments`,
      { cwd: worktreePath },
    );
    const data = JSON.parse(stdout) as { number: number; url: string; state: "OPEN" | "CLOSED" | "MERGED"; comments: unknown[] };
    return { number: data.number, url: data.url, state: data.state, commentCount: data.comments.length };
  } catch {
    return null;
  }
}

export function hyperlink(url: string, text: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

export type CIStatus = "passing" | "failing" | "running" | null;

export async function getCIStatus(
  branch: string,
  worktreePath: string,
): Promise<CIStatus> {
  try {
    const { stdout } = await run(
      `gh run list --branch ${branch} --limit 1 --json status,conclusion`,
      { cwd: worktreePath },
    );
    const [entry] = JSON.parse(stdout) as { status: string; conclusion: string }[];
    if (!entry) return null;
    if (entry.status !== "completed") return "running";
    return entry.conclusion === "success" ? "passing" : "failing";
  } catch {
    return null;
  }
}
