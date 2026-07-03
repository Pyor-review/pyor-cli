#!/usr/bin/env node
// /pyor:ai-review (ADR 0032) — mechanical primitives for the AI variant of the
// local-review command. The *analysis* (grouping + hints) is authored by the
// Claude Code session itself; this script only does the deterministic parts:
//
//   prepare  → resolve repo/head/base + revision token + a session nonce, and
//              hand back the review-context (base prompt + settings) the app
//              exported. Exits early if the app isn't installed/launched.
//   open     → write nothing; fire the pyor://local-review deep link carrying
//              the aids file + the session nonce, launching/focusing Pyor.
//   wait     → park, polling ~/.pyor/inbox/<session>.json for the comments the
//              reviewer sends back, and print them once they arrive.
//
// The agent orchestrates: prepare → (generate aids, write temp file) → open →
// wait. See commands/ai-review.md.

import { strict as assert } from 'node:assert';
import {
  fs,
  os,
  path,
  resolveRepoHead,
  resolveBase,
  computeRevision,
  computeSessionId,
  buildDeepLink,
  openUrl,
  readReviewContext,
  reviewContextPath,
  inboxPath,
} from './lib.mjs';

const INSTALL_CMD = 'curl -fsSL https://pyor.review/install.sh | sh';

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function prepare(argv) {
  let repo, head;
  try {
    ({ repo, head } = resolveRepoHead(process.cwd()));
  } catch (e) {
    out({ ok: false, error: e.message });
    process.exitCode = 1;
    return;
  }
  const context = readReviewContext();
  if (!context) {
    // Absent file = Pyor not installed, or installed but never launched. The
    // agent asks the user to install (running INSTALL_CMD on consent) and to
    // launch Pyor once, then re-runs prepare.
    out({
      ok: false,
      contextPresent: false,
      installCmd: INSTALL_CMD,
      contextPath: reviewContextPath(),
    });
    return;
  }
  const base = resolveBase(repo, head);
  const intent = flag(argv, 'intent') ?? context.defaultIntent ?? 'importance';
  out({
    ok: true,
    contextPresent: true,
    sessionId: computeSessionId(repo, head, base),
    repo,
    head,
    base,
    revision: computeRevision(repo),
    basePromptVersion: context.basePromptVersion,
    intent,
    customText: flag(argv, 'custom'),
    context,
  });
}

function open(argv) {
  const aidsIn = flag(argv, 'aids');
  const session = flag(argv, 'session');
  const repo = flag(argv, 'repo');
  const head = flag(argv, 'head');
  const base = flag(argv, 'base');
  const title = flag(argv, 'title');
  if (!aidsIn || !session || !repo || !head || !base) {
    out({ ok: false, error: 'open needs --aids --session --repo --head --base' });
    process.exitCode = 1;
    return;
  }
  // The app only reads aids from under os.tmpdir() (its deep-link read gate).
  // Re-materialize the agent's file there ourselves so a temp path the agent
  // chose elsewhere (e.g. a 0700 session scratchpad) doesn't silently fail to
  // load. Parse first to fail loudly on malformed aids instead of in the app.
  let aids;
  try {
    const raw = fs.readFileSync(aidsIn, 'utf8');
    JSON.parse(raw);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyor-aids-'));
    aids = path.join(dir, 'aids.json');
    fs.writeFileSync(aids, raw);
  } catch (e) {
    out({ ok: false, error: `Unreadable or invalid aids file: ${e.message}` });
    process.exitCode = 1;
    return;
  }
  const url = buildDeepLink({ path: repo, head, base, aids, session, title });
  try {
    openUrl(url);
    out({ ok: true, url });
  } catch (e) {
    out({ ok: false, error: `Could not open Pyor: ${e.message}` });
    process.exitCode = 1;
  }
}

async function wait(argv) {
  const session = flag(argv, 'session');
  if (!session) {
    out({ ok: false, error: 'wait needs --session' });
    process.exitCode = 1;
    return;
  }
  // Meant to run as a BACKGROUND command (see review.md step 4): it blocks until
  // the user clicks "Send to Claude", then exits with the feedback — the
  // harness's task-completion notification IS the push that wakes the agent, no
  // babysitting. Holds ~30 min then returns PENDING as a safety valve for an
  // abandoned review; the agent re-arms a fresh background wait on the SAME
  // (now-stable) session. Comments stay buffered server-side, so a missed window
  // is always recoverable by re-running wait.
  const timeoutMs = Number(flag(argv, 'timeout') ?? 1800) * 1000;
  const file = inboxPath(session);
  const started = Date.now();
  for (;;) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      fs.rmSync(file, { force: true }); // consume-once
      out({ ok: true, status: 'received', feedback: JSON.parse(raw) });
      return;
    } catch {
      // not there yet
    }
    if (Date.now() - started >= timeoutMs) {
      out({ ok: true, status: 'pending' });
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

function selftest() {
  const url = buildDeepLink({
    path: '/r',
    head: 'b/x',
    base: 'main',
    aids: '/tmp/a.json',
    session: 'abc',
  });
  const u = new URL(url);
  assert.equal(u.searchParams.get('path'), '/r');
  assert.equal(u.searchParams.get('aids'), '/tmp/a.json');
  assert.equal(u.searchParams.get('session'), 'abc');
  // computeRevision against this very repo returns "<sha>:<tree>".
  const rev = computeRevision(process.cwd());
  assert.match(rev, /^[0-9a-f]{7,40}(:[0-9a-f]{7,40})?$/i);
  // Session id: stable per review (so a re-prepare keeps a parked wait valid),
  // varies by review, and matches the app's strict 8-4-4-4-12 deep-link parser.
  const s = computeSessionId('/r', 'b/x', 'main');
  assert.equal(s, computeSessionId('/r', 'b/x', 'main'));
  assert.notEqual(s, computeSessionId('/r', 'b/y', 'main'));
  assert.match(s, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  process.stdout.write('selftest ok\n');
}

const argv = process.argv.slice(2);
const cmd = argv[0];
if (cmd === '--selftest') selftest();
else if (cmd === 'prepare') prepare(argv);
else if (cmd === 'open') open(argv);
else if (cmd === 'wait') await wait(argv);
else {
  process.stderr.write('usage: pyor-ai-review.mjs prepare|open|wait|--selftest\n');
  process.exitCode = 1;
}
