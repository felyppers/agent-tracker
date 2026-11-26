'use strict';
// Removes a git worktree an agent left behind, unless it holds work. Codes match the custom-script contract:
// 0 removed or already gone, 1 git failed, 2 kept (uncommitted changes or commits on no remote),
// 3 not a linked worktree (a main checkout is never touched).

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr || (err && err.message) || '').trim() });
    });
  });
}

async function cleanWorktree(wt) {
  if (!fs.existsSync(wt)) return { code: 0, message: `already gone: ${wt}` };
  const gitDir = await git(wt, ['rev-parse', '--absolute-git-dir']);
  const common = await git(wt, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!gitDir.ok || !common.ok || path.resolve(gitDir.out) === path.resolve(common.out)) {
    return { code: 3, message: `not a linked worktree: ${wt}` };
  }
  const status = await git(wt, ['status', '--porcelain']);
  if (!status.ok) return { code: 1, message: status.err.split('\n').pop() };
  const dirty = status.out.split('\n').filter(Boolean).length;
  const unpushed = Number((await git(wt, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])).out) || 0;
  if (dirty || unpushed) return { code: 2, message: `kept: ${dirty} uncommitted change(s), ${unpushed} unpushed commit(s) in ${wt}` };
  const removed = await git(path.dirname(common.out), ['worktree', 'remove', '--force', wt]);
  if (!removed.ok) return { code: 1, message: removed.err.split('\n').pop() };
  // Cursor nests each worktree in a folder of its own; drop it once empty.
  try {
    fs.rmdirSync(path.dirname(wt));
  } catch {}
  return { code: 0, message: `removed: ${wt}` };
}

module.exports = { cleanWorktree };
