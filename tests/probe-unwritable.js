/* Runs one zip into a destination that cannot be written, in a process of its
 * own, and prints what happened as JSON:
 *
 *   node tests/probe-unwritable.js <fixed|original> <sourceDir> <outputZip>
 *
 * It needs its own process because the original does two things a test runner
 * cannot survive: it throws an uncaught exception from an 'error' event nobody
 * listens for, and its promise never settles. Both are recorded, and after
 * three seconds the probe reports whatever state the zip is in and exits.
 */

"use strict";

const [mode, sourceDir, outputZip] = process.argv.slice(2);
const result = { state: "pending", uncaught: null, message: null };

process.on("uncaughtException", (err) => {
  result.uncaught = err.code || err.message;
});

const run =
  mode === "original"
    ? () => require("./original/pipeline.js").zipProject(sourceDir, outputZip)
    : () => require("../out/zipper.js").createZip(sourceDir, outputZip);

run().then(
  () => {
    result.state = "resolved";
  },
  (err) => {
    result.state = "rejected";
    result.message = err.code || err.message;
  }
);

setTimeout(() => {
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}, 3000);
