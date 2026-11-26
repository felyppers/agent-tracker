// Fictional sessions for the README screenshots and for working on the view without real data.
window.mockSnapshot = function mockSnapshot(now) {
  const min = 60 * 1000;
  const hour = 60 * min;
  const marker = (pct, step, text, next, stale = false) => ({ pct, step, text, next, stale });
  const session = (o) => ({
    id: o.id,
    source: o.source || 'cursor',
    sourceLabel: o.source === 'claude' ? 'Claude Code · VS Code' : 'Cursor',
    workspace: o.workspace || 'acme-web',
    cwd: `/Users/dev/code/${o.workspace || 'acme-web'}`,
    model: o.model || (o.source === 'claude' ? 'claude-opus-4-5' : 'gpt-5.1-codex'),
    file: `/Users/dev/.cursor/projects/acme/agent-transcripts/${o.id}.jsonl`,
    lastActive: now - (o.ago || 0),
    title: o.title,
    lastPrompt: o.title,
    asked: Boolean(o.asked),
    ticket: o.ticket || '',
    branch: o.branch || '',
    isWork: true,
    marker: o.marker || null,
    todos: null,
    lastText: o.lastText || (o.marker ? `**[${o.marker.pct}%]** ${o.marker.step} — ${o.marker.text}` : ''),
    turnEnded: o.status === 'working' || o.status === 'blocked' ? null : { status: 'success', error: '' },
    instructions: o.instructions || 1,
    tools: o.tools || 12,
    replies: o.replies || 8,
    worktrees: o.worktrees || [],
    prs: o.prs || [],
    cost: o.cost === undefined ? null : { usd: o.cost, output: 40000, unpriced: false, estimated: (o.source || 'cursor') === 'cursor' },
    context: o.context || { used: 64000, limit: 200000 },
    subs: o.subs || [],
    live: o.source === 'claude' ? { status: o.status === 'working' ? 'busy' : 'idle', alive: o.status === 'working', pid: 4242, entrypoint: 'claude-vscode' } : null,
    processes: o.processes || [],
    tags: o.tags,
    status: o.status,
  });
  const sub = (o) => ({
    id: o.id, name: o.name, file: '', lastActive: now - (o.ago || 0), finished: o.status === 'done', background: false,
    marker: o.marker || null, tools: o.tools || 6, lastText: o.lastText || '', prs: [], tags: o.tags || [], status: o.status,
  });

  return {
    generatedAt: now,
    since: now - 7 * 24 * hour,
    range: 'week',
    capabilities: { isCursor: true, hasClaudeExtension: true },
    sessions: [
      session({
        id: 'c1', title: 'Add CSV export to the invoices page', status: 'working', ago: 20 * 1000, tags: ['build'],
        ticket: 'ACME-142', branch: 'feature/csv-export', cost: 1.84, context: { used: 92000, limit: 200000 }, tools: 41,
        marker: marker(60, '3/5', 'export endpoint streams rows', 'wire the download button'),
        worktrees: ['~/.cursor/worktrees/acme-web/csv-export'],
        processes: [{ pid: 5120, command: 'pnpm test invoices' }],
        subs: [
          sub({ id: 's1', name: 'Write export tests', status: 'working', ago: 30 * 1000, tags: ['test'], marker: marker(40, '2/5', 'fixtures ready', 'edge cases') }),
          sub({ id: 's2', name: 'Explore the invoice table schema', status: 'done', ago: 12 * min, tags: ['research'] }),
          sub({ id: 's3', name: 'Check the export size limits', status: 'done', ago: 9 * min, tags: ['research'] }),
        ],
      }),
      session({
        id: 'c2', source: 'claude', workspace: 'acme-api', title: '/fix https://github.com/acme/api/pull/88', status: 'working',
        ago: 50 * 1000, tags: ['fix'], cost: 2.31, context: { used: 118000, limit: 200000 }, tools: 63,
        marker: marker(30, 'Round 1/≤5', 'triaged 5 threads (3 fix, 2 reply)', 'fix the 3 threads'),
        prs: ['https://github.com/acme/api/pull/88'], branch: 'fix/rate-limit-headers', processes: [{ pid: 4242, command: 'claude' }],
      }),
      session({
        id: 'c3', title: 'Migrate the users table to UUID keys', status: 'blocked', ago: 3 * min, tags: ['build', 'ops'],
        ticket: 'ACME-131', branch: 'feature/uuid-users', cost: 0.97,
        marker: marker(45, '4/9', 'backfill script written', 'run it against the dev database'),
        lastText: 'The backfill is ready. Running it needs your approval.',
      }),
      session({
        id: 'c4', source: 'claude', workspace: 'acme-web', title: 'Pick a charting library for the usage dashboard', status: 'waiting',
        ago: 7 * min, tags: ['research'], asked: true, cost: 0.62,
        marker: marker(50, '2/4', 'compared Recharts and ECharts', 'your choice'),
        lastText: 'Recharts is smaller; ECharts handles 100k points. Which one should I use?',
      }),
      session({
        id: 'c5', title: 'Explain the retry logic in the job queue', status: 'idle', ago: 2 * hour, tags: ['research'], cost: 0.18,
        lastText: 'Jobs retry 5 times with exponential backoff, capped at 10 minutes.',
      }),
      session({
        id: 'c6', source: 'claude', workspace: 'acme-api', title: '/review https://github.com/acme/api/pull/85', status: 'done',
        ago: 40 * min, tags: ['review'], cost: 1.12, marker: marker(100, '6/6', 'review posted: 0 high, 2 medium, 1 low', 'none'),
        prs: ['https://github.com/acme/api/pull/85'],
      }),
      session({
        id: 'c7', title: 'Write release notes for v2.4', status: 'done', ago: 3 * hour, tags: ['docs'], cost: 0.41,
        marker: marker(100, '3/3', 'notes published to the changelog', 'none'),
      }),
      session({
        id: 'c8', title: 'Fix the flaky login e2e test', status: 'done', ago: 5 * hour, tags: ['test', 'fix'], cost: 0.88,
        ticket: 'ACME-127', marker: marker(100, '4/4', 'test waits for the session cookie', 'none'),
        prs: ['https://github.com/acme/web/pull/412'],
      }),
      session({
        id: 'c9', source: 'claude', title: 'Upgrade React to 19', status: 'done', ago: 2 * 24 * hour, tags: ['ops'], cost: 3.4,
        marker: marker(100, '7/7', 'upgrade merged', 'none'), prs: ['https://github.com/acme/web/pull/398'],
      }),
      session({
        id: 'c10', title: 'Plan the billing settings redesign', status: 'idle', ago: 3 * 24 * hour, tags: ['plan'], cost: 0.55,
        marker: marker(100, '4/4', 'plan written to docs/plans', 'none'),
      }),
    ],
  };
};
