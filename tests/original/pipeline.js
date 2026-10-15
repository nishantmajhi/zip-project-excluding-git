/* The original extension's zip pipeline, transcribed from
 * `git show aa89820:src/extension.ts`, lines 55-110, so that the regression
 * tests can be run against it.
 *
 * Nothing here is imported by the extension. The original had no seam: this
 * logic sat inside the `withProgress` callback. The only changes are that the
 * cancellation token is a plain object the test flips, the progress report is
 * dropped, and the function says what the user would have seen - "created"
 * where the original went on to show its "Created x.zip" message, and
 * "nothing" where it returned without a word. tests/drift.test.js checks that
 * the lines this was taken from are still in that commit.
 */

"use strict";

const fs = require("node:fs");
const archiver = require("archiver");
const { walkAndAdd } = require("./zipLogic.js");

async function zipProject(targetDir, outputZipPath, token = { cancelled: false }) {
  const isCancelled = () => token.cancelled;

  try {
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputZipPath);
      const archive = archiver("zip", { zlib: { level: 9 } });
      const stats = { fileCount: 0 };

      output.on("close", () => resolve());
      archive.on("warning", (err) => {
        if (err.code !== "ENOENT") {
          console.warn("archiver warning:", err);
        }
      });
      archive.on("error", (err) => reject(err));

      archive.pipe(output);

      walkAndAdd(archive, targetDir, "", [], outputZipPath, stats, isCancelled)
        .then(() => {
          if (isCancelled()) {
            archive.abort();
            reject(new Error("cancelled"));
            return;
          }
          archive.finalize();
        })
        .catch(reject);
    });
  } catch (err) {
    if (err?.message === "cancelled") {
      fs.promises.unlink(outputZipPath).catch(() => undefined);
      return "nothing";
    }
    throw err;
  }

  if (isCancelled()) {
    return "nothing";
  }
  return "created";
}

module.exports = { zipProject };
