'use strict';
// Maps live processes to agent sessions. Cursor exports CURSOR_CONVERSATION_ID into every agent shell, and
// children inherit it; Claude Code sessions are found as descendants of the pid in ~/.claude/sessions.
// Windows doesn't expose other processes' environments, so there Cursor processes stay unmatched.

const fs = require('fs');
const { execFile } = require('child_process');

const CONV = /\bCURSOR_CONVERSATION_ID=([0-9a-f-]{36})\b/;

function macProcesses() {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-axEww', '-o', 'pid=,ppid=,command='], { maxBuffer: 64 << 20, timeout: 8000 }, (err, out) => {
      if (err) return resolve([]);
      const procs = [];
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (!m) continue;
        const raw = m[3];
        const conv = CONV.exec(raw);
        // ps -E appends the environment after the command; keep the command part for display.
        const envStart = raw.search(/\s[A-Z_][A-Z0-9_]*=/);
        procs.push({
          pid: Number(m[1]),
          ppid: Number(m[2]),
          command: (envStart > 0 ? raw.slice(0, envStart) : raw).slice(0, 160),
          conversation: conv ? conv[1] : null,
        });
      }
      resolve(procs);
    });
  });
}

function linuxProcesses() {
  const procs = [];
  let names = [];
  try {
    names = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n));
  } catch {
    return procs;
  }
  for (const name of names) {
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      // The command name in field 2 may contain spaces, so fields are counted from its closing paren.
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const command = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').join(' ').trim();
      let env = '';
      try {
        env = fs.readFileSync(`/proc/${name}/environ`, 'utf8');
      } catch {}
      const conv = /(?:^|\0)CURSOR_CONVERSATION_ID=([0-9a-f-]{36})/.exec(env);
      procs.push({ pid: Number(name), ppid, command: command.slice(0, 160), conversation: conv ? conv[1] : null });
    } catch {}
  }
  return procs;
}

function windowsProcesses() {
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 64 << 20, timeout: 15000, windowsHide: true }, (err, out) => {
      if (err) return resolve([]);
      let rows;
      try {
        rows = JSON.parse(out);
      } catch {
        return resolve([]);
      }
      resolve((Array.isArray(rows) ? rows : [rows]).map((r) => ({
        pid: Number(r.ProcessId),
        ppid: Number(r.ParentProcessId),
        command: String(r.CommandLine || '').slice(0, 160),
        conversation: null,
      })));
    });
  });
}

async function listProcesses() {
  if (process.platform === 'darwin') return macProcesses();
  if (process.platform === 'win32') return windowsProcesses();
  return linuxProcesses();
}

function descendants(procs, rootPid) {
  const children = new Map();
  for (const p of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  const out = [];
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    for (const child of children.get(pid) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      stack.push(child.pid);
    }
  }
  return out;
}

async function terminate(pids) {
  const own = new Set([process.pid, process.ppid]);
  const targets = [...new Set(pids)].filter((pid) => pid > 1 && !own.has(pid));
  for (const pid of targets) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 3000));
  let forced = 0;
  for (const pid of targets) {
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
      forced += 1;
    } catch {}
  }
  return { signalled: targets.length, forced };
}

module.exports = { listProcesses, descendants, terminate };
