import * as path from 'path';
import * as fs from 'fs';
import ignore = require('ignore');

/**
 * The ignore rules in force for one directory of the walk.
 *
 * Git does not evaluate each .gitignore on its own. It keeps one ordered list of
 * patterns - .git/info/exclude first, then each .gitignore from the repository
 * root down to the directory being read - and the last pattern that matches a
 * path decides it. That is what lets a nested `!keep.log` re-include a file the
 * root excluded. So a level here holds the whole list up to its directory, with
 * every nested file's patterns rewritten to be relative to `rootDir`, and one
 * `ignore` instance built from it.
 */
export interface RuleLevel {
  /** Every pattern in force, lowest precedence first, relative to the match root. */
  patterns: string[];
  ig: ignore.Ignore;
}

export interface ZipStats {
  fileCount: number;
  /** Symbolic links met during the walk. They are not archived. */
  skippedSymlinks: string[];
  /** Directories and .gitignore files that could not be read, with the reason. */
  unreadable: string[];
}

export interface ArchiverLike {
  file(filePath: string, options: { name: string }): void;
}

export function newStats(): ZipStats {
  return { fileCount: 0, skippedSymlinks: [], unreadable: [] };
}

/** Converts a filesystem path to posix-style ('/'-separated) for use with the `ignore` package. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Escapes a literal path so that it can be used as the start of a gitignore pattern. */
function escapeGlob(literal: string): string {
  return literal.replace(/[\\*?[\]]/g, '\\$&').replace(/^[#!]/, '\\$&');
}

/**
 * Rewrites the lines of a .gitignore that lives in `baseRelDir` (relative to the
 * match root, posix, '' = the root itself) so that each pattern means the same
 * thing when matched against a path relative to the root.
 *
 * gitignore(5): a pattern with a slash at its start or in its middle is relative
 * to the directory holding the file; one without may match at any depth below it.
 * A trailing slash only makes the pattern directory-only and does not count.
 */
export function rebasePatterns(content: string, baseRelDir: string): string[] {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (baseRelDir === '') {
    return lines;
  }
  const base = escapeGlob(baseRelDir);
  const out: string[] = [];
  for (const line of lines) {
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const negated = line.startsWith('!');
    let body = negated ? line.slice(1) : line;
    // Unescaped trailing spaces are not part of the pattern.
    const trimmed = body.replace(/(?<!\\) +$/, '');
    const core = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
    if (core === '') {
      continue;
    }
    if (core.includes('/')) {
      body = body.replace(/^\//, '');
      out.push(`${negated ? '!' : ''}${base}/${body}`);
    } else {
      out.push(`${negated ? '!' : ''}${base}/**/${body}`);
    }
  }
  return out;
}

export function makeLevel(patterns: string[]): RuleLevel {
  return { patterns, ig: ignore().add(patterns) };
}

/** Appends the patterns of `dir/.gitignore`, if there is one, to `level`. */
export function extendLevel(level: RuleLevel, dir: string, baseRelDir: string, stats?: ZipStats): RuleLevel {
  const gitignorePath = path.join(dir, '.gitignore');
  let content: string;
  try {
    content = fs.readFileSync(gitignorePath, 'utf8');
  } catch (err: any) {
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') {
      stats?.unreadable.push(`${gitignorePath}: ${err?.code ?? err}`);
    }
    return level;
  }
  return makeLevel([...level.patterns, ...rebasePatterns(content, baseRelDir)]);
}

/** Returns true if `relPath` (relative to the match root, posix) is ignored. */
export function isIgnored(level: RuleLevel, relPath: string, isDir: boolean): boolean {
  if (level.patterns.length === 0) {
    return false;
  }
  return level.ig.ignores(isDir ? `${relPath}/` : relPath);
}

/**
 * Finds the working tree `dir` belongs to: the nearest directory at or above it
 * that holds a `.git` directory or file. Returns undefined outside a repository.
 */
export function findRepoRoot(dir: string): string | undefined {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * Returns the path of the repository's info/exclude file. `.git` is a directory
 * in an ordinary clone, and a file holding `gitdir: <path>` in a worktree or a
 * submodule; a worktree's gitdir names the shared one in `commondir`.
 */
export function infoExcludePath(repoRoot: string): string | undefined {
  const dotGit = path.join(repoRoot, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) {
      return path.join(dotGit, 'info', 'exclude');
    }
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!match) {
      return undefined;
    }
    const gitDir = path.resolve(repoRoot, match[1]);
    const commonDirFile = path.join(gitDir, 'commondir');
    const commonDir = fs.existsSync(commonDirFile)
      ? path.resolve(gitDir, fs.readFileSync(commonDirFile, 'utf8').trim())
      : gitDir;
    return path.join(commonDir, 'info', 'exclude');
  } catch {
    return undefined;
  }
}

export interface WalkRoot {
  /** Rules in force at `targetDir`, before its own .gitignore is read. */
  level: RuleLevel;
  /** Path of `targetDir` relative to the match root (posix, '' = it is the root). */
  matchPrefix: string;
}

/**
 * Works out which rules apply to `targetDir` before the walk reads its own
 * .gitignore: the repository's info/exclude and every .gitignore from the
 * repository root down to the target's parent, exactly as git would see them.
 *
 * One exception. If the folder the user chose is itself ignored - they asked to
 * zip `dist/`, say - honouring the rules above it would produce an empty archive,
 * so the folder is then treated as a root of its own, as it always was before.
 */
export function resolveWalkRoot(targetDir: string, stats?: ZipStats): WalkRoot {
  const target = path.resolve(targetDir);
  const repoRoot = findRepoRoot(target);
  if (!repoRoot) {
    return { level: makeLevel([]), matchPrefix: '' };
  }

  let level = makeLevel([]);
  const excludePath = infoExcludePath(repoRoot);
  if (excludePath) {
    try {
      level = makeLevel(rebasePatterns(fs.readFileSync(excludePath, 'utf8'), ''));
    } catch {
      // No info/exclude is the normal case.
    }
  }

  const matchPrefix = toPosix(path.relative(repoRoot, target));
  if (matchPrefix === '') {
    return { level, matchPrefix };
  }

  const segments = matchPrefix.split('/');
  let dir = repoRoot;
  for (let i = 0; i < segments.length; i++) {
    level = extendLevel(level, dir, segments.slice(0, i).join('/'), stats);
    dir = path.join(dir, segments[i]);
  }

  if (isIgnored(level, matchPrefix, true)) {
    return { level: makeLevel([]), matchPrefix: '' };
  }
  return { level, matchPrefix };
}

/** True if `a` and `b` name the same file, allowing for a case-insensitive filesystem. */
function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return ra.toLowerCase() === rb.toLowerCase();
  }
  return ra === rb;
}

/**
 * Recursively walks `dir`, adding every non-git-ignored file to `archive` via archive.file(fullPath, {name: relPath}).
 * `relDir` is the path of `dir` relative to the zip root (posix, '' = root).
 * `level` holds the rules in force above `dir`; `matchPrefix` is the zip root's path relative to the match root.
 * Returns the list of relative paths added, for testing/inspection.
 */
export async function walkAndAdd(
  archive: ArchiverLike,
  dir: string,
  relDir: string,
  level: RuleLevel,
  matchPrefix: string,
  outputZipPath: string | undefined,
  stats: ZipStats,
  isCancelled: () => boolean,
  addedPaths?: string[]
): Promise<void> {
  if (isCancelled()) {
    return;
  }

  const matchRel = (rel: string) => (matchPrefix === '' ? rel : rel === '' ? matchPrefix : `${matchPrefix}/${rel}`);

  // Listed before its .gitignore is read: where a directory cannot be listed,
  // POSIX permissions stop the .gitignore inside it being opened too, and the
  // one directory would be reported twice.
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err: any) {
    stats.unreadable.push(`${dir}: ${err?.code ?? err}`);
    return;
  }
  const localLevel = extendLevel(level, dir, matchRel(relDir), stats);

  // Deterministic order makes output/testing predictable.
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (isCancelled()) {
      return;
    }

    // Always exclude .git directories (and any stray .git file, e.g. in submodules/worktrees).
    if (entry.name === '.git') {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;

    // Never include the output zip itself if it happens to live inside the target folder.
    if (outputZipPath && samePath(fullPath, outputZipPath)) {
      continue;
    }

    const isDirectory = entry.isDirectory();

    if (isIgnored(localLevel, matchRel(relPath), isDirectory)) {
      continue;
    }

    if (isDirectory) {
      await walkAndAdd(archive, fullPath, relPath, localLevel, matchPrefix, outputZipPath, stats, isCancelled, addedPaths);
    } else if (entry.isSymbolicLink()) {
      // Skip symlinks to avoid archiver errors on broken links; adjust here if you want to follow them.
      stats.skippedSymlinks.push(relPath);
      continue;
    } else {
      archive.file(fullPath, { name: relPath });
      stats.fileCount++;
      addedPaths?.push(relPath);
    }
  }
}

/**
 * Adds everything under `targetDir` that git would not ignore to `archive`, and
 * returns the counts. This is the entry point the extension uses.
 */
export async function addProject(
  archive: ArchiverLike,
  targetDir: string,
  outputZipPath: string | undefined,
  isCancelled: () => boolean = () => false,
  addedPaths?: string[]
): Promise<ZipStats> {
  const stats = newStats();
  const { level, matchPrefix } = resolveWalkRoot(targetDir, stats);
  await walkAndAdd(archive, targetDir, '', level, matchPrefix, outputZipPath, stats, isCancelled, addedPaths);
  return stats;
}
