/**
 * PURE. The HOST-HEADER allowlist — the sharp edge the `.gen` routing leaves.
 *
 * A hosted site is served at `https://web.acme.gen`, so the carrier sends
 * `Host: web.acme.gen` upstream. Some frameworks check that header against a
 * list they cannot possibly know about and answer a "Blocked request" page.
 * Everything Genie measures says the site is healthy — the container is up, the
 * port is bound, the readiness probe got an HTTP response — and the user sees a
 * wall of text. It is the single worst failure mode the routing design has,
 * because nothing in it looks like a failure.
 *
 * ## Production serving changes the answer, and mostly for the better
 *
 * Most host allowlists are DEV-SERVER features. Vite's `server.allowedHosts`,
 * Next's `allowedDevOrigins` and Django's DEBUG-mode default all exist to
 * protect a development server on a laptop — and the Hosting Manager runs none
 * of those, because it builds the app and runs the production server instead. A
 * built front end is nginx over static files; a Next app is `next start`; a
 * Laravel app is FrankenPHP.
 *
 * The one that SURVIVES the switch is Django's, and it gets stricter rather than
 * looser: `ALLOWED_HOSTS` is enforced by a middleware, not by `runserver`, and
 * with `DEBUG=False` it has no permissive default at all. So Django is still
 * `documented`, and everything else is now genuinely not blocked.
 *
 * ## Why not just rewrite the Host
 *
 * `upstreamHost` sends `Host: localhost` instead. It works, and it costs the app
 * its real origin: absolute URLs, cookie domains, CSRF origin checks and signed
 * routes all start pointing at `localhost` while the browser is at `.gen`. That
 * is a fine escape hatch and a bad default. So the approach here is to keep the
 * real Host and make the FRAMEWORK accept it.
 *
 * ## The `status` field is the honest part
 *
 * - `solved` — Genie sets something the framework DEFINITELY reads. Verified
 *   against the installed package, not assumed from documentation.
 * - `documented` — it does not, and `note` says exactly what the user must
 *   change, with `upstreamHostFallback` as the one-field way out.
 * - `not-needed` — this stack has no Host allowlist; nothing was blocking.
 *
 * Reporting a `documented` case as `solved` is how somebody spends an hour
 * fighting a wall they were told had been removed.
 *
 * ## Per framework, as of this commit
 *
 * | Framework | Status | Why |
 * |---|---|---|
 * | **Django** (gunicorn) | `documented` | `ALLOWED_HOSTS` is a settings value enforced by `CommonMiddleware`, and Django reads NO environment variable for it. Under `DEBUG=False` — which is what a production serve implies — an unlisted host is a hard 400. `DJANGO_ALLOWED_HOSTS` is injected because it is the near-universal convention (cookiecutter-django, Django's own Docker guide), but a settings.py that does not read it is unaffected, so this cannot be called solved. |
 * | **Laravel** (FrankenPHP) | `not-needed` | Laravel's `TrustHosts` middleware is opt-in and off in a fresh app, and FrankenPHP checks nothing. Nothing is blocked — but `APP_URL` is injected, because otherwise `asset()`, `url()` and signed routes are built from the wrong origin while the browser is at `.gen`, which breaks assets and signature validation. |
 * | **Next.js** (`next start`) | `not-needed` | `allowedDevOrigins` is a DEV-server setting; the production server does not check the Host. This was `documented` while Genie ran `next dev`, and building the app is what removed it. |
 * | **Vite** | `solved` | Only reachable now for an `explicit` site someone pointed at a dev server themselves — a recipe-built front end is nginx over `dist/`. Kept because that escape hatch still exists: Vite reads `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` and appends it to `server.allowedHosts` when that is an array (the default). |
 * | nginx, uvicorn/FastAPI, Go, Rust | `not-needed` | None check the Host header by default. Starlette's `TrustedHostMiddleware` is opt-in. |
 *
 * Rails is deliberately absent: Genie does not detect it yet (`serve-recipe.ts`
 * has no Ruby detector), and `config.hosts` would need an initializer edit
 * rather than an env var. Adding it here without detection would be a claim
 * about a stack Genie cannot host.
 */

/** A framework that has an opinion about the Host header, or `none`. */
export type DevFramework = 'vite' | 'next' | 'django' | 'laravel' | 'none';

export const DEV_FRAMEWORKS: readonly DevFramework[] = [
    'vite',
    'next',
    'django',
    'laravel',
    'none',
];

export function isDevFramework(value: unknown): value is DevFramework {
    return typeof value === 'string' && (DEV_FRAMEWORKS as readonly string[]).includes(value);
}

// --- detection --------------------------------------------------------------

export interface FrameworkInput {
    /** What detection recorded when the site was created. Authoritative. */
    framework?: string;
    /** The literal argv the site runs. */
    command?: readonly string[];
}

/**
 * Which framework this site runs.
 *
 * The STORED value wins, and has to exist, because the argv often cannot say:
 * `npm run dev -- --host 0.0.0.0` contains no token spelling "vite". Detection
 * knew — it read the script body to decide those flags were safe to append — so
 * `site-def.ts` records what it knew.
 *
 * The argv scan is the fallback for an `explicit` site, where the user typed the
 * command and nothing detected anything.
 */
export function detectFramework(input: FrameworkInput): DevFramework {
    if (isDevFramework(input.framework) && input.framework !== 'none') return input.framework;

    const argv = (input.command ?? []).map((t) => String(t).toLowerCase());
    const has = (token: string) => argv.some((t) => t === token || t.endsWith(`/${token}`));
    if (has('vite')) return 'vite';
    if (has('next')) return 'next';
    if (has('manage.py')) return 'django';
    if (has('artisan')) return 'laravel';
    return 'none';
}

// --- the plan ---------------------------------------------------------------

export interface HostAllowlistPlan {
    framework: DevFramework;
    /** Env merged UNDER the site's own `env`, so a pinned value always wins. */
    env: Record<string, string>;
    status: 'solved' | 'documented' | 'not-needed';
    /** One sentence: what was done, or what the user has to change. */
    note: string;
    /** Set on `documented`: the one-field escape, via `upstreamHost`. */
    upstreamHostFallback?: string;
}

export interface HostAllowlistInput {
    /** The browser-facing name — what upstream will receive as `Host`. */
    genName: string;
    framework?: string;
    command?: readonly string[];
    /** Already set by the user. When present, nothing is planned. */
    upstreamHost?: string;
}

export function planHostAllowlist(input: HostAllowlistInput): HostAllowlistPlan {
    const framework = detectFramework(input);

    // The user took the manual escape, so a different Host is being sent.
    // Injecting an allowlist for a name nobody will see is dead config, and an
    // APP_URL naming an origin the app is not addressed as is actively wrong.
    if (input.upstreamHost) {
        return {
            framework,
            env: {},
            status: 'not-needed',
            note: `This site overrides the upstream Host with "${input.upstreamHost}", so Genie adds no allow-host configuration.`,
        };
    }

    const host = input.genName;
    switch (framework) {
        case 'vite':
            return {
                framework,
                // Verified against the installed Vite: it appends this to
                // `server.allowedHosts` when that is an array (the default).
                env: { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: host },
                status: 'solved',
                note: `Vite is told to allow ${host} (it appends __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS to server.allowedHosts). Nothing to change in the repo.`,
            };

        case 'laravel':
            return {
                framework,
                // Not an allowlist fix — `artisan serve` blocks nothing. This is
                // the correctness fix that keeps generated URLs on the origin
                // the browser is actually at.
                env: { APP_URL: `https://${host}`, ASSET_URL: `https://${host}` },
                status: 'not-needed',
                note: `Laravel's dev server does not check the Host header, so nothing is blocked. APP_URL and ASSET_URL are set to https://${host} so asset(), url() and signed routes match the address the browser is using.`,
            };

        case 'django':
            return {
                framework,
                // The convention, not a Django feature. See the header table.
                env: { DJANGO_ALLOWED_HOSTS: host },
                status: 'documented',
                note: `Django checks ALLOWED_HOSTS in a middleware, and reads no environment variable for it. Served in production (DEBUG=False) an unlisted host is a hard 400. Genie sets DJANGO_ALLOWED_HOSTS=${host}, which works if your settings.py reads it (the cookiecutter/Docker convention); otherwise add "${host}" to ALLOWED_HOSTS yourself.`,
                upstreamHostFallback: 'localhost',
            };

        case 'next':
            return {
                framework,
                // `allowedDevOrigins` is a DEV-server setting. Genie builds the
                // app and runs `next start`, which checks nothing — so the
                // warning this used to carry would now be untrue.
                env: {},
                status: 'not-needed',
                note: `Next is BUILT and served by \`next start\`, which does not check the Host header — allowedDevOrigins is a dev-server setting and does not apply here.`,
            };

        default:
            return {
                framework: 'none',
                env: {},
                status: 'not-needed',
                note: 'This stack does not check the Host header, so it serves the .gen name as-is.',
            };
    }
}
