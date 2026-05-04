import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const CONFIG_DIR = path.join(os.homedir(), ".config", "armchair");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const GLOBAL_KEY = "__global__";

export type GlobalConfig = {
  appRelDirs?: string[];
  testCommand?: string;
  lintCommands?: string[];
};

type ConfigFile = Record<string, unknown>;

export async function loadGlobalConfig(): Promise<GlobalConfig> {
  try {
    const content = await readFile(CONFIG_PATH, "utf8");
    const file = JSON.parse(content) as ConfigFile;
    return (file[GLOBAL_KEY] as GlobalConfig) ?? {};
  } catch {
    return {};
  }
}

export async function saveGlobalConfig(patch: Partial<GlobalConfig>): Promise<void> {
  let file: ConfigFile = {};
  try {
    const content = await readFile(CONFIG_PATH, "utf8");
    file = JSON.parse(content) as ConfigFile;
  } catch {
    // first write
  }
  const existing = (file[GLOBAL_KEY] as GlobalConfig | undefined) ?? {};
  file[GLOBAL_KEY] = { ...existing, ...patch };
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(file, null, 2));
}
