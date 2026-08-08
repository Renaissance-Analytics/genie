import { createHash } from 'node:crypto';
import { isDevFramework } from './host-allowlist';
import type { DevFramework } from './host-allowlist';
import type { BuildStep, HostingRunMode, HostingStack, ProductionServer } from './serve-recipe';
import type { BrowserProtocol, ExposedSurface } from './exposure';

/**
 * PURE. The persisted per-workspace HOSTED SITE model.
 *
 * A hosted site is **a built artifact plus the production server that serves
 * it**, running in the workspace's container sandbox and reachable at
 * `https://<name>.gen`. So the stored shape is not "a command and a port" — it
 * is a {@link DevSiteConfig.build} list, a {@link DevSiteConfig.serve} argv, the
 * port that server listens on, and the browser-facing surfaces the site
 * {@link DevSiteConfig.exposed}. `serve-recipe.ts` is where those come from and
 * `site-build.ts` is what runs the first of them.
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
 * origin the browser trusts), a `serve`/`build` command that is not an array of
 * strings (a shell string would be passed as ONE argument and silently never
 * run), a NUL byte (unpassable to a process at all), and an env NAME that is not
 * a variable name (`--env` takes `NAME=value`, so a `=` in the name changes what
 * is set).
 *
 * An {@link ExposedSurface} gets one more check than the rest, because it is the
 * only field that opens a port: it must carry a `reason` naming what the BROWSER
 * needs it for. See `exposure.ts` — the boundary is only real if something
 * enforces it, and this is the persistence half of that.
 */

// --- the model -------------------------------------------------------------

export interface DevSiteConfig {
    /** The site's name inside its workspace — a DNS label (`web`, `api`). */
    name: string;
    /** The browser-facing name. Always ends `.gen`. */
    genName: string;
    /** A repo subfolder (`repos/<repo>`), or '' for the workspace root. */
    repo: string;
    runMode: HostingRunMode;
    /** What is being hosted, when detection could tell (`php`, `static`, `go`). */
    stack?: HostingStack;
    /** Which production server holds the port (`frankenphp`, `gunicorn`, …). */
    server?: ProductionServer;
    /**
     * The image the SERVER runs in. Absent = the workspace dev image.
     *
     * Routinely NOT the image the build ran in — a PHP site builds with Composer
     * in the sandbox and serves from FrankenPHP; a front end builds with npm and
     * serves from nginx. That split is the production model, not an accident.
     */
    image?: string;
    /**
     * The PRODUCTION BUILD, in order. Run in the workspace sandbox before the
     * server starts (see `site-build.ts`). Empty for a site whose image builds
     * itself.
     */
    build?: BuildStep[];
    /**
     * The USER-CONTROLLED startup command, as literal argv, run inside the
     * workspace sandbox in the repo's live-mounted dir. This is the whole model:
     * Genie makes NO assumptions — no forced dev server, no build, no `--no-dev` —
     * it runs exactly what you give it (`['npm','run','dev']`, `['php','artisan',
     * 'serve','--host=0.0.0.0']`, a binary, anything). The app binds {@link port}
     * on loopback; Caddy in the sandbox fronts it at `<genName>` over https.
     *
     * Supersedes {@link serve} (the old per-container production argv). `serve` is
     * still read as a fallback so pre-rework sites keep running until re-saved.
     */
    command?: string[];
    /** LEGACY (pre-sandbox-serve): the production server's literal argv. Read as a
     *  fallback for {@link command}; not written by the new model. */
    serve?: string[];
    /** The port the app's {@link command} listens on (loopback, inside the sandbox);
     *  Caddy reverse-proxies `<genName>` to it. */
    port?: number;
    /**
     * Extra BROWSER-FACING surfaces — a websocket, a gRPC endpoint.
     *
     * Only what the browser itself connects to. A database, a cache or an
     * internal API the server calls is reached on the workspace network through
     * the injected environment and never appears here. See `exposure.ts`.
     */
    exposed?: ExposedSurface[];
    env?: Record<string, string>;
    /** `http` is routable at `<genName>`; `tcp` is published and listed only. */
    kind: 'http' | 'tcp';
    /**
     * Which framework this site runs, when detection could tell.
     *
     * Stored rather than re-derived because the serve argv usually cannot say
     * it: `npm run start` contains no token spelling "next", and a bare gunicorn
     * invocation does not say "Django" — which is the framework whose
     * `ALLOWED_HOSTS` will reject the `.gen` name. See `host-allowlist.ts`.
     */
    framework?: DevFramework;
    /**
     * The `Host` header sent upstream. Defaults to {@link genName}, so the app
     * sees the same origin the browser does and its absolute URLs, cookies and
     * CSRF origin checks line up.
     *
     * Overridable because some frameworks check the Host against an allowlist
     * they cannot know about — Django's `ALLOWED_HOSTS` is the one that still
     * applies in production. Setting `localhost` here is the one-field escape
     * from a "Bad Request (400)" page.
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

const RUN_MODES: readonly HostingRunMode[] = [
    'dockerfile',
    'devcontainer',
    'compose',
    'recipe',
    'explicit',
];

const STACKS: readonly HostingStack[] = ['php', 'node', 'static', 'python', 'go', 'rust'];

const SERVERS: readonly ProductionServer[] = [
    'frankenphp',
    'node',
    'nginx',
    'gunicorn',
    'uvicorn',
    'binary',
];

const PROTOCOLS: readonly BrowserProtocol[] = ['http', 'ws', 'grpc', 'tcp'];

/** A literal argv: every token a string, none carrying a NUL. A whole-command
 *  STRING is rejected rather than split — splitting needs shell quoting rules,
 *  and passing it as one argument fails in a way nobody can read. */
function cleanArgv(value: unknown): string[] | null {
    if (!Array.isArray(value) || value.length === 0) return null;
    if (!value.every((t) => typeof t === 'string' && !t.includes('\0'))) return null;
    return [...(value as string[])];
}

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

    if (patch.stack && STACKS.includes(patch.stack)) out.stack = patch.stack;
    if (patch.server && SERVERS.includes(patch.server)) out.server = patch.server;

    const command = cleanArgv(patch.command);
    if (command) out.command = command;

    const serve = cleanArgv(patch.serve);
    if (serve) out.serve = serve;

    if (Array.isArray(patch.build)) {
        const build: BuildStep[] = [];
        for (const step of patch.build) {
            if (!step || typeof step !== 'object') continue;
            const command = cleanArgv((step as BuildStep).command);
            if (!command) continue;
            const label = String((step as BuildStep).label ?? '').trim().slice(0, 120);
            build.push({
                // A step with no label still runs; showing the argv beats
                // showing an empty progress line.
                label: label || command.join(' '),
                command,
                ...((step as BuildStep).optional ? { optional: true } : {}),
            });
        }
        out.build = build;
    }

    if (Array.isArray(patch.exposed)) {
        const exposed: ExposedSurface[] = [];
        for (const surface of patch.exposed) {
            if (!surface || typeof surface !== 'object') continue;
            const s = surface as ExposedSurface;
            const name = String(s.name ?? '').trim().toLowerCase();
            const reason = String(s.reason ?? '').trim();
            if (!DNS_LABEL.test(name)) continue;
            // The boundary, enforced at the point of STORAGE as well as at the
            // point of use: a surface that cannot say what the browser needs it
            // for is not persisted, so it cannot be quietly re-applied later.
            if (!reason) continue;
            if (!PROTOCOLS.includes(s.protocol)) continue;
            if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) continue;
            exposed.push({ name, port: s.port, protocol: s.protocol, reason: reason.slice(0, 400) });
        }
        out.exposed = exposed;
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
 * PURE. Does re-applying `after` over `before` need the CONTAINER rebuilt/
 * restarted, or is the change cosmetic?
 *
 * A hosted site's container is created around a fixed set of facts — the image,
 * the published port, the serve argv, the build steps, the injected env, and the
 * routing identity (`name`/`genName`/`upstreamHost`/`kind`). Change any of them
 * and the running container is serving the OLD definition; a restart is the only
 * way the edit takes effect (the published port alone is fixed at create time —
 * see `site-manager.ts`). Everything else — most obviously toggling `enabled` —
 * touches nothing the live container depends on, so a running site is left
 * exactly as it is. This is the decision the Site Manager's Edit form and the
 * `manageSite update` action both read, so a human edit and an agent edit reach
 * identical behaviour.
 */
const RECONFIGURE_KEYS: readonly (keyof DevSiteConfig)[] = [
    'name',
    'genName',
    'repo',
    'runMode',
    'stack',
    'server',
    'image',
    'build',
    'command',
    'serve',
    'port',
    'exposed',
    'env',
    'kind',
    'framework',
    'upstreamHost',
];

export function devSiteReconfigureNeedsRestart(
    before: DevSiteConfig | undefined,
    after: DevSiteConfig | undefined,
): boolean {
    if (!before || !after) return true;
    // A structural compare per field: order-insensitive it is not, but the
    // stored shapes are normalized through `sanitizeDevSitePatch`, so a genuine
    // change always reads as different JSON and a no-op edit never does.
    return RECONFIGURE_KEYS.some(
        (k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null),
    );
}

/**
 * The argv to actually run for a site: the new user-controlled {@link
 * DevSiteConfig.command}, falling back to the legacy {@link DevSiteConfig.serve}
 * for a site saved before the sandbox-serve rework. Null when neither is set (the
 * site has nothing to run — a config error the caller surfaces).
 */
export function effectiveCommand(config: DevSiteConfig): string[] | null {
    if (config.command && config.command.length > 0) return config.command;
    if (config.serve && config.serve.length > 0) return config.serve;
    return null;
}

/**
 * MIGRATION. A site created under the OLD production-recipe model stored a serve
 * (or command) that runs a PRODUCTION SERVER — FrankenPHP, nginx — in the site's
 * OWN image. The sandbox-serve rework runs the command INSIDE the workspace
 * sandbox instead, which has PHP/Node but NOT frankenphp or nginx, so those argvs
 * die on the first exec ("frankenphp: not found") and every pre-rework site is
 * dark after the update.
 *
 * This translates the two recipes Genie ever generated into an equivalent DEV
 * command that runs in the sandbox with tools it DOES have:
 *   - FrankenPHP `php-server` (a Laravel/PHP app) → `php artisan serve` on the
 *     same port (the sandbox has PHP; Laravel serves from public/ itself);
 *   - the nginx static bootstrap → PHP's built-in server over the built docroot
 *     (`php -S 0.0.0.0:<port> -t <docroot>`).
 *
 * Anything else — a real user command, a binary, `npm run dev` — is returned
 * UNCHANGED, so a command the user actually chose is never rewritten. Returns
 * null only when there is nothing to run at all.
 */
export function sandboxCommandFor(config: DevSiteConfig): string[] | null {
    const raw = effectiveCommand(config);
    if (!raw) return null;
    return migrateLegacyServeRecipe(raw, config) ?? raw;
}

/** The `PORT` a derived dev command binds — the site's declared port, defaulted. */
function sitePortOf(config: DevSiteConfig): number {
    return typeof config.port === 'number' && config.port >= 1 && config.port <= 65535
        ? config.port
        : 8000;
}

/** Detect and translate a legacy FrankenPHP/nginx recipe. Null = not a recipe. */
function migrateLegacyServeRecipe(argv: string[], config: DevSiteConfig): string[] | null {
    // A custom image supplies its OWN toolchain (e.g. dunglas/frankenphp has the
    // frankenphp binary), so the command must run UNCHANGED there. The migration
    // exists ONLY to substitute for tools the dev-base sandbox image lacks — with a
    // real image behind it there is nothing to substitute. (genie#141)
    if (config.image) return null;

    const has = (t: string) => argv.some((a) => a.toLowerCase().includes(t));
    const port = sitePortOf(config);

    // The LEGACY auto-generated FrankenPHP recipe was `frankenphp php-server …`;
    // `php artisan serve` is the sandbox-native dev equivalent (it serves public/
    // and rebuilds on request). Match that SHAPE — both tokens — not any argv that
    // merely mentions frankenphp: a real `frankenphp run --config Caddyfile` is the
    // user's own command (e.g. to serve a custom Caddyfile) and must pass through
    // untouched, not be silently rewritten to artisan serve. (genie#141)
    if (has('frankenphp') && has('php-server')) {
        return ['php', 'artisan', 'serve', '--host=0.0.0.0', `--port=${port}`];
    }

    // The nginx static bootstrap: `sh -c '… root <docroot>; exec nginx …'`.
    if (has('nginx')) {
        const docroot = legacyStaticDocroot(argv, config);
        return ['php', '-S', `0.0.0.0:${port}`, '-t', docroot];
    }

    return null;
}

/** The built static docroot a legacy nginx recipe served, for `php -S -t`. */
function legacyStaticDocroot(argv: string[], config: DevSiteConfig): string {
    // The recipe put it in GENIE_NGINX_ROOT env, or inlined `root $PWD/<docroot>`
    // in the bootstrap script. Fall back to the Vite/CRA convention.
    const fromEnv = config.env?.GENIE_NGINX_ROOT;
    if (fromEnv && /^[\w./-]+$/.test(fromEnv)) return fromEnv;
    const script = argv.find((a) => a.includes('root ')) ?? '';
    const m = script.match(/root\s+\S*?\/([\w./-]+?)\s*;/) ?? script.match(/root\s+\S*?\/([\w./-]+)/);
    const captured = m?.[1]?.replace(/%s\/?/g, '').replace(/\/+$/, '');
    return captured && /^[\w./-]+$/.test(captured) ? captured : 'dist';
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
