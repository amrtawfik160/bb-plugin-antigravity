// bb 0.41 registers custom ACP agents from the builtin provider-acp plugin's
// `customAgents` setting. The old `customAcpAgents` array in config.json is
// still written for older bb, but it does not put the provider in the picker
// on 0.41. This module upserts our entry into that setting without touching
// anyone else's agents.

import type { CustomAcpAgent } from "./config.js";

export const PROVIDER_ACP_PLUGIN_ID = "provider-acp";

export interface PluginSettingsClient {
  getSettings(args: { pluginId: string }): Promise<{ values: Record<string, unknown> }>;
  updateSettings(args: {
    pluginId: string;
    values: Record<string, unknown>;
  }): Promise<unknown>;
}

/** Fields the customAgents setting accepts. `logo` is not one of them. */
export function toCustomAgentsEntry(agent: CustomAcpAgent): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: agent.id,
    displayName: agent.displayName,
    command: agent.command,
  };
  if (agent.args && agent.args.length > 0) entry.args = agent.args;
  if (agent.env && Object.keys(agent.env).length > 0) entry.env = agent.env;
  if (agent.cwd) entry.cwd = agent.cwd;
  return entry;
}

export function parseCustomAgentsSetting(value: unknown): unknown[] {
  if (Array.isArray(value)) return [...value];
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `provider-acp customAgents is not valid JSON (${(error as Error).message}).`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("provider-acp customAgents must be a JSON array.");
  }
  return parsed;
}

function readId(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const id = (entry as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

export function upsertCustomAgent(list: unknown[], agent: CustomAcpAgent): unknown[] {
  const next = [...list];
  const index = next.findIndex((entry) => readId(entry) === agent.id);
  const item = toCustomAgentsEntry(agent);
  if (index === -1) {
    next.push(item);
  } else {
    next[index] = item;
  }
  return next;
}

export function removeCustomAgent(list: unknown[], agentId: string): unknown[] {
  return list.filter((entry) => readId(entry) !== agentId);
}

export function customAgentsHas(list: unknown[], agentId: string): boolean {
  return list.some((entry) => readId(entry) === agentId);
}

export async function readProviderAcpAgents(
  client: PluginSettingsClient,
): Promise<unknown[]> {
  const settings = await client.getSettings({ pluginId: PROVIDER_ACP_PLUGIN_ID });
  return parseCustomAgentsSetting(settings.values.customAgents);
}

export async function writeProviderAcpAgents(
  client: PluginSettingsClient,
  agents: unknown[],
): Promise<void> {
  await client.updateSettings({
    pluginId: PROVIDER_ACP_PLUGIN_ID,
    values: {
      customAgents: agents.length === 0 ? "" : JSON.stringify(agents),
    },
  });
}

export async function upsertProviderAcpAgent(
  client: PluginSettingsClient,
  agent: CustomAcpAgent,
): Promise<{ wrote: boolean }> {
  const current = await readProviderAcpAgents(client);
  const next = upsertCustomAgent(current, agent);
  const unchanged =
    current.length === next.length &&
    JSON.stringify(current) === JSON.stringify(next);
  if (unchanged) return { wrote: false };
  await writeProviderAcpAgents(client, next);
  return { wrote: true };
}

export async function removeProviderAcpAgent(
  client: PluginSettingsClient,
  agentId: string,
): Promise<{ removed: boolean }> {
  const current = await readProviderAcpAgents(client);
  const next = removeCustomAgent(current, agentId);
  if (next.length === current.length) return { removed: false };
  await writeProviderAcpAgents(client, next);
  return { removed: true };
}
