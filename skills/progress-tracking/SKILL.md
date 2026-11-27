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

- `NN` = steps done / total steps. If the plan grows or shrinks, change `N` and keep going. Don't restart from 0, except when you spawn subagents (below).
- Weight a step by its size when one clearly dominates (a long test run, a big refactor). The number should track time, not only count steps.
- When you stop to ask the user something, keep the current percentage. Never print 100% for a task that is waiting on the user.
- A skill or command that defines its own progress table uses that table, as long as its lines keep the `**[NN%]**` prefix.

## Subagents

Once you spawn subagents, your progress tracks their work, not the setup you did to launch them.

- **Spawning starts a new count.** Print `**[0%]** 0/N`, where `N` is the number of subagents plus one for each step you'll do after they return (merge, verify, report). This is the one time the number goes back down. Setup before spawning (picking tickets, making worktrees) never ends at 100%.
- **A subagent is one step**, however many steps it has inside. `k/N` counts your subagents and your own steps. Never add the subagents' step counts to `N`.
- **`k` goes up when a subagent's result is back**, not when you launch it.
- **`NN` includes partial work.** When you can see each subagent's latest percentage, add them as fractions of a step: three subagents at 40%, 15% and 25% out of `N = 4` is (0.40 + 0.15 + 0.25) / 4 = 20%. When you can't, use `k/N`.
- **Never print 100% while a subagent you started is still running.** A turn that ends with subagents running ends on the current percentage.
- Tell every subagent you spawn to follow this skill, so its own row shows its progress too.

## Examples

```
**[0%]** 0/4 — plan: reproduce, fix, test, open PR · next: reproduce the failing test
**[25%]** 1/4 — reproduced: date parsing drops the timezone · next: fix the parser
**[50%]** 2/4 — parser keeps the offset · next: run the suite
**[75%]** 3/4 — 412 tests pass · next: open the PR
**[100%]** 4/4 — PR opened · next: none
```

An orchestrator that sets up three tickets, hands each to a subagent, then reports the PRs:

```
**[60%]** 3/5 — tickets claimed, worktrees ready · next: spawn 3 subagents
**[0%]** 0/4 — spawned subagents for ACME-1, ACME-2, ACME-3 · next: wait for results
**[20%]** 0/4 — subagents at 40%, 15%, 25% · next: wait for results
**[45%]** 1/4 — ACME-1 done, PR opened; others at 50%, 30% · next: wait for ACME-2 and ACME-3
**[75%]** 3/4 — all three done · next: report the PRs
**[100%]** 4/4 — reported 3 PRs · next: none
```

A question back to the user keeps the number:

```
**[50%]** 2/4 — two fixes possible, need your call · next: your answer
```
