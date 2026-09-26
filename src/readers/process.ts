import { spawn } from "node:child_process";

export type Command = { executable: string; args: string[]; cwd: string; stdin?: string; timeoutMs: number; signal?: AbortSignal };
export type CommandResult = { stdout: string };
export type Runner = (command: Command) => Promise<CommandResult>;

/** No shell, no login scripts, no discovery. Own the child group, never another agent's process. */
export const runCommand: Runner = (command) => new Promise((resolve, reject) => {
  if (command.signal?.aborted) { reject(new Error("Reader cancelled")); return; }
  const child = spawn(command.executable, command.args, {
    cwd: command.cwd, env: { ...process.env, SHELL_SESSIONS_DISABLE: '1' }, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  let bytes = 0, failure: string | null = null;
  let settled = false;
  let killer: NodeJS.Timeout | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal); } catch { /* already gone */ }
  };
  const stop = (message: string) => {
    if (failure || settled) return;
    failure = message;
    kill("SIGTERM");
    killer = setTimeout(() => { kill("SIGKILL"); fail(message); }, 1000);
  };
  const timer = setTimeout(() => stop("Reader timed out"), command.timeoutMs);
  const abort = () => stop("Reader cancelled");
  command.signal?.addEventListener("abort", abort, { once: true });
  const clean = () => { clearTimeout(timer); clearTimeout(killer); command.signal?.removeEventListener("abort", abort); };
  const fail = (message: string) => {
    if (settled) return;
    settled = true; clean();
    // A detached descendant can retain inherited pipes after the owned process
    // group exits. The grace deadline must settle without waiting for close.
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    reject(new Error(message));
  };
  child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) stop("Reader output exceeded 16 MB"); else stdout.push(chunk); });
  child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) stop("Reader output exceeded 16 MB"); });
  child.once("error", () => fail("Cannot start configured reader executable"));
  child.once("close", (code) => {
    if (settled) return;
    if (failure || code !== 0) {
      if (failure) kill("SIGKILL");
      fail(failure ?? `Reader command exited ${code}; check provider login/configuration`);
    } else {
      settled = true; clean();
      resolve({ stdout: Buffer.concat(stdout).toString("utf8") });
    }
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(command.stdin ?? "");
});
