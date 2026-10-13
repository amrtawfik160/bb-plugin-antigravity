import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import { ModelCatalog, discoverFamilies, parseAgyModelsOutput } from "./model-families.mjs";

// What agy-acp 1.2 advertises in session/new (trimmed).
const RAW = [
  { value: "auto", name: "Gemini Pro Next" },
  { value: "gemini-launch-candidate-high", name: "Gemini 4 Argon (High)" },
  { value: "gemini-launch-candidate-medium", name: "Gemini 4 Argon (Medium)" },
  { value: "gemini-launch-candidate-low", name: "Gemini 4 Argon (Low)" },
  { value: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" },
  { value: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro" },
  { value: "opus-5.5-max", name: "Claude Opus 5.5 (Max)" },
  { value: "opus-5.5-high", name: "Claude Opus 5.5 (High)" },
  { value: "opus-5.5-medium", name: "Claude Opus 5.5 (Medium)" },
  { value: "opus-5.5-low", name: "Claude Opus 5.5 (Low)" },
];

const modelConfig = (currentValue = "auto") => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue,
  options: RAW,
});

test("discoverFamilies groups effort variants and keeps plain models", () => {
  const families = discoverFamilies(RAW);
  assert.deepEqual(
    families.map((f) => [f.id, f.name, f.efforts.join(","), f.defaultEffort]),
    [
      ["auto", "Gemini Pro Next", "", null],
      ["gemini-launch-candidate", "Gemini 4 Argon", "high,medium,low", "high"],
      ["gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", "", null],
      ["gemini-3.1-pro", "Gemini 3.1 Pro", "high", "high"],
      ["opus-5.5", "Claude Opus 5.5", "max,high,medium,low", "high"],
    ],
  );
});

test("compose and decompose round-trip through raw ids", () => {
  const catalog = new ModelCatalog({ cachePath: null });
  catalog.set(discoverFamilies(RAW));
  assert.equal(catalog.compose("opus-5.5", "max"), "opus-5.5-max");
  assert.equal(catalog.compose("opus-5.5", "bogus"), "opus-5.5-high");
  assert.equal(catalog.compose("gemini-3.5-flash-lite", "high"), "gemini-3.5-flash-lite");
  assert.equal(catalog.compose("opus-5.5-low", "high"), "opus-5.5-low", "raw ids pass through");
  assert.equal(catalog.compose("unknown-model", "high"), "unknown-model");
  assert.deepEqual(catalog.decompose("opus-5.5-low", "high"), { familyId: "opus-5.5", effort: "low" });
  assert.deepEqual(catalog.decompose("auto", "medium"), { familyId: "auto", effort: "medium" });
});

test("buildOptions omits thought_level for single-variant families", () => {
  const catalog = new ModelCatalog({ cachePath: null });
  assert.equal(catalog.buildOptions("auto", "high"), null);
  catalog.learn([modelConfig()]);
  assert.equal(catalog.buildOptions("auto", "high").thoughtLevel, null);
  const opus = catalog.buildOptions("opus-5.5", "max");
  assert.equal(opus.thoughtLevel.currentValue, "max");
  assert.equal(opus.model.options.length, 5);
});

test("the cache seeds a new catalog", () => {
  const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-models-")), "m.json");
  const first = new ModelCatalog({ cachePath });
  first.learn([modelConfig()]);
  const second = new ModelCatalog({ cachePath });
  second.loadCache();
  assert.equal(second.compose("opus-5.5", "low"), "opus-5.5-low");
});

test("parseAgyModelsOutput reads tab or space separated rows past the spinner", () => {
  const out = "\r⠋ Fetching available models...\rauto                Gemini Pro Next\nopus-5.5-max\tClaude Opus 5.5 (Max)\n";
  assert.deepEqual(parseAgyModelsOutput(out), [
    { value: "auto", name: "Gemini Pro Next" },
    { value: "opus-5.5-max", name: "Claude Opus 5.5 (Max)" },
  ]);
});

// End to end through the shim with a fake adapter that records model switches.
const adapter = `
const readline = require('node:readline');
const RAW = ${JSON.stringify(RAW)};
let current = 'auto';
const send = m => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...m})+'\\n');
const config = () => [{id:'model',name:'Model',category:'model',type:'select',currentValue:current,options:RAW},
  {id:'mode',name:'Mode',category:'mode',type:'select',currentValue:'default',options:[{value:'default',name:'Standard'}]}];
readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'session/new') send({id:m.id, result:{sessionId:'s', configOptions:config()}});
  if (m.method === 'session/set_config_option') { current = m.params.value; send({id:m.id, result:{configOptions:config()}}); }
});`;

test("shim exposes families and maps selections to raw ids", { timeout: 5000 }, async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-models-"));
  const child = spawn(
    process.execPath,
    [new URL("./acp-normalize.mjs", import.meta.url).pathname, process.execPath, "-e", adapter],
    {
      env: { ...process.env, AGY_ACP_MODEL_CACHE: path.join(cacheDir, "m.json"), AGY_BIN: "/nonexistent" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  t.after(() => child.stdin.end());
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const call = async (id, method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    for (;;) {
      const { value } = await lines.next();
      const m = JSON.parse(value);
      if (m.id === id) return m.result.configOptions;
    }
  };
  const pick = (opts, id) => opts.find((o) => o.id === id);

  let opts = await call(1, "session/new", { cwd: cacheDir, mcpServers: [] });
  assert.deepEqual(pick(opts, "model").options.map((o) => o.value),
    ["auto", "gemini-launch-candidate", "gemini-3.5-flash-lite", "gemini-3.1-pro", "opus-5.5"]);
  assert.equal(pick(opts, "thought_level"), undefined, "auto has no effort variants");
  assert.ok(pick(opts, "mode"), "other options pass through");

  opts = await call(2, "session/set_config_option", { sessionId: "s", configId: "model", value: "opus-5.5" });
  assert.equal(pick(opts, "model").currentValue, "opus-5.5");
  assert.equal(pick(opts, "thought_level").currentValue, "high");

  opts = await call(3, "session/set_config_option", { sessionId: "s", configId: "thought_level", value: "max" });
  assert.equal(pick(opts, "thought_level").currentValue, "max");

  opts = await call(4, "session/set_config_option", { sessionId: "s", configId: "model", value: "gemini-launch-candidate" });
  assert.deepEqual(pick(opts, "thought_level").options.map((o) => o.value), ["high", "medium", "low"]);
  assert.equal(pick(opts, "thought_level").currentValue, "high", "max is unavailable, so fall back");
});
