# Zip Project (excluding .git): review and remediation record

First reviewed 2026-09-04. Remediated 2026-09-30 on branch `cleanup/2026-09-30`.
Not pushed.

---

## Correction to the first review, at the top because it matters

**The first review said "the gaps are hygiene and verification, not
correctness", and singled out the nested-`.gitignore` handling as "the correct
way to honour nested `.gitignore` files, and the part most implementations get
wrong". That part was wrong.**

`isIgnoredByChain` tested a path against each `.gitignore` in turn and returned
`true` as soon as any of them ignored it. A deeper file's `!pattern` was
therefore never consulted for anything a shallower file excluded. With `*.log`
at the root and `!keep.log` in `sub/.gitignore`, git keeps `sub/keep.log` and
the extension dropped it. That is the README's headline promise ("correct
negation (`!pattern`) support, the same way `git` itself resolves ignore
rules"), and it had never worked.

The review praised the design (the chain carried down the recursion) without
running a single case through it. Its own first finding said the code was
"structured for testing and there are no tests". Writing the test it described,
with a nested `.gitignore` that re-includes something with `!`, fails on the
first run. The review named the fixture that would have caught the bug, and
described the code as correct instead of running it.

**How it was found**: not by reading. The suite builds each case as a real
repository and asks `git ls-files --others --exclude-standard` what git would
keep. Run over the first commit, 7 of 24 cases disagreed with git. Reading the
gitignore documentation and asserting it would have been a second opinion from
the same kind of reader. Git is the reference.

Review item 7, whether a path over 260 characters aborts the zip, is also
settled: it does not. Node handles long paths on Windows, and a 427-character
path zipped correctly on the original code. A test now keeps it that way.

---

## What was fixed

Every defect below has a test named `regression:` that is also run against the
original code (`tests/original/`), and asserts that the original fails it.

### Which files go in (`src/zipLogic.ts`)

1. **A nested `!pattern` could not re-include what a parent `.gitignore`
   excluded.** This covered a file (`!keep.log`), a directory (`!logs/`), one safe
   file of a family (`secret*` at the root, `!secret.example` below), and `!**/`
   at depth. Git keeps one ordered pattern list, `.git/info/exclude` first and then
   each `.gitignore` from the root down, and the last match wins. Each level now
   carries that whole list, with nested patterns rewritten onto the root
   (`rebasePatterns`: `pkg/.gitignore: *.log` becomes `pkg/**/*.log`, `/top`
   becomes `pkg/top`, and glob characters in the directory's own name are
   escaped). One `ignore` instance is built from the list. Separate matchers per
   level cannot be made correct: the `ignore` package checks a path's parent
   directories itself, so a shallower level re-excludes a directory a deeper one
   has just re-included.
2. **Zipping a folder inside a repository ignored every `.gitignore` above it.**
   The Explorer context menu makes this the normal case. Right-clicking
   `packages/app` in a repository whose root says `node_modules/` zipped
   `packages/app/node_modules`. The walk now finds the enclosing repository
   (`findRepoRoot`) and applies `info/exclude` and every `.gitignore` above the
   folder, matching from the repository root (`resolveWalkRoot`).
3. **`[!a]` was inverted, and POSIX classes (`[[:digit:]]`) matched nothing.**
   Both are defects in `ignore` 5.3.2. `ignore` 7.0.10 fixes both, and the
   dependency is now `^7.0.10`.
4. **A name starting with `..` escaped every rule.** The "not under this level"
   check was `startsWith('..')`, which also matches `..secret`. The check is gone
   along with the per-level relative paths.
5. **`.git/info/exclude` was not read** (the first review's item 2). It now is,
   including through a worktree's or submodule's `.git` file (`infoExcludePath`
   follows `gitdir:` and a worktree's `commondir`).

### Writing the zip (`src/zipper.ts`, new, out of `extension.ts`)

6. **An unwritable destination left the progress notification spinning
   forever**, with no message. Nothing listened for `'error'` on the output
   stream, so the error was thrown out of an event handler as an uncaught
   exception, and the promise the notification waited on never settled. It is
   demonstrated in a child process (`tests/probe-unwritable.js`), because the
   original never returns.
7. **A failed zip left a partial `.zip` at the chosen path.** For example, one
   file the user could not read. The error was right; the leftover file was not.
   It is now closed and deleted. A destination that could not be *opened* is
   never deleted, because it may be an existing file this run did not write.
8. **Cancel did nothing once compression had started.** The flag was read once,
   right after the walk. Compression finished, the extension returned silently,
   and a complete zip the user had cancelled was left on disk. `createZip` takes
   an `AbortSignal` and stops at any point.
9. **A zip saved inside the folder being zipped could include itself.** The
   self-exclusion compared paths exactly, so saving as `PROJECT.zip` over an
   existing `project.zip` put a truncated copy of the zip inside the zip. The
   comparison is case-insensitive on Windows and macOS.

### Hygiene (the first review's items)

- **`.gitignore` added** (P2). `node_modules/` was sitting untracked after the
  first `npm install` of this pass, one `git add -A` away from being committed.
- **Tests added** (P2): 76, all passing, one skipped on Windows (a filename with
  `*` in it, which only POSIX allows).
- **Symbolic links and unreadable directories are recorded** in `ZipStats`
  (`skippedSymlinks`, `unreadable`), and logged with `console.warn`, the same
  way archiver warnings already were. See "Deliberately not done" for why they
  are not shown to the user.
- **`tests/` and `review.md` are kept out of the `.vsix`.** Checked with
  `vsce ls`: the package holds `package.json`, `README.md`, the icon, the three
  compiled modules and the runtime `node_modules`, and no dev dependencies.
- **`ts-node` removed.** Nothing used it. The old README suggested it for
  testing.

---

## Deliberately not done

- **Showing skipped links and unreadable folders to the user.** The first review
  asked for a count after zipping. That means new text in the success
  notification, and the archive's standing rule is no UI or copy changes. The
  counts are collected and logged, so surfacing them is a one-line change in
  `extension.ts` if the author wants it.
- **An unreadable folder still does not fail the zip.** An unreadable *file*
  does, which is archiver's behaviour and was already the case. Making folders
  consistent with files would turn "a zip missing one folder" into "no zip". That
  is a product decision, so it is left for the author.
- **The global excludes file (`core.excludesFile`) is not read.** It is
  personal, not part of the project, and reading it means parsing git config.
  The README says so.
- **Case sensitivity is not taken from `core.ignorecase`.** Matching is
  case-insensitive, as git is by default on Windows and macOS. On Linux, git is
  case-sensitive by default and this is not. The README says so. It is untested
  here because this machine is Windows.
- **Nested repositories are not treated specially.** Outer rules still apply
  inside them, where git would not apply them. That errs towards leaving things
  out of a zip meant for sharing. Documented.
- **FIFOs, sockets and other special files.** Anything that is not a directory
  or a link is handed to archiver as a file, as before. A FIFO in the tree would
  block the zip. That cannot be built on Windows to test, so it was not changed.
- **`LICENSE`, `CHANGELOG`, CI** (the first review's item 4). Which licence is the
  author's decision, and `publisher` in `package.json` is still the placeholder
  `your-publisher-name`. Nothing here is ready to publish until both are chosen.

---

## Notes for the next session

- `npm test` compiles and runs everything, in about 15 seconds. It needs `git`
  on `PATH`. The comparisons against git skip themselves without it, and so
  do the drift checks.
- **`tests/differential.test.js` is the file to extend.** To add a case, add a
  row. Every row states whether the original agreed with git, and that is
  asserted. So a new `regression:` row that the original would also pass fails
  instead of passing vacuously.
- `tests/original/zipLogic.js` is the first commit's module compiled, with
  `require("ignore")` pointed at `ignore-5`, a dev-only alias for the `ignore`
  5.3.2 the original locked. `tests/original/pipeline.js` is the original
  `extension.ts` pipeline, transcribed. `tests/drift.test.js` compares both with
  `git show` of the first commit, and checks that `ignore-5` is the locked
  version.
- Two traps in the git differential. `git ls-files` needs `-z`, or paths with
  unusual characters come back quoted. The user's global
  excludes file has to be switched off (`-c core.excludesFile=<nonexistent>`),
  or the author's personal rules leak into the reference answer.
- Unreadable files and folders are made with `icacls /deny *S-1-1-0:(R)` on
  Windows and `chmod 000` elsewhere, and restored in a `finally`. As root on
  POSIX those tests skip, because root can read anything.
- The folder-is-itself-ignored rule (`resolveWalkRoot`) is a judgment call, not
  git behaviour. Git would say everything in `dist/` is ignored. It is tested and
  documented. If the author prefers the git answer, change the one `if` there
  and the two tests that pin it.

## Licence, 2026-10-02

The author chose one licence for all of their projects: free for personal,
non-commercial use, modifiable for the user's own use, and not to be
distributed, original or modified. No standard licence says that, so `LICENSE`
is a short custom text, the same in every project apart from the year and what
it excludes. The README's licence section says the same, and `package.json`
declares `SEE LICENSE IN LICENSE`, npm's form for a licence with no SPDX
identifier. Anything above that calls the licence an open question, or calls
the project MIT, is superseded.

## CI, 2026-10-02

`.github/workflows/ci.yml` runs `npm test` on `ubuntu-latest`. Nothing has
been pushed, so it has not run on GitHub yet. Every job was run before
committing, from a fresh clone of this branch, the way a runner would run it:
Linux jobs in a throwaway Ubuntu 24.04 (the image `ubuntu-latest` uses) with
the same tool versions. 74, and the 2 Windows-only cases skip.

**Fixed on the way:** an unreadable folder was reported twice on Linux and
macOS (`private/.gitignore: EACCES` and `private: EACCES`). `walkAndAdd` read
the folder's `.gitignore` before listing it, and a folder that cannot be
listed under POSIX permissions also refuses the open of a file inside it. It
now lists first. The existing test "a directory that cannot be read is skipped
and recorded" failed on Linux against the previous commit and passes now;
Windows was never affected and still passes 75.

The job fetches full history: three tests compare with the first commit and
fail without it (checked).
