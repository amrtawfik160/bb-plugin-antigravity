// agy-acp runs `agy -p` for every ACP prompt. Print mode exits as soon as the
// model yields — including when it parks a background command, hits an intermediate
// tool boundary, or says it will look later. BB then treats the turn as done.
// This policy decides when to send another prompt on the same session so the user
// does not have to type "continue".

export const CONTINUE_PROMPT =
  "Continue. Wait for any running commands or background work. Do not stop until the user's original task is finished.";

export const MAX_AUTO_CONTINUES = 16;

const YIELD_PATTERNS = [
  /\b(?:background|async)\s+(?:task|job|process|command|agent|timer)\b/i,
  /\bis\s+running\b/i,
  /\bin\s+the\s+background\b/i,
  /\b(?:once|when|after)\s+(?:it|that|this|the\s+[\w\s-]+?)\s+(?:finishes|completes|is\s+done|terminates)\b/i,
  /\bas\s+soon\s+as\b/i,
  /\bwaiting\s+(?:for|on)\b/i,
  /\bwait\s+for\s+(?:it|them|(?:the\s+)?[\w\s-]+?)\s+(?:to\s+)?(?:finish|complete|run|end)\b/i,
  /\b(?:let's|let\s+us|let\s+me)\s+wait\b/i,
  /\b(?:will|shall|i'll|we'll)\s+(?:wait|inspect|check|report|continue|look|come\s+back|report\s+back|proceed|update|fix|modify|edit|implement|run|test|create|verify|now)\b/i,
  /\breport\s+back\b/i,
  /\b(?:let\s+me|let's|let\s+us)\s+(?:now\s+)?(?:check|inspect|verify|run|test|implement|edit|modify|fix|update|see|find|look|search)\b/i,
  /\b(?:next|upcoming)\s+step\b/i,
  /\b(?:now|next)\s+(?:i\s+will|we\s+will|i\s+need\s+to|let's|i'll)\b/i,
  /\bproceeding\s+to\b/i,
  /\b(?:in\s+progress|currently\s+(?:running|working|checking|testing|implementing|building))\b/i,
  /\bworking\s+on\s+(?:it|this)\b/i,
  /\bhang\s+on\b/i,
  /\bone\s+moment\b/i,
  /\bstill\s+(?:running|working|waiting|in\s+progress)\b/i,
  /\bi\s+am\s+(?:now\s+)?(?:checking|looking|investigating|running|analyzing|working\s+on|proceeding)\b/i,
];

export function looksLikeYield(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return YIELD_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export class PromptTurn {
  constructor() {
    this.lastText = "";
    this.count = 0;
    this.toolCallCount = 0;
    this.lastEventWasToolCall = false;
  }

  onToolCall() {
    this.toolCallCount += 1;
    this.lastEventWasToolCall = true;
  }

  onAgentText(chunk) {
    if (typeof chunk === "string" && chunk.length > 0) {
      this.lastText += chunk;
      this.lastEventWasToolCall = false;
    }
  }

  shouldContinue(stopReason, error, max = MAX_AUTO_CONTINUES) {
    if (this.count >= max) return false;
    if (stopReason === "cancelled") return false;

    // 1. If agy exited with an error (e.g. timeout or non-zero exit)
    if (error) return true;

    // Print mode can exit silently even before emitting a tool call.
    if (stopReason === "end_turn" && this.lastText.trim().length === 0) {
      return true;
    }

    // 3. If the very last event received was a tool call (yielded before responding)
    if (this.lastEventWasToolCall) {
      return true;
    }

    // 4. If the assistant text indicates in-progress work or waiting for a task
    if (looksLikeYield(this.lastText)) {
      return true;
    }

    return false;
  }

  markContinued() {
    this.count += 1;
    this.lastText = "";
    this.lastEventWasToolCall = false;
  }
}

export function autoContinueEnabled(env = process.env) {
  const raw = env.AGY_ACP_AUTO_CONTINUE;
  if (raw === "0" || raw === "false") return false;
  return true;
}
