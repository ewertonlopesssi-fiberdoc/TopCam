import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Executa um programa com tempo máximo. Segredos vão por variável de ambiente (env) ou por
 * arquivo temporário 0600 — nunca pelos argumentos (que aparecem em `ps`).
 */
export function run(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = (s: string, d: Buffer) => (s.length > 200_000 ? s : s + d.toString("utf8"));
    child.stdout.on("data", (d: Buffer) => (stdout = cap(stdout, d)));
    child.stderr.on("data", (d: Buffer) => (stderr = cap(stderr, d)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 600_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

/** Pasta temporária privada (0700), apagada por `cleanup`. */
export async function privateDir(
  prefix: string,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await chmod(dir, 0o700);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function writePrivate(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600 });
}

/** Última linha útil de uma saída de erro (para mensagens), sem quebras. */
export function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return (lines.at(-1) ?? "").slice(0, 300);
}
