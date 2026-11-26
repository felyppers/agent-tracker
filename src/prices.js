'use strict';
// USD per 1M tokens, from docs.claude.com/en/docs/about-claude/pricing. cacheHit is the multiplier on input
// price for cache reads; cache writes cost 1.25x input for the 5-minute TTL and 2x for the 1-hour TTL.
// long applies to prompts over LONG_PROMPT tokens. Override or extend with the agentTracker.prices setting.
const PRICES = {
  'claude-fable-5-2': { input: 8, output: 40, cacheHit: 0.025 },
  'claude-mythos-5-2': { input: 8, output: 40, cacheHit: 0.025 },
  'claude-fable-5-1': { input: 10, output: 50, cacheHit: 0.025 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheHit: 0.025 },
  'claude-fable-5': { input: 10, output: 50, cacheHit: 0.1 },
  'claude-mythos-5': { input: 10, output: 50, cacheHit: 0.1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheHit: 0.05 },
  'claude-opus-5': { input: 5, output: 25, cacheHit: 0.1 },
  'claude-opus-4-8': { input: 5, output: 25, cacheHit: 0.1 },
  'claude-opus-4-7': { input: 5, output: 25, cacheHit: 0.1 },
  'claude-opus-4-6': { input: 5, output: 25, cacheHit: 0.1 },
  'claude-opus-4-5': { input: 5, output: 25, cacheHit: 0.1 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheHit: 0.05 },
  'claude-sonnet-5': { input: 2, output: 10, cacheHit: 0.1 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheHit: 0.1 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheHit: 0.1 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheHit: 0.1, long: { input: 0.5, output: 2.5 } },
  'claude-haiku-4-5': { input: 1, output: 5, cacheHit: 0.1 },
};
const LONG_PROMPT = 100_000;
const WEB_SEARCH_USD = 0.01;

function promptTokens(u) {
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

function priceFor(model, extra) {
  const table = { ...PRICES, ...(extra || {}) };
  const prefix = Object.keys(table)
    .filter((p) => model.startsWith(p))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? table[prefix] : null;
}

function replyCost(model, u, extra) {
  const price = priceFor(model || '', extra);
  if (!price) return null;
  let { input, output } = price;
  if (price.long && promptTokens(u) > LONG_PROMPT) ({ input, output } = price.long);
  const hit = price.cacheHit ?? 0.1;
  const writes = u.cache_creation || {};
  const write1h = writes.ephemeral_1h_input_tokens || 0;
  const write5m = writes.ephemeral_5m_input_tokens ?? Math.max((u.cache_creation_input_tokens || 0) - write1h, 0);
  let usd =
    ((u.input_tokens || 0) * input +
      write5m * input * 1.25 +
      write1h * input * 2 +
      (u.cache_read_input_tokens || 0) * input * hit +
      (u.output_tokens || 0) * output) /
    1_000_000;
  if (u.speed === 'fast') usd *= 2;
  if (u.inference_geo === 'us') usd *= 1.1;
  return usd + ((u.server_tool_use || {}).web_search_requests || 0) * WEB_SEARCH_USD;
}

const SYSTEM_PROMPT_TOKENS = 20_000;
const CHARS_PER_TOKEN = 4;

// Rough API-price estimate for a chat that records no token counts (Cursor). Assumes context grows evenly
// from the system prompt to its current size, each call re-reads it from cache, and each call's growth is a
// fresh cache write. Visible output is chars / 4; hidden thinking is not counted, so this undershoots.
function estimateCost(model, { calls, context, outChars }, extra) {
  const price = priceFor(model || '', extra);
  if (!price) return null;
  const base = Math.min(context, SYSTEM_PROMPT_TOKENS);
  const read = (calls * (base + context)) / 2;
  const written = Math.max(context - base, 0) + base;
  const output = Math.round(outChars / CHARS_PER_TOKEN);
  const hit = price.cacheHit ?? 0.1;
  const usd = (Math.max(read - written, 0) * price.input * hit + written * price.input * 1.25 + output * price.output) / 1_000_000;
  return { usd, output };
}

module.exports = { replyCost, promptTokens, estimateCost };
