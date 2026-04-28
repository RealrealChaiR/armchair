import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export async function run(cmd: string, options?: { cwd?: string }) {
  const { stdout, stderr } = await execAsync(cmd, { cwd: options?.cwd });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}
