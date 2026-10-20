// Turns the flat model list agy-acp advertises into model families plus a
// reasoning-effort axis, without hardcoding which models exist.
//
// agy encodes effort as an id suffix: `opus-5.5-max`, `opus-5.5-high`, ...
// Those collapse into family `opus-5.5` with efforts max/high/medium/low.
// Models with no effort suffix (`auto`, `gemini-3.5-flash-lite`) become
// single-variant families and pass through unchanged. New models therefore
// appear in bb as soon as agy lists them.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const EFFORT_SUFFIXES = ["max", "xhigh", "high", "medium", "low", "minimal"];
const DEFAULT_EFFORT_PREFERENCE = ["high", "medium", "max", "xhigh", "low", "minimal"];

export const DEFAULT_CACHE_PATH = path.join(os.homedir(), ".bb", "antigravity-acp-models.json");

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   efforts: string[],
 *   defaultEffort: string | null,
 *   raw: Record<string, string>,
 * }} ModelFamily
 * `raw` maps an effort (or `default` for an unsuffixed model) to the raw id.
 */

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {{ value?: unknown, name?: unknown }[]} rawOptions
 * @returns {ModelFamily[]}
 */
export function discoverFamilies(rawOptions) {
  /** @type {Map<string, ModelFamily>} */
  const byId = new Map();
  for (const opt of rawOptions ?? []) {
    const rawId = typeof opt?.value === "string" ? opt.value : undefined;
    if (!rawId) continue;
    const rawName = typeof opt.name === "string" && opt.name ? opt.name : rawId;

    let effort = null;
    let familyId = rawId;
    let familyName = rawName;
    for (const eff of EFFORT_SUFFIXES) {
      if (rawId.endsWith(`-${eff}`) && rawId.length > eff.length + 1) {
        effort = eff;
        familyId = rawId.slice(0, -(eff.length + 1));
        familyName =
          rawName.replace(new RegExp(`\\s*\\(${escapeRegExp(eff)}\\)\\s*$`, "i"), "").trim() ||
          familyId;
        break;
      }
    }

    let fam = byId.get(familyId);
    if (!fam) {
      fam = { id: familyId, name: familyName, efforts: [], defaultEffort: null, raw: {} };
      byId.set(familyId, fam);
    }
    if (effort) {
      if (!fam.efforts.includes(effort)) fam.efforts.push(effort);
      fam.raw[effort] = rawId;
    } else {
      fam.raw.default = rawId;
      fam.name = rawName;
    }
  }

  for (const fam of byId.values()) {
    fam.defaultEffort =
      DEFAULT_EFFORT_PREFERENCE.find((e) => fam.efforts.includes(e)) ?? fam.efforts[0] ?? null;
  }
  return [...byId.values()];
}

/** Parse `agy models` output: `<id><tab or 2+ spaces><name>` per line. */
export function parseAgyModelsOutput(stdout) {
  const rawOptions = [];
  for (const line of String(stdout).split("\n")) {
    // Spinner frames are separated by \r; keep only what follows the last one.
    const parts = line.slice(line.lastIndexOf("\r") + 1).trim().split(/\t+|\s{2,}/);
    if (parts.length >= 2 && parts[0] && !parts[0].includes(" ")) {
      rawOptions.push({ value: parts[0], name: parts.slice(1).join(" ").trim() });
    }
  }
  return rawOptions;
}

export class ModelCatalog {
  /**
   * @param {{ cachePath?: string | null, listModels?: () => string }} [options]
   * `cachePath: null` disables the cache. `listModels` returns `agy models`
   * output and is the last resort for an id the catalog has never seen.
   */
  constructor({ cachePath = DEFAULT_CACHE_PATH, listModels } = {}) {
    this.cachePath = cachePath;
    this.listModels = listModels;
    /** @type {ModelFamily[]} */
    this.families = [];
    this.signature = "";
    this.lastCliRefresh = 0;
  }

  /** Seed from the cache so a new process can translate ids before session/new. */
  loadCache() {
    if (!this.cachePath) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cachePath, "utf8"));
      if (Array.isArray(parsed?.families)) this.set(parsed.families, false);
    } catch {
      // no cache yet
    }
  }

  set(families, persist = true) {
    if (!Array.isArray(families) || families.length === 0) return;
    const signature = JSON.stringify(families);
    if (signature === this.signature) return;
    this.families = families;
    this.signature = signature;
    if (!persist || !this.cachePath) return;
    try {
      fs.writeFileSync(this.cachePath, `${JSON.stringify({ families }, null, 2)}\n`);
    } catch {
      // the cache is best-effort
    }
  }

  /** Learn from an adapter `configOptions` array, if it carries the raw list. */
  learn(configOptions) {
    if (!Array.isArray(configOptions)) return;
    const modelOpt = configOptions.find(
      (o) => (o?.id === "model" || o?.category === "model") && Array.isArray(o.options),
    );
    if (modelOpt && modelOpt.options.length > 0) this.set(discoverFamilies(modelOpt.options));
  }

  refreshFromCli() {
    if (!this.listModels || Date.now() - this.lastCliRefresh < 60_000) return;
    this.lastCliRefresh = Date.now();
    try {
      this.set(discoverFamilies(parseAgyModelsOutput(this.listModels())));
    } catch (err) {
      process.stderr.write(`acp-normalize: could not refresh models: ${err.message}\n`);
    }
  }

  find(familyId) {
    return this.families.find((f) => f.id === familyId);
  }

  /** @returns {{ family: ModelFamily, effort: string } | undefined} */
  ofRaw(rawId) {
    for (const family of this.families) {
      for (const [effort, raw] of Object.entries(family.raw)) {
        if (raw === rawId) return { family, effort };
      }
    }
    return undefined;
  }

  /** Raw id -> family id and effort. Unknown ids come back as their own family. */
  decompose(rawId, fallbackEffort) {
    if (!rawId || typeof rawId !== "string") {
      const f = this.families[0];
      return { familyId: f?.id ?? rawId, effort: f?.defaultEffort ?? fallbackEffort };
    }
    const hit = this.ofRaw(rawId);
    if (hit) {
      return {
        familyId: hit.family.id,
        effort: hit.effort === "default" ? (hit.family.defaultEffort ?? fallbackEffort) : hit.effort,
      };
    }
    const f = this.find(rawId);
    if (f) return { familyId: f.id, effort: f.defaultEffort ?? fallbackEffort };
    return { familyId: rawId, effort: fallbackEffort };
  }

  /** Family id + effort -> the raw id agy expects. Raw or unknown ids pass through. */
  compose(familyId, effort) {
    let f = this.find(familyId);
    if (!f && !this.ofRaw(familyId)) {
      this.refreshFromCli();
      f = this.find(familyId);
    }
    if (!f) return familyId;
    if (effort && f.raw[effort]) return f.raw[effort];
    if (f.raw.default) return f.raw.default;
    if (f.defaultEffort && f.raw[f.defaultEffort]) return f.raw[f.defaultEffort];
    return familyId;
  }

  /**
   * The `model` and `thought_level` options bb should see. Returns null when
   * nothing has been learned yet, so callers can pass the adapter's list on.
   * A family with no effort variants gets no `thought_level` option.
   */
  buildOptions(activeFamilyId, activeEffort) {
    if (this.families.length === 0) return null;
    const f = this.find(activeFamilyId) ?? this.families[0];
    const model = {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: f.id,
      options: this.families.map((fam) => ({ value: fam.id, name: fam.name })),
    };
    if (f.efforts.length === 0) return { model, thoughtLevel: null };
    const thoughtLevel = {
      id: "thought_level",
      name: "Reasoning Effort",
      category: "thought_level",
      type: "select",
      currentValue: f.efforts.includes(activeEffort) ? activeEffort : f.defaultEffort,
      options: f.efforts.map((e) => ({ value: e, name: e.charAt(0).toUpperCase() + e.slice(1) })),
    };
    return { model, thoughtLevel };
  }
}
