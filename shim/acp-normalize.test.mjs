import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";

// A real stdio peer reproduces an adapter ending after tools without a reply.
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
      if (process.env.SCENARIO !== 'blank') send({method:'session/update', params:{sessionId, update:{sessionUpdate:'tool_call',toolCallId:'t1',title:'Read file',status:'completed'}}});
    } else if (process.env.SCENARIO === 'cancel') {
      global.pending = m;
      send({method:'session/update', params:{sessionId, update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Waiting for cancellation'}}}});
      return;
    } else if (process.env.SCENARIO !== 'empty') {
      send({method:'session/update', params:{sessionId, update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Finished and verified.'}}}});
    }
    send({id:m.id,result:{stopReason:'end_turn'}});
  } else if (m.method === 'session/cancel' && global.pending) {
    send({id:global.pending.id,result:{stopReason:'cancelled'}});
  }
});`;

for (const scenario of ["recover", "blank", "empty", "cancel", "disabled"]) {
  test(`stdio silent stop: ${scenario}`, { timeout: 5000 }, async (t) => {
    const child = spawn(process.execPath, [process.env.SHIM_PATH || new URL("./acp-normalize.mjs", import.meta.url).pathname, process.execPath, "-e", adapter], {
      env: { ...process.env, SCENARIO: scenario, AGY_ACP_AUTO_CONTINUE: scenario === "disabled" ? "0" : "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(() => child.stdin.end());
    child.stderr.resume();
    const send = m => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    send({ id: 42, method: "session/prompt", params: { sessionId: "session", prompt: [{ type: "text", text: "Finish the task" }] } });
    let finalText = "";
    for await (const line of createInterface({ input: child.stdout })) {
      const m = JSON.parse(line);
      const text = m.params?.update?.content?.text;
      if (text) {
        finalText += text;
        if (scenario === "cancel") send({ method: "session/cancel", params: { sessionId: "session" } });
      }
      if (m.id === undefined) continue;
      assert.equal(m.id, 42, "the original prompt must receive the response");
      if (scenario === "recover" || scenario === "blank") assert.equal(finalText, "Finished and verified.");
      if (scenario === "empty") assert.match(m.error?.message ?? "", /without.*reply/i);
      if (scenario === "cancel") assert.equal(m.result?.stopReason, "cancelled");
      if (scenario === "disabled") assert.equal(finalText, "");
      return;
    }
    assert.fail("shim exited without resolving the prompt");
  });
}
