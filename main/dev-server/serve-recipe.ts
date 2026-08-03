import type { DevFramework } from './host-allowlist';

/**
 * PURE. How a repo is BUILT and SERVED IN PRODUCTION — the Hosting Manager's
 * site model.
 *
 * ## The correction this file exists to make
 *
 * Genie's hosting is not a dev-server launcher. The predecessor of this module
 * proposed `npm run dev`, `php artisan serve`, `manage.py runserver`, `go run .`
 * — a bespoke development setup that behaves differently from the thing the user
 * actually ships. A Hosting Manager does the opposite: it **builds the artifact**
 * and then **runs the production server**, backed by the same services production
 * uses, so a preview that works is evidence that production will.
 *
 * That single change ripples through everything here. A site is no longer "a
 * command and a port"; it is a **{@link BuildStep} list plus a serve argv plus a
 * port**, and the build and the serve happen in different places — the build
 * `exec`s into the workspace's long-lived sandbox container where the toolchain
 * lives, and the serve runs in the site's own container, which may not even be
 * the same image (FrankenPHP and nginx are not in the dev base image, and should
 * not be — they are production servers, not toolchains).
 *
 * ## Where a build artifact goes
 *
 * {@link GENIE_BUILD_DIR}, relative to the repo. It has to be a path, not a
 * container-local scratch dir, because the builder and the server are different
 * containers and the ONLY thing they share is the workspace bind mount. Relative
 * rather than absolute so the same recipe works at the workspace root and inside
 * `repos/<name>`, and so nothing here has to know the mount target.
 *
 * Stacks with a production build directory of their own keep it — Next writes
 * `.next`, Nuxt writes `.output`, Vite writes `dist`. Only the stacks with no
 * convention (Go's binary, Rust's target dir, Python's venv) are redirected
 * here, so one obviously-Genie directory appears instead of scattered artifacts.
 *
 * ## Every option still says how much of it is a GUESS
 *
 * `confident` and `needs` carry more weight than they did, because a production
 * recipe has more to get wrong: a docroot, a WSGI module path, a crate's binary
 * name, the port a compiled binary happens to bind. `confident: false` always
 * comes with a `needs` sentence naming what the caller must supply, and
 * `serve: undefined` means this option cannot serve at all until it is given one.
 *
 * ## What is NOT here
 *
 * A fallback to a dev command. Not for a Node repo with no build script, not for
 * anything. Offering `npm run dev` when the production recipe cannot be derived
 * is precisely the failure this model was written to remove — it would look like
 * it worked, and it would be hosting the wrong thing.
 *
 * No filesystem access — {@link RepoFacts} is the input, and `repo-facts.ts` is
 * the one place that reads a disk.
 */

// --- the facts we resolve from ---------------------------------------------

export interface PackageJsonFacts {
    name?: string;
    scripts?: Record<string, string>;
}

/** A repo root, reduced to exactly what resolution reads. */
export interface RepoFacts {
    /** Entry names at the repo root (files AND directories), case preserved. */
    entries: string[];
    /** Parsed `package.json`, or null when there is none / it is unreadable. */
    packageJson?: PackageJsonFacts | null;
    /**
     * The package directory holding Django's `wsgi.py` (`mysite` for
     * `mysite/wsgi.py`).
     *
     * Read from disk rather than guessed from the repo name: a Django project
     * directory is conventionally named after the project but very often is
     * not, and `gunicorn wrongname.wsgi:application` fails with an import error
     * that reads like the app is broken.
     */
    pythonPackage?: string;
    /** `[package] name` from Cargo.toml — the binary `cargo build` produces. */
    crateName?: string;
}

// --- the model -------------------------------------------------------------

/**
 * What kind of thing is being hosted.
 *
 * `static` is deliberately its own stack rather than a flavour of `node`: a
 * built SPA has NO server process of its own in production. It is a directory of
 * files behind nginx, and modelling it as "node, but different" is how a build
 * output ends up being served by a JavaScript process that has no business
 * existing in production.
 */
export type HostingStack = 'php' | 'node' | 'static' | 'python' | 'go' | 'rust';

/** The production server that ends up holding the port. */
export type ProductionServer =
    /** FrankenPHP, in classic (non-worker) mode. */
    | 'frankenphp'
    /** The app's own built Node server — `next start`, Nitro, an express build. */
    | 'node'
    | 'nginx'
    | 'gunicorn'
    | 'uvicorn'
    /** A compiled executable that serves directly. */
    | 'binary';

/**
 * `recipe` replaces the old `detected` mode, and the rename is the point: what
 * is detected is the STACK, but what is applied is a production build + serve
 * recipe, and a caller storing `detected` would be recording only half of it.
 */
export type HostingRunMode = 'dockerfile' | 'devcontainer' | 'compose' | 'recipe' | 'explicit';

/** One step of the production build, run before the server starts. */
export interface BuildStep {
    /** A short human label — this is what a progress line and a log header say. */
    label: string;
    /** Literal argv (never a shell string), run in the site's workdir. */
    command: string[];
    /**
     * A non-zero exit is reported but does NOT fail the build.
     *
     * For steps that are correct to attempt and normal to fail: `collectstatic`
     * on a project with no `STATIC_ROOT`, an asset build in a repo whose
     * package.json is for tooling only. A required step that fails must stop the
     * site, or Genie would serve a stale or half-built artifact and call it
     * production.
     */
    optional?: boolean;
}

/** One way this repo could be built and served, as offered to an agent or human. */
export interface HostingOption {
    runMode: HostingRunMode;
    stack?: HostingStack;
    /** Which production server holds the port. Absent when the repo's own image
     *  carries its server (a Dockerfile). */
    server?: ProductionServer;
    /** The framework, when detection could tell — see `host-allowlist.ts`. */
    framework?: DevFramework;
    /** The repo entry that produced this option (`Dockerfile`, `go.mod`, …). */
    source: string;
    /** One sentence: what this builds and serves, and why it was offered. */
    reason: string;
    /** The image the SERVER runs in. Absent = the workspace dev image. */
    image?: string;
    /** The production build, in order. Empty when the repo builds itself. */
    build: BuildStep[];
    /** The production server's literal argv. Absent = cannot serve as-is. */
    serve?: string[];
    /** The port the production server listens on INSIDE the container. */
    port?: number;
    /** Environment the server needs — a bind address a flag cannot express, a
     *  docroot for the nginx template. Merged UNDER the site's own `env`. */
    env?: Record<string, string>;
    /** True only when nothing load-bearing here was guessed. */
    confident: boolean;
    /** Set whenever `confident` is false: what the caller must supply or check. */
    needs?: string;
}

/**
 * Where Genie's own build artifacts go, relative to the repo.
 *
 * One directory, obviously Genie's, and inside the repo rather than beside it so
 * that a `.gitignore` entry is the single thing a user has to add. See the file
 * header for why it cannot be container-local scratch space.
 */
export const GENIE_BUILD_DIR = '.genie-build';

/**
 * The port each stack's production server listens on.
 *
 * A DEFAULT, never a detection — which is why a stack whose port cannot be read
 * from the repo (Go, Rust) reports `confident: false` even though the number
 * below is usually right.
 */
export const DEFAULT_STACK_PORTS: Readonly<Record<HostingStack, number>> = {
    php: 8080,
    node: 3000,
    static: 8080,
    python: 8000,
    go: 8080,
    rust: 8080,
};

// --- layer 1: the repo's own container config ------------------------------

const COMPOSE_FILES = [
    'compose.yaml',
    'compose.yml',
    'docker-compose.yaml',
    'docker-compose.yml',
];

function containerConfigOptions(entries: Set<string>): HostingOption[] {
    const options: HostingOption[] = [];

    if (entries.has('Dockerfile')) {
        options.push({
            runMode: 'dockerfile',
            source: 'Dockerfile',
            reason: 'This repo ships a Dockerfile — it already says how it is built and run in production, so Genie builds that and serves the result.',
            // No build steps and no serve argv: the Dockerfile IS the build, and
            // the image it produces carries its own CMD/ENTRYPOINT. Bolting
            // Genie's guesses on top of an explicit answer is how a tool loses a
            // user's trust.
            build: [],
            confident: false,
            needs: 'the port the built image listens on (a Dockerfile EXPOSE is not read yet)',
        });
    }

    if (entries.has('.devcontainer') || entries.has('devcontainer.json')) {
        options.push({
            runMode: 'devcontainer',
            source: entries.has('.devcontainer') ? '.devcontainer' : 'devcontainer.json',
            reason: 'This repo ships a devcontainer definition.',
            build: [],
            confident: false,
            needs: 'a devcontainer image + command — devcontainer.json is not parsed yet',
        });
    }

    const compose = COMPOSE_FILES.find((f) => entries.has(f));
    if (compose) {
        options.push({
            runMode: 'compose',
            source: compose,
            reason: `This repo ships ${compose}.`,
            build: [],
            // Said up front rather than discovered on start: reporting an option
            // and then failing to run it is worse than not offering it.
            confident: false,
            needs: 'compose orchestration, which Genie does not run yet — pick another option',
        });
    }

    return options;
}

// --- the production server images ------------------------------------------

/**
 * FrankenPHP, pinned to the dev base image's PHP major so a site does not build
 * against 8.4 and then run on something else.
 *
 * A separate image, and deliberately so: a production PHP server does not belong
 * in a toolchain image, and the alternative — nginx + php-fpm — is two processes
 * and a supervisor in a container that is meant to have one. FrankenPHP is a
 * single binary that serves the front controller correctly out of the box.
 */
export const FRANKENPHP_IMAGE = 'dunglas/frankenphp:1-php8.4';

/** nginx for built static output. Alpine because it serves files and nothing else. */
export const NGINX_IMAGE = 'nginx:1.29-alpine';

/**
 * The nginx site config, written at container start from the environment.
 *
 * Templated through env rather than a file, because a config file would have to
 * be written INTO the user's repo (visible, committed by accident, and stale the
 * moment a port changes). `$PWD` is the container workdir the site manager sets,
 * so `root` stays relative to the repo and this string never has to know the
 * mount target.
 *
 * `try_files … /index.html` is the SPA fallback: a client-routed app must answer
 * its own deep links rather than 404. A pure static site is unaffected — the
 * fallback only fires where a file genuinely does not exist.
 */
export const NGINX_BOOTSTRAP: readonly string[] = [
    'sh',
    '-c',
    'set -e; ' +
        'printf "server { listen %s default_server; server_name _; root %s/%s; index index.html; location / { try_files \\$uri \\$uri/ /index.html; } }" ' +
        '"$GENIE_NGINX_PORT" "$PWD" "$GENIE_NGINX_ROOT" > /etc/nginx/conf.d/default.conf; ' +
        'exec nginx -g "daemon off;"',
];

// --- layer 2: detect the stack, apply the recipe ---------------------------

interface Detector {
    stack: HostingStack;
    /** Any one of these at the repo root selects this stack. */
    markers: readonly string[];
    propose(
        entries: Set<string>,
        facts: RepoFacts,
        port: number,
    ): Omit<HostingOption, 'runMode' | 'source'>;
}

/** `npm ci` when there is a lockfile to honour, `npm install` when there is not. */
function npmInstall(entries: Set<string>): BuildStep {
    const locked = entries.has('package-lock.json') || entries.has('npm-shrinkwrap.json');
    return {
        label: 'Install Node dependencies',
        // `npm ci` is the production install — it installs the lockfile exactly
        // and refuses to silently resolve a newer version. It also REQUIRES a
        // lockfile, so a repo without one gets `install` rather than a hard fail.
        command: locked ? ['npm', 'ci'] : ['npm', 'install'],
    };
}

/** Which built directory a front-end build produces, when we can tell. */
function staticRoot(entries: Set<string>, scripts: Record<string, string>): string {
    const build = scripts.build ?? '';
    // Order matters: a repo can contain a stale `build/` from another tool.
    if (/\bvite\b/.test(build)) return 'dist';
    if (/react-scripts\b/.test(build)) return 'build';
    if (entries.has('dist')) return 'dist';
    if (entries.has('build')) return 'build';
    return 'dist';
}

function nodeRecipe(
    entries: Set<string>,
    facts: RepoFacts,
    port: number,
): Omit<HostingOption, 'runMode' | 'source'> {
    const scripts = facts.packageJson?.scripts ?? {};
    const build = scripts.build ?? '';
    const start = scripts.start ?? '';
    const install = npmInstall(entries);

    if (!scripts.build) {
        return {
            stack: 'node',
            build: [],
            confident: false,
            // No dev-command fallback. See the file header — offering one here
            // is the exact mistake the production model exists to remove.
            needs: 'a production build — this package.json has no `build` script, so there is no artifact to host. Add one, or supply an explicit `build` + `serve`.',
            reason: 'A Node repo with no build script; production hosting needs something built.',
        };
    }

    const buildSteps: BuildStep[] = [install, { label: 'Build', command: ['npm', 'run', 'build'] }];

    // --- Next: `next start` serves the .next build ---------------------------
    if (/\bnext\b/.test(build)) {
        return {
            stack: 'node',
            server: 'node',
            framework: 'next',
            build: buildSteps,
            // Through `npm run start` rather than a bare `next start`, so a repo
            // that wraps its production start (a custom server, an env preload)
            // keeps its wrapper. `--` passes the flags on to next itself.
            serve: ['npm', 'run', 'start', '--', '--hostname', '0.0.0.0', '--port', String(port)],
            port,
            confident: Boolean(scripts.start),
            ...(scripts.start
                ? {}
                : {
                      needs: 'a `start` script — Next builds to .next, and `next start` is what serves it',
                  }),
            reason: '`next build` then `next start` — the production Next server over the built app.',
        };
    }

    // --- Nuxt: the built Nitro server ---------------------------------------
    if (/\bnuxt\b/.test(build) || entries.has('nuxt.config.ts') || entries.has('nuxt.config.js')) {
        return {
            stack: 'node',
            server: 'node',
            build: buildSteps,
            serve: ['node', '.output/server/index.mjs'],
            port,
            // Nitro reads its bind from the environment; there is no flag to pass.
            env: { HOST: '0.0.0.0', PORT: String(port) },
            confident: true,
            reason: '`nuxt build` then the built Nitro server in .output — how a Nuxt app runs in production.',
        };
    }

    // --- a repo with its own production start -------------------------------
    if (start && !/\b(vite|nuxt|next)\s+(dev|preview)\b/.test(start)) {
        return {
            stack: 'node',
            server: 'node',
            build: buildSteps,
            serve: ['npm', 'run', 'start'],
            port,
            env: { HOST: '0.0.0.0', PORT: String(port) },
            confident: false,
            needs: `confirmation that \`${start.trim()}\` serves the BUILD (not source) and binds 0.0.0.0:${port} — HOST and PORT are set in the environment, which most Node servers read`,
            reason: `\`npm run build\` then \`npm run start\` (${start.trim()}).`,
        };
    }

    // --- a built SPA / static site ------------------------------------------
    //
    // The most important case of the whole reframe. In production this is a
    // directory of files, so it is served by a real static server and no
    // JavaScript process exists at all.
    const root = staticRoot(entries, scripts);
    return {
        stack: 'static',
        server: 'nginx',
        image: NGINX_IMAGE,
        build: buildSteps,
        serve: [...NGINX_BOOTSTRAP],
        port,
        env: { GENIE_NGINX_ROOT: root, GENIE_NGINX_PORT: String(port) },
        confident: entries.has('index.html') || Boolean(scripts.build),
        ...(entries.has('index.html')
            ? {}
            : { needs: `confirmation that \`npm run build\` writes its output to ${root}/` }),
        reason: `\`npm run build\`, then nginx over ${root}/ — a built front end is static files in production, not a dev server.`,
    };
}

function phpRecipe(
    entries: Set<string>,
    facts: RepoFacts,
    port: number,
): Omit<HostingOption, 'runMode' | 'source'> {
    const laravel = entries.has('artisan');
    const hasPublic = entries.has('public');
    const build: BuildStep[] = [
        {
            label: 'Install PHP dependencies (production)',
            // The three flags that make this a PRODUCTION install rather than a
            // dev one: no dev requirements, a classmap autoloader, and no prompt
            // to hang on.
            command: [
                'composer',
                'install',
                '--no-dev',
                '--optimize-autoloader',
                '--no-interaction',
                '--prefer-dist',
            ],
        },
    ];

    // A PHP app's front end is almost always built by Node. Optional, because a
    // package.json can be tooling-only and a failed lint script must not stop
    // the site from being hosted.
    if (entries.has('package.json') && facts.packageJson?.scripts?.build) {
        build.push(npmInstall(entries), {
            label: 'Build front-end assets',
            command: ['npm', 'run', 'build'],
            optional: true,
        });
    }

    const docroot = hasPublic ? 'public/' : './';
    return {
        stack: 'php',
        server: 'frankenphp',
        ...(laravel ? { framework: 'laravel' as DevFramework } : {}),
        image: FRANKENPHP_IMAGE,
        build,
        // `php-server` is FrankenPHP's front-controller mode: static files are
        // served directly and everything else falls through to index.php, which
        // is exactly what every PHP framework's public/ expects.
        serve: ['frankenphp', 'php-server', '--listen', `0.0.0.0:${port}`, '--root', docroot],
        port,
        confident: hasPublic,
        ...(hasPublic
            ? {}
            : {
                  needs: 'the document root — this repo has no public/ directory, so FrankenPHP is pointed at the repo root, which would expose composer.json and .env',
              }),
        reason: laravel
            ? 'A Laravel app — a production composer install, then FrankenPHP over public/.'
            : 'A PHP app — a production composer install, then FrankenPHP over the document root.',
    };
}

/** The venv every Python recipe builds into, and the binaries it then runs. */
const VENV = `${GENIE_BUILD_DIR}/venv`;

function pythonInstall(entries: Set<string>): BuildStep[] {
    const steps: BuildStep[] = [
        {
            label: 'Create the virtualenv',
            // A venv rather than a system install: Debian's python3 is PEP 668
            // "externally managed", so a system-wide install either refuses or
            // has to be forced past a guard that exists for good reasons. The
            // venv also lands in the bind mount, which is what lets the BUILDER
            // container and the SERVER container share it.
            command: ['uv', 'venv', VENV],
        },
    ];
    const python = `${VENV}/bin/python`;
    if (entries.has('uv.lock')) {
        steps.push({
            label: 'Install locked dependencies',
            command: ['uv', 'sync', '--frozen', '--python', python],
        });
    } else if (entries.has('requirements.txt')) {
        steps.push({
            label: 'Install dependencies',
            command: ['uv', 'pip', 'install', '--python', python, '-r', 'requirements.txt'],
        });
    } else {
        steps.push({
            label: 'Install the project',
            command: ['uv', 'pip', 'install', '--python', python, '.'],
        });
    }
    return steps;
}

function pythonRecipe(
    entries: Set<string>,
    facts: RepoFacts,
    port: number,
): Omit<HostingOption, 'runMode' | 'source'> {
    const python = `${VENV}/bin/python`;
    const build = pythonInstall(entries);

    if (entries.has('manage.py')) {
        build.push({
            label: 'Install the production server',
            // gunicorn is virtually never in a Django project's requirements
            // (it is a deployment concern), so the recipe supplies it.
            command: ['uv', 'pip', 'install', '--python', python, 'gunicorn'],
        });
        build.push({
            label: 'Collect static files',
            command: [python, 'manage.py', 'collectstatic', '--noinput'],
            // Normal to fail: a project with no STATIC_ROOT has nothing to
            // collect, and that is not a reason to refuse to host it.
            optional: true,
        });

        const pkg = facts.pythonPackage;
        if (!pkg) {
            return {
                stack: 'python',
                server: 'gunicorn',
                framework: 'django' as DevFramework,
                build,
                confident: false,
                needs: 'the WSGI module — no `<package>/wsgi.py` was found, so gunicorn has nothing to import. Supply an explicit `serve`.',
                reason: 'A Django project whose settings package could not be located.',
            };
        }
        return {
            stack: 'python',
            server: 'gunicorn',
            framework: 'django' as DevFramework,
            build,
            serve: [`${VENV}/bin/gunicorn`, `${pkg}.wsgi:application`, '--bind', `0.0.0.0:${port}`],
            port,
            confident: true,
            reason: `A Django project — dependencies + collectstatic, then gunicorn over ${pkg}.wsgi. This is how Django runs in production; runserver is explicitly not.`,
        };
    }

    const module = entries.has('main.py') ? 'main' : entries.has('app.py') ? 'app' : null;
    if (module) {
        build.push({
            label: 'Install the production server',
            command: ['uv', 'pip', 'install', '--python', python, 'uvicorn'],
        });
        return {
            stack: 'python',
            server: 'uvicorn',
            build,
            serve: [
                `${VENV}/bin/uvicorn`,
                `${module}:app`,
                '--host',
                '0.0.0.0',
                '--port',
                String(port),
            ],
            port,
            confident: false,
            // `<module>:app` is the FastAPI/Starlette convention, not a fact
            // about this repo — the attribute may be called anything.
            needs: `confirmation that \`${module}.py\` exposes an ASGI app named \`app\``,
            reason: `An ASGI app guessed from ${module}.py, served by uvicorn.`,
        };
    }

    return {
        stack: 'python',
        build,
        confident: false,
        needs: 'a serve command — no manage.py, main.py or app.py to infer a production server from',
        reason: 'A Python repo with no recognisable entry point.',
    };
}

const DETECTORS: readonly Detector[] = [
    { stack: 'php', markers: ['composer.json'], propose: phpRecipe },
    { stack: 'node', markers: ['package.json'], propose: nodeRecipe },
    {
        stack: 'python',
        markers: ['pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py', 'manage.py'],
        propose: pythonRecipe,
    },
    {
        stack: 'go',
        markers: ['go.mod'],
        propose(_entries, _facts, port) {
            return {
                stack: 'go',
                server: 'binary',
                build: [
                    {
                        label: 'Compile',
                        // A compiled binary IS the production artifact. `go run`
                        // compiles to a temp dir and runs it under a parent
                        // process — convenient in development, and not what
                        // ships.
                        command: ['go', 'build', '-o', `${GENIE_BUILD_DIR}/server`, '.'],
                    },
                ],
                serve: [`${GENIE_BUILD_DIR}/server`],
                port,
                // Very widely honoured by Go HTTP servers, and harmless when it
                // is not — which is why it is set AND declared as a guess.
                env: { PORT: String(port) },
                confident: false,
                needs: `the port this program listens on (defaulted to ${port}, also passed as PORT) and that it binds 0.0.0.0`,
                reason: 'A Go module — `go build` produces the server, and the binary is what runs.',
            };
        },
    },
    {
        stack: 'rust',
        markers: ['Cargo.toml'],
        propose(_entries, facts, port) {
            const target = `${GENIE_BUILD_DIR}/target`;
            const build: BuildStep[] = [
                {
                    label: 'Compile (release)',
                    // `--release` is not optional for a production recipe: a
                    // debug build of a Rust service is often an order of
                    // magnitude slower, which would make the preview lie.
                    command: ['cargo', 'build', '--release', '--target-dir', target],
                },
            ];
            if (!facts.crateName) {
                return {
                    stack: 'rust',
                    server: 'binary',
                    build,
                    confident: false,
                    needs: 'the binary name — Cargo.toml did not yield a `[package] name`, so there is nothing to run after the build. Supply an explicit `serve`.',
                    reason: 'A Rust crate whose package name could not be read.',
                };
            }
            return {
                stack: 'rust',
                server: 'binary',
                build,
                serve: [`${target}/release/${facts.crateName}`],
                port,
                env: { PORT: String(port) },
                confident: false,
                needs: `the port this program listens on (defaulted to ${port}, also passed as PORT) and that it binds 0.0.0.0`,
                reason: `A Rust crate — \`cargo build --release\` produces ${facts.crateName}, and the binary is what runs.`,
            };
        },
    },
];

// --- the resolution --------------------------------------------------------

export interface DetectOptions {
    /** A declared port. Overrides every stack default, and is threaded into the
     *  generated commands so the two can never disagree. */
    port?: number;
}

/**
 * Every way this repo could be built and served in production, best-offer first.
 *
 * Container-config options lead (layer 1), then detected stacks — and within the
 * detected ones, a stack that can actually SERVE outranks one that only
 * recognised its marker, so a Laravel app with a `package.json` full of build
 * scripts leads with FrankenPHP rather than a Node option that has no server.
 * When nothing at all matches, a single `explicit` option is returned naming
 * what the caller must supply; the list is never empty, because "no options"
 * tells an agent nothing it can act on.
 */
export function detectHostingOptions(
    facts: RepoFacts,
    opts: DetectOptions = {},
): HostingOption[] {
    const entries = new Set(facts.entries ?? []);
    const options = containerConfigOptions(entries);

    const detected: HostingOption[] = [];
    for (const detector of DETECTORS) {
        const marker = detector.markers.find((m) => entries.has(m));
        if (!marker) continue;
        const proposal = detector.propose(
            entries,
            facts,
            opts.port ?? DEFAULT_STACK_PORTS[detector.stack],
        );
        // The proposal's own stack wins: a Vite app enters through the `node`
        // detector and comes out `static`, because that is what it IS in
        // production.
        detected.push({ runMode: 'recipe', source: marker, ...proposal });
    }
    detected.sort((a, b) => rank(a) - rank(b));
    options.push(...detected);

    if (options.length === 0) {
        options.push({
            runMode: 'explicit',
            source: '',
            reason: 'No Dockerfile and no recognisable stack markers in this repo.',
            build: [],
            confident: false,
            needs: 'an explicit `serve` command and `port` (and optionally `build` steps and an `image`) — nothing here says how this repo is built or served',
        });
    }
    return options;
}

/** Lower sorts first: can-serve beats cannot-serve, certain beats guessed. */
function rank(option: HostingOption): number {
    if (!option.serve) return 2;
    return option.confident ? 0 : 1;
}

/**
 * The option to actually take, or null.
 *
 * Deliberately NOT `options[0]`. The ORDER of {@link detectHostingOptions}
 * answers "what has this repo told us about itself", where a Dockerfile outranks
 * a recipe Genie derived; the RECOMMENDATION answers "what would serve right
 * now", and a Dockerfile still has to be built and still has no known port. So a
 * confident recipe is recommended over an unbuilt Dockerfile, and the Dockerfile
 * is recommended when nothing else can serve.
 */
export function recommendedOption(options: readonly HostingOption[]): HostingOption | null {
    if (options.length === 0) return null;
    return (
        options.find((o) => o.serve && o.confident) ??
        options.find((o) => o.serve) ??
        options.find((o) => o.runMode === 'dockerfile') ??
        options[0] ??
        null
    );
}

// --- a stored site, resolved for the runtime -------------------------------

/** The persisted shape (see `sites-config.ts`), as this module needs it. */
export interface HostedSiteRunConfig {
    name: string;
    genName: string;
    /** A repo subfolder name (`repos/<repo>`), or '' for the workspace root. */
    repo: string;
    runMode: HostingRunMode;
    image?: string;
    /** The production build, in order. */
    build?: BuildStep[];
    /** The production server's literal argv. */
    serve?: string[];
    port?: number;
    env?: Record<string, string>;
    kind: 'http' | 'tcp';
    enabled: boolean;
}

export interface ResolveRunContext {
    /** The image to use when the site brings none — the workspace dev image. */
    devImage: string;
    /** Where the workspace is mounted inside the container (`/workspace`). */
    workdir: string;
}

export type ResolvedRun =
    | {
          ok: true;
          /** '' when {@link needsBuild} — the tag does not exist yet. */
          image: string;
          /** Build steps to run in the workspace sandbox before serving. */
          build: BuildStep[];
          serve?: string[];
          port: number;
          /** The container-side working directory — for BOTH the build and the
           *  server, which is what lets a relative build artifact path work. */
          workdir: string;
          /** The repo's own Dockerfile has to be built before this can run. */
          needsBuild: boolean;
      }
    | { ok: false; error: string };

/** A repo name that is safe to append to the container-side mount point. */
const SAFE_REPO = /^[A-Za-z0-9._-]+$/;

/**
 * Turn a stored site into what the runtime needs, or say why it cannot.
 *
 * The two refusals are the ones that would otherwise fail LATE and obscurely: a
 * site with no port has nothing to publish (the container starts and the browser
 * gets nothing), and a site with neither a serve command nor its own image would
 * run the dev image's idle command and look healthy forever.
 */
export function resolveHostedRun(
    config: HostedSiteRunConfig,
    ctx: ResolveRunContext,
): ResolvedRun {
    const port = config.port;
    if (!port || !Number.isInteger(port) || port < 1 || port > 65535) {
        return {
            ok: false,
            error: `Site "${config.name}" has no valid port — there is nothing to publish. Set the port the production server listens on inside the container.`,
        };
    }

    const named = config.image?.trim();
    // A `dockerfile` site's image does not exist yet — the caller builds it and
    // substitutes the tag. Resolution still has to ACCEPT it, or the build would
    // never happen and the run mode would be unreachable.
    const needsBuild = config.runMode === 'dockerfile' && !named;
    const image = named || (needsBuild ? '' : ctx.devImage);
    const serve = config.serve?.length ? config.serve : undefined;
    // An image built from the repo (or any image the caller named) carries its
    // own CMD; the shared dev image only idles, so it MUST be told what to run.
    if (!serve && !named && !needsBuild) {
        return {
            ok: false,
            error: `Site "${config.name}" has no serve command, and no image of its own to supply one. Give it a production serve command, or an image whose CMD starts the server.`,
        };
    }

    let workdir = ctx.workdir;
    if (config.repo) {
        if (!SAFE_REPO.test(config.repo) || config.repo === '.' || config.repo === '..') {
            return { ok: false, error: `Invalid repo name ${JSON.stringify(config.repo)}.` };
        }
        workdir = `${ctx.workdir}/repos/${config.repo}`;
    }

    return {
        ok: true,
        image,
        // A Dockerfile site builds its own image; running Genie's build steps
        // over the top of it would be doing the work twice, in the wrong place.
        build: needsBuild ? [] : config.build ?? [],
        ...(serve ? { serve } : {}),
        port,
        workdir,
        needsBuild,
    };
}
