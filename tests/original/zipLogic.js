"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadGitignore = loadGitignore;
exports.toPosix = toPosix;
exports.isIgnoredByChain = isIgnoredByChain;
exports.walkAndAdd = walkAndAdd;
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const ignore_1 = __importDefault(require("ignore-5"));
/**
 * Reads a .gitignore file (if present) in `dir` and returns an `ignore` instance for it.
 * Returns undefined if there is no .gitignore in that directory.
 */
function loadGitignore(dir) {
    const gitignorePath = path.join(dir, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
        return undefined;
    }
    try {
        const content = fs.readFileSync(gitignorePath, 'utf8');
        return (0, ignore_1.default)().add(content);
    }
    catch {
        return undefined;
    }
}
/** Converts a filesystem path to posix-style ('/'-separated) for use with the `ignore` package. */
function toPosix(p) {
    return p.split(path.sep).join('/');
}
/** Returns true if `relPathFromRoot` is ignored by any level in the chain. */
function isIgnoredByChain(chain, relPathFromRoot, isDir) {
    for (const level of chain) {
        let testPath = level.baseRelDir === '' ? relPathFromRoot : path.posix.relative(level.baseRelDir, relPathFromRoot);
        if (testPath === '' || testPath.startsWith('..')) {
            continue; // not under this level's directory
        }
        if (isDir && !testPath.endsWith('/')) {
            testPath += '/';
        }
        if (level.ig.ignores(testPath)) {
            return true;
        }
    }
    return false;
}
/**
 * Recursively walks `dir`, adding every non-git-ignored file to `archive` via archive.file(fullPath, {name: relPath}).
 * `relDir` is the path of `dir` relative to the zip root (posix, '' = root).
 * Returns the list of relative paths added, for testing/inspection.
 */
async function walkAndAdd(archive, dir, relDir, parentChain, outputZipPath, stats, isCancelled, addedPaths) {
    if (isCancelled()) {
        return;
    }
    let chain = parentChain;
    const localIg = loadGitignore(dir);
    if (localIg) {
        chain = [...parentChain, { baseRelDir: relDir, ig: localIg }];
    }
    let entries;
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
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
        if (outputZipPath && path.resolve(fullPath) === path.resolve(outputZipPath)) {
            continue;
        }
        const isDirectory = entry.isDirectory();
        if (isIgnoredByChain(chain, toPosix(relPath), isDirectory)) {
            continue;
        }
        if (isDirectory) {
            await walkAndAdd(archive, fullPath, relPath, chain, outputZipPath, stats, isCancelled, addedPaths);
        }
        else if (entry.isSymbolicLink()) {
            // Skip symlinks to avoid archiver errors on broken links; adjust here if you want to follow them.
            continue;
        }
        else {
            archive.file(fullPath, { name: relPath });
            stats.fileCount++;
            addedPaths?.push(toPosix(relPath));
        }
    }
}
//# sourceMappingURL=zipLogic.js.map