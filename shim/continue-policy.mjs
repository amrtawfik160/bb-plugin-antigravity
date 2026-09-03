// agy-acp runs `agy -p` for every ACP prompt. Print mode exits as soon as the
// model yields — including when it parks a background command and says it will
// look later. BB then treats the turn as done. This policy decides when to
// send another prompt on the same session so the user does not have to type
// "continue".

export const CONTINUE_PROMPT =
  "Continue. Wait for any running commands or background work. Do not stop until the user's original task is finished.";

export const MAX_AUTO_CONTINUES = 16;

const YIELD_PATTERNS = [
  /\bbackground (?:task|job|process|command|agent)\b/i,
  /\bis running\b/i,
  /\bin the background\b/i,
  /\bonce (?:it|that|this) finishes\b/i,
  /\bas soon as\b/i,
  /\bwaiting for\b/i,
  /\bwhen (?:it|that|the tests?|the command) (?:is )?(?:done|complete|finished)\b/i,
  /\bi(?:['’]ll| will) (?:inspect|check|report|continue|wait|look|come back|report back)\b/i,
  /\bi will report back\b/i,
  /\breport back (?:as soon as|once|when)\b/i,
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
  }

  onAgentText(chunk) {
    if (typeof chunk === "string" && chunk.length > 0) {
      this.lastText += chunk;
    }
  }

  shouldContinue(stopReason, max = MAX_AUTO_CONTINUES) {
    if (stopReason !== "end_turn") return false;
    if (this.count >= max) return false;
    return looksLikeYield(this.lastText);
  }

  markContinued() {
    this.count += 1;
    this.lastText = "";
  }
}

export function autoContinueEnabled(env = process.env) {
  const raw = env.AGY_ACP_AUTO_CONTINUE;
  if (raw === "0" || raw === "false") return false;
  return true;
}
