/**
 * PURE. The HOST-HEADER allowlist (Tynn #234 P4 item E) — the sharp edge P2 and
 * P3 left behind.
 *
 * A dev site is served at `https://web.acme.gen`, so the carrier sends
 * `Host: web.acme.gen` upstream. Several frameworks check that header against a
 * list they cannot possibly know about and answer a "Blocked request" page.
 * Everything Genie measures says the site is healthy — the container is up, the
 * port is bound, the readiness probe got an HTTP response — and the user sees a
 * wall of text about `server.allowedHosts`. It is the single worst failure mode
 * the routing design has, because nothing in it looks like a failure.
 *
 * ## Why not just rewrite the Host
 *
 * P2 shipped `upstreamHost`, which sends `Host: localhost` instead. It works,
 * and it costs the app its real origin: absolute URLs, cookie domains, CSRF
 * origin checks and signed routes all start pointing at `localhost` while the
 * browser is at `.gen`. That is a fine escape hatch and a bad default. So the
 * approach here is to keep the real Host and make the FRAMEWORK accept it.
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
 * | **Vite** | `solved` | Vite reads `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` and appends it to `server.allowedHosts` — the escape hatch it added for hosting providers when `allowedHosts` became a default-deny in 5.4.12 / 6.0.9. Verified in vite 7.3.6's `config.js`. It appends only when `allowedHosts` is an ARRAY, which is the default (`[]`); a project that set `allowedHosts: true` already allows everything. |
 * | **Laravel** (`artisan serve`) | `not-needed` | The PHP built-in server has no Host allowlist, and Laravel's `TrustHosts` middleware is opt-in and off in a fresh app. Nothing is blocked — but `APP_URL` is injected, because otherwise `asset()`, `url()` and signed routes are built from `127.0.0.1` while the browser is at `.gen`, which breaks assets and signature validation. |
 * | **Django** (`manage.py runserver`) | `documented` | `ALLOWED_HOSTS` is a settings value; Django reads NO environment variable for it. With `DEBUG=True` it permits only `localhost`, `127.0.0.1` and `[::1]`. `DJANGO_ALLOWED_HOSTS` is injected because it is the near-universal convention (cookiecutter-django, Django's own Docker guide) — but a settings.py that does not read it is unaffected, so this cannot be called solved. |
 * | **Next.js** | `documented` | `allowedDevOrigins` (15.2+) is `next.config` only, and there is no environment override. The dev server warns rather than blocking in most versions, so this is usually cosmetic. |
 * | uvicorn / FastAPI, PHP built-in, Go, Rust | `not-needed` | None check the Host header by default. Starlette's `TrustedHostMiddleware` is opt-in. |
 *
 * Rails is deliberately absent: Genie does not detect it yet (`site-def.ts` has
 * no Ruby detector), and `config.hosts` would need an initializer edit rather
 * than an env var. Adding it here without detection would be a claim about a
 * stack Genie cannot run.
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
                note: `Django checks ALLOWED_HOSTS, and reads no environment variable for it — with DEBUG=True it permits only localhost. Genie sets DJANGO_ALLOWED_HOSTS=${host}, which works if your settings.py reads it (the cookiecutter/Docker convention); otherwise add "${host}" to ALLOWED_HOSTS yourself.`,
                upstreamHostFallback: 'localhost',
            };

        case 'next':
            return {
                framework,
                env: {},
                status: 'documented',
                note: `Next reads allowedDevOrigins from next.config only, with no environment override — add "${host}" there if the dev server complains about the cross-origin request.`,
                upstreamHostFallback: 'localhost',
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
