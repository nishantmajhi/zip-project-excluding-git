# Zip Project (Excluding Git-Ignored Files)

A VS Code extension that zips a folder the way you would share it: without
`.git`, and without anything git ignores.

## Using it

Run **Zip Project (Excluding Git-Ignored Files)** from the Command Palette, or
right-click a folder in the Explorer and choose it there.

- From the Command Palette it zips the open folder, and asks which one if the
  workspace has several.
- From the Explorer it zips the folder you clicked.

You choose where to save the `.zip`. A progress notification shows while it
works, and **Cancel** stops it at any point and deletes the unfinished file. If
something goes wrong (a destination you cannot write to, or a file you cannot
read), you get an error and no partial zip is left behind. A folder you cannot
read is the exception: it is skipped, and noted in the extension host's log,
rather than failing the whole zip.

## What is left out

The rule is: **a file goes in the zip if and only if git would not ignore it.**
The test suite checks this against `git` itself, case by case.

- **`.git`**, always, and any `.git` file (worktrees and submodules have one).
- **Everything your `.gitignore` files exclude**, at every level, with git's
  precedence. A pattern in a deeper `.gitignore` overrides one in a shallower
  file, so `!keep.log` in `src/.gitignore` re-includes a file the root excluded
  with `*.log`. As in git, nothing can be re-included from inside a directory
  that is itself excluded.
- **`.git/info/exclude`**, the repository's private ignore list.
- **The zip itself**, if you save it inside the folder you are zipping.
- **Symbolic links and Windows junctions.** These are skipped, not followed, so
  the zip holds no link, and nothing from where a link points.

When you zip a **folder inside a repository** rather than its root, the rules
from above that folder still apply, just as they do for git. Right-clicking
`packages/app` in a repository whose root `.gitignore` says `node_modules/`
leaves out `packages/app/node_modules`.

One exception: if the folder you chose is **itself ignored** (say you
right-click `dist/`), the rules above it are set aside and it is zipped as a
root of its own. Applying them would give you an empty zip of the folder you
asked for. Its own `.gitignore`, if it has one, still applies.

A folder that is not in a git repository at all still has its `.gitignore`
files honoured.

### Not consulted

- **Your global excludes file** (`core.excludesFile`, usually
  `~/.config/git/ignore`). It is personal rather than part of the project, and
  reading it means parsing git's configuration.
- **Case sensitivity follows the platform default**, not your `core.ignorecase`
  setting. Matching is case-insensitive, which is what git does on Windows and
  macOS. On Linux, where git is case-sensitive by default, `*.LOG` would
  exclude `a.log` here but not in git.
- **Nested repositories** get no special treatment. A repository inside the
  folder is zipped like any other directory, less its `.git`. The outer
  `.gitignore` rules still apply inside it, even though git would not apply
  them there.

## Building

```bash
npm install
npm run compile      # or: npm run watch
```

Press **F5** in VS Code with this folder open to start an Extension Development
Host with the extension loaded.

## Testing

```bash
npm test
```

This compiles the extension and runs the suite under `node --test`. It needs
Node 18 or later and `git` on `PATH`. The tests that compare against git skip
themselves if git is missing. Nothing in the suite starts VS Code.

| File | What it checks |
| --- | --- |
| `tests/differential.test.js` | Builds each case as a real repository and requires exactly what `git ls-files --others --exclude-standard` lists. |
| `tests/logic.test.js` | How nested patterns are rewritten, how the repository and `info/exclude` are found, and ignored-folder behaviour. |
| `tests/zipper.test.js` | Writes real zips with `archiver` and opens them: contents, failures, cancelling, links, long paths. |
| `tests/drift.test.js` | Checks that `tests/original/` still matches the first commit. |

Tests named `regression:` are also run against the original code in
`tests/original/`, and assert that it fails them, so each one is known to test
something. `ignore-5` in `devDependencies` is the version of `ignore` the
original shipped with, installed under another name for that purpose only.

## Packaging

```bash
npx @vscode/vsce package
```

`vsce` runs `npm run compile` first, so install the dev dependencies before
packaging. `vsce` leaves dev dependencies out of the `.vsix` by itself.

## Layout

```
src/
  extension.ts   VS Code glue: the command, the dialogs, the progress notification
  zipper.ts      Writes the zip: archiver, the output file, cancelling, cleanup
  zipLogic.ts    Decides what goes in: the ignore rules and the directory walk
tests/
  original/      The first commit's code, kept so regression tests can run against it
```

Only `extension.ts` imports `vscode`. The other two can be run and tested in
plain Node.

## Licence

Free for personal, non-commercial use. You may use, study and modify this
software for yourself, but you may not use it commercially, and you may not
share or publish it, in its original form or modified. See [LICENSE](LICENSE)
for the full terms.
