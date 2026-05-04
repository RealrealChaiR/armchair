import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { registerChild } from "./child-registry.js";

const execAsync = promisify(exec);

export function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[mGKHFJA-Za-z]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");
}

export async function run(cmd: string, options?: { cwd?: string }) {
  const { stdout, stderr } = await execAsync(cmd, { cwd: options?.cwd });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

// Like run(), but streams each output line via onLine as it arrives.
export async function runLines(
  cmd: string,
  options: { cwd?: string },
  onLine: (line: string) => void,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("sh", ["-c", cmd], {
      cwd: options.cwd,
      env: process.env as Record<string, string>,
      stdio: ["ignore", "pipe", "pipe"],
    });
    registerChild(proc);

    let stdout = "";
    let stderr = "";
    let buf = "";

    const flush = (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const stripped = stripAnsi(line).trimEnd();
        if (stripped) onLine(stripped);
      }
    };

    proc.stdout.on("data", (chunk: Buffer) => { const t = chunk.toString(); stdout += t; flush(t); });
    proc.stderr.on("data", (chunk: Buffer) => { const t = chunk.toString(); stderr += t; flush(t); });

    proc.on("close", (code) => {
      if (buf.trim()) onLine(stripAnsi(buf).trimEnd());
      if (code === 0 || code === null) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(stdout.trim() || stderr.trim() || `exited with code ${code}`));
    });

    proc.on("error", reject);
  });
}
