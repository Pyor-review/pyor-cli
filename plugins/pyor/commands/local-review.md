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

Then tell the user the review is opening in Pyor (head vs base, as printed by
the script). Do not commit, push, or create a PR — this is a pre-PR read.

If the script prints "Not a git repository" or "Detached HEAD", relay that and
stop; there is nothing to review.
