// The integration itself: what "enabled" means, and how to report on it.
//
// bb already ships a working ACP bridge (the builtin `provider-acp` plugin).
// Antigravity's own CLI has no ACP mode, so the missing pieces are a stdio
// adapter and a correct `customAcpAgents` entry pointing at it. This plugin
// owns those two things and nothing else — threads run on bb's bridge.

import path from "node:path";
import fs from "node:fs/promises";

import { installAdapter, type AdapterInstallResult } from "./adapter-install.js";
import {
  type CustomAcpAgent,
  type RawConfig,
  findAgent,
  readConfig,
  removeAgent,
  resolveConfigPath,
  toProviderId,
  upsertAgent,
  writeConfig,
} from "./config.js";
import {
  type AgyProbe,
  buildLaunchPath,
  findExecutable,
  findFirstExecutable,
  findNode,
  probeAdapterHandshake,
  probeAgy,
} from "./discover.js";
import {
  type PluginSettingsClient,
  customAgentsHas,
  readProviderAcpAgents,
  removeProviderAcpAgent,
  upsertProviderAcpAgent,
} from "./provider-acp-agents.js";

export const AGY_BINARY = "agy";
/**
 * Adapter candidates, in preference order.
 *
 * `agy-acp` (shubzkothekar/antigravity-acp) is the default: it builds on the
 * official `@agentclientprotocol/sdk`, ships signed release binaries, and
 * delegates auth to the `agy` binary it is pointed at.
 *
 * `agy-agent-acp` (jameslunardi) is recognised but needs `compatibilityShim`
 * on, and its unconditional pre-flight path guard rejects any prompt that
 * contains an absolute-looking token plus a word like "create" — which bb's
 * injected instructions always do. See README.md.
 */
export const ADAPTER_BINARIES = ["agy-acp", "agy-acp.exe", "agy-agent-acp"] as const;
export const ADAPTER_BINARY = ADAPTER_BINARIES[0];
export const ADAPTER_INSTALL_HINT =
  "The plugin downloads agy-acp into ~/.local/bin on enable. " +
  "To do it yourself: https://github.com/shubzkothekar/antigravity-acp/releases";
export const LOGO_FILE_NAME = "antigravity-acp.svg";
export const SHIM_FILE_NAME = "antigravity-acp-shim.mjs";

export type Transport = "connect" | "cli";

export interface Options {
  agentId: string;
  displayName: string;
  transport: Transport;
  /** Empty means "auto-detect". */
  agyCommand: string;
  adapterCommand: string;
  /** Wrap the adapter to normalize non-spec ACP shapes. Only agy-agent-acp needs it. */
  compatibilityShim: boolean;
}

export interface Resolved {
  agyPath?: string;
  adapterPath?: string;
  nodePath?: string;
  launchEnv: Record<string, string>;
}

/**
 * Settle on absolute paths for every executable involved. Absolute rather than
 * bare names because the launch spec is consumed by the host daemon, whose PATH
 * we do not control.
 */
export async function resolveExecutables(
  options: Options,
): Promise<Resolved> {
  const [foundAgy, foundAdapter, foundNode] = await Promise.all([
    options.agyCommand.trim() ? undefined : findExecutable(AGY_BINARY),
    options.adapterCommand.trim() ? undefined : findFirstExecutable(ADAPTER_BINARIES),
    options.compatibilityShim ? findNode() : undefined,
  ]);
  const agyPath = options.agyCommand.trim() || foundAgy;
  const adapterPath = options.adapterCommand.trim() || foundAdapter;

  const launchEnv: Record<string, string> = {
    // agy-agent-acp reads this to choose its transport; agy-acp ignores it.
    AGY_ACP_TRANSPORT: options.transport,
  };
  if (agyPath && adapterPath) {
    launchEnv.PATH = buildLaunchPath(agyPath, adapterPath);
    // Without this, agy-acp tries to download its own `agy` from a release URL
    // that 404s, instead of using the installed CLI and its credentials.
    launchEnv.AGY_BIN = agyPath;
  }

  return {
    ...(agyPath ? { agyPath } : {}),
    ...(adapterPath ? { adapterPath } : {}),
    ...(foundNode ? { nodePath: foundNode } : {}),
    launchEnv,
  };
}

/**
 * Build the entry bb validates with `customAcpAgentSchema`.
 *
 * No `modelCli`: `agy models` prints tab-separated rows, which bb's model-list
 * parser (`id - Name`, bare `provider/model`, or bullets) does not read. It is
 * unnecessary anyway — the adapter returns `configOptions` with
 * `category: "model"` from `session/new`, which is bb's native discovery path.
 *
 * No `supportsManualCompaction` either. It defaults to false, which is what the
 * adapter warrants, and older `bb` CLIs reject the key outright — writing it
 * would make every CLI invocation on a mixed install warn about this entry.
 */
export function buildAgentEntry(
  options: Options,
  resolved: Resolved,
  shimPath: string | undefined,
  logoFileName?: string,
): CustomAcpAgent {
  if (!resolved.adapterPath) {
    throw new Error(
      `Could not find an ACP adapter (${ADAPTER_BINARIES.join(" or ")}). ` +
        `${ADAPTER_INSTALL_HINT}, or set the adapterCommand setting to its ` +
        `absolute path.`,
    );
  }
  if (!resolved.agyPath) {
    throw new Error(
      `Could not find the "${AGY_BINARY}" CLI. Install it with ` +
        `\`curl -fsSL https://antigravity.google/cli/install.sh | bash\`, ` +
        `or set the agyCommand setting to its absolute path.`,
    );
  }

  const launch = buildLaunchCommand(options, resolved, shimPath);

  return {
    id: options.agentId,
    displayName: options.displayName,
    command: launch.command,
    args: launch.args,
    env: resolved.launchEnv,
    ...(logoFileName ? { logo: logoFileName } : {}),
  };
}

/**
 * Normally the adapter is launched directly. With `compatibilityShim` on it is
 * launched as `node <shim> <adapter>` — see shim/acp-normalize.mjs.
 */
export function buildLaunchCommand(
  options: Options,
  resolved: Resolved,
  shimPath: string | undefined,
): { command: string; args: string[] } {
  const adapterPath = resolved.adapterPath ?? "";
  if (!options.compatibilityShim) {
    return { command: adapterPath, args: [] };
  }
  if (!shimPath) {
    throw new Error("compatibilityShim is on but the shim is not installed.");
  }
  return { command: shimPath, args: [adapterPath] };
}

/**
 * bb resolves a relative `logo` from the data dir, not from the plugin, so the
 * asset has to be copied out. A failure here is cosmetic — enable proceeds
 * without a logo rather than failing.
 */
export async function installLogo(
  dataDir: string,
  pluginRoot: string,
): Promise<string | undefined> {
  const destination = path.join(dataDir, LOGO_FILE_NAME);
  const copied = await copyAsset(
    pluginRoot,
    path.join("icons", "antigravity.svg"),
    destination,
  );
  return copied ? LOGO_FILE_NAME : undefined;
}

/**
 * Copy the shim into the data dir and return its absolute path.
 *
 * It lives beside bb's own state rather than being referenced in the plugin
 * directory so that reinstalling the plugin from a different path, or removing
 * a `path:` checkout, cannot leave config.json pointing at a deleted file.
 * Unlike the logo, a failure here is fatal — the entry is unusable without it.
 */
export async function installShim(
  dataDir: string,
  pluginRoot: string,
): Promise<string> {
  const destination = path.join(dataDir, SHIM_FILE_NAME);
  const copied = await copyAsset(
    pluginRoot,
    path.join("shim", "acp-normalize.mjs"),
    destination,
  );
  if (!copied) {
    throw new Error(
      `Could not install the ACP compatibility shim into ${destination}.`,
    );
  }
  return destination;
}

/**
 * `pluginRoot` is the directory of the loaded module: the plugin root when bb
 * runs the source, and `dist/` when it runs a build. Try both.
 */
async function copyAsset(
  pluginRoot: string,
  relativePath: string,
  destination: string,
): Promise<boolean> {
  for (const root of [pluginRoot, path.join(pluginRoot, "..")]) {
    try {
      await fs.copyFile(path.join(root, relativePath), destination);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

export interface Status {
  providerId: string;
  dataDir: string;
  configPath: string;
  enabled: boolean;
  transport: Transport;
  agy?: AgyProbe;
  agyMissing: boolean;
  adapterPath?: string;
  adapterMissing: boolean;
  /** True when provider-acp's customAgents setting contains this agent. */
  pickerRegistered?: boolean;
  /** The entry currently in config.json, if any. */
  entry?: CustomAcpAgent;
  /** Set when the on-disk entry no longer matches current settings. */
  drift?: string;
}

export async function readStatus(
  options: Options,
  dataDir: string,
  {
    probeAuth = true,
    registry,
  }: { probeAuth?: boolean; registry?: PluginSettingsClient } = {},
): Promise<Status> {
  const configPath = resolveConfigPath(dataDir);
  const config = await readConfig(configPath);
  const entry = findAgent(config, options.agentId);
  const resolved = await resolveExecutables(options);

  let pickerRegistered: boolean | undefined;
  if (registry) {
    try {
      const agents = await readProviderAcpAgents(registry);
      pickerRegistered = customAgentsHas(agents, options.agentId);
    } catch {
      pickerRegistered = false;
    }
  }

  const status: Status = {
    providerId: toProviderId(options.agentId),
    dataDir,
    configPath,
    enabled: entry !== undefined || pickerRegistered === true,
    transport: options.transport,
    agyMissing: resolved.agyPath === undefined,
    adapterMissing: resolved.adapterPath === undefined,
    ...(pickerRegistered !== undefined ? { pickerRegistered } : {}),
    ...(resolved.adapterPath ? { adapterPath: resolved.adapterPath } : {}),
    ...(entry ? { entry } : {}),
  };

  if (resolved.agyPath && probeAuth) {
    status.agy = await probeAgy(resolved.agyPath);
  } else if (resolved.agyPath) {
    status.agy = { path: resolved.agyPath, authState: "unknown" };
  }

  if (entry) {
    const drift: string[] = [];
    const registeredAdapter = options.compatibilityShim
      ? (entry.command.includes("antigravity-acp-shim") ? entry.args?.[0] : entry.args?.[1])
      : entry.command;
    if (resolved.adapterPath && registeredAdapter !== resolved.adapterPath) {
      drift.push(
        `registered adapter is ${registeredAdapter ?? "unset"}, resolved adapter is ${resolved.adapterPath}`,
      );
    }
    const shimRegistered = entry.command.includes("antigravity-acp-shim") || (entry.args?.length ?? 0) > 0;
    if (shimRegistered !== options.compatibilityShim) {
      drift.push(
        `compatibility shim is ${shimRegistered ? "registered" : "absent"}, setting is ${options.compatibilityShim}`,
      );
    }
    if (entry.env?.AGY_BIN !== resolved.agyPath) {
      drift.push(
        `registered AGY_BIN is ${entry.env?.AGY_BIN ?? "unset"}, resolved agy is ${resolved.agyPath ?? "missing"}`,
      );
    }
    const entryTransport = entry.env?.AGY_ACP_TRANSPORT;
    if (entryTransport !== options.transport) {
      drift.push(
        `transport is ${entryTransport ?? "unset"}, setting is ${options.transport}`,
      );
    }
    if (entry.displayName !== options.displayName) {
      drift.push(
        `displayName is ${entry.displayName}, setting is ${options.displayName}`,
      );
    }
    if (drift.length > 0) {
      status.drift = drift.join("; ");
    }
  }

  return status;
}

export interface ApplyResult {
  providerId: string;
  configPath: string;
  entry: CustomAcpAgent;
  reloaded: boolean;
  reloadError?: string;
  adapterInstall?: AdapterInstallResult;
  pickerWrote?: boolean;
}

export interface EnableContext {
  registry?: PluginSettingsClient;
}

async function resolveOrInstallAdapter(
  options: Options,
): Promise<{ resolved: Resolved; adapterInstall?: AdapterInstallResult }> {
  let resolved = await resolveExecutables(options);
  if (resolved.adapterPath || options.adapterCommand.trim()) {
    return { resolved };
  }
  const adapterInstall = await installAdapter();
  resolved = await resolveExecutables(options);
  if (!resolved.adapterPath) {
    resolved = {
      ...resolved,
      adapterPath: adapterInstall.path,
    };
  }
  return { resolved, adapterInstall };
}

export async function enable(
  options: Options,
  dataDir: string,
  pluginRoot: string,
  reload: () => Promise<void>,
  context: EnableContext = {},
): Promise<ApplyResult> {
  const { resolved, adapterInstall } = await resolveOrInstallAdapter(options);
  const shimPath = options.compatibilityShim
    ? await installShim(dataDir, pluginRoot)
    : undefined;
  const logo = await installLogo(dataDir, pluginRoot);
  const entry = buildAgentEntry(options, resolved, shimPath, logo);

  const configPath = resolveConfigPath(dataDir);
  const config = await readConfig(configPath);
  await writeConfig(configPath, upsertAgent(config, entry));

  let pickerWrote: boolean | undefined;
  if (context.registry) {
    const result = await upsertProviderAcpAgent(context.registry, entry);
    pickerWrote = result.wrote;
  }

  const { reloaded, reloadError } = await tryReload(reload);
  return {
    providerId: toProviderId(options.agentId),
    configPath,
    entry,
    reloaded,
    ...(reloadError ? { reloadError } : {}),
    ...(adapterInstall ? { adapterInstall } : {}),
    ...(pickerWrote !== undefined ? { pickerWrote } : {}),
  };
}

export async function disable(
  options: Options,
  dataDir: string,
  reload: () => Promise<void>,
  context: EnableContext = {},
): Promise<{
  removed: boolean;
  pickerRemoved?: boolean;
  configPath: string;
  reloaded: boolean;
  reloadError?: string;
}> {
  const configPath = resolveConfigPath(dataDir);
  const config = await readConfig(configPath);
  const next: RawConfig = removeAgent(config, options.agentId);
  const removed = next !== config;
  if (removed) {
    await writeConfig(configPath, next);
  }

  let pickerRemoved: boolean | undefined;
  if (context.registry) {
    const result = await removeProviderAcpAgent(context.registry, options.agentId);
    pickerRemoved = result.removed;
  }

  const changed = removed || pickerRemoved === true;
  const { reloaded, reloadError } = changed
    ? await tryReload(reload)
    : { reloaded: false, reloadError: undefined };
  return {
    removed: changed,
    ...(pickerRemoved !== undefined ? { pickerRemoved } : {}),
    configPath,
    reloaded,
    ...(reloadError ? { reloadError } : {}),
  };
}

export interface BootstrapResult {
  skipped: boolean;
  reason?: string;
  apply?: ApplyResult;
  status: Status;
}

/**
 * Download the adapter if needed and register the provider. Used on plugin
 * load so `bb plugin install` is the only step.
 */
export async function bootstrap(
  options: Options,
  dataDir: string,
  pluginRoot: string,
  reload: () => Promise<void>,
  context: EnableContext = {},
): Promise<BootstrapResult> {
  const { adapterInstall } = await resolveOrInstallAdapter(options).catch(
    (error: unknown) => {
      throw new Error(
        `Could not install the ACP adapter: ${(error as Error).message}`,
      );
    },
  );
  const status = await readStatus(options, dataDir, {
    probeAuth: false,
    registry: context.registry,
  });
  if (status.agyMissing) {
    return {
      skipped: true,
      reason: `agy CLI is missing. Install it with \`curl -fsSL https://antigravity.google/cli/install.sh | bash\`, then run \`bb antigravity enable\`.`,
      status: {
        ...status,
        ...(adapterInstall ? { adapterPath: adapterInstall.path, adapterMissing: false } : {}),
      },
    };
  }
  if (status.enabled && !status.drift && status.pickerRegistered !== false) {
    return { skipped: true, reason: "already registered", status };
  }
  const apply = await enable(options, dataDir, pluginRoot, reload, context);
  return {
    skipped: false,
    apply,
    status: await readStatus(options, dataDir, {
      probeAuth: false,
      registry: context.registry,
    }),
  };
}

/**
 * A failed reload is reported, never thrown: the config write already
 * succeeded, and the user only needs to know the change lands on restart.
 */
async function tryReload(
  reload: () => Promise<void>,
): Promise<{ reloaded: boolean; reloadError?: string }> {
  try {
    await reload();
    return { reloaded: true };
  } catch (error) {
    return { reloaded: false, reloadError: (error as Error).message };
  }
}

export interface DoctorReport {
  status: Status;
  handshake?: { ok: boolean; agentName?: string; version?: string; error?: string };
}

/**
 * Handshake through the shim, not around it: the point is to exercise exactly
 * what bb will launch.
 */
export async function doctor(
  options: Options,
  dataDir: string,
  pluginRoot: string,
  context: EnableContext = {},
): Promise<DoctorReport> {
  const status = await readStatus(options, dataDir, { registry: context.registry });
  const resolved = await resolveExecutables(options);
  if (!resolved.adapterPath) {
    return { status };
  }
  const shimPath = options.compatibilityShim
    ? await installShim(dataDir, pluginRoot)
    : undefined;
  const launch = buildLaunchCommand(options, resolved, shimPath);
  const handshake = await probeAdapterHandshake(
    launch.command,
    launch.args,
    resolved.launchEnv,
  );
  return { status, handshake };
}
