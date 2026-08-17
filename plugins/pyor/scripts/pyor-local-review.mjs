#!/usr/bin/env node
// Open the current git working changes as a Pyor local pre-PR review (ADR 0030).
//
// Fires a `pyor://local-review?path=&worktree=&head=&base=&session=` deep link
// that the Pyor desktop app handles; the app finds or creates the matching local
// review and opens it, ready to read. Self-contained and repo-agnostic — shared
// git + deep-link helpers live in lib.mjs (also used by /pyor:ai-review).
//
// The link carries a session id even though this path authors no AI aids: the
// id is what makes the review's "Send to Claude" button exist, and a plain read
// is exactly the case where the reviewer has notes to send back. It prints on
// stdout as `session <id>` so the caller can park a `wait` on it.
//
// Usage:
//   node pyor-local-review.mjs             open the review in Pyor
//   node pyor-local-review.mjs --print     print the deep link, do not open
//   node pyor-local-review.mjs --selftest  run the built-in assertions

import { strict as assert } from 'node:assert';
import {
  resolveRepoHead,
  resolveBase,
  buildDeepLink,
  openUrl,
  computeSessionId,
} from './lib.mjs';

function selftest() {
  assert.equal(
    buildDeepLink({ path: '/r/p', head: 'b/x', base: 'main' }),
    'pyor://local-review?path=%2Fr%2Fp&worktree=%2Fr%2Fp&head=b%2Fx&base=main',
  );
  const u = new URL(
    buildDeepLink({ path: '/a b', worktree: '/wt', head: 'feat', base: 'dev' }),
  );
  assert.equal(u.searchParams.get('path'), '/a b');
  assert.equal(u.searchParams.get('worktree'), '/wt');
  assert.equal(u.searchParams.get('head'), 'feat');
  // A plain open carries the session id too, so the review Pyor opens offers
  // "Send to Claude" the way an AI-authored one does. It is the same
  // deterministic id the AI flow derives, so both address one inbox per review.
  const session = computeSessionId('/r', 'b/x', 'main');
  const plain = new URL(
    buildDeepLink({ path: '/r', head: 'b/x', base: 'main', session }),
  );
  assert.equal(plain.searchParams.get('session'), session);
  assert.equal(plain.searchParams.get('aids'), null);
  console.log('selftest ok');
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();

  let repo, head;
  try {
    ({ repo, head } = resolveRepoHead(process.cwd()));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
    return;
  }
  const base = resolveBase(repo, head);
  const session = computeSessionId(repo, head, base);
  const url = buildDeepLink({ path: repo, head, base, session });
  if (argv.includes('--print')) {
    console.log(url);
    return;
  }
  console.log(`Opening Pyor local review: ${head} vs ${base}`);
  console.log(`session ${session}`);
  try {
    openUrl(url);
  } catch (e) {
    console.error(`Could not open Pyor: ${e.message}`);
    process.exitCode = 1;
  }
}

main();
