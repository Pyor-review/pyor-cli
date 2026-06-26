#!/usr/bin/env node
// Open the current git working changes as a Pyor local pre-PR review.
//
// Fires a `pyor://local-review?path=&worktree=&head=&base=` deep link that the
// Pyor desktop app handles; the app finds or creates the matching local review
// and opens it, ready to read.
//
// Self-contained and repo-agnostic: it shells out to `git` in the current
// directory, so it works from any repo. The `/pyor-local-review` Claude Code
// command is a thin wrapper around it.
//
// Usage:
//   node pyor-local-review.mjs             open the review in Pyor
//   node pyor-local-review.mjs --print     print the deep link, do not open
//   node pyor-local-review.mjs --selftest  run the built-in assertions

import { execFile, execFileSync } from 'node:child_process';
import { strict as assert } from 'node:assert';

/** Build the `pyor://local-review` deep link. Pure, so it is trivially
 * testable; URLSearchParams handles encoding of paths and slashy branch
 * names. worktree defaults to path (the session's working dir is its
 * worktree). */
export function buildDeepLink({ path, worktree, head, base }) {
  const q = new URLSearchParams({
    path,
    worktree: worktree ?? path,
    head,
    base,
  });
  return `pyor://local-review?${q.toString()}`;
}

function git(args, cwd) {
  // stderr ignored: probes like `symbolic-ref` are expected to fail (no
  // origin), and we handle that via the thrown non-zero exit, not the noise.
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function branchExists(repo, name) {
  try {
    git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], repo);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the base branch to diff against: origin's default branch when set,
 * else the first conventional default that exists, else `main`. Never returns
 * the head branch itself. */
function resolveBase(repo, head) {
  try {
    const ref = git(
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      repo,
    );
    const name = ref.replace(/^origin\//, '');
    // Only trust origin/HEAD's branch if it exists locally; otherwise
    // `git diff <name>...head` would fail with "ambiguous argument".
    if (name && name !== head && branchExists(repo, name)) return name;
  } catch {
    // No origin/HEAD (no remote, or never fetched): fall through to the
    // conventional-name probe below.
  }
  const candidate = ['main', 'master', 'trunk', 'develop'].find(
    (b) => b !== head && branchExists(repo, b),
  );
  return candidate ?? 'main';
}

function openUrl(url) {
  const win = process.platform === 'win32';
  const opener = win
    ? // The URL's `&` separators are shell-special to cmd, and Node only
      // auto-quotes args containing spaces, so quote it explicitly and pass
      // verbatim. Without this, cmd splits the link and the app sees only
      // `path`, dropping head/base.
      { cmd: 'cmd', args: ['/c', 'start', '', `"${url}"`] }
    : process.platform === 'darwin'
      ? { cmd: 'open', args: [url] }
      : { cmd: 'xdg-open', args: [url] };
  execFile(opener.cmd, opener.args, { windowsVerbatimArguments: win }, (err) => {
    if (!err) return;
    console.error(`Could not open Pyor: ${err.message}`);
    process.exitCode = 1;
  });
}

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

  let repo;
  let head;
  try {
    repo = git(['rev-parse', '--show-toplevel'], process.cwd());
    head = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo);
  } catch {
    console.error('Not a git repository (or git is not installed).');
    process.exitCode = 1;
    return;
  }
  if (head === 'HEAD') {
    console.error('Detached HEAD: check out a branch before opening a review.');
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
  openUrl(url);
}

main();
