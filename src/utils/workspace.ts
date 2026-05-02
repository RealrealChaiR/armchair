import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";

export type AppInfo = { name: string; dir: string };

export async function discoverApps(worktreePath: string): Promise<AppInfo[]> {
  let workspaceContent: string;
  try {
    workspaceContent = await readFile(
      path.join(worktreePath, "pnpm-workspace.yaml"),
      "utf8",
    );
  } catch {
    return [];
  }

  const patterns = parseWorkspacePatterns(workspaceContent);
  const apps: AppInfo[] = [];

  for (const pattern of patterns) {
    // Only handle simple "dir/*" patterns
    if (!pattern.endsWith("/*")) continue;
    const parentDir = path.join(worktreePath, pattern.slice(0, -2));
    let entries;
    try {
      entries = await readdir(parentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const appDir = path.join(parentDir, entry.name);
      if (await hasDevScript(appDir)) {
        apps.push({ name: entry.name, dir: appDir });
      }
    }
  }

  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

function parseWorkspacePatterns(yaml: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of yaml.split("\n")) {
    if (line.trim() === "packages:") {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const match = line.match(/^\s+-\s+"?([^"#\s]+)"?/);
      if (match?.[1]) {
        patterns.push(match[1]);
      } else if (line.trim() && !line.startsWith(" ") && !line.startsWith("\t")) {
        break;
      }
    }
  }
  return patterns;
}

async function hasDevScript(dir: string): Promise<boolean> {
  try {
    const content = await readFile(path.join(dir, "package.json"), "utf8");
    const pkg = JSON.parse(content) as { scripts?: Record<string, string> };
    return typeof pkg.scripts?.dev === "string";
  } catch {
    return false;
  }
}
