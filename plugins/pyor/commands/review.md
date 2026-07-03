---
description: Open the current branch's changes as an AI-reviewed local pre-PR review in Pyor (add `plain` to skip AI)
allowed-tools: Task, Bash(node:*), Bash(git:*), Bash(curl:*), Bash(mktemp:*), Write, Read
---

The primary way to open the working changes of the current git repository as a
**local pre-PR review** in the Pyor desktop app. **By default it authors an AI
review** — file grouping + inline hints — so the reviewer reads a pre-analyzed
diff (ADR 0032). No API key, no in-app model run.

**You do NOT author the review yourself.** You orchestrate a panel of **fresh
sub-agents** that author it with **no context from this session** — they see
only the diff, so the review isn't biased by whoever wrote the code (an author
reviewing their own work shares its blind spots). Your job is to launch them,
merge their output, and do the mechanical hand-off.

Arguments (optional):
- A grouping intent — `importance` (default), `walkthrough`, or
  `custom "<instruction>"`. Example: `/pyor:review walkthrough`.
- **`plain`** (or `fast`) — skip the AI panel and just open the diff for a quick
  read. Equivalent to `/pyor:local-review`.

## 0. Plain opt-out

If the argument is `plain` or `fast`, do NOT run the panel — just open a plain
review and stop:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pyor-local-review.mjs"
```

Tell the user the review is opening in Pyor (head vs base, as printed) with no
AI review, then stop. Otherwise, run the AI flow below in order.

## 1. Prepare

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pyor-ai-review.mjs" prepare --intent <intent> [--custom "<text>"]
```

Parse the JSON on stdout.

- If `ok:false` and `error` — relay it and stop (not a git repo / detached HEAD).
- If `contextPresent:false` — **Pyor isn't set up.** Ask the user: *"Pyor isn't
  installed (or hasn't been launched yet). Install it now?"* On **yes**, run
  `curl -fsSL https://pyor.review/install.sh | sh`, then tell them to **launch
  Pyor once** so it writes its review context, and **re-run prepare** (loop until
  `contextPresent:true`). On **no**, stop.
- If `ok:true` — keep `sessionId`, `repo`, `head`, `base`, `revision`,
  `basePromptVersion`, `intent`, `customText`, and `context`.

## 2. Generate the aids (delegate to a fresh panel)

Launch the sub-agents below with the **Task tool**. A Task sub-agent gets a
clean context window — it does NOT inherit this conversation. **Keep it that
way:** each sub-agent prompt must contain ONLY the repo path, the relevant
system prompt from `context`, the output schema, and the intent — never any of
this session's reasoning, intent, or "why the code is written this way." Tell
each sub-agent to **gather the diff itself** (`git diff <base>...<head>`, plus
`git diff <head>` and `git status --porcelain` for uncommitted, reading changed
files as needed) and return ONLY the JSON. Run the hint reviewers in parallel
(one message, multiple Task calls).

Substitute the real values (`<base>`, `<head>`, `<repo>`, `context.*`) into each
sub-agent's prompt before launching.

### 2a. Hints — a 3-lens review panel

Launch **three** fresh reviewers. Each gets `context.hintsSystem` **verbatim as
its system guidance** (it owns the schema, caps, taxonomy, in-hunk anchoring,
and never-post rule) **plus** its one-line lens focus, and returns:
```
{ "hints": [ { "path": str,   // exact path from the diff
               "line": int,    // 1-based line in the NEW (head) file, INSIDE a changed hunk
               "type": "bug"|"security"|"risk"|"complexity"|"test-gap",
               "severity": "info"|"warn"|"high",
               "title": str, "body": str, "guideline": str | null } ] }
```

- **Correctness lens** — "Focus on correctness: logic errors, edge cases, state
  and async bugs, error handling/propagation, and missing test coverage. Prefer
  types bug / risk / test-gap."
- **Simplicity lens** — "Focus on simplicity (the Ponytail lens): over-
  engineering, reinvented stdlib/native features, dead flexibility, and code
  that could be materially shorter. Prefer type complexity. Never flag input
  validation, error handling that prevents data loss, security, a11y, or a lone
  smoke test as over-engineering."
- **Security lens** — "Focus on security: exploitable input handling, injection,
  auth/authz gaps, secret exposure, and unsafe file/network/deserialization.
  Prefer types security / risk."

Anchor rule (state it to each): anchor every hint to a NEW-side line INSIDE a
changed hunk — the diff collapses unchanged regions, so an out-of-hunk anchor is
hidden and wasted.

**Merge (mechanical, you do it — no code context needed):** concatenate the
three hint arrays; **dedupe** — when two hints share the same `path` + `line` (or
are clearly the same issue), keep one (highest severity, most specific body);
then **cap to the contract**: at most **3 per file** and **12 total**, keeping
highest severity first. That merged array is `hints`.

### 2b. Grouping — one fresh agent

Launch **one** fresh agent with `context.grouping[intent]` as its system guidance
(for `custom`, take `context.grouping.customTemplate` and replace
`__PYOR_CUSTOM_INSTRUCTION__` with `customText`). It returns:
```
{ "groups": [ { "name": str (2–4 words),
                "description": str (one sentence),
                "detail": str (3–5 sentences),
                "kind": "important" | "noise",
                "files": [str] } ] }   // exact diff paths; every changed file in exactly one group
```

### 2c. Assemble the hand-off

Write it to a temp file (use `mktemp`), shaped exactly:
```json
{
  "basePromptVersion": <basePromptVersion from prepare>,
  "revision": "<revision from prepare>",
  "intent": "<intent>",
  "customText": "<customText or omit>",
  "grouping": { ...the grouping agent's object... },
  "hints": { "hints": [ ...the merged, deduped, capped hints... ] }
}
```

## 3. Open in Pyor

Give the review a short human **title** (≤ ~8 words) describing what this
session is about — its topic/goal, not the branch name (e.g. "Session-authored
review aids" or "Fix promo-code expiry"). Pass it as `--title`; Pyor shows it
instead of the raw branch slug.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pyor-ai-review.mjs" open \
  --aids <tempfile> --session <sessionId> \
  --repo <repo> --head <head> --base <base> \
  --title "<short session title>"
```

Then tell the user: the review is opening in Pyor (head vs base) with your
grouping + hints pre-loaded. They can read it, leave comments, and click
**"Send to Claude"** to send the comments back here.

## 4. Wait for feedback (park)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pyor-ai-review.mjs" wait --session <sessionId>
```

- `status:"received"` — present the returned `feedback` (its `commentsMarkdown`
  is reviewer notes to address) and act on them as the user directs.
- `status:"pending"` — nothing sent yet. **Re-run the same `wait` command** to
  keep parking. Repeat until received, or until the user tells you to stop.

Do not commit, push, or create a PR — this is a pre-PR read.
