'use strict';
// Renders a Claude Code or Cursor JSONL transcript as Markdown, for chats the editor can't open natively
// (Claude subagents, Cursor chats viewed from VS Code).
const fs = require('fs');

const MAX_TEXT = 6000;

function blocksOf(entry) {
  const content = entry.message && entry.message.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function toolLine(block) {
  const input = block.input || {};
  const arg = input.description || input.command || input.file_path || input.path || input.pattern || input.prompt || input.url || '';
  const short = String(arg).replace(/\s+/g, ' ').trim().slice(0, 140);
  return `- \`${block.name}\`${short ? ` ${short}` : ''}`;
}

function clip(text) {
  const t = String(text || '').trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n\n…(${t.length - MAX_TEXT} more characters)` : t;
}

function transcriptMarkdown(file, title) {
  const out = [`# ${title || 'Transcript'}`, '', `\`${file}\``, ''];
  let speaker = '';
  let tools = [];
  const flushTools = () => {
    if (tools.length) out.push(...tools, '');
    tools = [];
  };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const role = entry.role || entry.type;
    if (role !== 'user' && role !== 'assistant') continue;
    for (const block of blocksOf(entry)) {
      if (block.type === 'tool_use') {
        if (speaker !== 'assistant') out.push('## Agent', '');
        speaker = 'assistant';
        tools.push(toolLine(block));
      } else if (block.type === 'text' && block.text && block.text.trim()) {
        flushTools();
        if (speaker !== role) out.push(role === 'user' ? '## Prompt' : '## Agent', '');
        speaker = role;
        out.push(clip(block.text), '');
      }
    }
  }
  flushTools();
  return out.join('\n');
}

module.exports = { transcriptMarkdown };
