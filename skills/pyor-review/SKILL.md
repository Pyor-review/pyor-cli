---
name: pyor-review
description: Open the current git branch's working changes as an AI-reviewed local pre-PR review in the Pyor desktop app — file grouping + inline hints that point the reviewer at what matters. Works with any coding agent.
argument-hint: "[importance | walkthrough | custom <instruction> | plain]"
user-invocable: true
---

# pyor-review

Opens the working changes of the current git repository as a **local pre-PR
review** in the [Pyor](https://pyor.review) desktop app, before a PR exists. By
default it authors an **AI review** — file grouping + short inline hints — so the
reviewer reads a pre-analyzed diff.

The AI here is deliberately quiet: it **points the reviewer at what matters**
(groups to orient, a hint on a line worth a second look) and gets out of the
way. No summaries, no walls of generated text. You produce that analysis and
hand it to Pyor; Pyor renders it through its normal review UI.

## The CLI

Every step calls the `pyor-review` CLI, which does the deterministic parts (git
resolution, the working-tree revision token that must match the app, the deep
link, the feedback inbox). Run it without installing:

```bash
npx -y pyor-review <args>
```

(Not yet on npm? Run it straight from the repo instead:
`npx -y --package github:Pyor-review/pyor-cli pyor-review <args>`.)

Below, `pyor-review` is shorthand for that command. Only `git` and `node` are
required on the PATH.

## Arguments (optional)

- A grouping intent — `importance` (default), `walkthrough`, or
  `custom "<instruction>"`.
- `plain` (or `fast`) — skip the AI and just open the diff.

## 0. Plain opt-out

If the argument is `plain` or `fast`, skip the AI flow — open a plain review:

```bash
npx -y --package pyor-review pyor-local-review
```

Tell the user the review is opening (head vs base, as printed). Skipping the AI
skips the *analysis*, not the round-trip: the script prints a `session <id>`
line, so park a `wait` on it (step 4) and answer what they send with `reply`
(step 5). Then stop — do not generate aids.

## 1. Prepare

```bash
pyor-review prepare --intent <intent> [--custom "<text>"]
```

Parse the JSON on stdout.

- `ok:false` with `error` — relay it and stop (not a git repo / detached HEAD).
- `contextPresent:false` — **Pyor isn't set up.** Ask the user to install it
  (`curl -fsSL https://pyor.review/install.sh | sh`) and **launch it once** so it
  writes its review context, then re-run prepare (loop until `contextPresent:true`).
- `ok:true` — keep `sessionId`, `repo`, `head`, `base`, `revision`,
  `basePromptVersion`, `intent`, `customText`, and `context`. The `sessionId` is
  **deterministic** for this repo+branch, so re-running prepare returns the same
  id and a review left open earlier can still receive feedback.

## 2. Generate the aids

Produce two things from the diff: **grouping** (every changed file sorted into
labelled folders) and **hints** (a few short pointers to risks). Gather the diff
yourself — `git diff <base>...<head>`, plus `git diff <head>` and
`git status --porcelain` for uncommitted changes — and read changed files as
needed.

**Reviewer independence matters.** If your harness supports spawning fresh
sub-agents with a clean context (e.g. Claude Code's Task tool), delegate the
generation to them so the review isn't biased by whoever wrote the code — a hint
panel across three lenses (correctness, simplicity, security) plus one grouping
agent, then merge their output. If it doesn't, generate the aids inline in one
pass. Either way, feed each generator the relevant system prompt from `context`
(below) and have it return **only** JSON.

### 2a. Hints

Use `context.hintsSystem` as the system guidance (it owns the schema, caps,
taxonomy, in-hunk anchoring, and the never-post rule). Each hint:

```jsonc
{ "path": "exact/path/from/diff.ts",
  "line": 42,          // 1-based line in the NEW (head) file, INSIDE a changed hunk
  "type": "bug" | "security" | "risk" | "complexity" | "test-gap",
  "severity": "info" | "warn" | "high",
  "title": "short",
  "body": "one or two sentences",
  "guideline": "string or null" }
```

**Anchor rule:** every hint must anchor to a NEW-side line **inside a changed
hunk** — the diff collapses unchanged regions, so an out-of-hunk anchor is hidden
and wasted.

If you ran a multi-lens panel: concatenate the arrays, **dedupe** (same
`path`+`line`, or clearly the same issue → keep the highest-severity, most
specific one), then **cap** to at most **3 per file** and **12 total**,
highest-severity first.

### 2b. Grouping

Use `context.grouping[intent]` as the system guidance. For `custom`, take
`context.grouping.customTemplate` and replace `__PYOR_CUSTOM_INSTRUCTION__` with
`customText`. It returns:

```jsonc
{ "groups": [ { "name": "2-4 words",
                "description": "one sentence",
                "detail": "3-5 sentences",
                "kind": "important" | "noise",
                "files": ["exact/diff/path"] } ] }   // every changed file in exactly one group
```

### 2c. Assemble the hand-off

Write it to a temp file (`mktemp`), shaped exactly:

```json
{
  "basePromptVersion": <basePromptVersion from prepare>,
  "revision": "<revision from prepare>",
  "intent": "<intent>",
  "customText": "<customText, or omit>",
  "grouping": { "groups": [ ... ] },
  "hints": { "hints": [ ... ] }
}
```

## 3. Open in Pyor

Give the review a short human **title** (≤ ~8 words) describing the session's
topic/goal, not the branch name (e.g. "Fix promo-code expiry").

```bash
pyor-review open \
  --aids <tempfile> --session <sessionId> \
  --repo <repo> --head <head> --base <base> \
  --title "<short title>"
```

Then tell the user the review is opening with the grouping + hints pre-loaded,
and that they can read it, comment, and click **"Send to Claude"** to send their
comments back to you. Mention the **Auto-send** toggle beside that button — with
it on, each note reaches you the moment they save it, no click needed.

## 4. Wait for feedback

```bash
pyor-review wait --session <sessionId>
```

Run this **as a background command** if your harness supports it — it blocks
until the user's notes arrive, and its exit is the signal that wakes you with
them. It holds with **no deadline**; pass `--timeout <seconds>` if you want a
bounded wait. If you can't run background commands, run it in the foreground.

- `status:"received"` — present the returned `feedback.commentsMarkdown`, act on
  it as the user directs, reply to each note (step 5), then **park a fresh
  `wait`** on the same session. The reviewer is usually still reading, and their
  next note has nowhere to land without one.
- `status:"pending"` — only when you passed `--timeout`. Re-run `wait` to keep
  listening, or stop if the user is done. Comments are buffered on disk, so a
  send while no `wait` is running is picked up by the next `wait` on the same
  (deterministic) session.

## 5. Reply to each note

Every note in `commentsMarkdown` carries an `id:` in its heading. Answer it back
into Pyor so your reply renders under the reviewer's own comment:

```bash
pyor-review reply --session <sessionId> --comment <id from the heading> \
  --body "what you did, or why you didn't" --addressed
```

- `--addressed` marks the note done: it greys out in Pyor and drops out of every
  later hand-off, so the next `wait` returns only what is still open. Leave it
  off when you are answering a question or disagreeing rather than fixing.
- For a long markdown reply, pass `--body -` and pipe it on stdin instead of
  fighting shell quoting.

Reply to **every** note you were sent, one call each, before parking the next
`wait`. A note with no reply reads as ignored.

Do not commit, push, or open a PR — this is a pre-PR read.
