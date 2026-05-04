import { spawn } from "node:child_process";
import { registerChild } from "./child-registry.js";

// Runs claude non-interactively with --dangerously-skip-permissions so it can
// read/write files and run shell commands. Streams output lines via onLine.
export async function claudeRun(
  prompt: string,
  cwd: string,
  onLine?: (line: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      ["--dangerously-skip-permissions", "--print", prompt],
      {
        cwd,
        env: process.env as Record<string, string>,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    registerChild(proc);

    let output = "";
    let lineBuffer = "";

    const handleChunk = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (onLine) {
        lineBuffer += text;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) onLine(line);
        }
      }
    };

    proc.stdout.on("data", handleChunk);
    proc.stderr.on("data", handleChunk);

    proc.on("close", (code) => {
      if (lineBuffer.trim()) onLine?.(lineBuffer);
      if (code === 0 || code === null) resolve(output.trim());
      else reject(new Error(`claude exited with code ${code}`));
    });

    proc.on("error", reject);
  });
}
