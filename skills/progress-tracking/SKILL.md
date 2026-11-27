---
name: progress-tracking
description: Report a percentage progress line on every task and every follow-up message, in the `**[NN%]** k/N — done · next: step` shape that Agent Tracker parses. Use on every task, including one-shot answers and orchestrators whose progress includes their subagents' work, and pass it on to every subagent you spawn.
---

# Progress tracking

Agent Tracker (and any terminal status line reading the same format) shows each agent's progress by parsing lines it prints. A chat that prints none shows no progress bar, and a chat whose last line predates your latest message shows as stale.

## The line

Print each progress line on its own, at the start of the line:

```
**[NN%]** k/N — <what just finished> · next: <next step>
```

- `NN` is the percentage, `k/N` the steps done out of the total.
- The text after `—` says what just finished; the text after `next:` names the next step.

## When to print it

1. **Plan.** As soon as you know the plan for a message, print `**[0%]** 0/N — <plan in a few words> · next: <first step>`.
2. **Each step.** After each step finishes, print a line with the new percentage.
3. **Finish.** The last message of the task starts with `**[100%]**`.
4. **One-shot answers** are one step: start the answer with `**[100%]** 1/1 — <what you answered>`.
5. **Follow-ups** in the same chat are new tasks: start again at `**[0%]**` with their own plan.

## Rules

- `NN` = steps done / total steps. If the plan grows or shrinks, change `N` and keep going. Don't restart from 0.
- Weight a step by its size when one clearly dominates (a long test run, a big refactor). The number should track time, not only count steps.
- When you stop to ask the user something, keep the current percentage. Never print 100% for a task that is waiting on the user.
- A skill or command that defines its own progress table uses that table, as long as its lines keep the `**[NN%]**` prefix.

## Subagents

Your subagents' steps are part of your plan. `N` is your own steps plus every subagent's steps, and `k` is everything finished across all of them.

- **Plan their steps up front.** When you know you'll delegate, put each subagent's step count in `N` from the start, or an estimate if you don't know its plan yet. Then spawning doesn't make the number drop.
- **Correct `N` as you learn more.** When a subagent's real plan is longer or shorter than your estimate, change `N` and keep going. Never restart from 0.
- **Count their steps as they finish.** Add each subagent's finished steps to your `k` from its latest `k/N`. A subagent you can't read counts when its result comes back.
- **Check in on them.** Your line only moves when you print one, so while subagents run, check every few minutes. Use your host's wait tool (a background wait or monitor), not a busy loop. Read only each subagent's latest progress line, and print a new line of yours when any of them moved. Stop when the last one returns.
  - Cursor: `~/.cursor/projects/<project>/agent-transcripts/<your chat id>/subagents/<subagent id>.jsonl`
  - Claude Code: `~/.claude/projects/<project>/<your session id>/subagents/agent-<id>.jsonl`, or the output file the spawn call returned
  - Latest line of one subagent: `grep -oE '\[[0-9]{1,3}%\]\** *[0-9]+/[0-9]+' <file> | tail -1`
- **If your host ends your turn while subagents run**, you can't check in. End the turn on the current percentage and update it each time a subagent reports back.
- **Never print 100% while a subagent you started is still running.** A turn that ends with subagents running ends on the current percentage.
- Tell every subagent you spawn to follow this skill, so its own row shows its progress too.

## Approvals in subagents

A subagent's approval prompt shows only inside the subagent's own chat, and some hosts (Claude Code in VS Code) can't open that chat. The user watches your chat, so every approval goes through you.

- **Spot held subagents when you check in.** A subagent whose transcript hasn't changed for two minutes, and whose last entry is a tool call, is almost always waiting on an approval.
- **Ask the user in your own chat**, right away, and keep your percentage. Name the subagent, the exact command or file, and why it's needed. Tell them where to approve it: in Cursor, open the subagent from your chat; anywhere else, reply to you. Asking ends your turn on a question, which is what moves your chat to Needs you.
- **When they say yes**, unblock it however your host allows: resume the subagent with the approval, or run the command yourself and hand it the result.
- **Tell every subagent you spawn:** if a call is denied, or it needs something only the user can grant, stop and return the exact request to you. Don't work around it or wait silently.

`**[42%]** 13/31 — ACME-2 subagent is waiting for approval to edit db/schema.sql, needed for the new column. Approve it in that subagent's chat or reply "yes" here · next: your answer`

## Examples

```
**[0%]** 0/4 — plan: reproduce, fix, test, open PR · next: reproduce the failing test
**[25%]** 1/4 — reproduced: date parsing drops the timezone · next: fix the parser
**[50%]** 2/4 — parser keeps the offset · next: run the suite
**[75%]** 3/4 — 412 tests pass · next: open the PR
**[100%]** 4/4 — PR opened · next: none
```

An orchestrator with 4 steps of its own (claim, worktrees, spawn, report) and three subagents of about 9 steps each plans 4 + 27 = 31 steps:

```
**[0%]** 0/31 — plan: claim 3 tickets, make worktrees, 3 subagents (~9 steps each), report · next: claim tickets
**[10%]** 3/31 — spawned subagents for ACME-1, ACME-2, ACME-3 · next: wait for their steps
**[42%]** 13/31 — subagents at 5/9, 3/9, 2/9 · next: wait for their steps
**[67%]** 22/33 — ACME-1 done; ACME-2 has 11 steps, not 9; others at 6/11, 4/9 · next: wait for ACME-2 and ACME-3
**[97%]** 32/33 — all three done · next: report the PRs
**[100%]** 33/33 — reported 3 PRs · next: none
```

A question back to the user keeps the number:

```
**[50%]** 2/4 — two fixes possible, need your call · next: your answer
```
