---
description: Open the current branch's changes as an AI-reviewed local pre-PR review in Pyor (add `plain` to skip AI)
argument-hint: "[importance | walkthrough | custom <instruction> | plain]"
allowed-tools: Task, Bash(node:*), Bash(git:*), Bash(mktemp:*), Write, Read
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
  read.

## 0. Plain opt-out

If the argument is `plain` or `fast`, do NOT run the panel — just open a plain
review:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pyor-local-review.mjs" --agent claude
```

If it exits non-zero saying Pyor is not installed, relay its message: the user
runs the install command themselves (**never run it for them**), launches Pyor
once, and re-runs. Otherwise tell the user the review is opening in Pyor (head
vs base, as printed) with no AI review. Skipping the panel skips the *analysis*, not the round-trip: the
script prints a `session <id>` line, so **park a background wait on it** (step 5)
and answer whatever they send with `reply` (step 6). Then stop — do not run the
panel. Otherwise, run the AI flow below in order.

## 1. Prepare

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pyor-ai-review.mjs" prepare --intent <intent> [--custom "<text>"]
```

Parse the JSON on stdout.

- If `ok:false` and `error` — relay it and stop (not a git repo / detached HEAD).
- If `contextPresent:false` — **Pyor isn't set up.** Tell the user Pyor isn't
  installed (or hasn't been launched yet) and give them the install command to
  run themselves — **never run it for them**:

  ```bash
  curl -fsSL https://pyor.review/install.sh | sh
  ```

  Then ask them to **launch Pyor once** so it writes its review context, and
  **re-run prepare** (loop until `contextPresent:true`). If they'd rather not
  install, stop.
- If `ok:true` — keep `sessionId`, `repo`, `head`, `base`, `revision`,
  `basePromptVersion`, `intent`, `customText`, and `context`. `sessionId` is
  **stable per review** — re-running `prepare` for the same repo/head/base
  returns the same id, so a `wait` you already parked stays valid.

## 2. Open in Pyor now

Open the review **before** the panel runs, so the reviewer watches it happen
instead of waiting. Give it a short human **title** (≤ ~8 words) describing
what this session is about: its topic/goal, not the branch name (e.g.
"Session-authored review aids" or "Fix promo-code expiry"). Pyor shows it
instead of the raw branch slug.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pyor-ai-review.mjs" open \
  --session <sessionId> --repo <repo> --head <head> --base <base> \
  --title "<short session title>" --agent claude
```

Without `--aids`, Pyor opens on the diff and shows "Claude is reviewing" in the
toolbar and the runs dock until the hand-off lands (step 4). Tell the user the
review is open and filling in live.

## 3. Generate the aids (delegate to a fresh panel)

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

### 3a. Hints — a 3-lens review panel

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

**Stream each reviewer as it returns.** The moment one reviewer's JSON comes
back, write it to a temp file (`mktemp`) and push it to the open review, so its
hints appear in the diff while the others are still reading:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pyor-ai-review.mjs" progress \
  --session <sessionId> --hints <that reviewer's tempfile>
```

If the panel fails and you will not hand anything off, say so instead, so the
review stops showing a run that is never coming:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pyor-ai-review.mjs" progress \
  --session <sessionId> --failed "<one-line reason>"
```

**Merge (mechanical, you do it — no code context needed):** concatenate the
three hint arrays; **dedupe** — when two hints share the same `path` + `line` (or
are clearly the same issue), keep one (highest severity, most specific body);
then **cap to the contract**: at most **3 per file** and **12 total**, keeping
highest severity first. That merged array is `hints`.

### 3b. Grouping — one fresh agent

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

### 3c. Assemble the hand-off

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

## 4. Hand off to Pyor

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pyor-ai-review.mjs" open \
  --aids <tempfile> --session <sessionId> \
  --repo <repo> --head <head> --base <base> \
  --title "<short session title>" --agent claude
```

This replaces the streamed hints with the merged set and adds the grouping.
Then tell the user the review is ready (head vs base) with your grouping +
hints. They can read it, leave comments, and click **"Send to Claude"** to send
the comments back here. Mention the **Auto-send** toggle next to that button:
with it on, each note they save is delivered the moment they save it, no click
needed.

## 5. Wait for feedback (park)

Run `wait` **as a background command** (`run_in_background: true`). It blocks
until the user's notes arrive, then exits with them — the task-completion
notification wakes you the instant they send, so you can do other work meanwhile
without babysitting a poll.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pyor-ai-review.mjs" wait --session <sessionId>
```

It holds with **no deadline** — a review is read on human time, and the wait is
free while it idles. Pass `--timeout <seconds>` if you want a bounded one.

- `status:"received"` — present the returned `feedback` (its `commentsMarkdown`
  is reviewer notes to address), act on them as the user directs, answer each one
  with `reply` (step 6), and then **park a fresh `wait` on the same
  `sessionId`** — the reviewer is usually still reading, and their next note has
  nowhere to land without it.
- `status:"pending"` — only possible when you passed `--timeout`. Re-arm another
  background `wait` on the same `sessionId`. Comments are buffered on disk, so
  even if no `wait` was in flight when they sent, the next `wait` returns them
  immediately — if the user says they sent comments and you didn't react, just
  run `wait` again.
- `status:"superseded"` — a newer `wait` on the same `sessionId` took over (a
  re-run, or another session on this branch). Only one `wait` consumes a
  session's notes, so this one stepped aside: do **not** re-arm it.

A restart ends the parked `wait`. When a session starts and nothing is listening
on a review in this repo, or in any repo below the session's folder, the
plugin's SessionStart hook lists it in the session context: when it does,
re-arm a `wait` on each listed session first thing.

Because `sessionId` is stable per review (step 1), re-running `prepare` mid-flow
(e.g. after fixing a launch issue) does **not** orphan a parked `wait` — it's the
same session.

## 6. Reply to each note

Every note in `commentsMarkdown` carries an `id:` in its heading. Once you have
acted on one, answer it back into Pyor so the reply renders under the reviewer's
own comment, right where they wrote it. Always pass `--body -` and pipe the
reply on stdin, so the shell leaves backticks and quotes alone:

````bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pyor-ai-review.mjs" reply \
  --session <sessionId> --comment <id from the heading> \
  --addressed --body - <<'EOF'
> Should this retry on 429 too?

Yes. `fetchPage` now retries a 429 with the same backoff as a 5xx
(`src/api/client.ts:42`):

```ts
if (res.status === 429 || res.status >= 500) return retry(attempt + 1);
```
EOF
````

- `--addressed` marks the note done. It greys out in Pyor and drops out of every
  later hand-off, so the next `wait` returns only what is still open. Leave it
  off when you are answering a question or disagreeing rather than fixing.

Pyor renders the reply as GitHub-flavored markdown, like a comment in a PR
thread. Write it that way:

- When the note asks more than one thing, quote each part with `>` and answer
  under it.
- Put code longer than a name in a fenced block tagged with its language.
- Point at code as `path:line`.
- Keep it short. Say what you did or why you didn't, then stop.

Reply to **every** note you were sent, one call each, before parking the next
`wait`. A note with no reply reads as ignored.

Do not commit, push, or create a PR — this is a pre-PR read.
