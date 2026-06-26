# pyor-cli

Claude Code tooling for [Pyor](https://pyor.review), the native home for GitHub
code review.

## Plugins

### `pyor-local-review`

Adds the **`/pyor-local-review`** command. Run it from a coding session in any
git repository and your working changes open as a **local pre-PR review** in the
Pyor desktop app, ready to read before a PR exists. Re-running reopens the same
review (idempotent).

It resolves the repo root, current branch, and base branch, then fires a
`pyor://local-review` deep link the Pyor desktop app handles.

## Install

```sh
# In Claude Code:
/plugin marketplace add Pyor-review/pyor-cli
/plugin install pyor-local-review@pyor
```

Then run `/pyor-local-review` from any repository.

## Requirements

- The **Pyor desktop app** (it registers the `pyor://` URL scheme and handles
  `pyor://local-review`).
- `git` and `node` on your PATH.

## Development

The command is a thin wrapper around `scripts/pyor-local-review.mjs`, which is
self-contained and repo-agnostic:

```sh
node plugins/pyor-local-review/scripts/pyor-local-review.mjs --print     # print the deep link, do not open
node plugins/pyor-local-review/scripts/pyor-local-review.mjs --selftest  # run the built-in assertions
```
