// bb-plugin-antigravity — run bb threads on Google Antigravity over ACP.
//
// Antigravity's `agy` CLI has no ACP mode of its own, so this plugin wires bb's
// builtin ACP bridge to a stdio adapter and manages the `customAcpAgents` entry
// that makes `acp-antigravity` appear in the provider picker.

import { fileURLToPath } from "node:url";
import path from "node:path";

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  ADAPTER_BINARIES,
  ADAPTER_INSTALL_HINT,
  AGY_BINARY,
  type Options,
  type Status,
  type Transport,
  disable,
  doctor,
  enable,
  readStatus,
} from "./antigravity.js";
import { resolveDataDir } from "./config.js";
import { findExecutable, findFirstExecutable } from "./discover.js";

const CONFIG_RELOAD_PATH = "/api/v1/system/config/reload";

const statusSchema = z.object({
  providerId: z.string(),
  dataDir: z.string(),
  configPath: z.string(),
  enabled: z.boolean(),
  transport: z.string(),
  agyMissing: z.boolean(),
  adapterMissing: z.boolean(),
  adapterPath: z.string().optional(),
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
    };
  }

  /**
   * bb reads `customAcpAgents` at load; this is the same endpoint
   * `bb-app config refresh` posts to. Read the base URL inside the call —
   * it throws before the server is listening.
   */
  async function reloadServerConfig(): Promise<void> {
    const url = new URL(CONFIG_RELOAD_PATH, bb.server.loopbackBaseUrl);
    const response = await fetch(url, { method: "POST" });
    if (!response.ok) {
      throw new Error(
        `bb rejected the config reload with HTTP ${response.status}.`,
      );
    }
  }

  const dataDir = resolveDataDir();

  // Surface a missing prerequisite in `bb plugin list` and the UI rather than
  // failing to load — the plugin is still useful for diagnosing why.
  const [agyPath, adapterPath] = await Promise.all([
    findExecutable(AGY_BINARY),
    findFirstExecutable(ADAPTER_BINARIES),
  ]);
  if (!agyPath || !adapterPath) {
    const missing = [
      agyPath ? undefined : `${AGY_BINARY} CLI`,
      adapterPath ? undefined : `${ADAPTER_BINARIES[0]} ACP adapter`,
    ].filter(Boolean);
    bb.status.needsConfiguration(
      `Missing ${missing.join(" and ")}. Run \`bb antigravity doctor\`.`,
    );
  }

  bb.rpc.register(rpcContract, {
    status: async () => toWire(await readStatus(await options(), dataDir)),
    enable: async () => {
      try {
        const result = await enable(
          await options(),
          dataDir,
          pluginRoot,
          reloadServerConfig,
        );
        return {
          ok: true,
          message: result.reloaded
            ? `${result.providerId} is available in the provider picker.`
            : `Wrote ${result.providerId}. Reload failed (${result.reloadError}); restart bb to apply.`,
          status: toWire(await readStatus(await options(), dataDir)),
        };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
    disable: async () => {
      try {
        const result = await disable(
          await options(),
          dataDir,
          reloadServerConfig,
        );
        return {
          ok: true,
          message: result.removed
            ? "Removed the Antigravity provider."
            : "Nothing to remove.",
          status: toWire(await readStatus(await options(), dataDir)),
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
      const positional = argv.filter((arg) => !arg.startsWith("-"));
      const subcommand = positional[0] ?? "status";
      const current = await options();

      try {
        switch (subcommand) {
          case "status": {
            const status = await readStatus(current, dataDir);
            return json
              ? ok(JSON.stringify(toWire(status), null, 2))
              : ok(renderStatus(status));
          }

          case "doctor": {
            const report = await doctor(current, dataDir, pluginRoot);
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

          case "enable": {
            const result = await enable(
              current,
              dataDir,
              pluginRoot,
              reloadServerConfig,
            );
            const shimmed = (result.entry.args?.length ?? 0) > 0;
            const lines = [
              `Registered ${result.providerId} in ${result.configPath}`,
              `  adapter   ${shimmed ? result.entry.args?.[1] : result.entry.command}`,
              ...(shimmed
                ? [`  shim      ${result.entry.command} ${result.entry.args?.[0]}`]
                : []),
              `  AGY_BIN   ${result.entry.env?.AGY_BIN}`,
              result.reloaded
                ? `\n${result.providerId} is now in the provider picker. Try:\n  bb thread spawn --provider ${result.providerId} --prompt "..."`
                : `\nConfig reload failed (${result.reloadError}). Restart bb to apply.`,
            ];
            return ok(lines.join("\n"));
          }

          case "disable": {
            const result = await disable(current, dataDir, reloadServerConfig);
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
                "Usage: bb antigravity <status|doctor|enable|disable> [--json]\n",
            };
        }
      } catch (error) {
        return { exitCode: 1, stderr: `${(error as Error).message}\n` };
      }
    },
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

function renderStatus(status: Status): string {
  const lines = [
    `Provider   ${status.providerId}  ${status.enabled ? "registered" : "not registered"}`,
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

  if (!status.enabled && !status.agyMissing && !status.adapterMissing) {
    lines.push("\nReady to register. Run `bb antigravity enable`.");
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
