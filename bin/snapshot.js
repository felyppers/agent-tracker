#!/usr/bin/env node
'use strict';
// Prints one scan as JSON (or --brief for one line per session) without VS Code.
const { Collector } = require('../src/collect');

const args = process.argv.slice(2);
const hours = Number((args.find((a) => a.startsWith('--hours=')) || '--hours=24').split('=')[1]);

new Collector()
  .scan({ since: Date.now() - hours * 3600 * 1000, onlyWork: args.includes('--work'), stalledMinutes: 15, prices: {} })
  .then((snap) => {
    if (!args.includes('--brief')) return console.log(JSON.stringify(snap, null, 2));
    for (const s of snap.sessions) {
      const pct = s.marker ? `${s.marker.pct}%${s.marker.stale ? '?' : ''}` : s.todos ? `${s.todos.done}/${s.todos.total}` : '-';
      const cost = s.cost ? `$${s.cost.usd.toFixed(2)}` : '';
      const ago = Math.round((snap.generatedAt - s.lastActive) / 60000);
      console.log(
        [s.status.padEnd(8), s.sourceLabel.padEnd(22), s.workspace.padEnd(14), pct.padEnd(6), `${ago}m`.padEnd(6),
          cost.padEnd(8), s.title.slice(0, 60)].join(' '),
      );
      for (const sub of s.subs) console.log(`    └ ${sub.status.padEnd(8)} ${sub.name.slice(0, 70)}`);
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
