'use strict';
// Teaches Claude Code and Cursor agents to print the progress lines Agent Tracker reads:
// the progress-tracking skill for both, the rule in ~/.claude/CLAUDE.md, and a Cursor sessionStart hook.
// Each step skips itself when already in place, so running it again is safe.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MARK = 'agent-tracker:progress';
const SESSION_HOOK = './hooks/agent-tracker-session-start.sh';
const BRIDGE_HOOK = './hooks/progress-bridge.sh';
const BRIDGE_EVENTS = ['beforeSubmitPrompt', 'postToolUse', 'afterAgentResponse', 'stop'];

function onPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean)
    .some((dir) => exts.some((ext) => fs.existsSync(path.join(dir, name + ext))));
}

function writeExecutable(file, content) {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function register(hooks, event, command) {
  const list = (hooks.hooks[event] = hooks.hooks[event] || []);
  if (list.some((h) => h.command === command)) return false;
  list.push({ command, timeout: 10 });
  return true;
}

function installProgressRules({ bridge = false, home = os.homedir() } = {}) {
  const report = [];
  const rule = fs.readFileSync(path.join(ROOT, 'rules', 'progress-rule.md'), 'utf8');
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'progress-tracking', 'SKILL.md'), 'utf8');

  for (const root of [path.join(home, '.claude', 'skills'), path.join(home, '.cursor', 'skills')]) {
    fs.mkdirSync(path.join(root, 'progress-tracking'), { recursive: true });
    fs.writeFileSync(path.join(root, 'progress-tracking', 'SKILL.md'), skill);
    report.push(`Skill installed in ${root}`);
  }

  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  const current = fs.existsSync(claudeMd) ? fs.readFileSync(claudeMd, 'utf8') : '';
  const block = `<!-- ${MARK} -->\n${rule}<!-- /${MARK} -->`;
  const existing = new RegExp(`<!-- ${MARK} -->[\\s\\S]*?<!-- /${MARK} -->`);
  if (current.includes(block)) {
    report.push(`Claude Code: rule already in ${claudeMd}`);
  } else if (existing.test(current)) {
    fs.writeFileSync(claudeMd, current.replace(existing, () => block));
    report.push(`Claude Code: rule updated in ${claudeMd}`);
  } else if (current.includes('[NN%]')) {
    report.push(`Claude Code: ${claudeMd} already has a progress rule, left as is`);
  } else {
    fs.appendFileSync(claudeMd, `\n${block}\n`);
    report.push(`Claude Code: rule added to ${claudeMd}`);
  }

  const hooksDir = path.join(home, '.cursor', 'hooks');
  const hooksJson = path.join(home, '.cursor', 'hooks.json');
  fs.mkdirSync(hooksDir, { recursive: true });
  let hooks;
  try {
    hooks = readJson(hooksJson, { version: 1, hooks: {} });
    hooks.hooks = hooks.hooks || {};
  } catch {
    report.push(`Cursor: ${hooksJson} isn't valid JSON, so hooks were left alone`);
    return report;
  }

  // The hook only prints prepared JSON, so it needs nothing beyond a shell.
  fs.writeFileSync(path.join(hooksDir, 'agent-tracker-session-start.json'), JSON.stringify({ additional_context: rule }));
  fs.writeFileSync(path.join(hooksDir, 'progress-rule.md'), rule);
  writeExecutable(path.join(hooksDir, 'agent-tracker-session-start.sh'),
    '#!/usr/bin/env bash\ncat >/dev/null\ncat "$(dirname "$0")/agent-tracker-session-start.json"\n');
  const others = (hooks.hooks.sessionStart || []).filter((h) => h.command !== SESSION_HOOK);
  if (others.length) {
    report.push(`Cursor: you already have a sessionStart hook (${others[0].command}), and Cursor keeps only the last one's text. ` +
      `Add the text of ${path.join(hooksDir, 'progress-rule.md')} to its additional_context.`);
  } else {
    register(hooks, 'sessionStart', SESSION_HOOK);
    report.push('Cursor: sessionStart hook registered');
  }

  if (bridge) {
    writeExecutable(path.join(hooksDir, 'progress-bridge.sh'), fs.readFileSync(path.join(ROOT, 'hooks', 'progress-bridge.sh'), 'utf8'));
    for (const event of BRIDGE_EVENTS) register(hooks, event, BRIDGE_HOOK);
    report.push(onPath('jq') ? 'Cursor: progress bridge registered' : 'Cursor: progress bridge registered, but it needs jq, which is not on your PATH');
  }

  fs.writeFileSync(hooksJson, `${JSON.stringify(hooks, null, 2)}\n`);
  report.push('New chats pick up the rule. Open chats keep the instructions they started with.');
  return report;
}

function progressRulesInstalled(home = os.homedir()) {
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  const skill = path.join(home, '.claude', 'skills', 'progress-tracking', 'SKILL.md');
  return fs.existsSync(skill) || (fs.existsSync(claudeMd) && fs.readFileSync(claudeMd, 'utf8').includes('[NN%]'));
}

module.exports = { installProgressRules, progressRulesInstalled };
