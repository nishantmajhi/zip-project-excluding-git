/* Checks that tests/original/ is still the original.
 *
 *   npm test
 *
 * Every `regression:` test in this suite asserts that the original code got
 * something wrong, by running tests/original/. If those copies drifted from
 * what was actually committed, the assertions would be about code nobody ever
 * shipped. So this file fetches the first commit from git and compares.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const ts = require("typescript");

const ROOT = path.join(__dirname, "..");

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
}

let baseline;
try {
  baseline = git("rev-list", "--max-parents=0", "HEAD").trim().split("\n")[0];
} catch {
  baseline = undefined;
}
const skip = baseline ? false : "no git history to compare against";

const normalise = (s) => s.replace(/\r\n/g, "\n").replace(/\n\/\/# sourceMappingURL=.*\n?$/, "\n").trimEnd();

test("tests/original/zipLogic.js is the first commit's src/zipLogic.ts, compiled, on ignore 5", { skip }, () => {
  const source = git("show", `${baseline}:src/zipLogic.ts`);
  const tsconfig = ts.readConfigFile(path.join(ROOT, "tsconfig.json"), ts.sys.readFile).config;
  const { options } = ts.convertCompilerOptionsFromJson(tsconfig.compilerOptions, ROOT);
  const compiled = ts.transpileModule(source, { compilerOptions: { ...options, sourceMap: false } }).outputText;

  const kept = fs.readFileSync(path.join(__dirname, "original", "zipLogic.js"), "utf8");
  const expected = compiled.replace('require("ignore")', 'require("ignore-5")');
  assert.notEqual(expected, compiled, "the require it swaps was not found");
  assert.equal(normalise(kept), normalise(expected));
});

test("ignore-5 is the ignore the first commit locked", { skip }, () => {
  const lock = JSON.parse(git("show", `${baseline}:package-lock.json`));
  const locked = lock.packages["node_modules/ignore"].version;
  const installed = require("ignore-5/package.json").version;
  assert.equal(installed, locked);
});

test("tests/original/pipeline.js was transcribed from lines still in the first commit", { skip }, () => {
  const source = git("show", `${baseline}:src/extension.ts`);
  const lines = [
    "const output = fs.createWriteStream(outputZipPath);",
    "const archive = archiver('zip', { zlib: { level: 9 } });",
    "output.on('close', () => resolve());",
    "archive.on('error', (err: any) => reject(err));",
    "archive.pipe(output);",
    "walkAndAdd(archive, targetDir, '', [], outputZipPath, stats, () => cancelled)",
    "if (cancelled) {",
    "archive.abort();",
    "reject(new Error('cancelled'));",
    "archive.finalize();",
    ".catch(reject);",
    "if (err?.message === 'cancelled') {",
    "fs.promises.unlink(outputZipPath).catch(() => undefined);",
    "throw err;",
  ];
  const trimmed = source.split(/\r?\n/).map((l) => l.trim());
  for (const line of lines) {
    assert.ok(trimmed.includes(line), `not in the original extension.ts: ${line}`);
  }
  // And nothing listens for an error on the output stream.
  assert.doesNotMatch(source, /output\.on\('error'/);
});
