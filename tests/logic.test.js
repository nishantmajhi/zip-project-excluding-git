/* Unit tests for the rule handling in src/zipLogic.ts.
 *
 *   npm test
 *
 * tests/differential.test.js is where the behaviour is checked against git.
 * This file covers the pieces underneath it at their edges: how a nested
 * .gitignore is rewritten, how the repository and its info/exclude are found,
 * and what happens when the folder being zipped is itself ignored.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { GIT, build, remove, tempDir, gitIncluded, fixedIncluded, fixed } = require("./helpers");
const { rebasePatterns, makeLevel, isIgnored, findRepoRoot, infoExcludePath, resolveWalkRoot, newStats, addProject } = fixed;

const noGit = !GIT && "git is not on PATH";

/* ── rebasePatterns ──────────────────────────────────────────────────────── */

test("the root's patterns are passed through untouched, less a byte-order mark", () => {
  assert.deepEqual(rebasePatterns("\uFEFF*.log\n# c\n!x\n", ""), ["*.log", "# c", "!x", ""]);
});

test("an unanchored nested pattern may match at any depth below its directory", () => {
  assert.deepEqual(rebasePatterns("*.log\nbuild/\n", "pkg"), ["pkg/**/*.log", "pkg/**/build/"]);
});

test("a nested pattern with a leading or middle slash is anchored to its directory", () => {
  assert.deepEqual(rebasePatterns("/top\ndeep/x\n/a/b/\n", "pkg"), ["pkg/top", "pkg/deep/x", "pkg/a/b/"]);
});

test("negation survives the rewrite", () => {
  assert.deepEqual(rebasePatterns("!keep.log\n!/only/here\n", "a/b"), ["!a/b/**/keep.log", "!a/b/only/here"]);
});

test("comments, blank lines and patterns with nothing in them are dropped", () => {
  assert.deepEqual(rebasePatterns("# comment\n\n   \n!\n/\n!/\nx\n", "d"), ["d/**/x"]);
});

test("escaped leading characters stay escaped and are not taken for a comment or a negation", () => {
  assert.deepEqual(rebasePatterns("\\#h\n\\!b\n", "d"), ["d/**/\\#h", "d/**/\\!b"]);
});

test("trailing spaces: unescaped ones do not make a pattern anchored or non-empty", () => {
  assert.deepEqual(rebasePatterns("x/   \n   \nfoo\\ \n", "d"), ["d/**/x/   ", "d/**/foo\\ "]);
});

test("CRLF line endings", () => {
  assert.deepEqual(rebasePatterns("a\r\nb/c\r\n", "d"), ["d/**/a", "d/b/c"]);
});

test("glob characters in the directory's own name are escaped", () => {
  assert.deepEqual(rebasePatterns("x\n", "[v1]/a*b?"), ["\\[v1\\]/a\\*b\\?/**/x"]);
  assert.deepEqual(rebasePatterns("x\n", "#tag"), ["\\#tag/**/x"]);
  assert.deepEqual(rebasePatterns("x\n", "!bang"), ["\\!bang/**/x"]);
});

/* ── isIgnored ───────────────────────────────────────────────────────────── */

test("the last matching pattern wins", () => {
  const level = makeLevel(["*.log", "!keep.log", "keep.log"]);
  assert.equal(isIgnored(level, "keep.log", false), true);
  assert.equal(isIgnored(makeLevel(["*.log", "!keep.log"]), "keep.log", false), false);
});

test("a directory is tested as a directory", () => {
  const level = makeLevel(["build/"]);
  assert.equal(isIgnored(level, "build", true), true);
  assert.equal(isIgnored(level, "build", false), false);
});

test("no rules ignores nothing", () => {
  assert.equal(isIgnored(makeLevel([]), "anything", false), false);
});

/* ── Finding the repository ──────────────────────────────────────────────── */

test("the repository root is the nearest directory holding .git", { skip: noGit }, () => {
  const root = build({ "a/b/c.txt": "x", "a/inner/.git/HEAD": "ref: refs/heads/main\n", "a/inner/d/e": "y" });
  try {
    assert.equal(findRepoRoot(path.join(root, "a", "b")), root);
    assert.equal(findRepoRoot(root), root);
    assert.equal(findRepoRoot(path.join(root, "a", "inner", "d")), path.join(root, "a", "inner"));
  } finally {
    remove(root);
  }
});

test("outside any repository there is no root, and the folder's own .gitignore files still apply", async () => {
  const root = build({ ".gitignore": "*.tmp\n", "a.tmp": "1", "b.txt": "2", "sub/.gitignore": "x\n", "sub/x": "3" }, { git: false });
  try {
    // A temp directory could in principle sit inside a repository; only assert what holds either way.
    const found = findRepoRoot(root);
    assert.ok(found === undefined || !found.startsWith(root));
    assert.deepEqual(await fixedIncluded(root), [".gitignore", "b.txt", "sub/.gitignore"]);
  } finally {
    remove(root);
  }
});

test("info/exclude is found through a .git directory", { skip: noGit }, () => {
  const root = build({});
  try {
    assert.equal(infoExcludePath(root), path.join(root, ".git", "info", "exclude"));
  } finally {
    remove(root);
  }
});

test("info/exclude is found through a worktree's .git file and its commondir", { skip: noGit }, async () => {
  const root = build({ "a.txt": "a" });
  const wt = path.join(tempDir(), "wt");
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  try {
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    git("worktree", "add", "-q", wt);
    assert.ok(fs.statSync(path.join(wt, ".git")).isFile(), "a worktree's .git is a file");
    assert.equal(path.resolve(infoExcludePath(wt)), path.resolve(root, ".git", "info", "exclude"));

    fs.mkdirSync(path.join(root, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "info", "exclude"), "*.secret\n");
    fs.writeFileSync(path.join(wt, "x.secret"), "s");
    fs.writeFileSync(path.join(wt, "y.txt"), "y");
    assert.deepEqual(await fixedIncluded(wt), gitIncluded(wt));
    assert.deepEqual(await fixedIncluded(wt), ["y.txt"]);
  } finally {
    try {
      git("worktree", "remove", "--force", wt);
    } catch {}
    remove(root);
    remove(path.dirname(wt));
  }
});

test("a .git file that names no gitdir gives no info/exclude", () => {
  const root = build({ ".git": "not a gitdir line\n" }, { git: false });
  try {
    assert.equal(infoExcludePath(root), undefined);
  } finally {
    remove(root);
  }
});

/* ── The folder being zipped ─────────────────────────────────────────────── */

test("zipping the repository root: no prefix", { skip: noGit }, () => {
  const root = build({ ".gitignore": "*.log\n" });
  try {
    assert.equal(resolveWalkRoot(root).matchPrefix, "");
  } finally {
    remove(root);
  }
});

test("zipping a subfolder: the rules above it are in force and paths are matched from the repository root", { skip: noGit }, () => {
  const root = build({ ".gitignore": "*.log\n", "a/.gitignore": "x\n", "a/b/f": "1" });
  try {
    const { level, matchPrefix } = resolveWalkRoot(path.join(root, "a", "b"));
    assert.equal(matchPrefix, "a/b");
    assert.equal(isIgnored(level, "a/b/q.log", false), true);
    assert.equal(isIgnored(level, "a/b/x", false), true);
    assert.equal(isIgnored(level, "a/b/f", false), false);
  } finally {
    remove(root);
  }
});

test("zipping a folder that is itself ignored zips all of it, as before, rather than nothing", { skip: noGit }, async () => {
  const root = build({ ".gitignore": "dist/\n*.map\n", "dist/app.js": "1", "dist/app.js.map": "2", "dist/.gitignore": "*.tmp\n", "dist/x.tmp": "3" });
  try {
    const dist = path.join(root, "dist");
    assert.deepEqual(resolveWalkRoot(dist).matchPrefix, "");
    // The ancestors' rules are dropped; the folder's own still apply.
    assert.deepEqual(await fixedIncluded(dist), [".gitignore", "app.js", "app.js.map"]);
  } finally {
    remove(root);
  }
});

test("...and so does a folder inside an ignored one", { skip: noGit }, async () => {
  const root = build({ ".gitignore": "vendor/\n", "vendor/lib/a.js": "1" });
  try {
    assert.deepEqual(await fixedIncluded(path.join(root, "vendor", "lib")), ["a.js"]);
  } finally {
    remove(root);
  }
});

/* ── What gets recorded ──────────────────────────────────────────────────── */

test("a .gitignore that cannot be read is recorded, and the walk goes on", async () => {
  const root = build({ "a.txt": "a", "sub/b.txt": "b" }, { git: false });
  fs.mkdirSync(path.join(root, "sub", ".gitignore")); // a directory where a file should be
  try {
    const stats = newStats();
    const added = [];
    await fixed.walkAndAdd({ file() {} }, root, "", makeLevel([]), "", undefined, stats, () => false, added);
    assert.deepEqual(added.sort(), ["a.txt", "sub/b.txt"]);
    assert.equal(stats.unreadable.length, 1);
    assert.match(stats.unreadable[0], /\.gitignore: EISDIR$/);
  } finally {
    remove(root);
  }
});

test("addProject counts what it adds and hands each file to the archive under its relative name", async () => {
  const root = build({ "a.txt": "a", "d/b.txt": "b" }, { git: false });
  const calls = [];
  try {
    const stats = await addProject({ file: (full, opts) => calls.push([full, opts.name]) }, root, undefined);
    assert.equal(stats.fileCount, 2);
    assert.deepEqual(calls, [
      [path.join(root, "a.txt"), "a.txt"],
      [path.join(root, "d", "b.txt"), "d/b.txt"],
    ]);
  } finally {
    remove(root);
  }
});

test("the walk stops as soon as it is cancelled", async () => {
  const root = build({ "a/1": "1", "b/2": "2", "c/3": "3" }, { git: false });
  let calls = 0;
  try {
    const added = [];
    await addProject({ file() {} }, root, undefined, () => ++calls > 3, added);
    assert.ok(added.length < 3, `added ${added.length}`);
  } finally {
    remove(root);
  }
});
