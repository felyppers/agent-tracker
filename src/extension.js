'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');
const { Collector } = require('./collect');
const { listProcesses, descendants, terminate } = require('./procs');
const { KNOWN_TAGS } = require('./tags');
const { transcriptMarkdown } = require('./transcript');
const { cleanWorktree } = require('./worktrees');
const { installProgressRules, progressRulesInstalled } = require('./install');

const RANGES = ['today', 'week', 'month', 'all'];
const CLAUDE_EXTENSION = 'anthropic.claude-code';
const KILLED_KEY = 'agentTracker.killed';
const CLEANUP_KEY = 'agentTracker.worktreeCleanup';
const TAGS_KEY = 'agentTracker.tags';
const DAY_MS = 24 * 3600 * 1000;
const KILL_GRACE_MS = 30 * 1000;

function rangeStart(range) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (range === 'today') return d.getTime();
  if (range === 'week') {
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
  }
  if (range === 'month') {
    d.setDate(1);
    return d.getTime();
  }
  return 0;
}

function settings() {
  const c = vscode.workspace.getConfiguration('agentTracker');
  return {
    pollSeconds: Math.max(1, c.get('pollSeconds', 3)),
    onlyWork: c.get('onlyWork', false),
    stalledMinutes: c.get('stalledMinutes', 15),
    prices: c.get('prices', {}),
    tagRules: c.get('tagRules', {}),
    pingText: c.get('pingText', 'Continue where you left off. If you are blocked, say exactly what you need from me.'),
    cleanupScript: cleanupScriptPath(c.get('worktreeCleanupScript', 'builtin')),
    cleanDoneAfterMs: Math.max(0, c.get('cleanDoneWorktreesAfterMinutes', 10)) * 60 * 1000,
  };
}

const BUILTIN_CLEANUP = 'builtin';

function cleanupScriptPath(value) {
  const v = String(value || '').trim();
  return v === BUILTIN_CLEANUP ? v : v.replace(/^~(?=[\\/])/, os.homedir());
}

function cleanupReady(script) {
  return script === BUILTIN_CLEANUP || Boolean(script && fs.existsSync(script));
}

function runCleanup(script, worktree) {
  if (script === BUILTIN_CLEANUP) return cleanWorktree(worktree);
  return new Promise((resolve) => {
    execFile(script, ['--worktree', worktree], { timeout: 120000, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, message: (stdout || stderr || (err && err.message) || '').trim().split('\n').pop() });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Dashboard {
  constructor(context) {
    this.context = context;
    this.collector = new Collector();
    this.views = new Set();
    this.snapshot = null;
    this.scanning = false;
    this.range = context.globalState.get('agentTracker.range', 'today');
    this.isCursor = /cursor/i.test(vscode.env.appName);
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = 'agentTracker.view.focus';
    this.status.show();
    context.subscriptions.push(this.status);
  }

  capabilities() {
    return { isCursor: this.isCursor, hasClaudeExtension: Boolean(vscode.extensions.getExtension(CLAUDE_EXTENSION)) };
  }

  start() {
    this.stop();
    this.refresh();
    this.timer = setInterval(() => this.refresh(), settings().pollSeconds * 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  post(message) {
    for (const view of this.views) view.webview.postMessage(message);
  }

  async refresh() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      this.snapshot = await this.collector.scan({ ...settings(), since: rangeStart(this.range) });
      this.markKilled(this.snapshot.sessions);
      this.applyTagEdits(this.snapshot.sessions);
      this.attachWorktreeNotes(this.snapshot.sessions);
      this.autoCleanDone();
      this.snapshot.range = this.range;
      this.snapshot.capabilities = this.capabilities();
      this.updateStatusBar();
      this.post({ type: 'data', snapshot: this.snapshot });
    } catch (err) {
      this.status.text = '$(warning) Agents';
      this.status.tooltip = `Agent Tracker scan failed: ${err.message}`;
    } finally {
      this.scanning = false;
    }
  }

  updateStatusBar() {
    const sessions = this.snapshot.sessions;
    const working = sessions.filter((s) => s.status === 'working').length;
    const blocked = sessions.filter((s) => s.status === 'blocked' || s.status === 'error').length;
    const recent = Date.now() - 24 * 3600 * 1000;
    const yourTurn = sessions.filter((s) => s.status === 'waiting' && s.lastActive > recent).length;
    const parts = [`$(pulse) ${working} working`];
    if (yourTurn) parts.push(`${yourTurn} your turn`);
    if (blocked) parts.push(`$(alert) ${blocked}`);
    this.status.text = parts.join(' · ');
    this.status.tooltip = 'Agent Tracker: Cursor and Claude Code agents on this machine';
    this.status.backgroundColor = blocked ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }

  attach(view) {
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.views.add(view);
    view.onDidDispose(() => this.views.delete(view));
  }

  find(id) {
    return this.snapshot && this.snapshot.sessions.find((s) => s.id === id);
  }

  async onMessage(msg) {
    try {
      if (msg.type === 'ready') {
        if (this.snapshot) this.post({ type: 'data', snapshot: this.snapshot });
      } else if (msg.type === 'range' && RANGES.includes(msg.range)) {
        this.range = msg.range;
        await this.context.globalState.update('agentTracker.range', msg.range);
        this.post({ type: 'loading' });
        await this.refresh();
      } else if (msg.type === 'openUrl' && /^https:\/\//.test(msg.url)) {
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
      } else if (msg.type === 'openFile' && msg.file && fs.existsSync(msg.file)) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.file));
        vscode.window.showTextDocument(doc, { preview: true });
      } else if (msg.type === 'copy' && msg.text) {
        await vscode.env.clipboard.writeText(msg.text);
        vscode.window.setStatusBarMessage(`Copied ${msg.text}`, 2000);
      } else if (msg.type === 'editTags') {
        const s = this.find(msg.id);
        const target = s && msg.subId ? s.subs.find((x) => x.id === msg.subId) : s;
        if (target) await this.editTags(target);
      } else if (msg.type === 'openSub') {
        const s = this.find(msg.id);
        const sub = s && s.subs.find((x) => x.id === msg.subId);
        if (!sub) return;
        if (s.source === 'cursor' && this.isCursor) {
          await this.openCursorChat(sub.id);
        } else if (s.source === 'claude') {
          await this.open(s);
          const SHOW = 'Show subagent transcript';
          const choice = await vscode.window.showInformationMessage(
            `Claude Code can't open a subagent on its own, so its parent chat is open. "${sub.name}" runs inside it.`,
            ...(sub.file ? [SHOW] : []),
          );
          if (choice === SHOW) await this.showTranscript(sub.file, `${sub.name || 'Subagent'} · ${s.title}`);
        } else if (sub.file) {
          await this.showTranscript(sub.file, `${sub.name || 'Subagent'} · ${s.title}`);
        }
      } else if (msg.type === 'action') {
        const s = this.find(msg.id);
        if (!s) return;
        if (msg.action === 'open') await this.open(s);
        else if (msg.action === 'ping') await this.ping(s);
        else if (msg.action === 'kill') await this.kill(s);
        setTimeout(() => this.refresh(), 1500);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Agent Tracker: ${err.message}`);
    }
  }

  async showTranscript(file, title) {
    if (!fs.existsSync(file)) throw new Error(`transcript not found: ${file}`);
    const dir = path.join(os.tmpdir(), 'agents-tracker');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${path.basename(file, '.jsonl')}.md`);
    fs.writeFileSync(out, transcriptMarkdown(file, title));
    const uri = vscode.Uri.file(out);
    try {
      await vscode.commands.executeCommand('markdown.showPreview', uri);
    } catch {
      await vscode.window.showTextDocument(uri, { preview: true });
    }
  }

  async openCursorChat(id) {
    try {
      await vscode.commands.executeCommand('composer.openComposer', id);
    } catch {
      await vscode.commands.executeCommand('glass.openAgentById', id);
    }
  }

  claudeInEditor(s) {
    return this.capabilities().hasClaudeExtension && (!s.live || /vscode/.test(s.live.entrypoint) || /VS Code/.test(s.sourceLabel));
  }

  resumeInTerminal(s, prompt) {
    const term = vscode.window.createTerminal({ name: `claude ${s.title.slice(0, 30)}`, cwd: s.cwd || undefined });
    const quoted = prompt ? ` ${JSON.stringify(prompt)}` : '';
    term.sendText(`claude --resume ${s.id}${quoted}`);
    term.show();
  }

  async open(s) {
    if (s.source === 'cursor') {
      if (!this.isCursor) {
        vscode.window.showInformationMessage('Cursor chats open only inside Cursor. Showing the transcript instead.');
        if (s.file) await this.showTranscript(s.file, s.title);
        return;
      }
      await this.openCursorChat(s.id);
      return;
    }
    if (this.claudeInEditor(s)) {
      await vscode.commands.executeCommand('claude-vscode.editor.open', s.id);
      return;
    }
    if (s.live && s.live.alive) {
      vscode.window.showInformationMessage(`This Claude Code session runs in a terminal (pid ${s.live.pid}). Switch to that terminal to see it.`);
      return;
    }
    this.resumeInTerminal(s);
  }

  async ping(s) {
    const { pingText } = settings();
    if (s.source === 'cursor') {
      if (!this.isCursor) {
        vscode.window.showWarningMessage('Ping for Cursor chats works only inside Cursor.');
        return;
      }
      if (s.status === 'working') {
        const ok = await vscode.window.showWarningMessage(
          `"${s.title}" is still working. Pinging restarts its current step.`,
          { modal: true },
          'Ping anyway',
        );
        if (ok !== 'Ping anyway') return;
      }
      await this.openCursorChat(s.id);
      await sleep(400);
      await vscode.commands.executeCommand('composer.resumeCurrentChat');
      vscode.window.setStatusBarMessage(`Resumed "${s.title}"`, 3000);
      return;
    }
    if (this.claudeInEditor(s)) {
      await vscode.commands.executeCommand('claude-vscode.editor.open', s.id, pingText);
      vscode.window.setStatusBarMessage('Opened the Claude Code session with the ping text; press Enter if it is not sent.', 5000);
      return;
    }
    if (s.live && s.live.alive) {
      await vscode.env.clipboard.writeText(pingText);
      vscode.window.showInformationMessage(`Session runs in a terminal (pid ${s.live.pid}). Ping text copied: paste it there.`);
      return;
    }
    this.resumeInTerminal(s, pingText);
  }

  applyTagEdits(sessions) {
    const edits = this.context.globalState.get(TAGS_KEY, {});
    for (const s of sessions.flatMap((x) => [x, ...x.subs])) {
      if (!edits[s.id]) continue;
      s.autoTags = s.tags || [];
      s.tags = edits[s.id];
    }
  }

  async editTags(s) {
    const edits = this.context.globalState.get(TAGS_KEY, {});
    const edited = Boolean(edits[s.id]);
    const current = s.tags || [];
    const inUse = (this.snapshot ? this.snapshot.sessions : []).flatMap((x) => [...x.tags, ...x.subs.flatMap((sub) => sub.tags || [])]);
    const known = [...new Set([...KNOWN_TAGS, ...Object.keys(settings().tagRules), ...Object.values(edits).flat(), ...inUse])].sort();
    const NEW = '$(add) New label…';
    const RESET = '$(discard) Reset to automatic labels';
    const items = [
      ...known.map((t) => ({ label: t, picked: current.includes(t) })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: NEW, alwaysShow: true },
      ...(edited ? [{ label: RESET, alwaysShow: true, description: (s.autoTags || []).join(', ') }] : []),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: `Labels for "${s.title || s.name}"`,
      placeHolder: s.title ? 'Tick the labels this chat should have' : 'Tick the labels this subagent should have',
    });
    if (!picked) return;
    const labels = picked.map((p) => p.label);
    if (labels.includes(RESET)) {
      delete edits[s.id];
    } else {
      const tags = labels.filter((l) => l !== NEW);
      if (labels.includes(NEW)) {
        const typed = await vscode.window.showInputBox({ title: 'New label', prompt: 'One or more labels, separated by commas' });
        if (typed === undefined) return;
        tags.push(...typed.split(',').map((t) => t.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean));
      }
      edits[s.id] = [...new Set(tags)];
    }
    await this.context.globalState.update(TAGS_KEY, edits);
    await this.refresh();
  }

  worktreeInUse(wt, owner) {
    const now = Date.now();
    return (this.snapshot ? this.snapshot.sessions : []).some(
      (o) => o.id !== owner.id && o.worktrees.includes(wt) && !['done', 'killed'].includes(o.status) && now - o.lastActive < DAY_MS,
    );
  }

  async cleanWorktrees(s, reason) {
    const { cleanupScript } = settings();
    if (!cleanupReady(cleanupScript) || !s.worktrees.length) return [];
    const results = [];
    for (const wt of s.worktrees) {
      if (this.worktreeInUse(wt, s)) results.push({ wt, code: 2, message: `kept: another active agent uses ${wt}` });
      else results.push({ wt, ...(await runCleanup(cleanupScript, wt)) });
    }
    const cutoff = Date.now() - 31 * DAY_MS;
    const log = Object.fromEntries(Object.entries(this.context.globalState.get(CLEANUP_KEY, {})).filter(([, r]) => r.at > cutoff));
    for (const r of results) log[r.wt] = { at: Date.now(), code: r.code, message: r.message, reason };
    await this.context.globalState.update(CLEANUP_KEY, log);
    return results;
  }

  async autoCleanDone() {
    const { cleanDoneAfterMs } = settings();
    if (this.cleaning || !cleanDoneAfterMs || !this.snapshot) return;
    const log = this.context.globalState.get(CLEANUP_KEY, {});
    const now = Date.now();
    // A worktree that was kept is retried only after the task shows new activity.
    const due = this.snapshot.sessions.filter(
      (s) => s.status === 'done' && !s.processes.length && now - s.lastActive > cleanDoneAfterMs &&
        s.worktrees.some((wt) => !log[wt] || log[wt].at < s.lastActive),
    );
    if (!due.length) return;
    this.cleaning = true;
    try {
      for (const s of due) {
        const removed = (await this.cleanWorktrees(s, 'done')).filter((r) => r.code === 0);
        if (removed.length) vscode.window.setStatusBarMessage(`Agent Tracker: removed ${removed.length} worktree(s) of done task "${s.title}"`, 8000);
      }
    } finally {
      this.cleaning = false;
    }
  }

  attachWorktreeNotes(sessions) {
    const log = this.context.globalState.get(CLEANUP_KEY, {});
    for (const s of sessions) {
      s.worktreeNotes = s.worktrees.map((wt) => ({ path: wt, kept: log[wt] && log[wt].code === 2 ? log[wt].message : '' }));
    }
  }

  markKilled(sessions) {
    const killed = this.context.globalState.get(KILLED_KEY, {});
    for (const s of sessions) {
      const at = killed[s.id];
      // Cancelling appends to the transcript, so activity just after the kill still belongs to it.
      if (at && s.lastActive <= at + KILL_GRACE_MS) s.status = 'killed';
    }
  }

  async rememberKilled(id) {
    const cutoff = Date.now() - 31 * 24 * 3600 * 1000;
    const killed = Object.fromEntries(Object.entries(this.context.globalState.get(KILLED_KEY, {})).filter(([, at]) => at > cutoff));
    killed[id] = Date.now();
    await this.context.globalState.update(KILLED_KEY, killed);
  }

  async kill(s) {
    const procs = await listProcesses();
    let targets;
    if (s.source === 'cursor') {
      const ids = new Set([s.id, ...s.subs.map((x) => x.id)]);
      targets = procs.filter((p) => p.conversation && ids.has(p.conversation) && !/Cursor\.app\/Contents\/(MacOS|Frameworks)/.test(p.command));
    } else {
      const root = s.live && s.live.alive ? procs.find((p) => p.pid === s.live.pid) : null;
      targets = root ? [root, ...descendants(procs, root.pid)] : [];
    }
    const runningSubs = s.subs.filter((x) => x.status === 'working');
    const cancelChat = s.source === 'cursor' && this.isCursor;
    const lines = [
      cancelChat ? `Stop the chat${runningSubs.length ? ` and ${runningSubs.length} running subagent(s)` : ''}.` : '',
      s.source === 'cursor' && !this.isCursor ? 'The chat itself can only be stopped from Cursor; this kills its processes.' : '',
      targets.length ? `Terminate ${targets.length} process(es):` : 'No live processes found.',
      ...targets.slice(0, 12).map((p) => `  ${p.pid}  ${p.command}`),
      targets.length > 12 ? `  …and ${targets.length - 12} more` : '',
      ...this.worktreeLines(s),
    ].filter(Boolean);
    if (!cancelChat && !targets.length) {
      const ok = await vscode.window.showWarningMessage(
        `Nothing is running for "${s.title}". Move it to Closed?`,
        { modal: true, detail: ['The chat stays on disk. It returns to the board if it becomes active again.', ...this.worktreeLines(s)].join('\n') },
        'Move to Closed',
      );
      if (ok !== 'Move to Closed') return;
      await this.rememberKilled(s.id);
      const note = this.cleanupSummary(await this.cleanWorktrees(s, 'killed'));
      if (note) vscode.window.showInformationMessage(`"${s.title}" moved to Closed. ${note}`);
      return;
    }
    const ok = await vscode.window.showWarningMessage(`Kill "${s.title}"?`, { modal: true, detail: lines.join('\n') }, 'Kill');
    if (ok !== 'Kill') return;
    if (cancelChat) {
      for (const id of [s.id, ...runningSubs.map((x) => x.id)]) {
        try {
          await vscode.commands.executeCommand('composer.cancelChat', id);
        } catch {}
      }
    }
    const result = targets.length ? await terminate(targets.map((p) => p.pid)) : { signalled: 0, forced: 0 };
    await this.rememberKilled(s.id);
    const note = this.cleanupSummary(await this.cleanWorktrees(s, 'killed'));
    vscode.window.showInformationMessage(
      `Killed "${s.title}": ${cancelChat ? 'chat stopped, ' : ''}${result.signalled} process(es) terminated` +
        (result.forced ? `, ${result.forced} needed SIGKILL` : '') + `.${note ? ` ${note}` : ''}`,
    );
  }

  worktreeLines(s) {
    const { cleanupScript } = settings();
    if (!s.worktrees.length || !cleanupReady(cleanupScript)) return [];
    return ['Remove its worktree(s) unless they hold uncommitted or unpushed work:', ...s.worktrees.map((wt) => `  ${wt.replace(os.homedir(), '~')}`)];
  }

  cleanupSummary(results) {
    if (!results.length) return '';
    const removed = results.filter((r) => r.code === 0).length;
    const kept = results.filter((r) => r.code !== 0).map((r) => r.message.replace(os.homedir(), '~'));
    return [removed ? `Removed ${removed} worktree(s).` : '', ...kept.map((k) => `Worktree ${k}.`)].filter(Boolean).join(' ');
  }

  html(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const media = (f) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const template = fs.readFileSync(path.join(this.context.extensionPath, 'media', 'view.html'), 'utf8');
    return template
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{csp\}\}/g, webview.cspSource)
      .replace('{{script}}', String(media('view.js')))
      .replace('{{style}}', String(media('view.css')));
  }
}

async function installRulesCommand() {
  const BASIC = 'Install';
  const WITH_BRIDGE = 'Install, and show new Cursor chats sooner';
  const choice = await vscode.window.showQuickPick(
    [
      { label: BASIC, detail: 'The progress-tracking skill and an always-on rule, for Claude Code and Cursor' },
      { label: WITH_BRIDGE, detail: 'Also adds a Cursor hook that mirrors progress before the transcript is written. Needs jq and bash.' },
    ],
    { title: 'Install progress rules', placeHolder: 'Agents only show progress if they print progress lines' },
  );
  if (!choice) return;
  const report = installProgressRules({ bridge: choice.label === WITH_BRIDGE });
  const channel = vscode.window.createOutputChannel('Agent Tracker');
  for (const line of report) channel.appendLine(line);
  const action = await vscode.window.showInformationMessage('Progress rules installed. New agent chats will report progress.', 'Show details');
  if (action) channel.show();
}

async function offerRules(context) {
  const OFFERED = 'agentTracker.offeredRules';
  if (context.globalState.get(OFFERED) || progressRulesInstalled()) return;
  await context.globalState.update(OFFERED, true);
  const INSTALL = 'Install';
  const choice = await vscode.window.showInformationMessage(
    'Agent Tracker shows progress only for agents that print progress lines. Teach Claude Code and Cursor to print them?',
    INSTALL,
    'Not now',
  );
  if (choice === INSTALL) await installRulesCommand();
}

function activate(context) {
  const dashboard = new Dashboard(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'agentTracker.view',
      { resolveWebviewView: (view) => dashboard.attach(view) },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand('agentTracker.refresh', () => dashboard.refresh()),
    vscode.commands.registerCommand('agentTracker.installProgressRules', () =>
      installRulesCommand().catch((err) => vscode.window.showErrorMessage(`Agent Tracker: ${err.message}`))),
    vscode.commands.registerCommand('agentTracker.openPanel', () => {
      const panel = vscode.window.createWebviewPanel('agentTracker.panel', 'Agent Tracker', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      dashboard.attach(panel);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentTracker')) dashboard.start();
    }),
    { dispose: () => dashboard.stop() },
  );
  dashboard.start();
  offerRules(context).catch(() => {});
}

function deactivate() {}

module.exports = { activate, deactivate };
