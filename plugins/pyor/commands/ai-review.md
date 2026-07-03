---
description: Author an AI review (grouping + inline hints) of the current branch and open it in Pyor
allowed-tools: Bash(node:*), Bash(git:*), Bash(curl:*), Bash(mktemp:*), Write, Read
---

Open the working changes of the current git repository as a **local pre-PR
review** in the Pyor desktop app, **with AI review aids you author** — file
grouping and inline hints — so the reviewer reads a pre-analyzed diff (ADR
0032). You are the analysis engine: you already hold the diff, so you generate
the aids and hand them to Pyor. No API key, no in-app model run.

Argument (optional): a grouping intent — `importance` (default), `walkthrough`,
or `custom "<instruction>"`. Example: `/pyor:ai-review walkthrough`.

Run the flow in order. Each step is mechanical except the generation, which is
yours.

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

## 2. Generate the aids (this is your job)

Gather the change: `git diff <base>...<head>` for committed changes plus
`git diff <head>` and `git status --porcelain` for uncommitted ones. Read the
changed files as needed for context.

Use the prompts in `context` verbatim as your system guidance:

- **Grouping** — use `context.grouping[intent]` (for `custom`, take
  `context.grouping.customTemplate` and replace `__PYOR_CUSTOM_INSTRUCTION__`
  with `customText`). Produce an object matching **exactly**:
  ```
  { "groups": [ { "name": str (2–4 words),
                  "description": str (one sentence),
                  "detail": str (3–5 sentences),
                  "kind": "important" | "noise",
                  "files": [str]  // exact paths from the diff
                } ] }
  ```
  Every changed file must belong to exactly one group.

- **Hints** — use `context.hintsSystem`. Produce an object matching **exactly**:
  ```
  { "hints": [ { "path": str,             // exact path from the diff
                 "line": int,             // 1-based line in the NEW (head) file
                 "type": "bug"|"security"|"risk"|"complexity"|"test-gap",
                 "severity": "info"|"warn"|"high",
                 "title": str, "body": str,
                 "guideline": str | null } ] }
  ```
  Few and high-signal (≤ ~3 per file, ≤ ~12 total). Anchor each to a NEW-side
  line that is INSIDE a changed hunk (an added/changed line, or context right
  next to one) — the diff collapses unchanged regions, so a hint on an
  out-of-hunk line is hidden and wasted. A wrong or out-of-hunk line drops the
  hint.

Write the hand-off to a temp file (use `mktemp`), shaped exactly:
```json
{
  "basePromptVersion": <basePromptVersion from prepare>,
  "revision": "<revision from prepare>",
  "intent": "<intent>",
  "customText": "<customText or omit>",
  "grouping": { ...your grouping object... },
  "hints": { ...your hints object... }
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
