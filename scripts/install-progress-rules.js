#!/usr/bin/env node
'use strict';
// Same as the editor command "Agent Tracker: Install Progress Rules", for a cloned repo.
//   node scripts/install-progress-rules.js [--bridge]
const { installProgressRules } = require('../src/install');

for (const line of installProgressRules({ bridge: process.argv.includes('--bridge') })) console.log(line);
