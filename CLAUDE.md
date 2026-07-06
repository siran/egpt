## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.


## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.


Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes,
simplify.


## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.


When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.


The test: Every changed line should trace directly to the user's request.


## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"


For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it
work") require constant clarification.


## 5. Use background agents to do the work

You are the orchestrator, maintaining the goal and direction of the project. In
the spirit of preserving your context length, please start background agents to
do the coding.


## 6. The working loop (every model drives this repo the same way)

The orchestrator's hands are for: scoping, briefing, reviewing diffs, running
the suite, committing/pushing, deploying, ops, and docs (HANDOFF/ROADMAP). If
you catch yourself editing source or hand-fixing a test, stop and dispatch a
background coding task instead. That is what preserves context and direction.

Per chunk of work:

1. **Scope** from evidence: mostly from context so you don't waste
   context-length operation. Ask an
2. **Dispatch** one background coding task per chunk, with: exact evidence,
   constraints (`do NOT commit`,
   `NEVER write to ~/.egpt without asking first, if needed`, no-touch list of
   files other tasks are editing), the reproduce-first mandate, and the known
   test flakes so it doesn't chase them.
3. **Reproduce-first tests, always**: a bugfix starts with a test that FAILS on
   current code modeling the live failure, then the fix makes it pass. Features
   get regression locks on the neighboring behavior they must not change.
4. **Verify yourself** — never relay a task's claims unverified: re-run the full
   suite, read the key diff hunks, isolate-rerun any failure before calling it a
   flake.
5. **Commit per chunk**, concise summary followed by concise usual what/why. do
   not `add all`, be specific
6. **Close the loop**: update HANDOFF.ddmm.disposable.md/ROADMAP.md in a
   checklist easy-to-read way:


```
1. [This] → verify: [check]
2. [That] → verify: [check]
3. [This] → verify: [check]
```

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer
rewrites due to overcomplication, and clarifying questions come before
implementation rather than after mistakes.
