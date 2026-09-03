// Locating the two executables this integration needs, and the PATH the ACP
// adapter has to be spawned with.
//
// `agy` installs to `~/.local/bin`, which is frequently absent from the PATH a
// background daemon inherits. The adapter resolves the CLI with a plain
// `shutil.which("agy")`, so if we do not hand it a PATH that contains `agy`,
// every turn fails at spawn time with a message about `/usr/bin/agy`.

import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { isExecutable } from "./config.js";

const run = promisify(execFile);

/** Where `agy` and pipx put things, beyond whatever PATH we inherit. */
function extraSearchDirs(home: string): string[] {
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".local", "pipx", "venvs", "agy-agent-acp", "bin"),
    path.join(
      home,
      "Library",
      "Application Support",
      "pipx",
      "venvs",
      "agy-agent-acp",
      "bin",
    ),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
}

function searchDirs(env: NodeJS.ProcessEnv, home: string): string[] {
  const fromPath = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return dedupe([...fromPath, ...extraSearchDirs(home)]);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** First executable named `name` across PATH plus the known install dirs. */
export async function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): Promise<string | undefined> {
  for (const dir of searchDirs(env, home)) {
    const candidate = path.join(dir, name);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** First of `names` found, so a preferred adapter wins over a fallback. */
export async function findFirstExecutable(
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): Promise<string | undefined> {
  for (const name of names) {
    const found = await findExecutable(name, env, home);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/**
 * Node for the normalizing shim.
 *
 * Version-manager paths (nvm, fnm, asdf, volta) are deliberately last: the
 * resolved path is written into config.json, and those directories disappear
 * the moment the user switches Node versions. A system or Homebrew install
 * stays put.
 */
export async function findNode(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): Promise<string | undefined> {
  const stable = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
  for (const candidate of stable) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return await findExecutable("node", env, home);
}

/**
 * The PATH to spawn the adapter with: the directories holding the two
 * executables, then the standard locations. Written into the launch spec so
 * the adapter finds `agy` no matter how sparse the daemon's own PATH is.
 */
export function buildLaunchPath(
  agyPath: string,
  adapterPath: string,
  home: string = os.homedir(),
): string {
  return dedupe([
    path.dirname(agyPath),
    path.dirname(adapterPath),
    ...extraSearchDirs(home),
  ]).join(path.delimiter);
}

export interface AgyProbe {
  path: string;
  version?: string;
  /**
   * `ok` — `agy models` listed models, so the subscription is live.
   * `failed` — it ran and refused.
   * `unknown` — it did not answer in time. This is not evidence of a problem:
   *   the probe runs inside bb's Electron server, which reaches the macOS
   *   keychain differently than the host daemon that actually launches the
   *   agent. `doctor` and a real thread are the authoritative checks.
   */
  authState: "ok" | "failed" | "unknown";
  modelCount?: number;
  error?: string;
}

/**
 * Probe `agy`. Version and auth are reported separately because they fail
 * independently: an installed-but-logged-out CLI still answers `--version`.
 */
export async function probeAgy(
  agyPath: string,
  timeoutMs = 25_000,
): Promise<AgyProbe> {
  const probe: AgyProbe = { path: agyPath, authState: "unknown" };

  try {
    const { stdout } = await run(agyPath, ["--version"], { timeout: 15_000 });
    probe.version = stdout.trim().split("\n")[0];
  } catch (error) {
    probe.authState = "failed";
    probe.error = describeExecError(error);
    return probe;
  }

  try {
    const { stdout } = await run(agyPath, ["models"], { timeout: timeoutMs });
    const models = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("\t"));
    probe.authState = models.length > 0 ? "ok" : "failed";
    probe.modelCount = models.length;
  } catch (error) {
    const killed = (error as { killed?: boolean }).killed === true;
    probe.authState = killed ? "unknown" : "failed";
    probe.error = describeExecError(error);
  }

  return probe;
}

/**
 * `execFile` rejects with a message that stops at "Command failed", which hides
 * the reason (auth, keychain, network). The detail lives on stderr/stdout.
 */
function describeExecError(error: unknown): string {
  const detail = error as NodeJS.ErrnoException & {
    stderr?: string;
    stdout?: string;
    code?: unknown;
    killed?: boolean;
    signal?: string;
  };
  const parts: string[] = [];
  if (detail.killed) {
    parts.push("timed out");
  }
  const stderr = detail.stderr?.trim();
  const stdout = detail.stdout?.trim();
  if (stderr) parts.push(stderr);
  if (!stderr && stdout) parts.push(stdout);
  if (parts.length === 0) parts.push(detail.message ?? String(error));
  if (detail.code !== undefined && detail.code !== null) {
    parts.push(`(exit ${String(detail.code)})`);
  }
  return parts.join(" ").slice(0, 600);
}

/**
 * Drive one ACP `initialize` over the adapter's stdio. This is the only check
 * that exercises the same path a thread will, so it is what `doctor` reports.
 */
export async function probeAdapterHandshake(
  command: string,
  args: string[],
  launchEnv: Record<string, string>,
  timeoutMs = 45_000,
): Promise<{ ok: boolean; agentName?: string; version?: string; error?: string }> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...launchEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: {
      ok: boolean;
      agentName?: string;
      version?: string;
      error?: string;
    }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: `No ACP initialize response within ${Math.round(timeoutMs / 1000)}s. ${stderr.slice(-400)}`,
      });
    }, timeoutMs);

    child.on("error", (error) => {
      finish({ ok: false, error: error.message });
    });

    child.on("exit", (code) => {
      finish({
        ok: false,
        error: `Adapter exited with code ${code ?? "null"}. ${stderr.slice(-400)}`,
      });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      try {
        const message = JSON.parse(stdout.slice(0, newline)) as {
          result?: { agentInfo?: { name?: string; version?: string } };
          error?: { message?: string };
        };
        if (message.error) {
          finish({ ok: false, error: message.error.message ?? "ACP error" });
          return;
        }
        finish({
          ok: true,
          agentName: message.result?.agentInfo?.name,
          version: message.result?.agentInfo?.version,
        });
      } catch (error) {
        finish({ ok: false, error: `Unparseable ACP reply: ${String(error)}` });
      }
    });

    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
          },
        },
      })}\n`,
    );
  });
}
