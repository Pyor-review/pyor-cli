// Shared helpers for the Pyor Claude Code commands (ADR 0030, ADR 0032).
// Repo resolution, the deep-link builder, the working-tree revision token, and
// the on-device ~/.pyor channel paths. Kept in one place so /pyor:local-review
// and /pyor:ai-review can't drift on the URL or token contracts.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function git(args, cwd, env) {
  return execFileSync('git', args, {
    cwd,
    env: env ?? process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

export function branchExists(repo, name) {
  try {
    git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], repo);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the base branch to diff against: origin's default when set, else the
 * first conventional default that exists, else `main`. Never the head branch. */
export function resolveBase(repo, head) {
  try {
    const ref = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo);
    const name = ref.replace(/^origin\//, '');
    if (name && name !== head && branchExists(repo, name)) return name;
  } catch {
    // no origin/HEAD — fall through
  }
  const candidate = ['main', 'master', 'trunk', 'develop'].find(
    (b) => b !== head && branchExists(repo, b),
  );
  return candidate ?? 'main';
}

/** { repo, head } for the cwd, or throws a friendly message. */
export function resolveRepoHead(cwd) {
  let repo, head;
  try {
    repo = git(['rev-parse', '--show-toplevel'], cwd);
    head = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo);
  } catch {
    throw new Error('Not a git repository (or git is not installed).');
  }
  if (head === 'HEAD') {
    throw new Error('Detached HEAD: check out a branch before opening a review.');
  }
  return { repo, head };
}

/** The AI revision token (ADR 0032) — the exact value the Pyor app also
 * computes, so a session's aids cache-hit. It is the head SHA folded with a
 * content hash of the FULL working tree (committed HEAD + all uncommitted,
 * including untracked, minus gitignored), captured via a throwaway index so
 * the user's real index is untouched. Both sides MUST run this identical
 * sequence — a divergence silently misses the cache. Falls back to the head
 * SHA alone if the tree hash can't be taken. */
export function computeRevision(repo) {
  const headSha = git(['rev-parse', 'HEAD'], repo);
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyor-idx-'));
    const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, 'index') };
    git(['read-tree', 'HEAD'], repo, env); // seed with committed state
    git(['add', '-A'], repo, env); // overlay every working-tree change
    const tree = git(['write-tree'], repo, env);
    fs.rmSync(dir, { recursive: true, force: true });
    return `${headSha}:${tree}`;
  } catch {
    return headSha;
  }
}

/** Build the `pyor://local-review` deep link. Extends ADR 0030 with the ADR
 * 0032 aids + session + title params. Pure; URLSearchParams encodes
 * paths/branches. */
export function buildDeepLink({ path: repoPath, worktree, head, base, aids, session, title }) {
  const q = new URLSearchParams({ path: repoPath, worktree: worktree ?? repoPath, head, base });
  if (aids) q.set('aids', aids);
  if (session) q.set('session', session);
  if (title) q.set('title', title);
  return `pyor://local-review?${q.toString()}`;
}

/** Open a URL with the OS handler (fires the deep link → focuses/launches the
 * Pyor app). Cross-platform; quotes the `&`-laden URL on Windows so cmd does
 * not split it. */
export function openUrl(url) {
  const win = process.platform === 'win32';
  const opener = win
    ? { cmd: 'cmd', args: ['/c', 'start', '', `"${url}"`] }
    : process.platform === 'darwin'
      ? { cmd: 'open', args: [url] }
      : { cmd: 'xdg-open', args: [url] };
  execFileSync(opener.cmd, opener.args, {
    windowsVerbatimArguments: win,
    stdio: 'ignore',
  });
}

export function pyorDir() {
  return path.join(os.homedir(), '.pyor');
}

export function reviewContextPath() {
  return path.join(pyorDir(), 'review-context.json');
}

/** The session nonce that keys the Send-to-Claude round-trip (ADR 0032).
 * DETERMINISTIC per review `(repo, head, base)` so re-running `prepare` returns
 * the SAME id — a parked `wait` stays valid across a re-prepare instead of being
 * orphaned on a dead session. Shaped as a canonical 8-4-4-4-12 uuid (the app's
 * deep-link parser requires exactly that; it doesn't check RFC version bits). */
export function computeSessionId(repo, head, base) {
  const h = createHash('sha256').update(`${repo}\0${head}\0${base}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function inboxPath(sessionId) {
  return path.join(pyorDir(), 'inbox', `${sessionId}.json`);
}

/** Where `open` stages the aids hand-off for the app to read. Under ~/.pyor
 * (home-derived, so identical for the app and for a CLI whose TMPDIR a coding
 * harness has sandboxed) rather than os.tmpdir(), whose divergence made the
 * app's read gate silently reject the file. */
export function aidsPath(sessionId) {
  return path.join(pyorDir(), 'aids', `${sessionId}.json`);
}

/** The return leg of the round-trip: replies the agent writes back so the app
 * can render them on the reviewer's own notes. The agent appends, the app
 * drains. Mirrors `inboxPath` in the opposite direction. */
export function repliesPath(sessionId) {
  return path.join(pyorDir(), 'replies', `${sessionId}.json`);
}

/** Append one reply op to a session's queue, creating it on first write. The
 * app drains by rename, so a read-modify-write that loses a race re-creates the
 * file rather than clobbering ops the app already took. */
export function appendReplyOp(sessionId, op) {
  const file = repliesPath(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let ops = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) ops = parsed;
  } catch {
    // absent or malformed — start a fresh queue
  }
  ops.push(op);
  fs.writeFileSync(file, JSON.stringify(ops, null, 2));
  return ops.length;
}

/** Read + parse ~/.pyor/review-context.json, or null if absent/unreadable.
 * Its presence is the app's install + first-launch signal (ADR 0032). */
export function readReviewContext() {
  try {
    return JSON.parse(fs.readFileSync(reviewContextPath(), 'utf8'));
  } catch {
    return null;
  }
}

export { fs, os, path };
