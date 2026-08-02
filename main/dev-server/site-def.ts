import type { DevFramework } from './host-allowlist';
/**
 * PURE. How a repo RUNS — the layered site definition (Tynn #234, P2 item 2).
 *
 * The owner's decision was three layers, and the order is the whole design:
 *
 *   1. **The repo brought its own container config** (`Dockerfile`,
 *      `.devcontainer/`, `compose.yaml`). It has already said how it wants to be
 *      built and run, so that is OFFERED first. Guessing over the top of an
 *      explicit answer is how a tool loses a user's trust.
 *   2. **Detect the stack** from its markers (`package.json` → Node,
 *      `composer.json` → PHP, `pyproject.toml`/`requirements.txt` → Python,
 *      `go.mod` → Go, `Cargo.toml` → Rust) and propose a dev command + a port.
 *   3. **Explicit** — the agent or the user supplies `{ image, command, port }`.
 *
 * ## Every option says how much of it is a GUESS
 *
 * `confident` and `needs` are not decoration. Detection produces three genuinely
 * different qualities of answer: a Laravel `artisan serve --port 8000` is a
 * FACT; `npm run dev` for a script we could not recognise is a command we
 * believe but a bind address we do not; `cargo run` is a command with no port
 * information anywhere in the repo. An agent that cannot tell those apart will
 * publish 8080, get a connection refused, and report a working site.
 *
 * So the contract is: `confident: false` always comes with a `needs` sentence
 * naming what the caller has to supply or check, and `command: undefined` means
 * this option cannot start at all until it is given one.
 *
 * ## Why `0.0.0.0` appears in almost every command
 *
 * A dev server that binds `localhost` inside a container is reachable only from
 * inside that container — publishing the port changes nothing, because the
 * runtime's forwarder dials the container's external interface and finds nothing
 * listening. This is the single most common way a containerised dev server
 * "works but returns nothing", so every command we generate binds `0.0.0.0`, and
 * every command we DON'T generate says so in `needs`.
 *
 * No filesystem access here — {@link RepoFacts} is the input, and `repo-facts.ts`
 * is the one place that reads a disk.
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
}

// --- the model -------------------------------------------------------------

export type DevStack = 'node' | 'php' | 'python' | 'go' | 'rust';

export type DevSiteRunMode = 'dockerfile' | 'devcontainer' | 'compose' | 'detected' | 'explicit';

/**
 * The port each stack's conventional dev server listens on.
 *
 * A DEFAULT, never a detection — which is why a stack whose port cannot be read
 * from the repo (Go, Rust) reports `confident: false` even though the number
 * below is usually right.
 */
export const DEFAULT_STACK_PORTS: Readonly<Record<DevStack, number>> = {
    node: 5173,
    php: 8000,
    python: 8000,
    go: 8080,
    rust: 8080,
};

/** One way this repo could be run, as offered to an agent or a human. */
export interface DevSiteOption {
    runMode: DevSiteRunMode;
    stack?: DevStack;
    /**
     * Which framework this command runs, when detection could tell.
     *
     * Recorded — and PERSISTED on the site — because the argv often cannot say
     * it later: `npm run dev -- --host 0.0.0.0` contains no token spelling
     * "vite", and yet Vite is exactly the framework that will reject the `.gen`
     * Host header. This is the only moment the script body is in hand, so it is
     * the only moment that fact can be captured. See `host-allowlist.ts`.
     */
    framework?: DevFramework;
    /** The repo entry that produced this option (`Dockerfile`, `go.mod`, …). */
    source: string;
    /** One sentence: what this runs, and why it was offered. */
    reason: string;
    /** The image to run. Absent = the workspace dev image. */
    image?: string;
    /** Literal argv (never a shell string). Absent = cannot start as-is. */
    command?: string[];
    /** The port the server is expected to listen on INSIDE the container. */
    port?: number;
    /** True only when nothing load-bearing here was guessed. */
    confident: boolean;
    /** Set whenever `confident` is false: what the caller must supply or check. */
    needs?: string;
}

// --- layer 1: the repo's own container config ------------------------------

const COMPOSE_FILES = [
    'compose.yaml',
    'compose.yml',
    'docker-compose.yaml',
    'docker-compose.yml',
];

function containerConfigOptions(entries: Set<string>): DevSiteOption[] {
    const options: DevSiteOption[] = [];

    if (entries.has('Dockerfile')) {
        options.push({
            runMode: 'dockerfile',
            source: 'Dockerfile',
            reason: 'This repo ships a Dockerfile — Genie can build it and run the result.',
            // No command: the built image carries its own CMD/ENTRYPOINT.
            confident: false,
            needs: 'the port the built image listens on (a Dockerfile EXPOSE is not read yet)',
        });
    }

    if (entries.has('.devcontainer') || entries.has('devcontainer.json')) {
        options.push({
            runMode: 'devcontainer',
            source: entries.has('.devcontainer') ? '.devcontainer' : 'devcontainer.json',
            reason: 'This repo ships a devcontainer definition.',
            confident: false,
            needs: 'a devcontainer image + command — devcontainer.json is not parsed yet (P3)',
        });
    }

    const compose = COMPOSE_FILES.find((f) => entries.has(f));
    if (compose) {
        options.push({
            runMode: 'compose',
            source: compose,
            reason: `This repo ships ${compose}.`,
            confident: false,
            // Said up front rather than discovered on start: reporting an option
            // and then failing to run it is worse than not offering it.
            needs: 'compose orchestration, which Genie does not run yet (P3) — pick another option',
        });
    }

    return options;
}

// --- layer 2: detect the stack ---------------------------------------------

interface Detector {
    stack: DevStack;
    /** Any one of these at the repo root selects this stack. */
    markers: readonly string[];
    propose(
        entries: Set<string>,
        facts: RepoFacts,
        port: number,
    ): Omit<DevSiteOption, 'runMode' | 'stack' | 'source'>;
}

/** `npm run <script>`, plus the passthrough a vite/next script needs to bind. */
function nodeCommand(
    scripts: Record<string, string>,
    port: number,
): { command?: string[]; confident: boolean; needs?: string; reason: string; framework?: DevFramework } {
    const script = scripts.dev ? 'dev' : scripts.start ? 'start' : null;
    if (!script) {
        return {
            confident: false,
            needs: 'a command — this package.json has no `dev` or `start` script',
            reason: 'A Node repo with no dev script; supply the command to run.',
        };
    }
    const body = scripts[script] ?? '';
    // `--host` / `--port` are vite and next flags. Appending them to an
    // arbitrary script turns a working dev server into "unknown option", so they
    // go on ONLY when the script is one we recognise.
    if (/\b(vite|next)\b/.test(body)) {
        return {
            command: ['npm', 'run', script, '--', '--host', '0.0.0.0', '--port', String(port)],
            confident: true,
            // Captured HERE or nowhere: the generated argv reads `npm run dev`,
            // so nothing downstream could recover which of the two this is —
            // and Vite is exactly the framework that will reject the `.gen`
            // Host header. See `host-allowlist.ts`.
            framework: /\bvite\b/.test(body) ? 'vite' : 'next',
            reason: `\`npm run ${script}\` (${body.trim()}) — bound to 0.0.0.0 so the published port reaches it.`,
        };
    }
    return {
        command: ['npm', 'run', script],
        confident: false,
        needs: `confirmation that \`${body.trim()}\` binds 0.0.0.0:${port} — a server bound to localhost inside a container is unreachable from the host`,
        reason: `\`npm run ${script}\` (${body.trim()}).`,
    };
}

const DETECTORS: readonly Detector[] = [
    {
        stack: 'php',
        markers: ['composer.json'],
        propose(entries, _facts, port) {
            if (entries.has('artisan')) {
                return {
                    command: ['php', 'artisan', 'serve', '--host', '0.0.0.0', '--port', String(port)],
                    confident: true,
                    framework: 'laravel',
                    reason: 'A Laravel app (artisan) — `php artisan serve` on 0.0.0.0.',
                };
            }
            const docroot = entries.has('public') ? ['-t', 'public'] : [];
            return {
                command: ['php', '-S', `0.0.0.0:${port}`, ...docroot],
                confident: false,
                needs: `confirmation that ${docroot.length ? 'public/' : 'the repo root'} is the document root`,
                reason: "PHP's built-in server over the repo.",
            };
        },
    },
    {
        stack: 'node',
        markers: ['package.json'],
        propose(_entries, facts, port) {
            return nodeCommand(facts.packageJson?.scripts ?? {}, port);
        },
    },
    {
        stack: 'python',
        markers: ['pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py'],
        propose(entries, _facts, port) {
            if (entries.has('manage.py')) {
                return {
                    command: ['python3', 'manage.py', 'runserver', `0.0.0.0:${port}`],
                    confident: true,
                    framework: 'django',
                    reason: 'A Django project (manage.py) — `runserver` on 0.0.0.0.',
                };
            }
            const module = entries.has('main.py') ? 'main' : entries.has('app.py') ? 'app' : null;
            if (module) {
                return {
                    command: [
                        'python3',
                        '-m',
                        'uvicorn',
                        `${module}:app`,
                        '--host',
                        '0.0.0.0',
                        '--port',
                        String(port),
                    ],
                    confident: false,
                    // `<module>:app` is the FastAPI/Starlette convention, not a
                    // fact about this repo — the attribute may be called
                    // anything, and uvicorn may not even be installed.
                    needs: `confirmation that \`${module}.py\` exposes an ASGI app named \`app\` and that uvicorn is installed`,
                    reason: `An ASGI app guessed from ${module}.py.`,
                };
            }
            return {
                confident: false,
                needs: 'a command — no manage.py, main.py or app.py to infer one from',
                reason: 'A Python repo with no recognisable entry point.',
            };
        },
    },
    {
        stack: 'go',
        markers: ['go.mod'],
        propose(_entries, _facts, port) {
            return {
                command: ['go', 'run', '.'],
                confident: false,
                // Nothing in a Go repo declares the listen address, so BOTH the
                // port and the bind are unknown.
                needs: `the port this program listens on (defaulted to ${port}) and that it binds 0.0.0.0`,
                reason: '`go run .` over the module at the repo root.',
            };
        },
    },
    {
        stack: 'rust',
        markers: ['Cargo.toml'],
        propose(_entries, _facts, port) {
            return {
                command: ['cargo', 'run'],
                confident: false,
                needs: `the port this program listens on (defaulted to ${port}) and that it binds 0.0.0.0`,
                reason: '`cargo run` over the crate at the repo root.',
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
 * Every way this repo could be run, best-offer first.
 *
 * Container-config options lead (layer 1), then detected stacks — and within the
 * detected ones, a stack that can actually START outranks one that only
 * recognised its marker, so a Laravel app with a `package.json` full of build
 * scripts leads with `artisan serve` rather than a Node option that has no
 * command. When nothing at all matches, a single `explicit` option is returned
 * naming what the caller must supply; the list is never empty, because "no
 * options" tells an agent nothing it can act on.
 */
export function detectRunOptions(facts: RepoFacts, opts: DetectOptions = {}): DevSiteOption[] {
    const entries = new Set(facts.entries ?? []);
    const options = containerConfigOptions(entries);

    const detected: DevSiteOption[] = [];
    for (const detector of DETECTORS) {
        const marker = detector.markers.find((m) => entries.has(m));
        if (!marker) continue;
        const port = opts.port ?? DEFAULT_STACK_PORTS[detector.stack];
        detected.push({
            runMode: 'detected',
            stack: detector.stack,
            source: marker,
            port,
            ...detector.propose(entries, facts, port),
        });
    }
    // Runnable first, then confident-first, otherwise the detector order above.
    detected.sort((a, b) => rank(a) - rank(b));
    options.push(...detected);

    if (options.length === 0) {
        options.push({
            runMode: 'explicit',
            source: '',
            reason: 'No Dockerfile and no recognisable stack markers in this repo.',
            confident: false,
            needs: 'an explicit command and port (and optionally an image) — nothing here says how this repo runs',
        });
    }
    return options;
}

/** Lower sorts first: can-run beats cannot-run, certain beats guessed. */
function rank(option: DevSiteOption): number {
    if (!option.command) return 2;
    return option.confident ? 0 : 1;
}

/**
 * The option to actually take, or null.
 *
 * Deliberately NOT `options[0]`. The ORDER of {@link detectRunOptions} answers
 * "what has this repo told us about itself", where a Dockerfile outranks a
 * guess; the RECOMMENDATION answers "what would start right now", and a
 * Dockerfile still has to be built and still has no known port. So a confident
 * detection is recommended over an unbuilt Dockerfile, and the Dockerfile is
 * recommended when nothing else can run.
 */
export function recommendedOption(options: readonly DevSiteOption[]): DevSiteOption | null {
    if (options.length === 0) return null;
    return (
        options.find((o) => o.command && o.confident) ??
        options.find((o) => o.command) ??
        options.find((o) => o.runMode === 'dockerfile') ??
        options[0] ??
        null
    );
}

// --- a stored config, resolved for the runtime -----------------------------

/** The persisted shape (see `sites-config.ts`), as this module needs it. */
export interface DevSiteRunConfig {
    name: string;
    genName: string;
    /** A repo subfolder name (`repos/<repo>`), or '' for the workspace root. */
    repo: string;
    runMode: DevSiteRunMode;
    image?: string;
    command?: string[];
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
          command?: string[];
          port: number;
          /** The container-side working directory for the command. */
          workdir: string;
          /** The repo's own Dockerfile has to be built before this can run. */
          needsBuild: boolean;
      }
    | { ok: false; error: string };

/** A repo name that is safe to append to the container-side mount point. */
const SAFE_REPO = /^[A-Za-z0-9._-]+$/;

/**
 * Turn a stored config into what the runtime needs, or say why it cannot.
 *
 * The two refusals are the ones that would otherwise fail LATE and obscurely: a
 * site with no port has nothing to publish (the container starts and the browser
 * gets nothing), and a site with neither a command nor its own image would run
 * the dev image's idle command and look healthy forever.
 */
export function resolveSiteRun(
    config: DevSiteRunConfig,
    ctx: ResolveRunContext,
): ResolvedRun {
    const port = config.port;
    if (!port || !Number.isInteger(port) || port < 1 || port > 65535) {
        return {
            ok: false,
            error: `Site "${config.name}" has no valid port — there is nothing to publish. Set the port the server listens on inside the container.`,
        };
    }

    const named = config.image?.trim();
    // A `dockerfile` site's image does not exist yet — the caller builds it and
    // substitutes the tag. Resolution still has to ACCEPT it, or the build would
    // never happen and the run mode would be unreachable.
    const needsBuild = config.runMode === 'dockerfile' && !named;
    const image = named || (needsBuild ? '' : ctx.devImage);
    const command = config.command?.length ? config.command : undefined;
    // An image built from the repo (or any image the caller named) carries its
    // own CMD; the shared dev image only idles, so it MUST be told what to run.
    if (!command && !named && !needsBuild) {
        return {
            ok: false,
            error: `Site "${config.name}" has no command, and no image of its own to supply one. Give it a command, or an image whose CMD starts the server.`,
        };
    }

    let workdir = ctx.workdir;
    if (config.repo) {
        if (!SAFE_REPO.test(config.repo) || config.repo === '.' || config.repo === '..') {
            return { ok: false, error: `Invalid repo name ${JSON.stringify(config.repo)}.` };
        }
        workdir = `${ctx.workdir}/repos/${config.repo}`;
    }

    return { ok: true, image, ...(command ? { command } : {}), port, workdir, needsBuild };
}
