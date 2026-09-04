import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTINUE_PROMPT,
  PromptTurn,
  autoContinueEnabled,
  looksLikeYield,
} from "./continue-policy.mjs";

test("the live analytics-page yield is treated as incomplete", () => {
  const text =
    "The background task to capture screenshots of the current statistics page is running. I will inspect the results once it finishes.";
  assert.equal(looksLikeYield(text), true);
});

test("the live e2e-test yield is treated as incomplete", () => {
  const text =
    "I have updated the Analytics page with the new design and started the e2e test suite (`test:statistics-today`) to verify all interactions. I will report back as soon as the test finishes.";
  assert.equal(looksLikeYield(text), true);
});

test("a finished summary is not a yield", () => {
  assert.equal(
    looksLikeYield("Redesigned the analytics page. The e2e suite passed."),
    false,
  );
});

test("background command launched and wait pattern is recognized", () => {
  assert.equal(
    looksLikeYield("I have launched the test:unit command and will wait for it to finish."),
    true,
  );
  assert.equal(
    looksLikeYield("I will wait for the typecheck command to finish."),
    true,
  );
  assert.equal(
    looksLikeYield("Wait for typecheck to complete"),
    true,
  );
  assert.equal(
    looksLikeYield("I will now edit the CategorySheet component."),
    true,
  );
  assert.equal(
    looksLikeYield("Let me check the implementation in CategorySheet.tsx."),
    true,
  );
});

test("PromptTurn auto-continues when turn ran tools but produced no agent text", () => {
  const turn = new PromptTurn();
  turn.onToolCall();
  turn.onToolCall();
  // No onAgentText called (like in thr_s47zevpizn where it was searching and thinking)
  assert.equal(turn.shouldContinue("end_turn", null), true);
});

test("PromptTurn auto-continues when last event was a tool call", () => {
  const turn = new PromptTurn();
  turn.onAgentText("Checking files...");
  turn.onToolCall();
  assert.equal(turn.shouldContinue("end_turn", null), true);
});

test("PromptTurn auto-continues on agy error or timeout", () => {
  const turn = new PromptTurn();
  assert.equal(turn.shouldContinue("end_turn", "Error: timeout waiting for response"), true);
});

test("PromptTurn does not continue when turn is genuinely complete", () => {
  const turn = new PromptTurn();
  turn.onToolCall();
  turn.onAgentText("I have completed all changes requested to the categories page and tests pass.");
  assert.equal(turn.shouldContinue("end_turn", null), false);
});

test("PromptTurn auto-continues end_turn yields and stops after the cap", () => {
  const turn = new PromptTurn();
  turn.onAgentText("The background task is running. I will inspect the results once it finishes.");
  assert.equal(turn.shouldContinue("end_turn", null, 2), true);
  turn.markContinued();
  turn.onAgentText("Still waiting for the test.");
  assert.equal(turn.shouldContinue("cancelled", null, 2), false);
  turn.onAgentText(" I will report back as soon as the test finishes.");
  assert.equal(turn.shouldContinue("end_turn", null, 2), true);
  turn.markContinued();
  turn.onAgentText("I will report back as soon as the test finishes.");
  assert.equal(turn.shouldContinue("end_turn", null, 2), false);
});

test("auto-continue can be disabled with AGY_ACP_AUTO_CONTINUE=0", () => {
  assert.equal(autoContinueEnabled({ AGY_ACP_AUTO_CONTINUE: "0" }), false);
  assert.equal(autoContinueEnabled({}), true);
});

test("continue prompt is a single user nudge, not empty", () => {
  assert.ok(CONTINUE_PROMPT.includes("Continue"));
});
