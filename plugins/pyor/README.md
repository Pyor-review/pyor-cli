# Pyor for Claude Code

Open the working changes of the current git repository as a **local pre-PR
review** in the [Pyor](https://pyor.review) desktop app, before a PR exists.

<p align="center">
  <img src="https://raw.githubusercontent.com/Pyor-review/pyor-cli/main/assets/pyor-review.png" alt="A Pyor local pre-PR review: changes grouped by AI into labelled folders, with an inline hint pointing at a risk, and a Send to Claude button." width="900">
</p>

## Install

```sh
/plugin marketplace add Pyor-review/pyor-cli
/plugin install pyor@pyor
```

## Commands

- **`/pyor:review`** — the primary command, AI-reviewed by default. A panel of
  fresh sub-agents reads the diff across three lenses (correctness, simplicity,
  security) and hands Pyor **file groups** and short **inline hints**. The
  reviewers get no context from the calling session, so the review isn't biased
  by whoever wrote the code. After you read and comment in Pyor, **Send to
  Claude** pushes your comments back into the session that opened it.
- **`/pyor:review plain`** — skip the panel and just open the diff.

Takes an optional grouping intent: `importance` (default), `walkthrough`, or
`custom "<instruction>"`.

## Skill

`skills/pyor-review` is the same flow for any other agent (Codex, Cursor, Amp,
Gemini CLI, Windsurf, Zed). It drives the same agent-neutral CLI.

## Requirements

- The **Pyor desktop app**, which registers the `pyor://` URL scheme and renders
  the review. Get it at [pyor.review](https://pyor.review).
- `git` and `node` (>= 18) on your PATH.

Nothing here sends your code anywhere: the CLI resolves git state locally and
hands the app a `pyor://` deep link.

## Links

- Source and issues: [Pyor-review/pyor-cli](https://github.com/Pyor-review/pyor-cli)
- MIT licensed.
