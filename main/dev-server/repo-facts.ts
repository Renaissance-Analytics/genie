import fs from 'node:fs';
import path from 'node:path';
import { detectHostingOptions, recommendedOption } from './serve-recipe';
import type { DetectOptions, HostingOption, RepoFacts } from './serve-recipe';

/**
 * The ONE place the layered site definition touches a disk.
 *
 * `serve-recipe.ts` is pure on purpose — every ordering and honesty rule in it
 * is assertable without a fixture directory. This module is the thin, boring
 * half: read a repo root, read the few small files a production recipe needs,
 * hand over a {@link RepoFacts}.
 *
 * It reads only what resolution asks for — the root listing (one `readdir`, not
 * a walk), and at most three small files. A repo root can be a `node_modules`
 * away from a hundred thousand entries, and a detector that stats its way
 * through them turns "what is this project" into a visible pause.
 *
 * Every failure is absorbed: an unreadable directory or a malformed
 * `package.json` becomes "no facts", which resolves to an option that says what
 * it needs. A permissions error on one repo must not fail the workspace's whole
 * site listing.
 */

/** Cap the root listing. A directory bigger than this is not a repo root we can
 *  learn anything more from, and reading all of it helps nobody. */
const MAX_ENTRIES = 500;

/** Cap the Django package scan — one level, and only over plausible packages. */
const MAX_PACKAGE_PROBES = 60;

function readPackageJson(repoDir: string): RepoFacts['packageJson'] {
    try {
        const raw = fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8');
        const parsed = JSON.parse(raw) as { name?: unknown; scripts?: unknown };
        const scripts =
            parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)
                ? Object.fromEntries(
                      Object.entries(parsed.scripts as Record<string, unknown>).filter(
                          ([, v]) => typeof v === 'string',
                      ) as Array<[string, string]>,
                  )
                : undefined;
        return {
            ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
            ...(scripts ? { scripts } : {}),
        };
    } catch {
        // A package.json we cannot parse is the same as none for our purposes —
        // and saying "a Node repo with no build script" is more useful than
        // failing the whole detection over a trailing comma.
        return null;
    }
}

/**
 * The Django settings package — the directory holding `wsgi.py`.
 *
 * READ, never guessed from the repo name. A Django project directory is
 * conventionally named after the project and very often is not, and
 * `gunicorn wrongname.wsgi:application` fails with an ImportError that reads
 * like the application is broken rather than like Genie guessed.
 *
 * One level deep only: `manage.py` sits beside the settings package in every
 * layout Django's own `startproject` produces, and walking further would mean
 * descending into `node_modules` and `.venv` for a name we can ask for instead.
 */
function findPythonPackage(repoDir: string, entries: string[]): string | undefined {
    let probed = 0;
    for (const entry of entries) {
        if (entry.startsWith('.') || entry === 'node_modules' || entry === 'venv') continue;
        if (probed++ >= MAX_PACKAGE_PROBES) break;
        try {
            if (fs.existsSync(path.join(repoDir, entry, 'wsgi.py'))) return entry;
        } catch {
            /* one unreadable subdirectory must not fail the detection */
        }
    }
    return undefined;
}

/**
 * `[package] name` from Cargo.toml — the binary `cargo build --release` writes.
 *
 * A regex rather than a TOML parser: this reads ONE key out of a file whose
 * grammar is stable, and adding a dependency to the main process for it would be
 * a poor trade. Anchored to the `[package]` table so a `[dependencies]` entry
 * called `name` cannot win, and a miss simply means the recipe reports that it
 * needs the binary name.
 */
function readCrateName(repoDir: string): string | undefined {
    try {
        const raw = fs.readFileSync(path.join(repoDir, 'Cargo.toml'), 'utf8');
        const pkg = /^\s*\[package\]\s*$/m.exec(raw);
        if (!pkg) return undefined;
        const after = raw.slice(pkg.index + pkg[0].length);
        // Stop at the next table header, so only the [package] table is read.
        const table = after.split(/^\s*\[/m)[0] ?? '';
        const name = /^\s*name\s*=\s*["']([A-Za-z0-9_-]+)["']/m.exec(table);
        return name?.[1];
    } catch {
        return undefined;
    }
}

export function readRepoFacts(repoDir: string): RepoFacts {
    let entries: string[] = [];
    try {
        entries = fs.readdirSync(repoDir).slice(0, MAX_ENTRIES);
    } catch {
        return { entries: [] };
    }

    const facts: RepoFacts = { entries };
    if (entries.includes('package.json')) facts.packageJson = readPackageJson(repoDir);
    if (entries.includes('manage.py')) {
        const pkg = findPythonPackage(repoDir, entries);
        if (pkg) facts.pythonPackage = pkg;
    }
    if (entries.includes('Cargo.toml')) {
        const crate = readCrateName(repoDir);
        if (crate) facts.crateName = crate;
    }
    return facts;
}

/** Every way a repo on disk could be built and served in production, best-offer
 *  first, plus the one to take. The single call the MCP tool and the UX make. */
export function describeRepoRun(
    repoDir: string,
    opts: DetectOptions = {},
): { options: HostingOption[]; recommended: HostingOption | null } {
    const options = detectHostingOptions(readRepoFacts(repoDir), opts);
    return { options, recommended: recommendedOption(options) };
}
