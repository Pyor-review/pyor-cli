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
  aidsPath,
  appendReplyOp,
  repliesPath,
} from './lib.mjs';
import { randomUUID } from 'node:crypto';

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
  // Re-materialize the agent's aids under ~/.pyor (the app's read gate trusts
  // that dir). Do NOT stage in os.tmpdir(): a coding harness that sandboxes
  // TMPDIR gives this CLI a different os.tmpdir() than the app's, so the app
  // silently rejects the file and the review opens with no grouping/hints.
  // ~/.pyor is home-derived, so both sides agree. Parse first to fail loudly on
  // malformed aids instead of in the app.
  let aids;
  try {
    const raw = fs.readFileSync(aidsIn, 'utf8');
    JSON.parse(raw);
    aids = aidsPath(session);
    fs.mkdirSync(path.dirname(aids), { recursive: true });
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
  // babysitting.
  //
  // Waits with NO deadline by default. A review is read on human time: a
  // deadline only ever fired on a reviewer who was still reading, and its exit
  // relied on the agent noticing `pending` and re-arming, which is exactly the
  // step that got skipped. Pass `--timeout <seconds>` for a bounded wait (0 also
  // means no limit). The poll idles at one `stat` per interval, and the process
  // dies with the shell that owns it.
  const timeoutMs = Number(flag(argv, 'timeout') ?? 0) * 1000;
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
    if (timeoutMs > 0 && Date.now() - started >= timeoutMs) {
      out({ ok: true, status: 'pending' });
      return;
    }
    await new Promise((r) => setTimeout(r, pollDelay(Date.now() - started)));
  }
}

/** Poll cadence: snappy while the reviewer is likely mid-read, relaxed once the
 * wait is measured in hours. Bounded either way — the reviewer's click still
 * lands within a few seconds. */
function pollDelay(elapsedMs) {
  return elapsedMs < 10 * 60_000 ? 1500 : 5000;
}

/** Answer one note the reviewer left: a reply rendered under their comment in
 * Pyor, and/or the addressed flag that retires it from the next hand-off.
 *
 * `--body -` (or an omitted `--body` on a pipe) reads the reply from stdin, so
 * a multi-paragraph markdown answer doesn't have to survive shell quoting. */
function reply(argv) {
  const session = flag(argv, 'session');
  const commentId = flag(argv, 'comment');
  if (!session || !commentId) {
    out({ ok: false, error: 'reply needs --session and --comment' });
    process.exitCode = 1;
    return;
  }
  const bodyFlag = flag(argv, 'body');
  const body =
    bodyFlag && bodyFlag !== '-'
      ? bodyFlag
      : readStdin();
  const addressed = argv.includes('--addressed');
  if (!body && !addressed) {
    out({ ok: false, error: 'reply needs a --body, --addressed, or both' });
    process.exitCode = 1;
    return;
  }
  try {
    const queued = appendReplyOp(session, {
      id: randomUUID(),
      commentId,
      body: body || null,
      addressed,
      author: flag(argv, 'author') ?? 'claude',
      createdAt: new Date().toISOString(),
    });
    out({ ok: true, queued, file: repliesPath(session) });
  } catch (e) {
    out({ ok: false, error: `Could not queue the reply: ${e.message}` });
    process.exitCode = 1;
  }
}

/** Empty on a terminal — a bare `--addressed` with no pipe must not hang
 * waiting for input that is never coming. */
function readStdin() {
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8').trim();
  } catch {
    return '';
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
  // Aids stage under ~/.pyor/aids (home-derived), not os.tmpdir() — so the app's
  // read gate accepts it even when a coding harness sandboxes TMPDIR.
  assert.ok(aidsPath('abc').endsWith(path.join('.pyor', 'aids', 'abc.json')));
  // wait holds with no deadline unless one is asked for.
  assert.equal(Number(flag([], 'timeout') ?? 0), 0);
  assert.equal(Number(flag(['--timeout', '90'], 'timeout') ?? 0), 90);
  // Reply ops queue under ~/.pyor/replies and accumulate in write order.
  const rs = computeSessionId('/selftest', 'b/replies', 'main');
  fs.rmSync(repliesPath(rs), { force: true });
  appendReplyOp(rs, { id: '1', commentId: 'c1', body: 'first', addressed: false });
  assert.equal(appendReplyOp(rs, { id: '2', commentId: 'c1', addressed: true }), 2);
  const queued = JSON.parse(fs.readFileSync(repliesPath(rs), 'utf8'));
  assert.deepEqual(queued.map((o) => o.id), ['1', '2']);
  fs.rmSync(repliesPath(rs), { force: true });
  process.stdout.write('selftest ok\n');
}

const argv = process.argv.slice(2);
const cmd = argv[0];
if (cmd === '--selftest') selftest();
else if (cmd === 'prepare') prepare(argv);
else if (cmd === 'open') open(argv);
else if (cmd === 'reply') reply(argv);
else if (cmd === 'wait') await wait(argv);
else {
  process.stderr.write(
    'usage: pyor-ai-review.mjs prepare|open|wait|reply|--selftest\n',
  );
  process.exitCode = 1;
}
