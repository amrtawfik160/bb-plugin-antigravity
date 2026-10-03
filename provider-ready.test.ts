import assert from "node:assert/strict";
import test from "node:test";
import { waitForProviderAcp } from "./provider-ready.ts";

test("provider setup waits for ACP registration during plugin startup", async () => {
  let calls = 0;
  await waitForProviderAcp({
    async getSettings() {
      if (++calls < 3) throw new Error("HTTP 404: plugin not found");
      return { values: {} };
    },
    async updateSettings() {},
  }, new AbortController().signal, { attempts: 3, delayMs: 1 });
  assert.equal(calls, 3);
});

test("provider setup stops on disposal and does not retry other errors", async () => {
  let calls = 0;
  const client = {
    async getSettings(): Promise<{ values: Record<string, unknown> }> {
      calls++;
      throw new Error("HTTP 500: unavailable");
    },
    async updateSettings() {},
  };
  await assert.rejects(waitForProviderAcp(client, new AbortController().signal), /HTTP 500/);
  assert.equal(calls, 1);
  const abort = new AbortController();
  const pending = waitForProviderAcp({ ...client, async getSettings() { throw new Error("HTTP 404: plugin not found"); } }, abort.signal);
  abort.abort(new Error("disposed"));
  await assert.rejects(pending, /disposed/);
});
