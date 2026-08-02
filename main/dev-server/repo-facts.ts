import fs from 'node:fs';
import path from 'node:path';
import { detectRunOptions, recommendedOption } from './site-def';
import type { DetectOptions, DevSiteOption, RepoFacts } from './site-def';

/**
 * The ONE place the layered site definition touches a disk.
 *
 * `site-def.ts` is pure on purpose — every ordering and honesty rule in it is
 * assertable without a fixture directory. This module is the thin, boring half:
 * read a repo root, read its `package.json` if it has one, hand over a
 * {@link RepoFacts}.
 *
 * It reads only what resolution asks for — the root listing (one `readdir`, not
 * a walk) and one small JSON file. A repo root can be a `node_modules` away from
 * a hundred thousand entries, and a detector that stats its way through them
 * turns "what is this project" into a visible pause.
 *
 * Every failure is absorbed: an unreadable directory or a malformed
 * `package.json` becomes "no facts", which resolves to the explicit layer with a
 * sentence saying what is needed. A permissions error on one repo must not fail
 * the workspace's whole site listing.
 */

/** Cap the root listing. A directory bigger than this is not a repo root we can
 *  learn anything more from, and reading all of it helps nobody. */
const MAX_ENTRIES = 500;

export function readRepoFacts(repoDir: string): RepoFacts {
    let entries: string[] = [];
    try {
        entries = fs.readdirSync(repoDir).slice(0, MAX_ENTRIES);
    } catch {
        return { entries: [] };
    }

    if (!entries.includes('package.json')) return { entries };

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
            entries,
            packageJson: {
                ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
                ...(scripts ? { scripts } : {}),
            },
        };
    } catch {
        // A package.json we cannot parse is the same as none for our purposes —
        // and saying "a Node repo with no dev script" is more useful than
        // failing the whole detection over a trailing comma.
        return { entries, packageJson: null };
    }
}

/** Every way a repo on disk could be run, best-offer first, plus the one to
 *  take. The single call the MCP tool and the (P4) UX both make. */
export function describeRepoRun(
    repoDir: string,
    opts: DetectOptions = {},
): { options: DevSiteOption[]; recommended: DevSiteOption | null } {
    const options = detectRunOptions(readRepoFacts(repoDir), opts);
    return { options, recommended: recommendedOption(options) };
}
