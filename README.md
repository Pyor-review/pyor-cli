# pyor-cli

Claude Code tooling for [Pyor](https://pyor.review), the native home for GitHub
code review.

<p align="center">
  <img src="assets/pyor-review.png" alt="A Pyor local pre-PR review: changes grouped by AI into labelled folders, with an inline hint pointing at a risk, and a Send to Claude button." width="900">
</p>

Open your working changes as a **local pre-PR review** in the Pyor desktop app,
before a PR exists. `/pyor:review` has a panel of fresh sub-agents read the diff
and hand Pyor two things: **file groups** (the changes sorted into labelled
folders, important first) and **inline hints** (short pointers to risks worth a
look). No API key, no in-app model run.

The AI here is deliberately quiet: it **points you at what matters** and gets out
of the way. No summaries, no walls of generated text to wade through, just
groups to orient you and the occasional hint on a line worth a second look. You
read the actual code.

## Commands

- **`/pyor:review`** — the primary command. **Authors an AI review by default.**
  A panel of **fresh sub-agents** produces the file grouping + inline hints from
  the diff, then hands them to Pyor to render. The reviewers run with **no
  context from the calling session** (they see only the code, so the review
  isn't biased by whoever wrote it) across three lenses: correctness,
  simplicity, and security. After you read and comment in Pyor, click **"Send to
  Claude"** to push your comments straight back into the session that opened it.

  Takes an optional grouping intent:

  ```sh
  /pyor:review                      # importance — signal vs noise, important first (default)
  /pyor:review walkthrough          # order the groups as a reading path through the change
  /pyor:review custom "by feature"  # your own grouping instruction
  /pyor:review plain                # skip the AI panel, just open the diff (alias: fast)
  ```

- **`/pyor:local-review`** — a plain, fast open with **no AI** (equivalent to
  `/pyor:review plain`). Resolves the repo root, current branch, and base
  branch, then fires a `pyor://local-review` deep link the Pyor desktop app
  handles.

Both open your working changes as a local pre-PR review, ready to read before a
PR exists; re-running reopens the same review (idempotent).

## Install

```sh
# In Claude Code:
/plugin marketplace add Pyor-review/pyor-cli
/plugin install pyor@pyor
```

Then run `/pyor:review` from any repository.

## Requirements

- The **Pyor desktop app** — it registers the `pyor://` URL scheme, renders the
  review, and exports the review context the AI panel writes against. Grab it at
  [pyor.review](https://pyor.review); `/pyor:review` will offer to install it for
  you if it's missing.
- `git` and `node` on your PATH.
- `gh` (the GitHub CLI) is optional, used only when a command needs GitHub data.

## Development

The commands wrap two self-contained, repo-agnostic scripts sharing
`scripts/lib.mjs` (git resolution, the deep-link builder, the working-tree
revision token, and the `~/.pyor` channel paths):

```sh
node plugins/pyor/scripts/pyor-local-review.mjs --print     # print the deep link, do not open
node plugins/pyor/scripts/pyor-local-review.mjs --selftest  # run the built-in assertions
node plugins/pyor/scripts/pyor-ai-review.mjs prepare        # resolve repo/head/base + revision + context
node plugins/pyor/scripts/pyor-ai-review.mjs --selftest     # run the built-in assertions
```
