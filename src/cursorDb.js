'use strict';
// Cursor keeps per-chat metadata in its global SQLite store: title, live status, model and context size.
// It stores no billed tokens (message bubbles record 0/0), so context use is the only usage figure available.

const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

function cursorUserDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Cursor', 'User');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Cursor', 'User');
}

function findSqlite() {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, `sqlite3${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return fs.existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : null;
}

const DB = path.join(cursorUserDir(), 'globalStorage', 'state.vscdb');
const SQLITE = findSqlite();

function available() {
  return Boolean(SQLITE) && fs.existsSync(DB);
}

const UUID = /^[0-9a-f-]{36}$/;

function query(sql, maxBuffer) {
  return new Promise((resolve) => {
    execFile(SQLITE, ['-readonly', '-json', '-cmd', '.timeout 2000', DB, sql], { timeout: 8000, maxBuffer }, (err, out) => {
      if (err || !out.trim()) return resolve([]);
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve([]);
      }
    });
  });
}

async function composerInfo(ids) {
  const clean = ids.filter((id) => UUID.test(id));
  if (!clean.length || !available()) return new Map();
  const keys = clean.map((id) => `'composerData:${id}'`).join(',');
  const sql =
    "select substr(key, 14) as id, json_extract(value, '$.name') as name, json_extract(value, '$.status') as status, " +
    "json_extract(value, '$.contextTokensUsed') as ctx, json_extract(value, '$.contextTokenLimit') as ctxLimit, " +
    "json_extract(value, '$.modelConfig.modelName') as model, json_extract(value, '$.modelConfig.maxMode') as maxMode, " +
    "json_extract(value, '$.lastUpdatedAt') as updatedAt, json_extract(value, '$.totalLinesAdded') as added, " +
    "json_extract(value, '$.totalLinesRemoved') as removed " +
    `from cursorDiskKV where key in (${keys})`;
  return new Map((await query(sql, 8 << 20)).map((row) => [row.id, row]));
}

// Message rows are written as the chat runs, while the transcript file can lag a whole turn behind.
// sinceById maps a chat id to the epoch ms after which rows are wanted.
async function liveMessages(sinceById) {
  const parts = [];
  for (const [id, since] of sinceById) {
    if (!UUID.test(id)) continue;
    const after = new Date(Math.max(0, since)).toISOString();
    parts.push(
      `select '${id}' as id, json_extract(value, '$.createdAt') as at, json_extract(value, '$.type') as type, ` +
        "json_extract(value, '$.text') as text, json_extract(value, '$.toolFormerData.name') as tool, " +
        "json_extract(value, '$.toolFormerData.status') as toolStatus, length(json_extract(value, '$.toolFormerData.rawArgs')) as argChars, " +
        "coalesce(json_extract(value, '$.toolFormerData.additionalData.blockReason'), json_extract(value, '$.toolFormerData.additionalData.smartModeApprovalRequestId')) as blockReason, " +
        "json_extract(value, '$.toolFormerData.userDecision') as decision, " +
        "json_extract(value, '$.toolFormerData.additionalData.reviewData.status') as reviewStatus, " +
        "json_extract(value, '$.toolFormerData.additionalData.startedAtMs') as startedAt, " +
        "json_extract(value, '$.toolFormerData.additionalData.status') as runStatus " +
        `from cursorDiskKV where key >= 'bubbleId:${id}:' and key < 'bubbleId:${id};' ` +
        `and (json_extract(value, '$.createdAt') > '${after}' or json_extract(value, '$.toolFormerData.status') = 'loading')`,
    );
  }
  const byId = new Map();
  if (!parts.length || !available()) return byId;
  for (const row of await query(parts.join(' union all '), 64 << 20)) {
    if (!byId.has(row.id)) byId.set(row.id, []);
    byId.get(row.id).push(row);
  }
  for (const rows of byId.values()) rows.sort((a, b) => (a.at < b.at ? -1 : 1));
  return byId;
}

module.exports = { composerInfo, liveMessages };
