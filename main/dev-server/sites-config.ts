import { createHash } from 'node:crypto';
import { isDevFramework } from './host-allowlist';
import type { DevFramework } from './host-allowlist';
import type { DevSiteRunMode } from './site-def';

/**
 * PURE. The persisted per-workspace DEV SITE model (Tynn #234, P2 item 2).
 *
 * The sibling of `hosting/sites-config.ts`, and deliberately a SEPARATE column
 * rather than more fields on `hosted_sites`, because the two describe different
 * substrates. A `hosted_sites` row is "Genie serves this document root with its
 * own native runtime" (the beta.218 path, PHP-first, host-native). A dev-site row
 * is "a container runs this command in the workspace sandbox and Genie routes its
 * published port". P4 retires the first; until then a workspace can hold both,
 * and mixing them into one blob would make that retirement a data migration.
 *
 * ## Why the id is workspace-scoped
 *
 * A hosted site's id is `sha256(hostname)` — global, because a hostname IS
 * global (`tynn.test` means the same thing everywhere on the machine). A dev
 * site's name is workspace-local: `web` in one workspace and `web` in another
 * are two different sites that must be able to run at once. So the id hashes the
 * pair, and the `.gen` name defaults to `<site>.<workspace>.gen` for the same
 * reason — one flat `.gen` namespace across workspaces would have them silently
 * shadow each other in the Testing Browser's first-wins merge.
 *
 * ## SECURITY
 *
 * Everything here reaches a container CLI as literal argv (`argv.ts` spawns with
 * `shell: false`), so this is not escaping — it is keeping the ARGUMENT GRAMMAR
 * intact. What is refused: a name that is not a DNS label (it becomes part of an
 * origin the browser trusts), a `command` that is not an array of strings (a
 * shell string would be passed as ONE argument and silently never run), a NUL
 * byte (unpassable to a process at all), and an env NAME that is not a variable
 * name (`--env` takes `NAME=value`, so a `=` in the name changes what is set).
 */

// --- the model -------------------------------------------------------------

export interface DevSiteConfig {
    /** The site's name inside its workspace — a DNS label (`web`, `api`). */
    name: string;
    /** The browser-facing name. Always ends `.gen`. */
    genName: string;
    /** A repo subfolder (`repos/<repo>`), or '' for the workspace root. */
    repo: string;
    runMode: DevSiteRunMode;
    /** The image to run. Absent = the workspace dev image. */
    image?: string;
    /** Literal argv run inside the container. */
    command?: string[];
    /** The port the server listens on INSIDE the container. */
    port?: number;
    env?: Record<string, string>;
    /** `http` is routable at `<genName>`; `tcp` is published and listed only. */
    kind: 'http' | 'tcp';
    /**
     * Which framework this site runs, when detection could tell.
     *
     * Stored rather than re-derived because the argv usually cannot say it:
     * `npm run dev -- --host 0.0.0.0` contains no token spelling "vite", and
     * Vite is exactly the framework that rejects the `.gen` Host header. This
     * is what `host-allowlist.ts` uses to keep the real Host working instead of
     * falling back to {@link upstreamHost}.
     */
    framework?: DevFramework;
    /**
     * The `Host` header sent upstream. Defaults to {@link genName}, so the dev
     * server sees the same origin the browser does and its absolute URLs,
     * cookies and CSRF origin checks line up.
     *
     * Overridable because several frameworks check the Host against an allowlist
     * they cannot know about — Vite's `server.allowedHosts`, Django's
     * `ALLOWED_HOSTS`, Rails' `hosts`. Setting `localhost` here is the one-field
     * escape from a "Blocked request" page.
     */
    upstreamHost?: string;
    /** Strict opt-in: nothing runs until this is true. */
    enabled: boolean;
}

/** A workspace's dev sites, keyed by {@link devSiteIdFor}. */
export type DevSites = Record<string, DevSiteConfig>;

/** A DNS label: what a site name and each `.gen` segment must be. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Docker/OCI reference characters. Deliberately permissive about registries and
 *  digests, and strict about whitespace and shell metacharacters. */
const IMAGE_REF = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]{0,254}$/;

/** Environment names we will put on a command line. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const RUN_MODES: readonly DevSiteRunMode[] = [
    'dockerfile',
    'devcontainer',
    'compose',
    'detected',
    'explicit',
];

// --- identity ---------------------------------------------------------------

/**
 * The opaque id a dev site is stored and routed under.
 *
 * Workspace-scoped (see the file header) and stable, because this id is the key
 * `localTargetsBySiteId` builds the Testing Browser's resolver map on — if it
 * changed between runs, every open tab would resolve to nothing.
 */
export function devSiteIdFor(workspaceId: string, name: string): string {
    return createHash('sha256')
        .update(`${workspaceId}\0${name.toLowerCase()}`)
        .digest('hex')
        .slice(0, 16);
}

/**
 * The default `.gen` name for a site: `<site>.<workspace>.gen`.
 *
 * Per-site subdomain rather than `acme.gen/web` — a path prefix is not an
 * origin, so two sites sharing one would share cookies, storage and service
 * workers, which is precisely the isolation the `.gen` design exists to give.
 */
export function defaultGenNameFor(workspaceLabel: string, name: string): string {
    const label = slugLabel(workspaceLabel);
    const site = slugLabel(name) || 'site';
    return label ? `${site}.${label}.gen` : `${site}.gen`;
}

/** Reduce arbitrary text to a DNS label, or '' when nothing survives. */
export function slugLabel(value: string): string {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '')
        .slice(0, 63)
        .replace(/-+$/, '');
}

// --- sanitize ---------------------------------------------------------------

/** PURE. Normalize an untrusted patch: only well-typed, in-bounds fields survive. */
export function sanitizeDevSitePatch(
    patch: Partial<DevSiteConfig> | null | undefined,
): Partial<DevSiteConfig> {
    const out: Partial<DevSiteConfig> = {};
    if (!patch || typeof patch !== 'object') return out;

    if (typeof patch.name === 'string') {
        const name = patch.name.trim().toLowerCase();
        if (DNS_LABEL.test(name)) out.name = name;
    }

    if (typeof patch.genName === 'string') {
        const genName = patch.genName.trim().toLowerCase().replace(/\.$/, '');
        const labels = genName.split('.');
        // Must BE a `.gen` name, with at least one label in front of it: the
        // browser session trusts `*.gen` and nothing else, so a name that is not
        // one would resolve nowhere and mint a cert for a name it must not.
        if (labels.length >= 2 && labels.at(-1) === 'gen' && labels.every((l) => DNS_LABEL.test(l))) {
            out.genName = genName;
        }
    }

    if (typeof patch.repo === 'string') {
        const repo = patch.repo.trim().replace(/^\.\//, '');
        // A repo name becomes a path segment inside the container's mount; `..`
        // or a separator there climbs out of the workspace.
        if (repo === '' || (/^[A-Za-z0-9._-]+$/.test(repo) && repo !== '.' && repo !== '..')) {
            out.repo = repo;
        }
    }

    if (patch.runMode && RUN_MODES.includes(patch.runMode)) out.runMode = patch.runMode;

    if (typeof patch.image === 'string') {
        const image = patch.image.trim();
        if (image && IMAGE_REF.test(image)) out.image = image;
    }

    if (Array.isArray(patch.command)) {
        // Every token must be a string with no NUL. A whole-command STRING is
        // rejected rather than split: splitting it would need shell quoting
        // rules, and passing it as one argument fails in a way nobody can read.
        const command = patch.command;
        if (command.every((t) => typeof t === 'string' && !t.includes('\0'))) {
            if (command.length) out.command = [...command];
        }
    }

    if (typeof patch.port === 'number' && Number.isInteger(patch.port)) {
        if (patch.port >= 1 && patch.port <= 65535) out.port = patch.port;
    }

    if (patch.env && typeof patch.env === 'object' && !Array.isArray(patch.env)) {
        const env: Record<string, string> = {};
        for (const [name, value] of Object.entries(patch.env)) {
            if (!ENV_NAME.test(name) || typeof value !== 'string' || value.includes('\0')) continue;
            env[name] = value;
        }
        out.env = env;
    }

    if (patch.kind === 'http' || patch.kind === 'tcp') out.kind = patch.kind;

    if (isDevFramework(patch.framework)) out.framework = patch.framework;

    if (typeof patch.upstreamHost === 'string') {
        const host = patch.upstreamHost.trim().toLowerCase();
        if (host && host.length <= 253 && host.split('.').every((l) => DNS_LABEL.test(l))) {
            out.upstreamHost = host;
        }
    }

    if (typeof patch.enabled === 'boolean') out.enabled = patch.enabled;

    return out;
}

/**
 * PURE. Parse a stored `dev_sites` blob. Robust to NULL, corrupt JSON and junk —
 * an unreadable blob reads as `{}` (the safe default: nothing runs).
 */
export function parseDevSites(raw: string | null | undefined): DevSites {
    if (!raw) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: DevSites = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        const clean = sanitizeDevSitePatch(value as DevSiteConfig);
        // A row with no name or no `.gen` cannot be routed or addressed; keeping
        // it would show an unusable site in every list.
        if (!clean.name || !clean.genName) continue;
        out[id] = {
            repo: '',
            runMode: 'explicit',
            kind: 'http',
            enabled: false,
            ...clean,
        } as DevSiteConfig;
    }
    return out;
}
