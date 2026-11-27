## Progress updates

Every task reports a percentage, including follow-up messages in the same chat. Agent Tracker and terminal status lines parse these lines, and a chat without a fresh one shows no progress.

- Print each line on its own, at the start of the line, in this exact shape:
  `**[NN%]** k/N — <what just finished> · next: <next step>`
- Once you know the plan for a message, print `**[0%]** 0/N — <plan in a few words> · next: <first step>`. Then print a line after each step finishes.
- NN = steps done / total steps. If the plan grows or shrinks, change N and keep going. Don't restart from 0.
- Weight a step by its size when one clearly dominates (a long test run, a big refactor). The number should track time, not just count steps.
- The last message of the task starts with `**[100%]**`. A one-shot answer is one step: start it with `**[100%]** 1/1 — <what you answered>`.
- When you stop to ask the user something, keep the current percentage. Never print 100% for a task that is waiting on the user.
- Work you hand to subagents counts in your percentage, and spawning them finishes nothing. Plan each subagent as a step, count it when its result is back, and when your turn ends with subagents still running, end it on the current percentage, never 100%.
- Tell every subagent you spawn to follow these rules.
