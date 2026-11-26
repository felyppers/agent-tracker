'use strict';
// Tags a session by the kind of work its opening prompt asks for. An explicit slash command or skill wins;
// otherwise the tag with the most keyword hits does. Extend or override with the agentTracker.tagRules setting.

const COMMANDS = [
  [/(^|\s)\/(review|code-review|pr-review|security-review)\b|skills\/review\//, 'review'],
  [/(^|\s)\/(fix|bugfix)\b|skills\/fix\//, 'fix'],
  [/(^|\s)\/(plan|spec|tech-spec|design)\b/, 'plan'],
  [/(^|\s)\/(work|build|implement|feature)\b|skills\/work\//, 'build'],
  [/(^|\s)\/(debug|investigate|triage|oncall)\b/, 'debug'],
  [/(^|\s)\/(report|digest|standup|summary)\b/, 'report'],
  [/(^|\s)\/(test|qa|e2e)\b/, 'test'],
  [/\bread-only\b|^\s*(decide|research|investigate|explore)\b/i, 'research'],
  [/^\s*(find (bugs|pr defects)|review|adversarial review)\b/i, 'review'],
];

const KEYWORDS = {
  review: /\b(review|find bugs|defects?|audit the pr|look over|feedback on)\b/gi,
  fix: /\b(fix(es|ing)?|resolve (the )?threads?|address (the )?comments|compliance|failing checks?|ci (is )?fail\w*)\b/gi,
  build: /\b(implement\w*|build|create|add (a|an|the)?\s*\w+|scaffold|feature|ticket|endpoint|migration|refactor\w*|i'?d like (a|an|to)|plugin|extension|dashboard|script)\b/gi,
  debug: /\b(debug\w*|error|exception|crash\w*|broken|not working|doesn'?t work|stack ?trace|why (is|does)|root cause|ECONNREFUSED|timeout)\b/gi,
  research: /\b(research|read-only|explore|investigate|how does|what is|compare|options for|find out|look into|decide|decision)\b/gi,
  report: /\b(report|digest|summary|summari[sz]e|status update|metrics|weekly|recap|list (all|the))\b/gi,
  test: /\b(tests?|qa|e2e|screenshots?|verify|smoke)\b/gi,
  docs: /\b(docs?|document\w*|readme|pr description|write[- ]up|guideline)\b/gi,
  plan: /\b(plan(s|ning)?|tech spec|design doc|spec out|scope (this|it|the)|roadmap|break (it|this) down|approach for)\b/gi,
  ops: /\b(deploy\w*|infra|terraform|pulumi|disk|storage|free space|caches?|clean ?up|install|upgrade|config(ure)?)\b/gi,
};

function compile(extra) {
  const rules = { ...KEYWORDS };
  for (const [tag, pattern] of Object.entries(extra || {})) {
    try {
      rules[tag] = new RegExp(pattern, 'gi');
    } catch {}
  }
  return rules;
}

function tagsFor(text, extra) {
  const body = String(text || '').slice(0, 4000);
  for (const [re, tag] of COMMANDS) if (re.test(body)) return [tag];
  const rules = compile(extra);
  const scored = Object.entries(rules)
    .map(([tag, re]) => [tag, (body.match(re) || []).length])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!scored.length) return ['general'];
  const [first, second] = scored;
  return second && second[1] >= Math.max(2, first[1] * 0.75) ? [first[0], second[0]] : [first[0]];
}

const KNOWN_TAGS = [...new Set([...Object.keys(KEYWORDS), 'general'])];

module.exports = { tagsFor, KNOWN_TAGS };
