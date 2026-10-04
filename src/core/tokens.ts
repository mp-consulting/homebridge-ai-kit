/** Rough token maths, good enough to keep inputs inside a model's context window. */

const CHARS_PER_TOKEN = 4;

/** Estimated token count of `text` (~4 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface TrimOptions {
  /** Which end to keep. `tail` (default) suits logs, where the newest lines matter most. */
  keep?: 'head' | 'tail';
}

/**
 * Cut `text` to roughly `maxTokens`, on a line boundary when possible, and
 * say how much was dropped so the model knows it is not seeing everything.
 */
export function trimToContext(text: string, maxTokens: number, { keep = 'tail' }: TrimOptions = {}): string {
  const maxChars = Math.max(0, Math.floor(maxTokens * CHARS_PER_TOKEN));
  if (text.length <= maxChars) {
    return text;
  }
  if (keep === 'tail') {
    let kept = text.slice(text.length - maxChars);
    const nl = kept.indexOf('\n');
    if (nl !== -1 && nl < kept.length - 1) {
      kept = kept.slice(nl + 1);
    }
    return `[… ${text.length - kept.length} earlier characters trimmed]\n${kept}`;
  }
  let kept = text.slice(0, maxChars);
  const nl = kept.lastIndexOf('\n');
  if (nl > 0) {
    kept = kept.slice(0, nl);
  }
  return `${kept}\n[… ${text.length - kept.length} later characters trimmed]`;
}

/**
 * Tokens left for variable input once the output and a fixed overhead
 * (system prompt, instructions) are reserved, capped at `cap`.
 */
export function inputBudget(contextTokens: number, maxOutputTokens: number, cap = Infinity, overhead = 1024): number {
  return Math.max(256, Math.min(cap, contextTokens - maxOutputTokens - overhead));
}
