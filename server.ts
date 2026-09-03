// bb-plugin-antigravity — run bb threads on Google Antigravity over ACP.
//
// Antigravity's `agy` CLI has no ACP mode of its own, so this plugin downloads
// a stdio adapter, wraps it with a model-normalizing shim, and registers
// `acp-antigravity` with bb's ACP bridge. On bb 0.41 that means writing the
// builtin provider-acp plugin's `customAgents` setting; older bb still reads
// `customAcpAgents` from config.json, so both are kept in sync.

import { fileURLToPath } from "node:url";
import path from "node:path";

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { installAdapter } from "./adapter-install.js";
import {
  ADAPTER_BINARIES,
  ADAPTER_INSTALL_HINT,
  AGY_BINARY,
  type Options,
  type Status,
  type Transport,
  bootstrap,
  disable,
  doctor,
  enable,
  readStatus,
} from "./antigravity.js";
import { resolveDataDir } from "./config.js";
import { findExecutable, findFirstExecutable } from "./discover.js";

const OPTED_OUT_KEY = "optedOut";

const statusSchema = z.object({
  providerId: z.string(),
  dataDir: z.string(),
  configPath: z.string(),
  enabled: z.boolean(),
  transport: z.string(),
  agyMissing: z.boolean(),
  adapterMissing: z.boolean(),
  adapterPath: z.string().optional(),
  pickerRegistered: z.boolean().optional(),
  drift: z.string().optional(),
  agy: z
    .object({
      path: z.string(),
      version: z.string().optional(),
      authState: z.enum(["ok", "failed", "unknown"]),
      modelCount: z.number().optional(),
      error: z.string().optional(),
    })
    .optional(),
});

export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: statusSchema },
  enable: {
    input: z.null(),
    output: z.object({
      ok: z.boolean(),
      message: z.string(),
      status: statusSchema.optional(),
    }),
  },
  disable: {
    input: z.null(),
    output: z.object({
      ok: z.boolean(),
      message: z.string(),
      status: statusSchema.optional(),
    }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
  const registry = bb.sdk.plugins;

  const settings = bb.settings.define({
    agentId: {
      type: "string",
      label: "Agent id",
      default: "antigravity",
      description: "bb exposes this as provider id acp-<id>.",
    },
    displayName: {
      type: "string",
      label: "Display name",
      default: "Antigravity",
      description: "Shown in the provider picker.",
    },
    transport: {
      type: "select",
      label: "Transport",
      options: ["connect", "cli"],
      default: "connect",
      description:
        "connect holds one agy language server warm (~1.3s/turn, per-tool-call " +
        "permission prompts). cli spawns agy per turn (~3.4s/turn, blanket " +
        "per-turn permission) and is the fallback if the private API breaks.",
    },
    adapterCommand: {
      type: "string",
      label: "Adapter path",
      default: "",
      description: `Absolute path to the ACP adapter. Empty auto-detects ${ADAPTER_BINARIES.join(", then ")}.`,
    },
    agyCommand: {
      type: "string",
      label: "agy path",
      default: "",
      description: `Absolute path to the ${AGY_BINARY} CLI. Empty means auto-detect.`,
    },
    compatibilityShim: {
      type: "boolean",
      label: "Compatibility & Model Normalization Shim",
      default: true,
      description:
        "Wrap the adapter to normalize models into clean families and provide native " +
        "reasoning effort (Low / Medium / High) in the composer picker.",
    },
    autoContinue: {
      type: "boolean",
      label: "Auto-continue when Antigravity yields",
      default: true,
      description:
        "agy-acp ends the ACP turn when print-mode agy exits. If the last " +
        "assistant text says it is waiting on background work, send Continue on " +
        "the same session instead of going idle.",
    },
  });

  async function options(): Promise<Options> {
    const current = await settings.get();
    return {
      agentId: current.agentId,
      displayName: current.displayName,
      transport: current.transport as Transport,
      adapterCommand: current.adapterCommand,
      agyCommand: current.agyCommand,
      compatibilityShim: current.compatibilityShim,
      autoContinue: current.autoContinue,
    };
  }

  async function reloadServerConfig(): Promise<void> {
    await bb.sdk.system.reloadConfig();
  }

  async function currentStatus(): Promise<Status> {
    return await readStatus(await options(), dataDir, { registry });
  }

  const dataDir = resolveDataDir();

  const [agyPath, adapterPath] = await Promise.all([
    findExecutable(AGY_BINARY),
    findFirstExecutable(ADAPTER_BINARIES),
  ]);
  if (!agyPath) {
    bb.status.needsConfiguration(
      `Missing ${AGY_BINARY} CLI. Install it with \`curl -fsSL https://antigravity.google/cli/install.sh | bash\`, then reload.`,
    );
  }

  bb.rpc.register(rpcContract, {
    status: async () => toWire(await currentStatus()),
    enable: async () => {
      try {
        await bb.storage.kv.delete(OPTED_OUT_KEY);
        const result = await enable(
          await options(),
          dataDir,
          pluginRoot,
          reloadServerConfig,
          { registry },
        );
        return {
          ok: true,
          message: result.reloaded
            ? `${result.providerId} is available in the provider picker.`
            : `Wrote ${result.providerId}. Reload failed (${result.reloadError}); restart bb to apply.`,
          status: toWire(await currentStatus()),
        };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
    disable: async () => {
      try {
        await bb.storage.kv.set(OPTED_OUT_KEY, true);
        const result = await disable(
          await options(),
          dataDir,
          reloadServerConfig,
          { registry },
        );
        return {
          ok: true,
          message: result.removed
            ? "Removed the Antigravity provider."
            : "Nothing to remove.",
          status: toWire(await currentStatus()),
        };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
  });

  bb.cli.register({
    name: "antigravity",
    summary: "Run bb threads on Google Antigravity over ACP",
    commands: [
      {
        name: "status",
        summary: "Show whether the Antigravity ACP provider is wired up",
        usage: "bb antigravity status [--json]",
      },
      {
        name: "doctor",
        summary:
          "Check the agy CLI, its subscription, and the ACP adapter handshake",
        usage: "bb antigravity doctor [--json]",
      },
      {
        name: "install",
        summary:
          "Download agy-acp if needed and register the provider in the picker",
        usage: "bb antigravity install [--force] [--json]",
      },
      {
        name: "enable",
        summary: "Register the Antigravity ACP provider with bb",
        usage: "bb antigravity enable",
      },
      {
        name: "disable",
        summary: "Remove the Antigravity ACP provider from bb",
        usage: "bb antigravity disable",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const force = argv.includes("--force");
      const positional = argv.filter((arg) => !arg.startsWith("-"));
      const subcommand = positional[0] ?? "status";
      const current = await options();

      try {
        switch (subcommand) {
          case "status": {
            const status = await readStatus(current, dataDir, { registry });
            return json
              ? ok(JSON.stringify(toWire(status), null, 2))
              : ok(renderStatus(status));
          }

          case "doctor": {
            const report = await doctor(current, dataDir, pluginRoot, { registry });
            return json
              ? ok(
                  JSON.stringify(
                    { ...report, status: toWire(report.status) },
                    null,
                    2,
                  ),
                )
              : ok(renderDoctor(report.status, report.handshake));
          }

          case "install": {
            const adapter = await installAdapter({ force });
            await bb.storage.kv.delete(OPTED_OUT_KEY);
            const result = await enable(
              current,
              dataDir,
              pluginRoot,
              reloadServerConfig,
              { registry },
            );
            if (json) {
              return ok(
                JSON.stringify(
                  {
                    adapter,
                    providerId: result.providerId,
                    pickerWrote: result.pickerWrote ?? null,
                    reloaded: result.reloaded,
                  },
                  null,
                  2,
                ),
              );
            }
            return ok(renderEnable(result, adapter.path));
          }

          case "enable": {
            await bb.storage.kv.delete(OPTED_OUT_KEY);
            const result = await enable(
              current,
              dataDir,
              pluginRoot,
              reloadServerConfig,
              { registry },
            );
            return json
              ? ok(
                  JSON.stringify(
                    {
                      providerId: result.providerId,
                      pickerWrote: result.pickerWrote ?? null,
                      reloaded: result.reloaded,
                      adapter: result.adapterInstall ?? null,
                    },
                    null,
                    2,
                  ),
                )
              : ok(renderEnable(result));
          }

          case "disable": {
            await bb.storage.kv.set(OPTED_OUT_KEY, true);
            const result = await disable(
              current,
              dataDir,
              reloadServerConfig,
              { registry },
            );
            if (!result.removed) {
              return ok(`No Antigravity entry in ${result.configPath}.`);
            }
            return ok(
              `Removed the Antigravity provider from ${result.configPath}.` +
                (result.reloaded
                  ? ""
                  : `\nConfig reload failed (${result.reloadError}). Restart bb to apply.`),
            );
          }

          default:
            return {
              exitCode: 2,
              stderr:
                `Unknown subcommand "${subcommand}".\n` +
                "Usage: bb antigravity <status|doctor|install|enable|disable> [--json]\n",
            };
        }
      } catch (error) {
        return { exitCode: 1, stderr: `${(error as Error).message}\n` };
      }
    },
  });

  bb.background.service("auto-setup", {
    async start(signal) {
      if (signal.aborted) return;
      if (await bb.storage.kv.get<boolean>(OPTED_OUT_KEY)) {
        bb.log.info("auto-setup skipped — provider was disabled on purpose");
        return;
      }
      try {
        const result = await bootstrap(
          await options(),
          dataDir,
          pluginRoot,
          reloadServerConfig,
          { registry },
        );
        if (result.skipped && result.reason && result.status.agyMissing) {
          bb.status.needsConfiguration(result.reason);
          bb.log.warn(result.reason);
          return;
        }
        if (result.skipped) {
          bb.log.info(`auto-setup skipped (${result.reason ?? "already registered"})`);
          return;
        }
        bb.log.info(
          `auto-setup registered ${result.apply?.providerId}` +
            (result.apply?.adapterInstall?.downloaded ? " and downloaded agy-acp" : ""),
        );
      } catch (error) {
        const message = (error as Error).message;
        bb.log.warn(`auto-setup failed: ${message}`);
        bb.status.needsConfiguration(message);
      }
    },
  });

  bb.agents.configure((context) => {
    if (context.provider.id !== "acp-antigravity") {
      return { tools: [], skills: [] };
    }
    return {
      tools: [],
      skills: [],
      instructions:
        "You are running through ACP print-mode (`agy -p`). That process exits as soon as you yield. " +
        "Do not stop because a command, test, screenshot, or background task is still running. " +
        "Wait for it, then keep going until the user's original task is finished.",
    };
  });

  bb.log.info(
    `ready (agy: ${agyPath ?? "missing"}, adapter: ${adapterPath ?? "missing"})`,
  );
}

function ok(stdout: string): { exitCode: number; stdout: string } {
  return { exitCode: 0, stdout: stdout.endsWith("\n") ? stdout : `${stdout}\n` };
}

/** Drop the full entry — the wire type only carries what the UI renders. */
function toWire(status: Status): z.infer<typeof statusSchema> {
  const { entry: _entry, ...rest } = status;
  return rest;
}

function adapterLaunchPath(entry: {
  command: string;
  args?: string[];
}): string {
  const shimmed = entry.command.includes("antigravity-acp-shim");
  if (shimmed) return entry.args?.[0] ?? entry.command;
  return entry.command;
}

function renderEnable(
  result: {
    providerId: string;
    configPath: string;
    entry: { command: string; args?: string[]; env?: Record<string, string> };
    reloaded: boolean;
    reloadError?: string;
    adapterInstall?: { path: string; downloaded: boolean };
    pickerWrote?: boolean;
  },
  adapterOverride?: string,
): string {
  const adapter =
    adapterOverride ??
    result.adapterInstall?.path ??
    adapterLaunchPath(result.entry);
  const shimmed = result.entry.command.includes("antigravity-acp-shim");
  const lines = [
    `Registered ${result.providerId} in ${result.configPath}`,
    `  adapter   ${adapter}`,
    ...(result.adapterInstall?.downloaded ? ["  adapter   downloaded"] : []),
    ...(shimmed ? [`  shim      ${result.entry.command}`] : []),
    `  AGY_BIN   ${result.entry.env?.AGY_BIN}`,
    result.pickerWrote === false
      ? "  picker    already listed"
      : "  picker    provider-acp customAgents",
    result.reloaded
      ? `\n${result.providerId} is now in the provider picker. Try:\n  bb thread spawn --provider ${result.providerId} --prompt "..."`
      : `\nConfig reload failed (${result.reloadError}). Restart bb to apply.`,
  ];
  return lines.join("\n");
}

function renderStatus(status: Status): string {
  const picker =
    status.pickerRegistered === true
      ? "in picker"
      : status.pickerRegistered === false
        ? "not in picker"
        : status.enabled
          ? "registered"
          : "not registered";
  const lines = [
    `Provider   ${status.providerId}  ${picker}`,
    `Config     ${status.configPath}`,
    `Transport  ${status.transport}`,
  ];

  lines.push(
    status.agy
      ? `agy        ${status.agy.path}${status.agy.version ? ` (${status.agy.version})` : ""}` +
          `\n           ${renderAuth(status.agy)}`
      : `agy        MISSING — curl -fsSL https://antigravity.google/cli/install.sh | bash`,
  );

  lines.push(
    status.adapterPath
      ? `adapter    ${status.adapterPath}`
      : `adapter    MISSING — ${ADAPTER_INSTALL_HINT}`,
  );

  if (status.drift) {
    lines.push(
      `\nThe registered entry is stale: ${status.drift}.\nRun \`bb antigravity enable\` to rewrite it.`,
    );
  }

  if (!status.enabled && status.agyMissing) {
    lines.push(
      "\nInstall and log into agy, then run `bb antigravity enable` (or reload the plugin).",
    );
  }

  return lines.join("\n");
}

function renderAuth(agy: NonNullable<Status["agy"]>): string {
  switch (agy.authState) {
    case "ok":
      return `subscription live, ${agy.modelCount} models`;
    case "failed":
      return `NOT authenticated${agy.error ? ` — ${agy.error}` : ""} — run \`agy\` once to log in`;
    default:
      return (
        "auth unverified from the bb server process (its keychain reach differs " +
        "from the host daemon that launches the agent) — not a blocker"
      );
  }
}

function renderDoctor(
  status: Status,
  handshake?: { ok: boolean; agentName?: string; version?: string; error?: string },
): string {
  const lines = [renderStatus(status), ""];
  if (!handshake) {
    lines.push("ACP        skipped — the adapter was not found.");
  } else if (handshake.ok) {
    lines.push(
      `ACP        handshake ok — ${handshake.agentName ?? "agent"} ${handshake.version ?? ""}`.trimEnd(),
    );
  } else {
    lines.push(`ACP        handshake FAILED — ${handshake.error}`);
  }
  return lines.join("\n");
}
