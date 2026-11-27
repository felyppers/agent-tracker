(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  let filter = saved.filter || 'all';
  let tagFilter = saved.tagFilter || '';
  let query = saved.query || '';
  let snapshot = null;
  let loading = false;
  const openGroups = new Set(saved.openGroups || ['working', 'turn']);
  const expandedSubs = new Set();
  const hiddenInBar = new Set(saved.hiddenInBar || []);
  const root = document.getElementById('root');
  const search = document.getElementById('search');
  search.value = query;

  const STATUS = {
    working: { label: 'working', cls: 'working' },
    blocked: { label: 'needs approval', cls: 'blocked' },
    waiting: { label: 'asked you', cls: 'waiting' },
    idle: { label: 'idle', cls: 'idle' },
    stalled: { label: 'stalled', cls: 'stalled' },
    stopped: { label: 'stopped', cls: 'stalled' },
    error: { label: 'error', cls: 'error' },
    done: { label: 'done', cls: 'done' },
    killed: { label: 'killed', cls: 'stalled' },
  };
  const CLOSED_MS = 24 * 3600 * 1000;
  const NEEDS_YOU = ['waiting', 'blocked', 'error', 'stalled', 'stopped'];

  function groupOf(s, now) {
    const fresh = now - s.lastActive < CLOSED_MS;
    if (s.status === 'killed') return s.processes.length ? 'leftover' : 'closed';
    if (s.status === 'working') return 'working';
    if (s.status === 'done' && (fresh || !s.processes.length)) return 'done';
    if (fresh && NEEDS_YOU.includes(s.status)) return 'turn';
    if (fresh && s.status === 'idle') return 'idle';
    // A chat nobody touched for a day is history, unless it still has processes running.
    return s.processes.length ? 'leftover' : 'closed';
  }

  function colourOfStatus(status) {
    if (NEEDS_YOU.includes(status)) return 'turn';
    if (status === 'killed') return 'closed';
    return STATUS[status] ? status : 'working';
  }
  const CURSOR_USAGE = 'https://cursor.com/dashboard?tab=usage';
  const ESTIMATE_HINT =
    'Estimate at API list price. Cursor stores no token counts, so this is built from the number of model calls, ' +
    'the current context size and the characters the agent wrote. Hidden thinking is not counted. Billed usage is on cursor.com.';

  function save() {
    vscode.setState({ filter, tagFilter, query, openGroups: [...openGroups], hiddenInBar: [...hiddenInBar] });
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      // The webview CSP blocks style attributes; CSSOM writes are allowed.
      else if (k === 'style') node.style.cssText = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const send = (msg) => vscode.postMessage(msg);
  const link = (label, onclick, attrs) => el('a', { href: '#', ...attrs, onclick: (e) => (e.preventDefault(), e.stopPropagation(), onclick()) }, label);

  function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
    return `${Math.floor(s / 86400)}d`;
  }

  function human(n) {
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
    return String(n);
  }

  function progressOf(s) {
    if (s.marker) return { pct: s.marker.pct, step: s.marker.step, text: s.marker.text, next: s.marker.next, stale: s.marker.stale };
    if (s.todos) {
      return {
        pct: Math.round((100 * s.todos.done) / s.todos.total),
        step: `${s.todos.done}/${s.todos.total} to-dos`,
        text: s.todos.current,
        next: '',
        stale: false,
      };
    }
    return null;
  }

  function pctOf(s) {
    if (s.status === 'done') return 100;
    const p = progressOf(s);
    return p && !p.stale ? p.pct : null;
  }

  function bar(pct, cls) {
    return el('div', { class: `bar ${cls || ''}` }, el('div', { class: 'fill', style: `width:${pct}%` }));
  }

  function tagChip(tag) {
    return el('span', { class: `tag tag-${tag}`, title: `Filter by ${tag}`, onclick: (e) => (e.stopPropagation(), setTag(tagFilter === tag ? '' : tag)) }, tag);
  }

  function prLink(url) {
    const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
    return link(m ? `${m[2]}#${m[3]}` : url, () => send({ type: 'openUrl', url }), { title: url });
  }

  function usageLine(s) {
    const parts = [];
    if (s.context) {
      const pct = s.context.limit ? Math.round((100 * s.context.used) / s.context.limit) : null;
      parts.push(el('span', { class: 'ctx', title: 'Context window in use after the latest reply' },
        `ctx ${human(s.context.used)}${s.context.limit ? `/${human(s.context.limit)}` : ''}`,
        pct !== null && bar(pct, `mini ${pct >= 85 ? 'hot' : ''}`)));
    }
    if (s.cost && s.cost.estimated && !s.cost.usd) {
      parts.push(el('span', { class: 'dim', title: 'The chat uses a model missing from the price table (agentTracker.prices).' }, 'cost: unpriced model'));
    } else if (s.cost && s.cost.estimated) {
      parts.push(el('span', { title: ESTIMATE_HINT }, `≈$${s.cost.usd.toFixed(2)} est. · ${human(s.cost.output)} out`));
    } else if (s.cost) {
      const usd = `${s.cost.unpriced ? '≥' : ''}$${s.cost.usd.toFixed(2)}`;
      parts.push(el('span', { title: 'API list price for every reply, cache reads and writes included. Subscription plans are not billed this.' },
        `${usd} API-equiv · ${human(s.cost.output)} out`));
    } else if (s.source === 'cursor') {
      parts.push(link('cost on cursor.com', () => send({ type: 'openUrl', url: CURSOR_USAGE }), {
        class: 'dimlink', title: 'Cursor stores no per-chat token counts locally. Billed usage is on the Cursor dashboard.',
      }));
    }
    if (s.lines) parts.push(el('span', { class: 'lines' }, el('span', { class: 'add' }, `+${s.lines.added}`), ' ', el('span', { class: 'del' }, `−${s.lines.removed}`)));
    return parts;
  }

  function procChip(s) {
    const n = s.processes.length;
    if (!n) return null;
    const leftover = !['working', 'blocked'].includes(s.status);
    return el('span', {
      class: `procs${leftover ? ' leftover' : ''}`,
      title: `${leftover ? 'Still running after the agent stopped:\n' : ''}${s.processes.map((p) => `${p.pid}  ${p.command}`).join('\n')}`,
    }, `${n} proc${n === 1 ? '' : 's'}${leftover ? ' left over' : ''}`);
  }

  function worktreeChip(s) {
    const notes = s.worktreeNotes || [];
    if (!notes.length) return null;
    const kept = notes.filter((n) => n.kept);
    const label = `${notes.length} worktree${notes.length === 1 ? '' : 's'}${kept.length ? ' kept' : ''}`;
    const title = notes.map((n) => `${n.path}${n.kept ? `\n  ${n.kept}` : ''}`).join('\n');
    return el('span', { class: `procs${kept.length ? ' leftover' : ''}`, title }, label);
  }

  function actions(s) {
    const caps = snapshot.capabilities || {};
    const cursorOnly = s.source === 'cursor' && !caps.isCursor;
    const running = s.processes.length > 0 || (s.source === 'cursor' && caps.isCursor && s.status === 'working');
    const canKill = s.status !== 'killed';
    const killTitle = running
      ? 'Stop the chat, its subagents and every process it started'
      : 'Nothing is running; move this chat to Closed';
    const btn = (label, action, title, disabled, cls) =>
      el('button', { class: `act ${cls || ''}`, title, disabled, onclick: (e) => (e.stopPropagation(), send({ type: 'action', action, id: s.id })) }, label);
    return el('div', { class: 'actions' },
      btn('Ping', 'ping', s.source === 'cursor' ? 'Resume the chat so the agent takes another turn' : 'Send the ping message to the session', cursorOnly),
      btn('Kill', 'kill', killTitle, !canKill, 'danger'),
    );
  }

  const SUB_ORDER = ['working', 'blocked', 'waiting', 'error', 'stalled', 'stopped', 'idle', 'done', 'killed'];
  function subRank(sub) {
    const i = SUB_ORDER.indexOf(sub.status);
    return i < 0 ? SUB_ORDER.indexOf('idle') : i;
  }

  function subRow(s, sub, now) {
    const st = STATUS[sub.status] || STATUS.working;
    const pct = sub.marker ? `${sub.marker.pct}%` : '';
    const opens = s.source === 'cursor' && (snapshot.capabilities || {}).isCursor ? 'Open the subagent chat'
      : s.source === 'claude' ? 'Open the parent chat (Claude Code has no subagent view)' : 'Open the subagent transcript';
    return el('div', { class: 'sub', title: sub.lastText || '' },
      el('span', { class: `dot g-${colourOfStatus(sub.status)} ${st.cls}` }),
      (sub.tags || []).map(tagChip),
      link(sub.name, () => send({ type: 'openSub', id: s.id, subId: sub.id }), {
        class: 'sub-name', title: `${sub.name}\n\n${opens}`,
      }),
      el('button', {
        class: 'tag-edit',
        title: sub.autoTags ? `Edit labels (automatic: ${sub.autoTags.join(', ') || 'none'})` : 'Edit labels',
        onclick: (e) => (e.stopPropagation(), send({ type: 'editTags', id: s.id, subId: sub.id })),
      }, '✎'),
      el('span', { class: 'dim' }, [pct, sub.status === 'working' ? `${ago(now - sub.lastActive)} ago` : st.label].filter(Boolean).join(' · ')),
    );
  }

  function card(s, now, key) {
    const st = STATUS[s.status] || STATUS.working;
    const p = progressOf(s);
    const meta = [s.sourceLabel, s.workspace, s.model, s.ticket, s.branch && s.branch !== s.ticket ? s.branch : ''].filter(Boolean);
    const subs = [...s.subs].sort((a, b) => subRank(a) - subRank(b) || b.lastActive - a.lastActive);
    const runningSubs = subs.filter((x) => x.status === 'working');
    const expanded = expandedSubs.has(s.id);
    const shownSubs = expanded ? subs : s.status === 'done' ? [] : runningSubs.concat(
      subs.filter((x) => x.status !== 'working').slice(0, Math.max(0, 3 - runningSubs.length)),
    );
    const hiddenSubs = s.subs.length - shownSubs.length;
    const toggleSubs = (e) => {
      e.stopPropagation();
      expanded ? expandedSubs.delete(s.id) : expandedSubs.add(s.id);
      render();
    };
    const showLast = s.lastText && (!p || !s.lastText.includes(p.text)) && s.status !== 'done';

    return el('section', { class: `card g-${key}` },
      el('div', { class: 'row title-row' },
        el('span', { class: `dot ${st.cls}`, title: st.label }),
        link(s.title, () => send({ type: 'action', action: 'open', id: s.id }), { class: 'title', title: `${s.title}\n\nOpen` }),
        el('span', { class: 'ago', title: new Date(s.lastActive).toLocaleString() }, ago(now - s.lastActive)),
      ),
      el('div', { class: 'meta' },
        s.tags.map(tagChip),
        el('button', {
          class: 'tag-edit',
          title: s.autoTags ? `Edit labels (automatic: ${s.autoTags.join(', ')})` : 'Edit labels',
          onclick: (e) => (e.stopPropagation(), send({ type: 'editTags', id: s.id })),
        }, '✎'),
        el('span', { class: 'badge' }, st.label), ' ', meta.join(' · ')),
      p && !p.stale && el('div', { class: 'row progress' }, bar(p.pct), el('span', { class: 'pct' }, `${p.pct}%`), p.step && el('span', { class: 'step' }, p.step)),
      p && !p.stale && p.text && el('div', { class: 'now' }, p.text),
      p && !p.stale && p.next && el('div', { class: 'next' }, `next: ${p.next}`),
      p && p.stale && el('div', { class: 'next', title: p.text }, `No progress line since your latest instruction. Previous turn ended at ${p.pct}%${p.step ? ` (${p.step})` : ''}.`),
      !p && s.status === 'working' && el('div', { class: 'dim' }, 'No progress line yet.'),
      showLast && el('div', { class: 'last', title: s.lastText }, `› ${s.lastText}`),
      s.subs.length > 0 && (shownSubs.length > 0 || hiddenSubs > 0) && el('div', { class: 'subs' },
        shownSubs.map((x) => subRow(s, x, now)),
        hiddenSubs > 0 && el('div', { class: 'sub more', onclick: toggleSubs }, `▸ ${hiddenSubs} more subagent${hiddenSubs === 1 ? '' : 's'}`),
        expanded && s.subs.length > 3 && el('div', { class: 'sub more', onclick: toggleSubs }, '▾ show fewer'),
      ),
      s.prs.length > 0 && el('div', { class: 'prs' }, s.prs.map(prLink)),
      el('div', { class: 'foot' },
        el('span', {}, `${s.tools} tools · ${s.instructions} prompt${s.instructions === 1 ? '' : 's'}${s.subs.length ? ` · ${s.subs.length} subagents` : ''}`),
        usageLine(s),
        procChip(s),
        worktreeChip(s),
        link('id', () => send({ type: 'copy', text: s.id }), { class: 'copy', title: 'Copy session id' }),
      ),
      actions(s),
    );
  }

  function group(key, title, items, now, hint) {
    if (!items.length) return null;
    const open = openGroups.has(key);
    return el('div', { class: 'group' },
      el('button', {
        class: 'group-head',
        onclick: () => {
          open ? openGroups.delete(key) : openGroups.add(key);
          save();
          render();
        },
      }, `${open ? '▾' : '▸'} ${title}`, el('span', { class: 'count' }, items.length), hint && el('span', { class: 'dim hint' }, hint)),
      open && items.map((s) => card(s, now, key)),
    );
  }

  function matches(s, withTag) {
    if (filter !== 'all' && s.source !== filter) return false;
    if (withTag && tagFilter && !s.tags.includes(tagFilter) && !s.subs.some((x) => (x.tags || []).includes(tagFilter))) return false;
    if (!query) return true;
    const hay = [s.title, s.lastPrompt, s.workspace, s.ticket, s.branch, s.model, ...s.tags, ...s.prs, ...s.subs.map((x) => x.name)].join(' ').toLowerCase();
    return hay.includes(query.toLowerCase());
  }

  function setTag(tag) {
    tagFilter = tag;
    save();
    render();
  }

  function renderTags(pool) {
    const counts = new Map();
    for (const s of pool) for (const t of s.tags) counts.set(t, (counts.get(t) || 0) + 1);
    const tags = [...counts].sort((a, b) => b[1] - a[1]);
    document.getElementById('tags').replaceChildren(...[
      ...tags.map(([t, n]) => el('button', { class: `tag tag-${t}${tagFilter === t ? ' on' : ''}`, onclick: () => setTag(tagFilter === t ? '' : t) }, `${t} ${n}`)),
      tagFilter && link('clear', () => setTag(''), { class: 'dimlink' }),
    ].filter(Boolean));
  }

  function renderOverall(sessions, counts) {
    const box = document.getElementById('overall');
    box.hidden = sessions.length === 0;
    if (box.hidden) return box.replaceChildren();
    // A closed chat is finished business, so it counts as complete whatever its last progress line said.
    const pctIn = (key, s) => (key === 'closed' ? 100 : pctOf(s));
    const shown = Object.keys(counts).filter((key) => !hiddenInBar.has(key));
    const scored = shown.flatMap((key) => counts[key].map((s) => pctIn(key, s))).filter((x) => x !== null);
    const overall = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : 0;
    const sum = (list) => list.reduce((a, s) => a + s.cost.usd, 0);
    const claude = sessions.filter((s) => s.cost && !s.cost.estimated);
    const cursor = sessions.filter((s) => s.cost && s.cost.estimated && s.cost.usd);
    const claudeFloor = claude.some((s) => s.cost.unpriced);
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const parts = [
      ['turn', 'need you'],
      ['working', 'working'],
      ['idle', 'idle'],
      ['leftover', 'left over'],
      ['done', 'done'],
      ['closed', 'closed'],
    ].map(([key, label]) => [key, label, counts[key].length]).filter(([, , n]) => n > 0);
    // Each group's slice is its share of the summed progress, so the slices add up to the average.
    const slices = parts.filter(([key]) => !hiddenInBar.has(key)).map(([key, label]) => {
      const pcts = counts[key].map((s) => pctIn(key, s)).filter((x) => x !== null);
      return [key, label, scored.length ? pcts.reduce((a, b) => a + b, 0) / scored.length : 0, pcts.length];
    }).filter(([, , width]) => width > 0);
    const toggle = (key) => {
      hiddenInBar.has(key) ? hiddenInBar.delete(key) : hiddenInBar.add(key);
      save();
      render();
    };
    const hiddenNote = hiddenInBar.size ? `\nHidden from the bar: ${[...hiddenInBar].map((k) => (parts.find(([key]) => key === k) || [k, k])[1]).join(', ')}` : '';
    box.replaceChildren(...[
      el('div', { class: 'row overall-row', title: `Average progress of ${plural(scored.length, 'session')} that report progress; closed counts as 100%${hiddenNote}` },
        el('span', { class: 'overall-label' }, 'Overall'),
        el('div', { class: 'progress-stack' },
          slices.map(([key, label, width, n]) => el('div', { class: `slice g-${key}`, style: `width:${width}%`, title: `${plural(n, label + ' session')}` }))),
        el('span', { class: 'pct big' }, `${overall}%`),
      ),
      el('div', { class: 'legend' },
        parts.map(([key, label, n]) => el('button', {
          class: `legend-item${hiddenInBar.has(key) ? ' off' : ''}`,
          title: hiddenInBar.has(key) ? `Show ${label} in the bar` : `Hide ${label} from the bar`,
          onclick: () => toggle(key),
        }, el('span', { class: `swatch g-${key}` }), `${n} ${label}`)),
        el('span', { class: 'dim' }, `of ${sessions.length}`)),
      (claude.length > 0 || cursor.length > 0) && el('div', { class: 'cost-row' },
        el('span', {},
          claude.length > 0 && el('span', { title: `API list price for every reply in ${plural(claude.length, 'Claude Code session')}. Subscription plans are not billed this.` },
            el('strong', {}, `${claudeFloor ? '≥' : ''}$${sum(claude).toFixed(2)}`), ' Claude'),
          claude.length > 0 && cursor.length > 0 && ' · ',
          cursor.length > 0 && el('span', { title: `${ESTIMATE_HINT}\n\n${plural(cursor.length, 'Cursor chat')}.` },
            el('strong', {}, `≈$${sum(cursor).toFixed(2)}`), ' Cursor est.'),
          el('span', { class: 'dim' }, ` · total ${claudeFloor ? '≥' : '≈'}$${(sum(claude) + sum(cursor)).toFixed(2)}`)),
        cursor.length > 0 && link('billed on cursor.com', () => send({ type: 'openUrl', url: CURSOR_USAGE }), { class: 'dimlink' })),
    ].filter(Boolean));
  }

  function render() {
    document.querySelectorAll('[data-range]').forEach((b) => b.classList.toggle('on', snapshot && b.dataset.range === snapshot.range));
    if (!snapshot) return;
    const now = Date.now();
    const pool = snapshot.sessions.filter((s) => matches(s, false));
    renderTags(pool);
    const sessions = pool.filter((s) => matches(s, true));
    const by = { working: [], turn: [], idle: [], leftover: [], done: [], closed: [] };
    for (const s of sessions) by[groupOf(s, now)].push(s);
    renderOverall(sessions, by);
    root.replaceChildren(
      ...[
        group('turn', 'Needs you', by.turn, now, 'asked you something, blocked or failed'),
        group('working', 'Working', by.working, now),
        group('idle', 'Idle', by.idle, now, 'finished answering, nothing pending'),
        group('leftover', 'Processes left over', by.leftover, now, 'quiet over a day, still running'),
        group('done', 'Done', by.done, now, 'last progress line said 100%'),
        group('closed', 'Closed', by.closed, now, 'quiet over a day'),
      ].filter(Boolean),
    );
    if (!sessions.length) root.append(el('p', { class: 'dim' }, loading ? 'Scanning…' : 'No agent sessions match.'));
    const version = snapshot.capabilities && snapshot.capabilities.version;
    document.getElementById('updated').textContent =
      `Updated ${new Date(snapshot.generatedAt).toLocaleTimeString()}${loading ? ' · scanning…' : ''}${version ? ` · v${version}` : ''}`;
  }

  document.querySelectorAll('[data-range]').forEach((b) =>
    b.addEventListener('click', () => {
      loading = true;
      if (snapshot) snapshot.range = b.dataset.range;
      render();
      send({ type: 'range', range: b.dataset.range });
    }),
  );
  document.querySelectorAll('[data-filter]').forEach((b) => {
    b.classList.toggle('on', b.dataset.filter === filter);
    b.addEventListener('click', () => {
      filter = b.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach((x) => x.classList.toggle('on', x === b));
      save();
      render();
    });
  });
  search.addEventListener('input', () => {
    query = search.value.trim();
    save();
    render();
  });
  window.addEventListener('message', (e) => {
    const msg = e.data || {};
    if (msg.type === 'data') {
      snapshot = msg.snapshot;
      loading = false;
      render();
    } else if (msg.type === 'loading') {
      loading = true;
      render();
    }
  });
  setInterval(render, 15000);
  send({ type: 'ready' });
})();
