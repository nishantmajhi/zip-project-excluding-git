/* The extension against git itself.
 *
 *   npm test
 *
 * Each case builds a real tree in a real repository, asks git which files it
 * would ignore, and requires the extension to put exactly the rest in the zip.
 * Git is the reference: writing down what the gitignore documentation says
 * would get the subtle cases wrong in whichever direction the reader did.
 *
 * Every case also records whether the ORIGINAL code (tests/original/, the
 * first commit, with the `ignore` 5.3.2 it shipped with) agreed with git, and
 * that is asserted too. A case marked `originalAgrees: false` is a regression
 * test, and if the original ever turns out to pass it, the test fails - so
 * nothing in this file can claim to have found a bug it has not demonstrated.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { GIT, build, remove, gitIncluded, fixedIncluded, originalIncluded } = require("./helpers");

const skip = GIT ? false : "git is not on PATH";

/* `zip` is the folder the user chose, relative to the repository; '' is the root. */
const cases = [
  // ── Already right in the original ────────────────────────────────────────
  { name: "a root .gitignore excludes what it names", originalAgrees: true,
    files: { ".gitignore": "*.log\nbuild/\n", "a.log": "1", "build/x.o": "2", "src/a.js": "3" } },
  { name: "a deeper .gitignore beats a shallower negation", originalAgrees: true,
    files: { ".gitignore": "!sub/a.txt\n", "sub/.gitignore": "*.txt\n", "sub/a.txt": "x" } },
  { name: "a byte-order mark does not break the first rule", originalAgrees: true,
    files: { ".gitignore": "\uFEFF*.tmp\n", "x.tmp": "x", "y.txt": "y" } },
  { name: "a directory-only rule leaves a file of the same name alone", originalAgrees: true,
    files: { ".gitignore": "build/\n", "build/a.o": "x", "src/build": "a file" } },
  { name: "CRLF line endings", originalAgrees: true,
    files: { ".gitignore": "*.bak\r\nkeep\r\n", "a.bak": "x", keep: "x", b: "x" } },
  { name: "an escaped trailing space is part of the name", originalAgrees: true,
    files: { ".gitignore": "foo\\ \n", "foo ": "x", foo: "y" } },
  { name: "unescaped trailing spaces are not", originalAgrees: true,
    files: { ".gitignore": "foo   \n", foo: "x" } },
  { name: "a file cannot be re-included from inside an excluded directory", originalAgrees: true,
    files: { ".gitignore": "build/\n!build/keep.txt\n", "build/keep.txt": "x", ok: "y" } },
  { name: "a leading slash anchors a nested pattern to its own directory", originalAgrees: true,
    files: { "sub/.gitignore": "/x\n", "sub/x": "1", "sub/deeper/x": "2" } },
  { name: "** in the middle and at both ends", originalAgrees: true,
    files: { ".gitignore": "**/gen/**\n", "a/gen/b.js": "x", "gen.js": "y" } },
  { name: "the whitelist idiom: ignore everything, re-include one directory", originalAgrees: true,
    files: { ".gitignore": "/*\n!/src/\n", "src/a.ts": "x", "lib/b.ts": "x", "top.txt": "x" } },
  { name: "the whitelist idiom: only .ts files at any depth", originalAgrees: true,
    files: { ".gitignore": "*\n!*/\n!*.ts\n", "a.ts": "x", "a.js": "x", "d/b.ts": "x", "d/b.js": "x" } },
  { name: "escaped # and !", originalAgrees: true,
    files: { ".gitignore": "\\#h\n\\!b\n", "#h": "x", "!b": "x", c: "x" } },
  { name: "a slash in the middle anchors the pattern", originalAgrees: true,
    files: { ".gitignore": "a/b\n", "a/b": "x", "c/a/b": "x" } },
  { name: "a single * does not cross a directory", originalAgrees: true,
    files: { ".gitignore": "a/*/c\n", "a/x/c": "1", "a/x/y/c": "2" } },
  { name: "case-insensitive on this platform, as git is here", originalAgrees: true,
    platforms: ["win32", "darwin"],
    files: { ".gitignore": "*.LOG\n", "a.log": "x" } },
  { name: "a leading **/ matches at the root too", originalAgrees: true,
    files: { ".gitignore": "**/tmp\n", tmp: "x", "q/tmp/z": "x" } },
  { name: "a deeper file can ignore what a shallower one re-included", originalAgrees: true,
    files: { ".gitignore": "*.txt\n", "a/.gitignore": "x.txt\n", "a/x.txt": "1", "a/y.txt": "2" } },

  // ── Wrong in the original ────────────────────────────────────────────────
  { name: "regression: a nested ! re-includes a file the root excluded", originalAgrees: false,
    files: { ".gitignore": "*.log\n", "sub/.gitignore": "!keep.log\n", "sub/keep.log": "x", "sub/drop.log": "x", "a.log": "x" } },
  { name: "regression: a nested ! re-includes a directory the root excluded", originalAgrees: false,
    files: { ".gitignore": "logs/\n", "sub/.gitignore": "!logs/\n", "sub/logs/a": "x", "logs/b": "x" } },
  { name: "regression: a nested ! re-includes the one safe file of a family", originalAgrees: false,
    files: { ".gitignore": "secret*\n", "pkg/.gitignore": "!secret.example\n", "pkg/secret.example": "x", "pkg/secret.real": "x" } },
  { name: "regression: a nested !**/ re-includes directories at any depth", originalAgrees: false,
    files: { ".gitignore": "gen/\n", "pkg/.gitignore": "!**/gen/\n", "pkg/a/gen/x": "1", "gen/y": "2" } },
  { name: "regression: three levels, each overriding the one above", originalAgrees: false,
    files: { ".gitignore": "*.txt\n", "a/.gitignore": "!*.txt\n", "a/b/.gitignore": "x.txt\n",
             "a/b/x.txt": "1", "a/b/y.txt": "2", "a/z.txt": "3", "r.txt": "4" } },
  { name: "regression: a name starting with .. is matched like any other", originalAgrees: false,
    files: { ".gitignore": "..secret\n", "..secret": "x", "sub/.gitignore": "..b\n", "sub/..b": "x", "sub/ok": "y" } },
  { name: "regression: .git/info/exclude is honoured", originalAgrees: false,
    files: { ".git/info/exclude": "private.txt\n", "private.txt": "x", "pub.txt": "y" } },
  { name: "regression: [!a] means 'not a'", originalAgrees: false,
    files: { ".gitignore": "f[!a].txt\n", "f1.txt": "x", "fa.txt": "x" } },
  { name: "regression: POSIX character classes", originalAgrees: false,
    files: { ".gitignore": "f[[:digit:]].txt\n", "f1.txt": "x", "fa.txt": "x" } },

  // ── New paths through the fixed code: nested files are rewritten onto the root ──
  { name: "glob characters in a nested directory's own name are literal", originalAgrees: false,
    files: { "[x]/.gitignore": "*.log\n!keep.log\n", ".gitignore": "*.log\n", "[x]/a.log": "1", "[x]/keep.log": "2", "x/keep.log": "3" } },
  { name: "* and ? in a nested directory's own name are literal", originalAgrees: true,
    platforms: ["linux", "darwin"], // neither character is legal in a Windows filename
    files: { "a*b/.gitignore": "q\n", "a*b/q": "1", "axb/q": "2", "a?c/.gitignore": "r\n", "a?c/r": "1", "abc/r": "2" } },
  { name: "a nested directory named like a comment or a negation", originalAgrees: true,
    files: { "#d/.gitignore": "z\n", "#d/z": "1", "#d/y": "2", "!e/.gitignore": "z\n", "!e/z": "1", "!e/y": "2" } },
  { name: "nested slash-anchored, directory-only and rooted patterns", originalAgrees: true,
    files: { "sub/.gitignore": "deep/x\nd2/\n/top\n", "sub/deep/x": "1", "sub/o/deep/x": "2",
             "sub/d2/f": "3", "sub/q/d2/f": "4", "sub/top": "5", "sub/q/top": "6" } },
  { name: "nested comments, blanks, lone ! and lone /", originalAgrees: true,
    files: { "sub/.gitignore": "# a comment\n\n   \n!\n/\n*.o\n", "sub/a.o": "1", "sub/b.c": "2" } },

  // ── Zipping a folder inside a repository, not its root ───────────────────
  { name: "regression: zipping a subfolder applies the root .gitignore", originalAgrees: false, zip: "pkg",
    files: { ".gitignore": "node_modules/\n*.log\n", "pkg/node_modules/m.js": "1", "pkg/a.log": "2", "pkg/src/i.js": "3" } },
  { name: "regression: zipping a subfolder applies an intermediate .gitignore", originalAgrees: false, zip: "a/b",
    files: { "a/.gitignore": "secret\n", "a/b/secret": "1", "a/b/ok": "2" } },
  { name: "regression: zipping a subfolder applies info/exclude", originalAgrees: false, zip: "p",
    files: { ".git/info/exclude": "*.bak\n", "p/x.bak": "1", "p/y": "2" } },
  { name: "regression: zipping a subfolder applies an anchored root rule", originalAgrees: false, zip: "p",
    files: { ".gitignore": "/p/gen\n", "p/gen/a": "1", "p/src/gen/b": "2" } },
  { name: "zipping a subfolder: its own ! still beats the root", originalAgrees: false, zip: "p",
    files: { ".gitignore": "*.log\n", "p/.gitignore": "!keep.log\n", "p/keep.log": "1", "p/d.log": "2" } },
];

for (const c of cases) {
  const platformSkip = c.platforms && !c.platforms.includes(process.platform) ? `only meaningful on ${c.platforms.join("/")}` : false;
  test(c.name, { skip: skip || platformSkip }, async () => {
    const root = build(c.files);
    try {
      const dir = c.zip ? path.join(root, c.zip) : root;
      const expected = gitIncluded(dir);
      assert.deepEqual(await fixedIncluded(dir), expected, "the fixed code disagrees with git");

      const orig = await originalIncluded(dir);
      if (c.originalAgrees) {
        assert.deepEqual(orig, expected, "the original agreed with git here; the case is mislabelled");
      } else {
        assert.notDeepEqual(orig, expected, "the original already agreed with git: this regression test tests nothing");
      }
    } finally {
      remove(root);
    }
  });
}

module.exports = { cases };
