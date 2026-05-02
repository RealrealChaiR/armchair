import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const CONFIG_DIR = path.join(os.homedir(), ".config", "armchair");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

type WorktreeConfig = { appDirs: string[] };
type ConfigFile = Record<string, WorktreeConfig>;

export async function loadConfig(
  worktreePath: string,
): Promise<WorktreeConfig | null> {
  try {
    const content = await readFile(CONFIG_PATH, "utf8");
    const file = JSON.parse(content) as ConfigFile;
    return file[worktreePath] ?? null;
  } catch {
    return null;
  }
}

export async function saveConfig(
  worktreePath: string,
  config: WorktreeConfig,
): Promise<void> {
  let file: ConfigFile = {};
  try {
    const content = await readFile(CONFIG_PATH, "utf8");
    file = JSON.parse(content) as ConfigFile;
  } catch {
    // first write
  }
  file[worktreePath] = config;
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(file, null, 2));
}
