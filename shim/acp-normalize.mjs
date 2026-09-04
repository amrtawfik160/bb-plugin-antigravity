#!/usr/bin/env node
// A stdio pass-through and normalizer for Antigravity ACP in bb.
//
// 1. Normalizes models and reasoning efforts into clean model families
//    (Gemini 3.8 Flash, Gemini 3.7 Flash, Gemini 3.6 Flash, Gemini 3.1 Pro, etc.)
//    paired with a native `thought_level` config option (Low, Medium, High).
//    This eliminates duplicate reasoning tags ("Gemini 3.7 Flash High Medium") in the UI.
// 2. Maps `session/set_config_option` for both model and thought_level back
//    to the underlying raw variant ids (`gemini-3.8-flash-high`, etc.).
// 3. Normalizes `session/new` model arrays to `{ currentModelId, availableModels }`
//    for backward-compatibility with older ACP adapters.
// 4. Answers `models` CLI invocations with clean `id - Name` lines.

import { spawn, execFileSync } from "node:child_process";
import {
  CONTINUE_PROMPT,
  PromptTurn,
  autoContinueEnabled,
} from "./continue-policy.mjs";

const args = process.argv.slice(2);

// Handle CLI `models` subcommand if invoked directly
if (args[0] === "models") {
  try {
    const agyBin = process.env.AGY_BIN || "agy";
    const stdout = execFileSync(agyBin, ["models"], { encoding: "utf8", timeout: 15000 });
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("Fetching")) continue;
      const parts = trimmed.split("\t");
      if (parts.length >= 2) {
        process.stdout.write(`${parts[0]} - ${parts[1]}\n`);
      } else {
        process.stdout.write(`${trimmed}\n`);
      }
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Failed to list models: ${err.message}\n`);
    process.exit(1);
  }
}

const [adapterPath, ...adapterArgs] = args;

if (!adapterPath) {
  process.stderr.write("acp-normalize: missing adapter path\n");
  process.exit(64);
}

const FAMILIES = [
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", efforts: ["high", "medium", "low"], defaultEffort: "high" },
  { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash", efforts: ["high", "medium", "low"], defaultEffort: "high" },
  { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", efforts: ["high", "medium", "low"], defaultEffort: "high" },
  { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", efforts: ["high", "low"], defaultEffort: "high" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)", efforts: ["medium"], defaultEffort: "medium" },
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", efforts: ["medium"], defaultEffort: "medium" },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", efforts: ["medium"], defaultEffort: "medium" },
];

const CLEAN_MODEL_OPTIONS = FAMILIES.map((f) => ({
  value: f.id,
  name: f.name,
}));

function decomposeRawId(rawId) {
  if (!rawId || typeof rawId !== "string") return { familyId: "gemini-3.8-flash", effort: "high" };
  for (const f of FAMILIES) {
    for (const e of f.efforts) {
      if (rawId === `${f.id}-${e}` || (f.efforts.length === 1 && rawId === f.id)) {
        return { familyId: f.id, effort: e };
      }
    }
    if (rawId === f.id) {
      return { familyId: f.id, effort: f.defaultEffort };
    }
  }
  return { familyId: rawId, effort: "medium" };
}

function composeRawId(familyId, effort) {
  const f = FAMILIES.find((cand) => cand.id === familyId);
  if (!f) return familyId;
  const eff = f.efforts.includes(effort) ? effort : f.defaultEffort;
  if (f.efforts.length === 1 && f.efforts[0] === "medium" && !f.id.endsWith("-medium")) {
    return f.id;
  }
  if (f.id.endsWith(`-${eff}`)) return f.id;
  return `${f.id}-${eff}`;
}

let activeFamilyId = "gemini-3.8-flash";
let activeEffort = "high";
const pendingRequests = new Map();

function buildCleanConfigOptions(existingOptions = []) {
  const f = FAMILIES.find((cand) => cand.id === activeFamilyId) ?? FAMILIES[0];
  const effortOptions = f.efforts.map((e) => ({
    value: e,
    name: e.charAt(0).toUpperCase() + e.slice(1),
  }));

  const modelOpt = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: activeFamilyId,
    options: CLEAN_MODEL_OPTIONS,
  };

  const thoughtOpt = {
    id: "thought_level",
    name: "Reasoning Effort",
    category: "thought_level",
    type: "select",
    currentValue: f.efforts.includes(activeEffort) ? activeEffort : f.defaultEffort,
    options: effortOptions,
  };

  const otherOptions = (existingOptions || []).filter(
    (opt) =>
      opt.id !== "model" &&
      opt.category !== "model" &&
      opt.id !== "thought_level" &&
      opt.category !== "thought_level",
  );

  return [modelOpt, thoughtOpt, ...otherOptions];
}

function normalizeModel(model) {
  if (typeof model !== "object" || model === null) return undefined;
  const modelId = model.modelId ?? model.value ?? model.id;
  if (typeof modelId !== "string" || modelId.length === 0) return undefined;
  const name = model.name ?? model.label ?? modelId;
  const normalized = { ...model, modelId, name };
  if (
    normalized.description === undefined &&
    typeof model.label === "string" &&
    model.label !== name
  ) {
    normalized.description = model.label;
  }
  return normalized;
}

function normalizeResult(result, reqMeta) {
  if (typeof result !== "object" || result === null) return result;
  const res = { ...result };

  if (reqMeta?.type === "set_thought_level") {
    activeEffort = reqMeta.value;
  } else if (reqMeta?.type === "set_model") {
    activeFamilyId = reqMeta.value;
  }

  if (Array.isArray(res.configOptions)) {
    const rawModelOpt = res.configOptions.find((o) => o.id === "model" || o.category === "model");
    if (rawModelOpt?.currentValue && !reqMeta) {
      const dec = decomposeRawId(rawModelOpt.currentValue);
      activeFamilyId = dec.familyId;
      activeEffort = dec.effort;
    }
    res.configOptions = buildCleanConfigOptions(res.configOptions);
  }

  if (Array.isArray(res.models)) {
    const availableModels = res.models
      .map(normalizeModel)
      .filter((m) => m !== undefined);
    if (availableModels.length > 0) {
      const currentModelId =
        typeof res.activeModelId === "string"
          ? res.activeModelId
          : typeof res.currentModelId === "string"
            ? res.currentModelId
            : availableModels[0].modelId;
      res.models = { currentModelId, availableModels };
    }
  }

  return res;
}

function normalizeInboundLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }

  if (typeof message !== "object" || message === null) return line;

  const { method, params, id } = message;

  if (method === "session/set_config_option" && params) {
    const { configId, value, sessionId } = params;
    if (configId === "thought_level" || configId === "thoughtLevel") {
      activeEffort = value;
      const rawModelId = composeRawId(activeFamilyId, activeEffort);
      if (id !== undefined) {
        pendingRequests.set(String(id), { type: "set_thought_level", value });
      }
      return JSON.stringify({
        ...message,
        params: {
          ...params,
          configId: "model",
          value: rawModelId,
        },
      });
    }

    if (configId === "model") {
      const dec = decomposeRawId(value);
      activeFamilyId = dec.familyId;
      if (dec.effort && dec.effort !== "medium") {
        activeEffort = dec.effort;
      }
      const rawModelId = composeRawId(activeFamilyId, activeEffort);
      if (id !== undefined) {
        pendingRequests.set(String(id), { type: "set_model", value: activeFamilyId });
      }
      return JSON.stringify({
        ...message,
        params: {
          ...params,
          configId: "model",
          value: rawModelId,
        },
      });
    }
  }

  if (method === "session/new" || method === "session/load" || method === "session/resume") {
    if (params?.model) {
      const raw = composeRawId(params.model, activeEffort);
      return JSON.stringify({
        ...message,
        params: { ...params, model: raw },
      });
    }
  }

  return line;
}

function normalizeOutboundLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }

  if (typeof message !== "object" || message === null) return line;

  if (message.id !== undefined && message.result !== undefined) {
    const reqMeta = pendingRequests.get(String(message.id));
    if (reqMeta) pendingRequests.delete(String(message.id));
    const result = normalizeResult(message.result, reqMeta);
    return JSON.stringify({ ...message, result });
  }

  if (message.method === "session/update" && message.params?.update?.configOptions) {
    const configOptions = buildCleanConfigOptions(message.params.update.configOptions);
    return JSON.stringify({
      ...message,
      params: {
        ...message.params,
        update: {
          ...message.params.update,
          configOptions,
        },
      },
    });
  }

  return line;
}

const currentExtra = process.env.AGY_EXTRA_ARGS || "";
if (!currentExtra.includes("--print-timeout")) {
  process.env.AGY_EXTRA_ARGS = `${currentExtra} --print-timeout 60m`.trim();
}

const child = spawn(adapterPath, adapterArgs, {
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});

// agy-acp runs `agy -p` per prompt and returns end_turn when the process
// exits. Antigravity often yields after starting a background command,
// or finishes tool execution before producing final text, or hits print timeouts.
// Hold the original session/prompt RPC open and nudge the same session
// until the last assistant text no longer looks like an incomplete turn or yield.
let promptTurn = null;
let promptOrigin = null;
let continueSeq = 0;

function isContinueId(id) {
  return typeof id === "string" && id.startsWith("bb-antigravity-continue-");
}

function sendContinue(sessionId) {
  continueSeq += 1;
  const id = `bb-antigravity-continue-${continueSeq}`;
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: CONTINUE_PROMPT }],
      },
    })}\n`,
  );
  process.stderr.write(
    `acp-normalize: auto-continue ${promptTurn?.count ?? 0} for session ${sessionId}\n`,
  );
}

function handleInboundMessage(message) {
  if (message.method === "session/prompt" && !isContinueId(message.id)) {
    promptOrigin = {
      id: message.id,
      sessionId: message.params?.sessionId,
    };
    promptTurn = new PromptTurn();
  }
  if (message.method === "session/cancel") {
    promptTurn = null;
    promptOrigin = null;
  }
}

function rewriteOutbound(message) {
  const update = message.params?.update;
  if (message.method === "session/update" && update) {
    if (update.sessionUpdate === "tool_call") {
      promptTurn?.onToolCall();
    }
    const text = update.content?.text;
    if (update.sessionUpdate === "agent_message_chunk" && typeof text === "string") {
      promptTurn?.onAgentText(text);
    }
    if (typeof text === "string" && text.includes(CONTINUE_PROMPT)) {
      return null;
    }
  }

  const isPromptReply =
    message.id !== undefined &&
    promptOrigin !== null &&
    (message.id === promptOrigin.id || isContinueId(message.id));
  if (!isPromptReply) return message;

  const stopReason = message.result?.stopReason;
  const resultError = message.result?.error || message.error;
  if (
    autoContinueEnabled() &&
    promptTurn &&
    promptOrigin.sessionId &&
    promptTurn.shouldContinue(stopReason, resultError)
  ) {
    promptTurn.markContinued();
    sendContinue(promptOrigin.sessionId);
    return null;
  }

  return { ...message, id: promptOrigin.id };
}

child.on("error", (error) => {
  process.stderr.write(`acp-normalize: cannot spawn ${adapterPath}: ${error.message}\n`);
  process.exit(127);
});

// Buffer stdin lines before sending to child
let inBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inBuffer += chunk;
  let newline = inBuffer.indexOf("\n");
  while (newline !== -1) {
    const line = inBuffer.slice(0, newline);
    inBuffer = inBuffer.slice(newline + 1);
    const normalized = line.length > 0 ? normalizeInboundLine(line) : line;
    if (normalized.length > 0) {
      try {
        handleInboundMessage(JSON.parse(normalized));
      } catch {
        // pass-through of a non-JSON line
      }
    }
    child.stdin.write(`${normalized}\n`);
    newline = inBuffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  if (inBuffer.length > 0) {
    child.stdin.write(`${normalizeInboundLine(inBuffer)}\n`);
    inBuffer = "";
  }
  child.stdin.end();
});

child.stdin.on("error", () => {});

// Buffer stdout lines from child before writing to process.stdout
let outBuffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  outBuffer += chunk;
  let newline = outBuffer.indexOf("\n");
  while (newline !== -1) {
    const line = outBuffer.slice(0, newline);
    outBuffer = outBuffer.slice(newline + 1);
    const normalized = line.length > 0 ? normalizeOutboundLine(line) : line;
    if (normalized.length > 0) {
      let outbound = normalized;
      let drop = false;
      try {
        const rewritten = rewriteOutbound(JSON.parse(normalized));
        if (rewritten === null) drop = true;
        else outbound = JSON.stringify(rewritten);
      } catch {
        // keep the normalized line
      }
      if (!drop) process.stdout.write(`${outbound}\n`);
    }
    newline = outBuffer.indexOf("\n");
  }
});

child.stdout.on("end", () => {
  if (outBuffer.length > 0) {
    process.stdout.write(`${normalizeOutboundLine(outBuffer)}\n`);
    outBuffer = "";
  }
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
