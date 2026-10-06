import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";

// The first prompt yields, so the shim sends a hidden continue. The continue
// hangs. BB then cancels. Before this fix a lost reply left BB waiting forever.
const adapter = `
const readline = require('node:readline');
let count = 0;
const send = m => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...m})+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'session/prompt') {
    count++;
    const sessionId = m.params.sessionId;
    if (count === 1) {
      send({method:'session/update', params:{sessionId, update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'The suite is running in the background. I will report back once it finishes.'}}}});
      send({id:m.id,result:{stopReason:'end_turn'}});
      return;
    }
    global.pending = m;
    send({id:1, method:'session/request_permission', params:{sessionId, options:[]}});
  } else if (m.method === 'session/cancel' && global.pending && process.env.SCENARIO === 'answers') {
    send({id:global.pending.id,result:{stopReason:'cancelled'}});
  }
});`;

for (const scenario of ["answers", "ignores"]) {
  test(`cancel during a hidden continue: agent ${scenario} cancel`, { timeout: 15000 }, async (t) => {
    const child = spawn(process.execPath, [new URL("./acp-normalize.mjs", import.meta.url).pathname, process.execPath, "-e", adapter], {
      env: { ...process.env, SCENARIO: scenario, AGY_ACP_AUTO_CONTINUE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(() => child.kill());
    child.stderr.resume();
    const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    send({ id: 1, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "go" }] } });
    for await (const line of createInterface({ input: child.stdout })) {
      const m = JSON.parse(line);
      if (m.method === "session/request_permission") {
        // An agent request that reuses the prompt id must pass through untouched.
        assert.equal(m.id, 1);
        send({ method: "session/cancel", params: { sessionId: "s" } });
        continue;
      }
      if (m.id === undefined) continue;
      assert.equal(m.id, 1, "the original prompt must receive the response");
      assert.equal(m.result?.stopReason, "cancelled");
      return;
    }
    assert.fail("shim exited without resolving the prompt");
  });
}
