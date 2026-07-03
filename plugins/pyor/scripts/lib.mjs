// Shared helpers for the Pyor Claude Code commands (ADR 0030, ADR 0032).
// Repo resolution, the deep-link builder, the working-tree revision token, and
// the on-device ~/.pyor channel paths. Kept in one place so /pyor:local-review
// and /pyor:ai-review can't drift on the URL or token contracts.

import { execFileSync } from 'node:child_process';
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

export function inboxDir() {
  return path.join(pyorDir(), 'inbox');
}

export function inboxPath(sessionId) {
  return path.join(inboxDir(), `${sessionId}.json`);
}

/** Adopt orphaned "Send to Claude" bundles for this repo+branch (ADR 0032).
 * When the original /pyor:review session already ended, its parked `wait` is
 * gone; a fresh run mints a new session nonce, so the app's inbox file would
 * strand forever. On reopen we claim any bundle whose payload matches this
 * repo root + branch, delete it (consume-once), and return them newest-first
 * so the agent can surface the prior review's comments. */
export function drainInboxForRepo(repoRoot, branch, dir = inboxDir()) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const found = [];
  names
    .filter((n) => n.endsWith('.json'))
    .forEach((n) => {
      const file = path.join(dir, n);
      try {
        const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (payload.repoRoot === repoRoot && payload.branch === branch) {
          found.push(payload);
          fs.rmSync(file, { force: true });
        }
      } catch {
        // skip foreign / unreadable files
      }
    });
  return found.sort((a, b) => String(b.sentAt ?? '').localeCompare(String(a.sentAt ?? '')));
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
