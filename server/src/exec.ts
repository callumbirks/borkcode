import { execFile, spawn } from "node:child_process";

export class CommandError extends Error {
  readonly stderr: string;
  /** Some commands print a usable partial result before failing, like `gh api graphql`. */
  readonly stdout: string;
  constructor(message: string, stderr: string, stdout = "") {
    super(message);
    this.stderr = stderr;
    this.stdout = stdout;
  }
}

/** Runs a command and resolves with trimmed stdout. Rejects with stderr in the message. */
export function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new CommandError(`${command} ${args.join(" ")}: ${detail}`, stderr, stdout));
          return;
        }
        resolve(stdout.trimEnd());
      },
    );
  });
}

export function git(cwd: string, ...args: string[]): Promise<string> {
  return run("git", args, { cwd });
}

/** Runs a shell command, collecting combined output. Never rejects. */
export function runShell(
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => resolve({ code: null, output: output + error.message }));
    child.on("close", (code) => resolve({ code, output }));
  });
}
