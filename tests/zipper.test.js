/* The zip pipeline in src/zipper.ts, with the real `archiver`, writing real files.
 *
 *   npm test
 *
 * Every zip is opened afterwards with tests/zip.js and its entries compared,
 * because a file that exists and starts with "PK" says nothing about what is
 * in it. Where a test is named `regression:`, the same scenario is run through
 * tests/original/pipeline.js - the original extension.ts, transcribed - and the
 * original's failure is asserted as well.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { GIT, build, remove, tempDir, gitIncluded } = require("./helpers");
const { readZip } = require("./zip.js");
const { createZip, ZipCancelled } = require("../out/zipper.js");
const original = require("./original/pipeline.js");

const WIN = process.platform === "win32";
const CASE_INSENSITIVE = WIN || process.platform === "darwin";

function entries(zipPath) {
  return Object.keys(readZip(fs.readFileSync(zipPath))).sort();
}

/** Makes `file` unreadable for everyone; returns a function that undoes it. */
function denyRead(file) {
  if (WIN) {
    execFileSync("icacls", [file, "/deny", "*S-1-1-0:(R)"], { stdio: "ignore" });
    return () => execFileSync("icacls", [file, "/remove:d", "*S-1-1-0"], { stdio: "ignore" });
  }
  fs.chmodSync(file, 0o000);
  return () => fs.chmodSync(file, 0o755);
}

function canDenyRead() {
  if (WIN) {
    return true;
  }
  return typeof process.getuid === "function" && process.getuid() !== 0;
}

/* ── What goes in ────────────────────────────────────────────────────────── */

test("the zip holds exactly what git would keep, with the right contents", { skip: !GIT && "git is not on PATH" }, async () => {
  const root = build({
    ".gitignore": "*.log\nnode_modules/\n",
    "src/.gitignore": "!keep.log\n",
    "src/a.js": "console.log(1);\n",
    "src/keep.log": "kept",
    "debug.log": "dropped",
    "node_modules/m/index.js": "dropped",
    "README.md": "# hello\n",
  });
  const out = path.join(tempDir(), "out.zip");
  try {
    const stats = await createZip(root, out);
    const files = readZip(fs.readFileSync(out));
    assert.deepEqual(Object.keys(files).sort(), gitIncluded(root));
    assert.equal(files["src/keep.log"].toString(), "kept");
    assert.equal(files["src/a.js"].toString(), "console.log(1);\n");
    assert.equal(stats.fileCount, Object.keys(files).length);
  } finally {
    remove(root);
    remove(path.dirname(out));
  }
});

test("progress is reported once the walk is done, with the file count", async () => {
  const root = build({ a: "1", b: "2", "c/d": "3" }, { git: false });
  const out = path.join(tempDir(), "out.zip");
  const messages = [];
  try {
    await createZip(root, out, { onProgress: (m) => messages.push(m) });
    assert.deepEqual(messages, ["Compressing 3 files…"]);
  } finally {
    remove(root);
    remove(path.dirname(out));
  }
});

test("a zip saved inside the folder it is zipping leaves itself out", async () => {
  const root = build({ "a.txt": "a" }, { git: false });
  const out = path.join(root, "self.zip");
  try {
    await createZip(root, out);
    assert.deepEqual(entries(out), ["a.txt"]);
    assert.equal((await original.zipProject(root, out)), "created");
    assert.deepEqual(entries(out), ["a.txt"], "the original handled the exact-name case too");
  } finally {
    remove(root);
  }
});

test("regression: ...even when the name it is saved under differs only in case", { skip: !CASE_INSENSITIVE && "only on a case-insensitive filesystem" }, async () => {
  const root = build({ "a.txt": "a", "project.zip": "an old zip from last time" }, { git: false });
  try {
    await createZip(root, path.join(root, "PROJECT.zip"));
    assert.deepEqual(entries(path.join(root, "project.zip")), ["a.txt"]);

    fs.writeFileSync(path.join(root, "project.zip"), "an old zip from last time");
    await original.zipProject(root, path.join(root, "PROJECT.zip"));
    assert.deepEqual(entries(path.join(root, "project.zip")), ["a.txt", "project.zip"],
      "the original put a truncated copy of the zip inside itself");
  } finally {
    remove(root);
  }
});

test("a path longer than 260 characters is archived", async () => {
  const root = tempDir();
  let deep = root;
  for (let i = 0; i < 10; i++) {
    deep = path.join(deep, "d".repeat(30));
  }
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, "deep.txt"), "deep");
  const out = path.join(tempDir(), "out.zip");
  try {
    assert.ok(path.join(deep, "deep.txt").length > 300);
    await createZip(root, out);
    const [name] = entries(out);
    assert.ok(name.endsWith("/deep.txt") && name.length > 300, name);
  } finally {
    remove(root);
    remove(path.dirname(out));
  }
});

/* ── Failure ─────────────────────────────────────────────────────────────── */

test("regression: a destination that cannot be written is an error, not a notification that spins forever", async () => {
  const root = build({ "a.txt": "a" }, { git: false });
  const dest = tempDir();
  const out = path.join(dest, "readonly.zip");
  fs.writeFileSync(out, "someone else's file");
  fs.chmodSync(out, 0o444); // read-only attribute on Windows, r--r--r-- elsewhere
  const probe = (mode) =>
    JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "probe-unwritable.js"), mode, root, out]).toString());
  try {
    const fixed = probe("fixed");
    assert.equal(fixed.state, "rejected");
    assert.match(fixed.message, /EPERM|EACCES/);
    assert.equal(fixed.uncaught, null);
    assert.equal(fs.readFileSync(out, "utf8"), "someone else's file", "a file it could not open must not be deleted");

    const orig = probe("original");
    assert.equal(orig.state, "pending", "the original's promise never settled");
    assert.match(String(orig.uncaught), /EPERM|EACCES/, "the original threw from an unhandled 'error' event");
  } finally {
    fs.chmodSync(out, 0o644);
    remove(root);
    remove(dest);
  }
});

test("regression: a file that cannot be read fails the zip and leaves no partial file behind", { skip: !canDenyRead() && "cannot make a file unreadable as root" }, async () => {
  const root = build({ "a.txt": "a", "locked.txt": "secret" }, { git: false });
  const out = path.join(tempDir(), "out.zip");
  const restore = denyRead(path.join(root, "locked.txt"));
  try {
    await assert.rejects(createZip(root, out), (err) => /EPERM|EACCES/.test(err.code));
    assert.equal(fs.existsSync(out), false);

    await assert.rejects(original.zipProject(root, out), (err) => /EPERM|EACCES/.test(err.code));
    assert.equal(fs.existsSync(out), true, "the original left a partial zip where the user asked for one");
  } finally {
    restore();
    remove(root);
    remove(path.dirname(out));
  }
});

test("a directory that cannot be read is skipped and recorded", { skip: !canDenyRead() && "cannot make a directory unreadable as root" }, async () => {
  const root = build({ "a.txt": "a", "private/b.txt": "b" }, { git: false });
  const out = path.join(tempDir(), "out.zip");
  const restore = denyRead(path.join(root, "private"));
  try {
    const stats = await createZip(root, out);
    assert.deepEqual(entries(out), ["a.txt"]);
    assert.equal(stats.unreadable.length, 1);
    assert.match(stats.unreadable[0], /private: (EPERM|EACCES)$/);
  } finally {
    restore();
    remove(root);
    remove(path.dirname(out));
  }
});

/* ── Cancelling ──────────────────────────────────────────────────────────── */

test("cancelling before anything starts writes nothing", async () => {
  const root = build({ "a.txt": "a" }, { git: false });
  const out = path.join(tempDir(), "out.zip");
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(createZip(root, out, { signal: controller.signal }), ZipCancelled);
    assert.equal(fs.existsSync(out), false);
  } finally {
    remove(root);
    remove(path.dirname(out));
  }
});

test("cancelling during the walk removes the file", async () => {
  const files = {};
  for (let i = 0; i < 200; i++) {
    files[`d${i}/f.txt`] = String(i);
  }
  const root = build(files, { git: false });
  const out = path.join(tempDir(), "out.zip");
  const controller = new AbortController();
  try {
    const zipping = createZip(root, out, { signal: controller.signal });
    setImmediate(() => controller.abort());
    await assert.rejects(zipping, ZipCancelled);
    assert.equal(fs.existsSync(out), false);
  } finally {
    remove(root);
    remove(path.dirname(out));
  }
});

test("regression: cancelling while it compresses stops it and removes the file", async () => {
  // Incompressible, and large enough that level-9 deflate takes a while.
  const root = build({ "big.bin": crypto.randomBytes(24 * 1024 * 1024), "a.txt": "a" }, { git: false });
  const out = path.join(tempDir(), "out.zip");
  try {
    const controller = new AbortController();
    const zipping = createZip(root, out, {
      signal: controller.signal,
      onProgress: () => setImmediate(() => controller.abort()),
    });
    await assert.rejects(zipping, ZipCancelled);
    assert.equal(fs.existsSync(out), false);

    // The original only looked at the cancel flag once, straight after the walk.
    const token = { cancelled: false };
    const zippingOriginal = original.zipProject(root, out, token);
    setTimeout(() => (token.cancelled = true), 150);
    assert.equal(await zippingOriginal, "nothing", "the original said nothing...");
    assert.deepEqual(entries(out), ["a.txt", "big.bin"], "...and left the whole zip behind");
  } finally {
    remove(root);
    remove(path.dirname(out));
  }
});

/* ── Links ───────────────────────────────────────────────────────────────── */

test("a symbolic link or junction is not followed, and is recorded", async (t) => {
  const root = build({ "real/f.txt": "f" }, { git: false });
  const out = path.join(tempDir(), "out.zip");
  try {
    try {
      fs.symlinkSync(path.join(root, "real"), path.join(root, "link"), WIN ? "junction" : "dir");
    } catch (err) {
      t.skip(`cannot create a link here: ${err.code}`);
      return;
    }
    const stats = await createZip(root, out);
    assert.deepEqual(entries(out), ["real/f.txt"]);
    assert.deepEqual(stats.skippedSymlinks, ["link"]);
  } finally {
    remove(root);
    remove(path.dirname(out));
  }
});
