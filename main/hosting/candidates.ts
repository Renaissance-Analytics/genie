import fs from 'node:fs';
import path from 'node:path';
import type { HostedSiteKind } from './types';

/**
 * CANDIDATE DETECTION for the Workspace Site Manager (Tynn #232, hosting UX).
 *
 * The Site Manager exists so a user can say "serve this" — not so they can type
 * a document root. Getting that root wrong is the difference between a working
 * preview and a 404 (or, worse, publishing a directory that holds `.env`), so
 * Genie proposes it from what is actually on disk:
 *
 *   - a `public/index.php` means a Laravel-shaped app whose ONLY safe docroot is
 *     that `public/` — never the repo root, which holds the source and the env;
 *   - a `dist/index.html` means a built frontend, servable as-is;
 *   - a `package.json` with a build means a frontend that will be servable once
 *     {@link ensureBuilt} has run — offered, but flagged so the UI says so
 *     rather than promising a site that is currently an empty directory.
 *
 * A project that matches none of those is simply not offered. The user can
 * still add a site by hand in the Site Manager; this is the shortcut, not the
 * gate.
 *
 * Everything above `--- thin impure ---` is PURE and directly unit-tested. The
 * fs walk below takes its access as injected seams for the same reason.
 */

// --- pure ------------------------------------------------------------------

/**
 * Directories a build writes to, most-preferred first.
 *
 * `public` is last on purpose: for a PHP app it is the front-controller root
 * (already claimed by the php candidate), and for a static-site generator it is
 * usually a source directory rather than an artifact — so it only ever wins
 * when nothing better holds an `index.html`.
 */
export const BUILD_OUTPUT_DIRS = ['dist', 'build', 'out', '_site', 'public'] as const;

/** What the scanner learned about ONE project directory. */
export interface ProjectScan {
    /** Directory RELATIVE to the workspace, POSIX-separated. `''` = the
     *  workspace root itself (a plain-folder project). */
    dir: string;
    /** Display name + hostname seed — the repo (or workspace) leaf. */
    name: string;
    /** `<dir>/public/index.php` exists. */
    publicIndexPhp: boolean;
    /** `<dir>/index.php` exists. */
    indexPhp: boolean;
    /** Build-output dirs (relative to the project) that ALREADY hold an
     *  `index.html`, i.e. are servable right now. */
    built: string[];
    /** The project declares a build (a `build` script, or a vite dependency). */
    buildable: boolean;
}

/** One site the Site Manager can offer to host. */
export interface SiteCandidate {
    /** {@link ProjectScan.dir} — which project this came from. */
    project: string;
    /** Display name for the row. */
    name: string;
    kind: HostedSiteKind;
    /** Document root RELATIVE to the workspace — exactly what
     *  `HostedSiteConfig.docroot` stores, so enabling is a straight copy. */
    docroot: string;
    /** The vhost we suggest. Always a valid mapped hostname. */
    hostname: string;
    /** Why Genie thinks this is a site — shown in the row so the proposal is
     *  never mysterious. */
    reason: string;
    /** A static site whose docroot has no `index.html` yet: enabling it runs the
     *  project's build first. */
    needsBuild: boolean;
}

/**
 * PURE. A repo/folder name reduced to a hostname label.
 *
 * The `.agi` suffix goes first — an envelope called `tynn.agi` is the `tynn`
 * project, and `tynn-agi.test` would be nobody's idea of the right name.
 */
export function siteSlug(name: string): string {
    const slug = String(name ?? '')
        .trim()
        .toLowerCase()
        .replace(/\.agi$/, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || 'site';
}

/** PURE. The suggested vhost for a slug; `suffix` distinguishes a second site
 *  in the same project (e.g. a repo that is both a PHP app and a built SPA). */
export function candidateHostname(slug: string, suffix?: string): string {
    const label = suffix ? `${slug}-${siteSlug(suffix)}` : slug;
    return `${label}.test`;
}

/**
 * PURE. The sites one project offers.
 *
 * Order is significance order: the PHP app first (it is the project's actual
 * application), then each servable build output, then the not-yet-built one.
 * The first candidate keeps the plain `<slug>.test`; the rest are qualified, so
 * two sites in one repo can both be enabled without one's stored config
 * silently replacing the other's (the site id is derived from the hostname).
 */
export function candidatesFrom(scan: ProjectScan): SiteCandidate[] {
    const slug = siteSlug(scan.name);
    const under = (rel: string): string =>
        [scan.dir, rel].filter(Boolean).join('/') || rel;

    const found: Array<Omit<SiteCandidate, 'hostname'> & { suffix?: string }> = [];

    if (scan.publicIndexPhp || scan.indexPhp) {
        // public/ wins whenever it exists: serving the repo root of a Laravel
        // app would publish its source tree and its `.env`.
        const inPublic = scan.publicIndexPhp;
        found.push({
            project: scan.dir,
            name: scan.name,
            kind: 'php',
            docroot: inPublic ? under('public') : scan.dir,
            reason: inPublic
                ? 'PHP application — public/index.php'
                : 'PHP application — index.php',
            needsBuild: false,
        });
    }

    for (const dir of BUILD_OUTPUT_DIRS) {
        if (!scan.built.includes(dir)) continue;
        found.push({
            project: scan.dir,
            name: scan.name,
            kind: 'static',
            docroot: under(dir),
            reason: `Built frontend — ${dir}/index.html`,
            needsBuild: false,
            suffix: dir,
        });
    }

    if (scan.buildable && scan.built.length === 0) {
        found.push({
            project: scan.dir,
            name: scan.name,
            kind: 'static',
            docroot: under(BUILD_OUTPUT_DIRS[0]),
            reason: 'Frontend — runs the project build, then serves dist/',
            needsBuild: true,
            suffix: BUILD_OUTPUT_DIRS[0],
        });
    }

    // One directory is one site. A PHP app whose public/ also holds an
    // index.html must not be offered twice under two different backends.
    const seen = new Set<string>();
    return found
        .filter((c) => {
            if (seen.has(c.docroot)) return false;
            seen.add(c.docroot);
            return true;
        })
        .map(({ suffix, ...c }, i) => ({
            ...c,
            hostname: candidateHostname(slug, i === 0 ? undefined : suffix),
        }));
}

/**
 * PURE. Every candidate across a workspace's projects, with hostnames made
 * unique.
 *
 * Uniqueness is not cosmetic: a site's id is `siteIdFor(hostname)`, so two
 * repos slugging to the same name (`Tynn-UI` and `tynn.ui`) would share one
 * stored config and one served port — the second would quietly displace the
 * first. Collisions get a numeric suffix instead.
 */
export function candidatesForWorkspace(scans: ProjectScan[]): SiteCandidate[] {
    const taken = new Set<string>();
    const out: SiteCandidate[] = [];
    for (const scan of scans) {
        for (const candidate of candidatesFrom(scan)) {
            let hostname = candidate.hostname;
            for (let n = 2; taken.has(hostname); n += 1) {
                hostname = candidate.hostname.replace(/\.test$/, `-${n}.test`);
            }
            taken.add(hostname);
            out.push({ ...candidate, hostname });
        }
    }
    return out;
}

// --- thin impure -----------------------------------------------------------

export interface CandidateSeams {
    /** Repo folder names under `<workspace>/repos`. */
    listRepos(workspacePath: string): string[];
    exists(p: string): boolean;
    readPackageJson(dir: string): Record<string, unknown> | null;
}

/** PURE. Does this manifest declare a frontend build? Mirrors the rule
 *  `build.ts#buildPlanFor` applies when it actually runs one. */
function declaresBuild(pkg: Record<string, unknown> | null): boolean {
    if (!pkg) return false;
    const manifest = pkg as {
        scripts?: Record<string, unknown>;
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
    };
    if (typeof manifest.scripts?.build === 'string' && manifest.scripts.build.trim()) {
        return true;
    }
    return !!(manifest.devDependencies?.vite ?? manifest.dependencies?.vite);
}

function scanProject(
    workspacePath: string,
    dir: string,
    name: string,
    seams: CandidateSeams,
): ProjectScan {
    const abs = dir ? path.join(workspacePath, dir) : workspacePath;
    return {
        dir,
        name,
        publicIndexPhp: seams.exists(path.join(abs, 'public', 'index.php')),
        indexPhp: seams.exists(path.join(abs, 'index.php')),
        // "Built" means SERVABLE — a `dist/` that exists but holds no
        // index.html is a stale directory, not a site.
        built: BUILD_OUTPUT_DIRS.filter((d) => seams.exists(path.join(abs, d, 'index.html'))),
        buildable: declaresBuild(seams.readPackageJson(abs)),
    };
}

/**
 * Every site Genie could host in this workspace: each `repos/<name>`, plus the
 * workspace root itself (which IS the project for a plain-folder workspace).
 *
 * Never throws — an unreadable workspace yields no candidates, because the Site
 * Manager still has to open and let the user add a site by hand.
 */
export function scanWorkspaceCandidates(
    workspacePath: string,
    seams: CandidateSeams = defaultSeams,
): SiteCandidate[] {
    if (!workspacePath) return [];
    try {
        const rootName = path.basename(workspacePath.replace(/[\\/]+$/, '')) || 'site';
        const scans: ProjectScan[] = [
            ...seams
                .listRepos(workspacePath)
                .map((repo) => scanProject(workspacePath, `repos/${repo}`, repo, seams)),
            scanProject(workspacePath, '', rootName, seams),
        ];
        return candidatesForWorkspace(scans);
    } catch {
        return [];
    }
}

const defaultSeams: CandidateSeams = {
    listRepos(workspacePath) {
        const reposDir = path.join(workspacePath, 'repos');
        try {
            return fs
                .readdirSync(reposDir, { withFileTypes: true })
                .filter((d) => d.isDirectory())
                .map((d) => d.name);
        } catch {
            return [];
        }
    },

    exists(p) {
        try {
            return fs.existsSync(p);
        } catch {
            return false;
        }
    },

    readPackageJson(dir) {
        try {
            const parsed: unknown = JSON.parse(
                fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
            );
            return parsed && typeof parsed === 'object'
                ? (parsed as Record<string, unknown>)
                : null;
        } catch {
            return null;
        }
    },
};
