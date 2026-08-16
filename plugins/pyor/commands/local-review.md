---
description: Open the current branch's working changes as a Pyor local pre-PR review
allowed-tools: Bash(node:*)
---

Open the working changes of the current git repository as a **local pre-PR
review** in the Pyor desktop app, so they can be read before a PR exists.

Run exactly this (it resolves the repo root, head branch, and base, then fires
the `pyor://local-review` deep link the Pyor desktop app handles):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pyor-local-review.mjs"
```

It prints the head/base pair and a `session <id>` line. Tell the user the review
is opening in Pyor, then **park a background wait on that session id** so their
notes can reach you:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pyor-ai-review.mjs" wait --session <id>
```

Run it with `run_in_background: true`. It holds with no deadline and exits the
moment the user clicks **"Send to Claude"** in Pyor, waking you with their notes
in `feedback.commentsMarkdown`. Act on them as the user directs, and answer each
note back into Pyor with `reply` — see step 5 of `/pyor:review` for that call.

Do not commit, push, or create a PR — this is a pre-PR read.

If the script prints "Not a git repository" or "Detached HEAD", relay that and
stop; there is nothing to review.
