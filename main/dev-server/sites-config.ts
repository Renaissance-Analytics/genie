import { createHash } from 'node:crypto';
import { isDevFramework } from './host-allowlist';
import type { DevFramework } from './host-allowlist';
import type { BuildStep, HostingRunMode, HostingStack, ProductionServer } from './serve-recipe';
import type { BrowserProtocol, ExposedSurface } from './exposure';
import { isLanguageTool, type LanguageTool } from './toolchain-versions';

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
     * HOST-NATIVE routing target (Wish #102 / story #238). When set, the site is
     * served NOT by a container but by a dev server already running as a HOST
     * process — the repo's own dev server (e.g. `php artisan serve` / `npm run
     * dev`), started via `manageProcess` so it holds `127.0.0.1:<hostPort>` on the
     * host and reaches the workspace's managed services in host form (beta.237).
     * `<genName>` routes straight to it: NO sandbox, NO build — "just serve the
     * repo the site points to", the way Herd did (Docker only for pg/redis/…).
     *
     * The dev server speaks plain http; in the Testing Browser the session-CA shim
     * terminates TLS at `.gen`, so it is reachable as https there with no host
     * Caddy. Mutually exclusive with the container path — when this is set,
     * `command`/`serve`/`image`/`build` do not apply (nothing is spawned).
     */
    hostPort?: number;
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
    /**
     * When set (host-native only), Genie serves this site with its OWN bundled
     * web server (Caddy) rather than running a repo dev server: a built directory
     * (`static`) or a PHP app via FastCGI (`php`). The agent declares the mode and
     * never writes a server config. Absent ⇒ run the repo's own dev server. See
     * {@link HostServeConfig} and `serve-config.ts`.
     */
    hostServe?: HostServeConfig;
    /**
     * CONFIGURED to be served. Strict opt-in: nothing runs until this is true.
     *
     * Not "running right now" (genie#407). This field is persisted into the
     * `.agi` envelope's project.json, which is git-TRACKED so the site definition
     * travels with the repo — the right home for a fact about the PROJECT, and
     * the wrong one for a fact about one person's machine at one moment. A stop
     * is the second kind, so it lives in the host's machine-local run state
     * (`site_run_state` in genie.db) and boot checks BOTH: a site is resumed only
     * when it is enabled AND the user has not stopped it.
     */
    enabled: boolean;
    /**
     * Opt-in (story #238): expose `<genName>` to REAL external browsers
     * (Chrome/Edge), not just the in-app Testing Browser. When true, the site
     * joins the host reconcile — Genie installs its local CA, adds the hosts-file
     * entry, and fronts it on the host Caddy `:443` — which prompts for admin
     * ONCE. Off by default: the in-app browser already serves the site with zero
     * prompts, so external access is a deliberate choice. Drives the HOST
     * reconcile, never the site process, so toggling it does not restart anything.
     */
    browserExposed?: boolean;
}

/**
 * How Genie's OWN bundled web server (Caddy) serves a host-native site that is
 * NOT its own dev server — so an agent declares a serve MODE and Genie renders
 * the config, instead of hand-rolling an nginx/Caddy server block. `root` is a
 * repo-relative directory (`dist`, `dashboard/dist`, `public`).
 *   - `static` — serve a built directory over `file_server`, `spa` adding the
 *     `index.html` fallback so client-side routes resolve;
 *   - `php`    — serve `public/` with a FastCGI PHP worker (the nginx/Valet model).
 * Absent ⇒ the host-native site runs the repo's OWN dev server, reverse-proxied
 * (the config-less path). See `serve-config.ts`.
 *
 * `version` PINS the engine (genie#207): the site runs on THAT toolchain version
 * — and fails to start, naming it, if Genie no longer manages it. Omitted ⇒ the
 * site follows the machine default and moves with it, which is what the Toolchain
 * page's "changes on their next start" promises.
 */
export type HostServeConfig =
    | { mode: 'static'; root: string; spa?: boolean }
    | { mode: 'php'; root: string; version?: string };

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
    // Story #238: the repo's dev server run as a HOST process (no container),
    // with `.gen` routed straight to it. "Just serve the repo the site points to."
    'host',
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

/**
 * Toolchain binaries the spawn layer resolves by their BARE name on PATH — so an
 * absolute, machine-specific path to one can be stored portably as just its name.
 */
const PORTABLE_TOOLCHAIN_BINS: ReadonlySet<string> = new Set([
    'php',
    'node',
    'npm',
    'npx',
    'pnpm',
    'yarn',
    'bun',
    'deno',
    'composer',
    'git',
    'python',
    'python3',
    'ruby',
    'go',
    'cargo',
    'dotnet',
    'java',
]);

/** Executable extensions dropped when reading a binary's bare name. */
const EXE_EXT = /\.(exe|bat|cmd|com|ps1)$/i;

/** An absolute path in EITHER OS's notation (`C:\…`, `\\unc`, `/abs`, `\abs`) —
 *  the config may have been written on a different platform than it's read on. */
function isAbsolutePathToken(token: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(token) || /^[\\/]/.test(token);
}

/**
 * Strip a machine-specific absolute toolchain path out of a stored command
 * (genie #199).
 *
 * A site's `command` is committed to `project.json` — the SHARED, cloned Aionima
 * envelope — so an absolute path like `C:\Users\x\.config\herd\bin\php84\php.exe`
 * (a workaround for Herd exposing `php` as an unspawnable `.bat` shim) is dead on
 * anyone else's machine. When argv[0] is an ABSOLUTE path to a KNOWN toolchain
 * binary, rewrite it to the bare name the spawn layer already resolves on PATH.
 *
 * Left ALONE: a bare name (`php`) and a repo-relative script (`./vendor/bin/pest`)
 * are already portable; an absolute path to an UNKNOWN binary stays, because
 * baring it could point at nothing on PATH — a visible wrong path beats a silent
 * break. Same class of fix as stripping env at the write boundary (#168).
 */
export function portableArgv(argv: string[]): string[] {
    if (argv.length === 0) return argv;
    const first = argv[0];
    if (!isAbsolutePathToken(first)) return argv;
    const bare = (first.split(/[\\/]/).pop() ?? first).replace(EXE_EXT, '').toLowerCase();
    if (!PORTABLE_TOOLCHAIN_BINS.has(bare)) return argv;
    return [bare, ...argv.slice(1)];
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
/** A serve root is a repo-RELATIVE directory. Reject anything that climbs out of
 *  the repo or carries shell/quote metacharacters — it becomes a docroot Genie's
 *  Caddy serves, so it must stay inside the repo Genie mounted. */
function cleanServeRoot(root: unknown): string | null {
    if (typeof root !== 'string') return null;
    const r = root.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!r || r.startsWith('/') || !/^[A-Za-z0-9._\-/]+$/.test(r)) return null;
    if (r.split('/').some((seg) => seg === '' || seg === '..')) return null;
    return r;
}

/**
 * An ENGINE VERSION a site pins: `8.3`, `8.3.33`, `24`. Dotted numbers only.
 *
 * It is matched against the versions the toolchain scan found, so an unknown
 * string can never become a path — but a value that is not a version is not a pin
 * either, and storing one would produce a start that fails on a typo nobody can
 * see in the config. Anything else is DROPPED, which leaves the site following
 * the machine default: the state it was in before the bad value.
 */
const ENGINE_VERSION = /^\d+(?:\.\d+){0,2}$/;

function cleanEngineVersion(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t && ENGINE_VERSION.test(t) ? t : null;
}

/** Validate a {@link HostServeConfig}: a known mode + an in-repo root (+ for php,
 *  an optional pinned engine version). */
function cleanHostServe(hs: unknown): HostServeConfig | null {
    if (!hs || typeof hs !== 'object') return null;
    const candidate = hs as HostServeConfig;
    const root = cleanServeRoot(candidate.root);
    if (!root) return null;
    if (candidate.mode === 'static') {
        return { mode: 'static', root, ...(candidate.spa ? { spa: true } : {}) };
    }
    if (candidate.mode === 'php') {
        const version = cleanEngineVersion(candidate.version);
        return { mode: 'php', root, ...(version ? { version } : {}) };
    }
    return null;
}

/**
 * Strip `env` from EVERY site (genie #168) — the single authoritative transform
 * the persistence layer applies before writing `project.json`. {@link
 * sanitizeDevSitePatch} already drops env from a fresh patch, but a write merges
 * the patch OVER the stored row, and a stored row from before this fix (or a patch
 * that did not touch env) still carries an env the merge would keep. Applying this
 * at the write boundary guarantees the tracked manifest never holds a secret,
 * scrubbing an existing leak on the next write. Env lives in the repo `.env`.
 */
export function withoutPersistedEnv(sites: DevSites): DevSites {
    const out: DevSites = {};
    for (const [id, site] of Object.entries(sites)) {
        const copy = { ...site };
        delete copy.env;
        out[id] = copy;
    }
    return out;
}

/**
 * PURE. What a patch would LOSE to the sanitiser, and why.
 *
 * `sanitizeDevSitePatch` builds its result by copying only values that pass a
 * check, so a value that fails is never assigned — and the caller gets a site
 * with that field simply absent, no error, nothing to read. A `repo` of
 * `"repos/thing"` mints a site with NO repo, silently.
 *
 * THE RULES ARE CORRECT AND ARE NOT RELAXED HERE. A repo name becomes a path
 * segment inside the workspace mount, so a separator or `..` climbs out of it;
 * a `genName` that is not a `*.gen` label would mint a certificate for a name
 * the browser session must not trust. Those refusals should happen — only the
 * silence is the defect.
 *
 * Reported rather than thrown, and separate from the sanitiser rather than
 * folded into it: several callers depend on that function's return type, and a
 * refusal is not always fatal to the wider operation. The caller decides what to
 * do; this only makes sure it CAN.
 *
 * Each message names the field, the offending value, and the REASON — a caller
 * told only "invalid" tries a different spelling of the same illegal thing.
 */
export function describeDroppedSiteFields(
    patch: Partial<DevSiteConfig> | null | undefined,
): string[] {
    const dropped: string[] = [];
    if (!patch || typeof patch !== 'object') return dropped;

    if (typeof patch.repo === 'string') {
        const repo = patch.repo.trim().replace(/^\.\//, '');
        // '' is how a caller says "the workspace root" and the sanitiser accepts
        // it, so it is a legitimate value rather than a refusal.
        const ok = repo === '' || (/^[A-Za-z0-9._-]+$/.test(repo) && repo !== '.' && repo !== '..');
        if (!ok) {
            dropped.push(
                `\`repo\` "${patch.repo}" was ignored: it becomes a path segment INSIDE the workspace mount, so it must be a plain folder name — no separators and no "..", which would climb out of the workspace. Use the folder's own name, or "" for the workspace root.`,
            );
        }
    }

    if (typeof patch.genName === 'string') {
        const genName = patch.genName.trim().toLowerCase();
        const labels = genName.split('.');
        const ok =
            labels.length >= 2 && labels.at(-1) === 'gen' && labels.every((l) => DNS_LABEL.test(l));
        if (!ok) {
            dropped.push(
                `\`genName\` "${patch.genName}" was ignored: it must be a dotted DNS name ending in \`.gen\`. The browser session trusts \`*.gen\` and nothing else, so another name would resolve nowhere and mint a certificate for a name it must not.`,
            );
        }
    }

    return dropped;
}

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

    // portableArgv strips a machine-specific absolute toolchain path (e.g. Herd's
    // php.exe) out of every stored command — project.json is the cloned envelope
    // (genie #199), same reason env is stripped here (#168).
    const command = cleanArgv(patch.command);
    if (command) out.command = portableArgv(command);

    const serve = cleanArgv(patch.serve);
    if (serve) out.serve = portableArgv(serve);

    if (Array.isArray(patch.build)) {
        const build: BuildStep[] = [];
        for (const step of patch.build) {
            if (!step || typeof step !== 'object') continue;
            const cleaned = cleanArgv((step as BuildStep).command);
            if (!cleaned) continue;
            const command = portableArgv(cleaned);
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

    if (typeof patch.hostPort === 'number' && Number.isInteger(patch.hostPort)) {
        if (patch.hostPort >= 1 && patch.hostPort <= 65535) out.hostPort = patch.hostPort;
    }

    // Site `env` is DELIBERATELY NOT persisted (genie #168). project.json is a
    // TRACKED, committed + pushed manifest, so a secret in `sites.<id>.env` (e.g.
    // Laravel's APP_KEY) leaks. The manifest carries STACK META only — the recipe
    // a teammate needs to set the same site up — while env (secret and per-dev)
    // lives in the repo's `.env`, which the app reads and Genie writes there via
    // the create/update path. `env` is dropped here, so an existing entry that
    // still holds it is scrubbed on the next site write.

    if (patch.kind === 'http' || patch.kind === 'tcp') out.kind = patch.kind;

    if (isDevFramework(patch.framework)) out.framework = patch.framework;

    if (typeof patch.upstreamHost === 'string') {
        const host = patch.upstreamHost.trim().toLowerCase();
        if (host && host.length <= 253 && host.split('.').every((l) => DNS_LABEL.test(l))) {
            out.upstreamHost = host;
        }
    }

    // Serve mode (genie #167/#171). PRESENCE decides, not validity: a patch that
    // MENTIONS hostServe is setting it (Edit picker / agent), so the key is always
    // emitted — a valid static|php config is stored, anything else (an explicit
    // clear, or junk) drops to `undefined`. Because the write merges the patch OVER
    // the stored row, that present-but-undefined key is what switches a site back to
    // its OWN dev server; a MISSING key (a cosmetic edit) leaves the serve mode as-is.
    if ('hostServe' in patch) out.hostServe = cleanHostServe(patch.hostServe) ?? undefined;

    if (typeof patch.enabled === 'boolean') out.enabled = patch.enabled;

    // Opt-in external-browser exposure (#238). A boolean only — never coerced;
    // deliberately NOT a RECONFIGURE key, since it changes the host reconcile,
    // not the running dev server.
    if (typeof patch.browserExposed === 'boolean') out.browserExposed = patch.browserExposed;

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
    'hostPort',
    'exposed',
    'kind',
    'framework',
    'upstreamHost',
    'hostServe',
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
 * Which LANGUAGE a site consumes, and whether it PINS a version — the input to
 * the Toolchain page's "used by" line and to the sentence a default change shows
 * ("these sites follow the default and change on their next start").
 *
 * The SERVE MODE outranks `stack`: a site Genie serves as php runs php, whatever
 * the detector guessed the repo is. A site that pins a version is reported with
 * it, because it is exactly the site a default change does NOT move — counting it
 * would make that sentence a lie (genie#207).
 *
 * `null` for a site that runs no managed engine (a static folder, a proxy to
 * something with no detected stack) — those are not moved by a default at all.
 */
export function siteEngineUse(site: {
    genName: string;
    stack?: string;
    hostServe?: HostServeConfig;
}): { genName: string; tool: LanguageTool; version?: string } | null {
    if (site.hostServe) {
        if (site.hostServe.mode !== 'php') return null;
        return {
            genName: site.genName,
            tool: 'php',
            ...(site.hostServe.version ? { version: site.hostServe.version } : {}),
        };
    }
    return isLanguageTool(site.stack) ? { genName: site.genName, tool: site.stack } : null;
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

/** The routing target of a HOST-NATIVE site (story #238) — one that points
 *  `<genName>` straight at a dev server already running as a HOST process on
 *  `127.0.0.1:<hostPort>`, with NO container. Null for an ordinary container site
 *  (or a non-http one). When non-null the site manager registers this route and
 *  spawns nothing; the dev server speaks plain http and the Testing Browser's
 *  session-CA shim terminates TLS at `.gen`. */
export interface HostNativeRoute {
    genName: string;
    scheme: 'http';
    loopback: '127.0.0.1';
    port: number;
    upstreamHost?: string;
}

export function hostNativeRoute(config: DevSiteConfig): HostNativeRoute | null {
    if (typeof config.hostPort !== 'number' || config.kind !== 'http') return null;
    return {
        genName: config.genName,
        scheme: 'http',
        loopback: '127.0.0.1',
        port: config.hostPort,
        ...(config.upstreamHost ? { upstreamHost: config.upstreamHost } : {}),
    };
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
    const has = (t: string) => argv.some((a) => a.toLowerCase().includes(t));
    const port = sitePortOf(config);

    // The LEGACY auto-generated FrankenPHP recipe was `frankenphp php-server …`;
    // `php artisan serve` is the sandbox-native dev equivalent (it serves public/
    // and rebuilds on request). Match that SHAPE — both tokens — not any argv that
    // merely mentions frankenphp: a real `frankenphp run --config Caddyfile` is the
    // user's own command (e.g. to serve a custom Caddyfile) and must NOT be silently
    // rewritten to artisan serve — it passes through so the real limitation
    // (frankenphp is not in the sandbox) surfaces instead of being masked. (genie#141)
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
    return parseDevSitesValue(parsed) ?? {};
}

/**
 * PURE. Normalize an ALREADY-DECODED `sites` map — the shape that arrives from
 * outside our own blob, i.e. the `.agi` envelope's project.json.
 *
 * Two things that file is, and genie.db is not: it is UNTRUSTED (git-tracked, so
 * it arrives from a clone, a merge, another machine, an agent's hand edit) and it
 * is AUTHORITATIVE (`hosting-config.ts` mirrors it over genie.db). Read raw it was
 * both a way for unsanitized values to reach a spawn and a certificate, and a way
 * for one unreadable file to erase a workspace's registrations while its dev
 * servers kept running (genie#190).
 *
 * Hence three answers, not two:
 *   - `null` — this is not a sites map at all (absent, a string, an array). The
 *     caller must treat it as "the envelope does not say", NEVER as "no sites".
 *   - `{}` — an explicitly empty map. It DOES mean no sites: the user removed
 *     their last one, and that has to propagate.
 *   - a map — every row through the same sanitizer a write goes through, so an
 *     unusable row is dropped rather than trusted.
 */
export function parseDevSitesValue(value: unknown): DevSites | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const out: DevSites = {};
    for (const [id, row] of Object.entries(value as Record<string, unknown>)) {
        const clean = sanitizeDevSitePatch(row as DevSiteConfig);
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
