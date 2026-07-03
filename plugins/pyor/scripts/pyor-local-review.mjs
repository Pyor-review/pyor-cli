#!/usr/bin/env node
// Open the current git working changes as a Pyor local pre-PR review (ADR 0030).
//
// Fires a `pyor://local-review?path=&worktree=&head=&base=` deep link that the
// Pyor desktop app handles; the app finds or creates the matching local review
// and opens it, ready to read. Self-contained and repo-agnostic — shared git +
// deep-link helpers live in lib.mjs (also used by /pyor:ai-review).
//
// Usage:
//   node pyor-local-review.mjs             open the review in Pyor
//   node pyor-local-review.mjs --print     print the deep link, do not open
//   node pyor-local-review.mjs --selftest  run the built-in assertions

import { strict as assert } from 'node:assert';
import { resolveRepoHead, resolveBase, buildDeepLink, openUrl } from './lib.mjs';

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
  const url = buildDeepLink({ path: repo, head, base });
  if (argv.includes('--print')) {
    console.log(url);
    return;
  }
  console.log(`Opening Pyor local review: ${head} vs ${base}`);
  try {
    openUrl(url);
  } catch (e) {
    console.error(`Could not open Pyor: ${e.message}`);
    process.exitCode = 1;
  }
}

main();
