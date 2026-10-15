/* Shared fixtures for the suite.
 *
 * Every tree is built inside a real, empty git repository, so that git itself
 * can be asked what it would ignore. `git ls-files --others --exclude-standard`
 * lists exactly the untracked files git does not ignore, which in a repository
 * with nothing committed is the set this extension promises to put in the zip.
 * The user's global excludes file is switched off for the question, since the
 * extension deliberately does not read it.
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const fixed = require("../out/zipLogic.js");
const original = require("./original/zipLogic.js");

function hasGit() {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const GIT = hasGit();

function tempDir(prefix = "zip-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Writes `files` ({relative path: content}) under a new directory, as a git repository if `git` is true. */
function build(files, { git = true } = {}) {
  const root = tempDir();
  if (git) {
    execFileSync("git", ["init", "-q", root]);
  }
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function remove(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** What git would include, relative to `dir`, sorted. */
function gitIncluded(dir) {
  const out = execFileSync(
    "git",
    [
      "-c", `core.excludesFile=${path.join(dir, "no-such-global-excludes-file")}`,
      "ls-files", "--others", "--exclude-standard", "-z",
    ],
    { cwd: dir }
  ).toString("utf8");
  return out.split("\0").filter(Boolean).sort();
}

const nullArchive = { file() {} };

/** What the fixed code would put in the zip, sorted. */
async function fixedIncluded(dir, outputZipPath) {
  const added = [];
  await fixed.addProject(nullArchive, dir, outputZipPath, () => false, added);
  return added.sort();
}

/** What the original code would put in the zip, sorted - called the way its extension.ts called it. */
async function originalIncluded(dir, outputZipPath) {
  const added = [];
  await original.walkAndAdd(nullArchive, dir, "", [], outputZipPath, { fileCount: 0 }, () => false, added);
  return added.sort();
}

module.exports = {
  GIT,
  build,
  remove,
  tempDir,
  gitIncluded,
  fixedIncluded,
  originalIncluded,
  fixed,
  original,
};
