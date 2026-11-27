'use strict';
// Reads Cursor and Claude Code transcripts from disk and reduces each to a session summary.
// Files are tailed by byte offset, so a rescan only parses lines appended since the last one.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { replyCost, promptTokens, estimateCost } = require('./prices');
const { tagsFor } = require('./tags');
const { composerInfo, liveMessages } = require('./cursorDb');
const { listProcesses, descendants } = require('./procs');

const HOME = os.homedir();
const CURSOR_PROJECTS = path.join(HOME, '.cursor', 'projects');
const CURSOR_HOOK_STATE = path.join(HOME, '.cursor', 'progress');
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
const CLAUDE_SESSIONS = path.join(HOME, '.claude', 'sessions');

// A progress line starts its own line: "**[85%]** 4/5 — did X · next: Y". Mid-sentence mentions don't count.
const MARKER = /^[ \t>]*(?:\*\*)?\[(\d{1,3})%\](?:\*\*)?[ \t]*(.*)$/gm;
const WORK_PROMPT = /skills\/work\/SKILL\.md|Run the `?\/work`? skill|^\s*\/work\b|<command-name>\/?work<\/command-name>/m;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const TICKET = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/;
const BRANCH = /(?<![\w/.-])(?:feature|bugfix|hotfix|fix|chore)\/[\w.-]+/g;
const NOT_INSTRUCTION = new RegExp(
  [
    '<task-notification',
    '<system_notification',
    '<local-command-',
    '<command-message>[^<]*</command-message>\\s*$',
    // Cursor's own follow-ups when a background subagent or shell finishes.
    '^\\s*Briefly inform the user about the task result',
    '^\\s*Perform any necessary follow-up actions in response to',
  ].join('|'),
);
const CHUNK = 4 * 1024 * 1024;
const LIVE_WINDOW_MS = 6 * 3600 * 1000;
const FLUSH_SLACK_MS = 60 * 1000;
// Agent worktrees live at ~/.cursor/worktrees/<name>/<repo> (Cursor) or <repo>/.claude/worktrees/<name> (Claude Code).
// Separators may be / or \, and transcripts store a backslash JSON-escaped as \\.
const SEP = String.raw`(?:/|\\{1,2})`;
const SEG = String.raw`[\w.-]+`;
const ABS = String.raw`(?:~${SEP}|/|[A-Za-z]:${SEP})(?:${SEG}${SEP})*?`;
const WORKTREE_PATH = new RegExp(
  String.raw`${ABS}\.cursor${SEP}worktrees${SEP}${SEG}${SEP}${SEG}|${ABS}\.claude${SEP}worktrees${SEP}${SEG}`,
);

function worktreePath(raw) {
  return path.normalize(raw.replace(/\\\\/g, '\\').replace(/^~(?=[\\/])/, HOME));
}
// Only paths an agent worked in count as its worktree, not ones it merely listed or measured.
const WORKED_IN = new RegExp(
  String.raw`(?:\bcd\s+\\?["']?|"(?:working_directory|cwd)":\s*"|worktree add\s+(?:-b\s+\S+\s+)?\\?["']?)(` + WORKTREE_PATH.source + ')',
  'g',
);
const ASK_TOOL = /^(AskQuestion|AskUserQuestion|ask_question)$/;
const ENDS_WITH_QUESTION =
  /\?\s*\**\s*$|\b(should I|shall I|do you want|would you like|want me to|let me know (if|which|whether|how)|which (one|option) do you|can you confirm|please confirm|waiting for your|need your (input|decision|approval))\b[^.!]*$/i;

function newState() {
  return {
    firstPrompt: '', title: '', ticket: '', branch: '', isWork: false, cwd: '', entrypoint: '',
    instructions: 0, tools: 0, replies: 0, outChars: 0,
    marker: null, todos: new Map(), lastText: '', lastPrompt: '',
    turnEnded: null, stopReason: '', lastTs: 0,
    prs: [], usage: new Map(), model: '', aiTitle: '',
    spawns: [], prCreates: new Set(), asked: false, worktrees: new Set(),
  };
}

class Tail {
  constructor(file, reducer) {
    this.file = file;
    this.reducer = reducer;
    this.reset();
  }

  reset() {
    this.offset = 0;
    this.leftover = Buffer.alloc(0);
    this.state = newState();
  }

  async update(size) {
    if (size < this.offset) this.reset();
    if (size === this.offset) return false;
    const fh = await fsp.open(this.file, 'r');
    try {
      while (this.offset < size) {
        const len = Math.min(CHUNK, size - this.offset);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        let data = Buffer.concat([this.leftover, buf.subarray(0, bytesRead)]);
        const lastNl = data.lastIndexOf(0x0a);
        if (lastNl === -1) {
          this.leftover = data;
          continue;
        }
        this.leftover = data.subarray(lastNl + 1);
        data = data.subarray(0, lastNl);
        for (const line of data.toString('utf8').split('\n')) {
          if (!line) continue;
          let entry;
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          this.reducer(this.state, entry);
        }
      }
    } finally {
      await fh.close();
    }
    return true;
  }
}

function textParts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('\n');
}

function userQuery(text) {
  const m = /<user_query>([\s\S]*?)(?:<\/user_query>|$)/.exec(text);
  return m ? m[1] : text;
}

function cleanTitle(text) {
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
  const body = args ? args[1] : text.replace(/<[^>]+>/g, ' ');
  return body.replace(/^\s*\/?work\b/, '').replace(/\s+/g, ' ').trim();
}

function addPrs(st, urls) {
  for (const url of urls) if (!st.prs.includes(url)) st.prs.push(url);
}

function onPrompt(st, raw) {
  const text = userQuery(raw);
  if (!text.trim() || NOT_INSTRUCTION.test(text)) return;
  st.instructions += 1;
  st.lastPrompt = cleanTitle(text);
  if (st.instructions > 1) return;
  st.firstPrompt = text;
  st.isWork = WORK_PROMPT.test(text);
  st.title = cleanTitle(text);
  const t = TICKET.exec(text);
  st.ticket = t ? t[0] : '';
}

function unwrapTool(part) {
  const input = part.input || {};
  if (part.name === 'CallDynamicTool') return { name: input.toolName || '', input: input.arguments || {} };
  return { name: part.name || '', input };
}

function onToolUse(st, part) {
  st.tools += 1;
  const blob = JSON.stringify(part.input || {});
  st.outChars += blob.length;
  if (blob.includes('gh pr create')) st.prCreates.add(part.id);
  for (const m of blob.matchAll(WORKED_IN)) st.worktrees.add(worktreePath(m[1]));
  const { name, input } = unwrapTool(part);
  if (ASK_TOOL.test(name)) st.asked = true;
  if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    if (!input.merge) st.todos = new Map();
    input.todos.forEach((t, i) => {
      const id = t.id || t.content || String(i);
      st.todos.set(id, { ...(st.todos.get(id) || {}), ...t });
    });
  }
  if ((name === 'Task' || name === 'Agent') && (input.prompt || input.description)) {
    st.spawns.push({ description: input.description || '', prompt: String(input.prompt || '').slice(0, 200) });
  }
  const own = st.ticket.toLowerCase();
  if (own && st.branch.toLowerCase().includes(own)) return;
  for (const b of blob.match(BRANCH) || []) {
    if (!st.branch || (own && b.toLowerCase().includes(own))) st.branch = b.replace(/[.,]+$/, '');
  }
}

function onAssistantText(st, text) {
  st.outChars += text.length;
  if (text.trim()) st.lastText = text.replace(/\s+/g, ' ').trim();
  MARKER.lastIndex = 0;
  let m;
  while ((m = MARKER.exec(text))) {
    st.marker = { ...parseMarker(Number(m[1]), m[2]), instruction: st.instructions };
  }
  addPrs(st, text.match(PR_URL) || []);
}

function parseMarker(pct, rest) {
  let body = rest.replace(/\*\*/g, '').trim();
  let step = '';
  const s = /^(Done|Round\s+\d+\/\S+|\d+\/\d+)[.:!]?\s*/.exec(body);
  if (s) {
    step = s[1];
    body = body.slice(s[0].length);
  }
  body = body.replace(/^[—–-]\s*/, '');
  const [now, ...next] = body.split(/\s+·\s+next:\s*/i);
  return { pct: Math.min(pct, 100), step, text: now.trim(), next: next.join(' · ').trim() };
}

function reduceCursor(st, entry) {
  if (entry.type === 'turn_ended') {
    st.turnEnded = { status: entry.status || 'success', error: entry.error || '' };
    return;
  }
  const content = entry.message && entry.message.content;
  if (entry.role === 'user') {
    st.turnEnded = null;
    onPrompt(st, textParts(content));
    return;
  }
  if (entry.role !== 'assistant' || !Array.isArray(content)) return;
  st.replies += 1;
  // A question only counts while it is the agent's last action; anything after it means it was answered.
  st.asked = false;
  for (const part of content) {
    if (part.type === 'tool_use') onToolUse(st, part);
    else if (part.type === 'text') onAssistantText(st, part.text || '');
  }
}

function reduceClaude(st, entry) {
  if (entry.type === 'ai-title' && entry.aiTitle) st.aiTitle = entry.aiTitle;
  if (entry.type === 'custom-title' && entry.customTitle) st.aiTitle = entry.customTitle;
  if (entry.type !== 'user' && entry.type !== 'assistant') return;
  if (entry.isSidechain && !st.isSubagentFile) return;
  if (entry.timestamp) st.lastTs = Date.parse(entry.timestamp) || st.lastTs;
  if (!st.cwd && entry.cwd) st.cwd = entry.cwd;
  if (!st.entrypoint && entry.entrypoint) st.entrypoint = entry.entrypoint;
  const message = entry.message || {};
  const content = message.content;
  if (entry.type === 'user') {
    if (Array.isArray(content) && content.some((p) => p.type === 'tool_result')) {
      for (const p of content) {
        if (p.type === 'tool_result' && st.prCreates.has(p.tool_use_id)) {
          addPrs(st, JSON.stringify(p.content || '').match(PR_URL) || []);
        }
      }
      return;
    }
    if (entry.isMeta) return;
    st.turnEnded = null;
    onPrompt(st, textParts(content));
    return;
  }
  const id = message.id;
  if (!id || !st.usage.has(id)) st.replies += 1;
  if (message.usage && id) st.usage.set(id, { model: message.model || '', usage: message.usage });
  if (message.model && !message.model.startsWith('<')) st.model = message.model;
  if (message.stop_reason) st.stopReason = message.stop_reason;
  st.turnEnded = message.stop_reason === 'end_turn' ? { status: 'success', error: '' } : null;
  st.asked = false;
  for (const part of Array.isArray(content) ? content : []) {
    if (part.type === 'tool_use') onToolUse(st, part);
    else if (part.type === 'text') onAssistantText(st, part.text || '');
  }
}

function spend(states, extraPrices) {
  let usd = 0;
  let output = 0;
  let unpriced = false;
  let hasUsage = false;
  for (const st of states) {
    for (const { model, usage } of st.usage.values()) {
      hasUsage = true;
      output += usage.output_tokens || 0;
      const cost = replyCost(model, usage, extraPrices);
      if (cost === null) unpriced = true;
      else usd += cost;
    }
  }
  return hasUsage ? { usd, output, unpriced } : null;
}

function contextSize(st) {
  const last = [...st.usage.values()].pop();
  return last ? promptTokens(last.usage) + (last.usage.output_tokens || 0) : null;
}

function todoSummary(st) {
  const todos = [...st.todos.values()];
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === 'completed' || t.status === 'cancelled').length;
  const current = todos.find((t) => t.status === 'in_progress');
  return { done, total: todos.length, current: current ? current.content || current.activeForm || '' : '' };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function safeReaddir(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeStat(file) {
  try {
    return await fsp.stat(file);
  } catch {
    return null;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function workspaceFromProjectDir(dir) {
  const parts = dir.split('-').filter(Boolean);
  return parts[parts.length - 1] || dir;
}

class Collector {
  constructor() {
    this.tails = new Map();
  }

  async tail(file, reducer, stat, extra) {
    let t = this.tails.get(file);
    if (!t) {
      t = new Tail(file, reducer);
      Object.assign(t.state, extra || {});
      this.tails.set(file, t);
    }
    await t.update(stat.size);
    t.mtime = stat.mtimeMs;
    t.seen = true;
    return t;
  }

  async scan(opts) {
    const now = Date.now();
    const cutoff = opts.since || 0;
    for (const t of this.tails.values()) t.seen = false;
    const [cursor, claude, procs] = await Promise.all([
      this.scanCursor(cutoff, opts),
      this.scanClaude(cutoff, opts),
      listProcesses(),
    ]);
    const sessions = [...cursor, ...claude];
    for (const [file, t] of this.tails) if (!t.seen) this.tails.delete(file);
    const db = await composerInfo(cursor.flatMap((s) => [s.id, ...s.subs.map((x) => x.id)]));
    const hot = cursor.filter((s) => !s.file || now - s.lastActive < LIVE_WINDOW_MS);
    const hotSubs = hot.flatMap((s) => s.subs).filter((x) => !x.finished && now - x.lastActive < LIVE_WINDOW_MS);
    const live = await liveMessages(new Map([...hot.map((s) => [s.id, s.flushedAt]), ...hotSubs.map((x) => [x.id, x.lastActive])]));
    for (const s of sessions) {
      if (s.source === 'cursor') {
        mergeComposer(s, db);
        applyLiveMessages(s, live.get(s.id) || [], now);
        for (const sub of s.subs) sub.pendingApproval = pendingApproval(sub.composerStatus, sub.lastActive, live.get(sub.id) || [], now);
        s.cost = cursorEstimate(s, db, opts.prices);
      }
      delete s.flushedAt;
      delete s.calls;
      delete s.outChars;
      s.processes = processesFor(s, procs);
      s.tags = tagsFor(s.promptText, opts.tagRules);
      for (const sub of s.subs) {
        const byName = tagsFor(sub.name, opts.tagRules);
        sub.tags = byName[0] !== 'general' ? byName : tagsFor(sub.promptText, opts.tagRules);
      }
      s.status = deriveStatus(s, now, opts);
      delete s.promptText;
      delete s.liveTool;
      delete s.pendingApproval;
      const trees = new Set([...s.worktrees, ...s.subs.flatMap((x) => x.worktrees || [])]);
      const cwdTree = s.cwd && WORKTREE_PATH.exec(s.cwd);
      if (cwdTree) trees.add(worktreePath(cwdTree[0]));
      s.worktrees = [...trees].filter((w) => fs.existsSync(w));
      for (const sub of s.subs) {
        delete sub.pendingApproval;
        delete sub.promptText;
        delete sub.calls;
        delete sub.outChars;
        delete sub.worktrees;
      }
    }
    const visible = sessions.filter((s) => !opts.onlyWork || s.isWork);
    visible.sort((a, b) => b.lastActive - a.lastActive);
    return { generatedAt: now, since: cutoff, sessions: visible };
  }

  async scanCursor(cutoff, opts) {
    const hookState = new Map();
    for (const d of await safeReaddir(CURSOR_HOOK_STATE)) {
      if (!d.isFile() || !d.name.endsWith('.json')) continue;
      const data = await readJson(path.join(CURSOR_HOOK_STATE, d.name));
      if (data) hookState.set(d.name.slice(0, -5), data);
    }
    const found = [];
    const subagentIds = new Set();
    for (const project of await safeReaddir(CURSOR_PROJECTS)) {
      if (!project.isDirectory()) continue;
      const root = path.join(CURSOR_PROJECTS, project.name, 'agent-transcripts');
      for (const conv of await safeReaddir(root)) {
        if (!conv.isDirectory()) continue;
        const file = path.join(root, conv.name, `${conv.name}.jsonl`);
        const subDir = path.join(root, conv.name, 'subagents');
        const subFiles = (await safeReaddir(subDir)).filter((d) => d.name.endsWith('.jsonl'));
        for (const d of subFiles) subagentIds.add(d.name.slice(0, -6));
        const stat = await safeStat(file);
        if (!stat) continue;
        const subStats = [];
        for (const d of subFiles) {
          const p = path.join(subDir, d.name);
          const s = await safeStat(p);
          if (s) subStats.push([p, s]);
        }
        const newest = Math.max(stat.mtimeMs, ...subStats.map(([, s]) => s.mtimeMs));
        if (newest < cutoff) continue;
        found.push({ conv: conv.name, project: project.name, file, stat, subStats });
      }
    }
    const sessions = [];
    const withTranscript = new Set(found.map((f) => f.conv));
    for (const [conv, hook] of hookState) {
      if (withTranscript.has(conv) || subagentIds.has(conv) || (hook.updated || 0) * 1000 < cutoff) continue;
      if (!hook.task && !hook.marker) continue;
      sessions.push(hookOnlySession(conv, hook));
    }
    for (const f of found) {
      if (subagentIds.has(f.conv)) continue;
      const t = await this.tail(f.file, reduceCursor, f.stat);
      const st = t.state;
      const hook = hookState.get(f.conv) || {};
      const subs = [];
      for (const [p, s] of f.subStats) {
        const sub = await this.tail(p, reduceCursor, s);
        const spawn = st.spawns.find((sp) => sp.prompt && sub.state.firstPrompt.includes(sp.prompt.slice(0, 120)));
        subs.push(subagentView(sub, spawn ? spawn.description : '', null));
      }
      sessions.push({
        id: f.conv,
        source: 'cursor',
        sourceLabel: 'Cursor',
        workspace: hook.workspace || workspaceFromProjectDir(f.project),
        model: hook.model || '',
        file: f.file,
        flushedAt: t.mtime,
        lastActive: Math.max(t.mtime, (hook.updated || 0) * 1000, ...subs.map((s) => s.lastActive)),
        ...sessionView(st),
        cost: null,
        context: null,
        subs,
        live: null,
      });
    }
    return sessions;
  }

  async scanClaude(cutoff, opts) {
    const live = new Map();
    for (const d of await safeReaddir(CLAUDE_SESSIONS)) {
      if (!d.isFile() || !d.name.endsWith('.json')) continue;
      const data = await readJson(path.join(CLAUDE_SESSIONS, d.name));
      if (data && data.sessionId) live.set(data.sessionId, { ...data, alive: processAlive(data.pid) });
    }
    const sessions = [];
    for (const project of await safeReaddir(CLAUDE_PROJECTS)) {
      if (!project.isDirectory()) continue;
      const dir = path.join(CLAUDE_PROJECTS, project.name);
      for (const d of await safeReaddir(dir)) {
        if (!d.isFile() || !d.name.endsWith('.jsonl')) continue;
        const id = d.name.slice(0, -6);
        const file = path.join(dir, d.name);
        const stat = await safeStat(file);
        if (!stat) continue;
        const subDir = path.join(dir, id, 'subagents');
        const subFiles = (await safeReaddir(subDir)).filter((x) => x.name.endsWith('.jsonl'));
        const subStats = [];
        for (const x of subFiles) {
          const p = path.join(subDir, x.name);
          const s = await safeStat(p);
          if (s) subStats.push([p, s]);
        }
        const newest = Math.max(stat.mtimeMs, ...subStats.map(([, s]) => s.mtimeMs));
        if (newest < cutoff) continue;
        const t = await this.tail(file, reduceClaude, stat);
        const st = t.state;
        if (!st.instructions && !st.replies) continue;
        const subs = [];
        const subStates = [];
        for (const [p, s] of subStats) {
          const sub = await this.tail(p, reduceClaude, s, { isSubagentFile: true });
          const meta = (await readJson(p.slice(0, -6) + '.meta.json')) || {};
          subStates.push(sub.state);
          subs.push(subagentView(sub, meta.description || meta.agentType || '', meta));
        }
        const info = live.get(id) || null;
        sessions.push({
          id,
          source: 'claude',
          sourceLabel: /vscode/.test(st.entrypoint) ? 'Claude Code · VS Code' : 'Claude Code CLI',
          workspace: st.cwd ? path.basename(st.cwd) : workspaceFromProjectDir(project.name),
          cwd: st.cwd,
          model: st.model,
          file,
          lastActive: Math.max(t.mtime, ...subs.map((s) => s.lastActive)),
          ...sessionView(st),
          title: (info && info.nameSource === 'user' && info.name) || st.aiTitle || st.title || id.slice(0, 8),
          cost: spend([st, ...subStates], opts.prices),
          context: contextSize(st) ? { used: contextSize(st), limit: null } : null,
          subs,
          live: info ? { status: info.status || '', alive: info.alive, pid: info.pid, entrypoint: info.entrypoint || '' } : null,
        });
      }
    }
    return sessions;
  }
}

function mergeComposer(s, db) {
  const row = db.get(s.id);
  if (row) {
    if (row.name) s.title = row.name;
    if (row.model) s.model = row.model + (row.maxMode ? ' (max)' : '');
    if (row.ctx) s.context = { used: row.ctx, limit: row.ctxLimit || null };
    s.composerStatus = row.status || '';
    s.lines = row.added || row.removed ? { added: row.added || 0, removed: row.removed || 0 } : null;
  }
  for (const sub of s.subs) {
    const r = db.get(sub.id);
    if (r && r.status) sub.composerStatus = r.status;
  }
}

function processesFor(s, procs) {
  let list;
  if (s.source === 'cursor') {
    const ids = new Set([s.id, ...s.subs.map((x) => x.id)]);
    list = procs.filter((p) => p.conversation && ids.has(p.conversation));
  } else {
    list = s.live && s.live.alive && s.live.pid ? [{ pid: s.live.pid, command: 'claude' }, ...descendants(procs, s.live.pid)] : [];
  }
  return list.map((p) => ({ pid: p.pid, command: p.command }));
}

function sessionView(st) {
  return {
    promptText: st.firstPrompt,
    title: st.title || '(no prompt)',
    lastPrompt: st.lastPrompt,
    asked: st.asked || ENDS_WITH_QUESTION.test(st.lastText.slice(-300)),
    ticket: st.ticket,
    branch: st.branch,
    isWork: st.isWork,
    marker: st.marker ? { ...st.marker, stale: st.marker.instruction < st.instructions } : null,
    todos: todoSummary(st),
    lastText: st.lastText.slice(0, 400),
    turnEnded: st.turnEnded,
    instructions: st.instructions,
    tools: st.tools,
    replies: st.replies,
    calls: st.replies,
    outChars: st.outChars,
    worktrees: [...st.worktrees],
    prs: st.prs.slice(-8),
  };
}

// A tool call held for approval is 'loading' with a block reason; approving it marks the review Done and
// starts it, rejecting it records a decision. Approved edits can stay 'loading' forever, so only the chat's
// latest activity counts: nothing else can happen while the agent waits on you.
function pendingApproval(composerStatus, flushedAt, all, now) {
  if (composerStatus === 'completed') return false;
  // The transcript records the held call itself a few seconds after the request.
  const latest = Math.max(flushedAt - FLUSH_SLACK_MS, ...all.map((r) => Date.parse(r.at) || 0));
  return all.some((r) => {
    const at = Date.parse(r.at) || 0;
    return r.tool && r.toolStatus === 'loading' && r.blockReason && !r.decision && r.reviewStatus !== 'Done' &&
      !r.startedAt && !r.runStatus && at >= latest && now - at < LIVE_WINDOW_MS;
  });
}

function applyLiveMessages(s, all, now) {
  s.pendingApproval = pendingApproval(s.composerStatus, s.flushedAt, all, now);
  const rows = all.filter((r) => (Date.parse(r.at) || 0) > s.flushedAt);
  if (!rows.length) return;
  if (!s.file && rows.some((r) => r.type === 1)) s.instructions = 0;
  for (const r of rows) {
    const at = Date.parse(r.at) || 0;
    if (at > s.lastActive) s.lastActive = at;
    const text = r.text || '';
    if (r.type === 1) {
      const prompt = userQuery(text);
      if (!prompt.trim() || NOT_INSTRUCTION.test(prompt)) continue;
      s.instructions += 1;
      s.lastPrompt = cleanTitle(prompt);
      if (s.marker) s.marker = { ...s.marker, stale: true };
      s.asked = false;
      continue;
    }
    if (r.tool) {
      s.tools += 1;
      s.calls += 1;
      s.outChars += r.argChars || 0;
      s.asked = ASK_TOOL.test(r.tool);
    }
    if (text.trim()) {
      s.calls += 1;
      s.outChars += text.length;
      s.lastText = text.replace(/\s+/g, ' ').trim().slice(0, 400);
      s.asked = ENDS_WITH_QUESTION.test(s.lastText.slice(-300));
      MARKER.lastIndex = 0;
      let m;
      while ((m = MARKER.exec(text))) s.marker = { ...parseMarker(Number(m[1]), m[2]), stale: false };
      for (const url of text.match(PR_URL) || []) if (!s.prs.includes(url)) s.prs.push(url);
    }
  }
  // Rows newer than the transcript mean the current turn has not been written out yet.
  s.turnEnded = null;
  const last = rows[rows.length - 1];
  s.liveTool = Boolean(last.tool && last.toolStatus === 'loading');
}

function cursorEstimate(s, db, extraPrices) {
  const chats = [{ calls: s.calls, outChars: s.outChars, row: db.get(s.id) }, ...s.subs.map((x) => ({ calls: x.calls, outChars: x.outChars, row: db.get(x.id) }))];
  let usd = 0;
  let output = 0;
  let priced = false;
  let unpriced = false;
  for (const c of chats) {
    if (!c.row || !c.row.ctx || !c.calls) continue;
    const est = estimateCost(c.row.model || '', { calls: c.calls, context: c.row.ctx, outChars: c.outChars }, extraPrices);
    if (!est) {
      unpriced = true;
      continue;
    }
    priced = true;
    usd += est.usd;
    output += est.output;
  }
  if (!priced) return unpriced ? { usd: 0, output: 0, unpriced: true, estimated: true } : null;
  return { usd, output, unpriced, estimated: true };
}

// Cursor sometimes writes a chat's transcript only after its first turn; the progress hook has it sooner.
function hookOnlySession(conv, hook) {
  const m = hook.marker ? /^\[(\d{1,3})%\]\s*(.*)$/.exec(hook.marker) : null;
  const todos = hook.todos && hook.todos.total ? hook.todos : null;
  const ended = hook.status === 'working' ? null : { status: hook.status === 'done' ? 'success' : 'error', error: '' };
  const t = TICKET.exec(hook.task || '');
  return {
    id: conv,
    source: 'cursor',
    sourceLabel: 'Cursor',
    workspace: hook.workspace || '?',
    model: hook.model || '',
    file: null,
    flushedAt: 0,
    calls: 0,
    outChars: 0,
    worktrees: [],
    lastActive: (hook.updated || 0) * 1000,
    promptText: hook.task || '',
    title: hook.task || '(no prompt)',
    lastPrompt: hook.task || '',
    asked: false,
    ticket: t ? t[0] : '',
    branch: '',
    isWork: WORK_PROMPT.test(hook.task || ''),
    marker: m ? { ...parseMarker(Number(m[1]), m[2]), stale: false } : null,
    todos: todos ? { done: todos.done, total: todos.total, current: todos.current || '' } : null,
    lastText: '',
    turnEnded: ended,
    instructions: 1,
    tools: 0,
    replies: 0,
    prs: [],
    cost: null,
    context: null,
    subs: [],
    live: null,
  };
}

function subagentView(tail, name, meta) {
  const st = tail.state;
  return {
    id: path.basename(tail.file, '.jsonl'),
    promptText: st.firstPrompt,
    name: name || cleanTitle(userQuery(st.firstPrompt)).slice(0, 80) || path.basename(tail.file, '.jsonl').slice(0, 8),
    file: tail.file,
    calls: st.replies,
    outChars: st.outChars,
    worktrees: [...st.worktrees],
    lastActive: tail.mtime,
    finished: meta ? Boolean(meta.finished) : Boolean(st.turnEnded),
    background: meta ? meta.requestShape === 'background' : true,
    marker: st.marker,
    tools: st.tools,
    lastText: st.lastText.slice(0, 200),
    prs: st.prs,
  };
}

// working: a turn is in flight · stalled: in flight but silent too long · waiting: turn over, your move
// done: turn over and the last progress line of the current instruction says 100% · error: turn failed
function deriveStatus(s, now, opts) {
  const stalledMs = opts.stalledMinutes * 60 * 1000;
  for (const sub of s.subs) {
    if (sub.pendingApproval) {
      sub.status = 'blocked';
      continue;
    }
    if (sub.composerStatus === 'generating') {
      sub.status = 'working';
      continue;
    }
    // Claude Code never marks a foreground subagent finished; it can't outlive its parent's turn.
    const over = sub.finished || (!sub.background && s.turnEnded) || sub.composerStatus === 'completed';
    sub.status = over ? 'done' : now - sub.lastActive < stalledMs ? 'working' : 'stalled';
  }
  const subsWorking = s.subs.filter((x) => x.status === 'working').length;
  const finishedByMarker = s.marker && !s.marker.stale && s.marker.pct >= 100;
  // Cursor's stored chat status is written lazily, so it only wins once the transcript agrees or goes quiet.
  const quiet = now - s.lastActive > 2 * 60 * 1000;
  if (s.pendingApproval || s.subs.some((x) => x.status === 'blocked')) return 'blocked';
  if (s.composerStatus === 'generating' || s.liveTool) return now - s.lastActive < stalledMs * 2 ? 'working' : 'stalled';
  if (s.composerStatus === 'aborted' && quiet && !subsWorking) return 'stopped';
  if (s.composerStatus === 'completed' && !s.turnEnded) s.turnEnded = { status: 'success', error: '' };
  if (s.live && s.live.alive) {
    const st = s.live.status;
    if (/wait|permission|input|approv/i.test(st)) return 'blocked';
    if (st && st !== 'idle') return 'working';
  }
  if (!s.turnEnded) {
    if (s.live && !s.live.alive && s.source === 'claude') return subsWorking ? 'working' : 'stopped';
    return now - s.lastActive < stalledMs || subsWorking ? 'working' : 'stalled';
  }
  if (s.turnEnded.status === 'error' && s.turnEnded.error !== 'new_message_submitted') return 'error';
  if (subsWorking) return 'working';
  if (finishedByMarker) return 'done';
  return s.asked ? 'waiting' : 'idle';
}

module.exports = { Collector, parseMarker };
