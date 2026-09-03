// Reading and writing the bb data-dir `config.json`.
//
// bb has no set/unset CLI surface for `customAcpAgents`, so this plugin owns
// the entry directly. Everything here treats the file as *someone else's* —
// unknown keys survive a round trip, and a write never lands half-finished.

import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** A `customAcpAgents[]` entry, as bb's `customAcpAgentSchema` validates it. */
export interface CustomAcpAgent {
  id: string;
  displayName: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  logo?: string;
  supportsManualCompaction?: boolean;
}

/**
 * bb sets BB_DATA_DIR on every server process it starts. The fallback matters
 * only for an unusual launch; a wrong guess here writes a config file the
 * running server never reads, so prefer the env var.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.BB_DATA_DIR?.trim();
  return configured && configured.length > 0
    ? configured
    : path.join(os.homedir(), ".bb");
}

export function resolveConfigPath(dataDir: string): string {
  return path.join(dataDir, "config.json");
}

/** bb derives the provider id from the agent's slug id. */
export function toProviderId(agentId: string): string {
  return `acp-${agentId}`;
}

/**
 * The raw parsed config. Deliberately untyped beyond the one key we touch:
 * rewriting from a narrowed view would silently drop the user's other
 * settings.
 */
export type RawConfig = Record<string, unknown> & {
  customAcpAgents?: unknown[];
};

export async function readConfig(configPath: string): Promise<RawConfig> {
  let text: string;
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
  if (text.trim().length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${configPath} is not valid JSON (${(error as Error).message}). ` +
        `Fix or remove the file, then retry.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${configPath} must contain a JSON object.`);
  }
  return parsed as RawConfig;
}

/**
 * Write via a sibling temp file and rename. The bb server reloads this file on
 * request, and a torn write would take out every other setting in it.
 */
export async function writeConfig(
  configPath: string,
  config: RawConfig,
): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const temp = `${configPath}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temp, configPath);
}

function readAgentId(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const id = (entry as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

export function findAgent(
  config: RawConfig,
  agentId: string,
): CustomAcpAgent | undefined {
  const agents = config.customAcpAgents ?? [];
  const match = agents.find((entry) => readAgentId(entry) === agentId);
  return match as CustomAcpAgent | undefined;
}

/** Replace the entry with this id, or append it. Other agents are untouched. */
export function upsertAgent(
  config: RawConfig,
  agent: CustomAcpAgent,
): RawConfig {
  const agents = config.customAcpAgents ?? [];
  const index = agents.findIndex((entry) => readAgentId(entry) === agent.id);
  const next = [...agents];
  if (index === -1) {
    next.push(agent);
  } else {
    next[index] = agent;
  }
  return { ...config, customAcpAgents: next };
}

/**
 * Remove the entry. An emptied list is dropped rather than left as `[]`, so
 * disabling restores the file to what it looked like before enable.
 */
export function removeAgent(config: RawConfig, agentId: string): RawConfig {
  const agents = config.customAcpAgents ?? [];
  const next = agents.filter((entry) => readAgentId(entry) !== agentId);
  if (next.length === agents.length) {
    return config;
  }
  if (next.length === 0) {
    const { customAcpAgents: _dropped, ...rest } = config;
    return rest;
  }
  return { ...config, customAcpAgents: next };
}

export async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, constants.X_OK);
    const stat = await fs.stat(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}
