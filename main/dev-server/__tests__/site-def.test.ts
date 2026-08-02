import { describe, expect, it } from 'vitest';
import {
    DEFAULT_STACK_PORTS,
    detectRunOptions,
    recommendedOption,
    resolveSiteRun,
} from '../site-def';
import type { RepoFacts } from '../site-def';

/**
 * The LAYERED site definition (Tynn #234, P2 item 2).
 *
 * The owner's decision was three layers, in this order:
 *
 *   1. the repo brings its own container config (Dockerfile / devcontainer /
 *      compose) → OFFER it,
 *   2. otherwise DETECT the stack from its markers → a run command and a port,
 *   3. otherwise the agent/user supplies `{ image, command, port }` explicitly.
 *
 * What is asserted here is the ORDER and the HONESTY. Order, because a repo that
 * ships a Dockerfile has told us how it wants to run and a guessed `npm run dev`
 * must not silently win. Honesty, because every option carries `confident` and
 * `needs`: a detected Go port is a guess, and an agent that cannot tell a guess
 * from a fact will publish port 8080 and report a working site that serves
 * nothing.
 */

const facts = (entries: string[], packageJson?: RepoFacts['packageJson']): RepoFacts => ({
    entries,
    ...(packageJson === undefined ? {} : { packageJson }),
});

describe('detectRunOptions — layer 1: the repo brings its own container config', () => {
    it('OFFERS a Dockerfile ahead of anything detected', () => {
        // A repo with both a Dockerfile and a package.json has said how it wants
        // to be built. Ranking `npm run dev` above that would ignore it.
        const options = detectRunOptions(
            facts(['Dockerfile', 'package.json'], { scripts: { dev: 'vite' } }),
        );
        expect(options[0]?.runMode).toBe('dockerfile');
        expect(options[0]?.source).toBe('Dockerfile');
        expect(options.map((o) => o.runMode)).toContain('detected');
    });

    it('offers a devcontainer and a compose file too', () => {
        const options = detectRunOptions(facts(['docker-compose.yml', '.devcontainer']));
        expect(options.map((o) => o.runMode)).toEqual(['devcontainer', 'compose']);
    });

    it('marks compose as NOT runnable yet, naming what is missing', () => {
        // P2 does not orchestrate compose. Reporting it as an option and then
        // failing on start would be worse than saying so up front.
        const compose = detectRunOptions(facts(['compose.yaml']))[0];
        expect(compose?.runMode).toBe('compose');
        expect(compose?.confident).toBe(false);
        expect(compose?.needs).toMatch(/compose/i);
    });
});

describe('detectRunOptions — layer 2: detect the stack', () => {
    it('detects Node and runs its `dev` script', () => {
        const [option] = detectRunOptions(facts(['package.json'], { scripts: { dev: 'vite' } }));
        expect(option?.stack).toBe('node');
        expect(option?.port).toBe(DEFAULT_STACK_PORTS.node);
        // Vite binds localhost by default, which inside a container is
        // unreachable from the host no matter what is published.
        expect(option?.command).toEqual([
            'npm',
            'run',
            'dev',
            '--',
            '--host',
            '0.0.0.0',
            '--port',
            '5173',
        ]);
        expect(option?.confident).toBe(true);
    });

    it('falls back to `start` and does NOT invent a --host for an unknown script', () => {
        // `--host` is a vite/next flag. Appending it to an arbitrary script is
        // how a working dev server turns into "unknown option".
        const [option] = detectRunOptions(facts(['package.json'], { scripts: { start: 'node server.js' } }));
        expect(option?.command).toEqual(['npm', 'run', 'start']);
        expect(option?.confident).toBe(false);
        expect(option?.needs).toMatch(/0\.0\.0\.0/);
    });

    it('says what it needs when a Node repo has no dev script at all', () => {
        const [option] = detectRunOptions(facts(['package.json'], { scripts: {} }));
        expect(option?.stack).toBe('node');
        expect(option?.command).toBeUndefined();
        expect(option?.needs).toMatch(/command/i);
    });

    it('detects Laravel by its artisan file', () => {
        const [option] = detectRunOptions(facts(['composer.json', 'artisan']));
        expect(option?.stack).toBe('php');
        expect(option?.command).toEqual([
            'php',
            'artisan',
            'serve',
            '--host',
            '0.0.0.0',
            '--port',
            '8000',
        ]);
        expect(option?.confident).toBe(true);
    });

    it('serves a plain PHP repo from public/ when it has one', () => {
        const [option] = detectRunOptions(facts(['composer.json', 'public']));
        expect(option?.command).toEqual(['php', '-S', '0.0.0.0:8000', '-t', 'public']);
    });

    it('detects Django by manage.py', () => {
        const [option] = detectRunOptions(facts(['requirements.txt', 'manage.py']));
        expect(option?.stack).toBe('python');
        expect(option?.command).toEqual(['python3', 'manage.py', 'runserver', '0.0.0.0:8000']);
        expect(option?.confident).toBe(true);
    });

    it('guesses uvicorn for a pyproject repo with a main.py, and SAYS it is a guess', () => {
        const [option] = detectRunOptions(facts(['pyproject.toml', 'main.py']));
        expect(option?.command).toEqual([
            'python3',
            '-m',
            'uvicorn',
            'main:app',
            '--host',
            '0.0.0.0',
            '--port',
            '8000',
        ]);
        expect(option?.confident).toBe(false);
    });

    it('detects Go and Rust but never claims to know their port', () => {
        // Neither `go run` nor `cargo run` declares a port anywhere we can read,
        // so the port in the option is a DEFAULT, not a detection.
        for (const [marker, stack] of [
            ['go.mod', 'go'],
            ['Cargo.toml', 'rust'],
        ] as const) {
            const [option] = detectRunOptions(facts([marker]));
            expect(option?.stack).toBe(stack);
            expect(option?.confident).toBe(false);
            expect(option?.needs).toMatch(/port/i);
        }
    });

    it('honours a caller-declared port everywhere it appears in a command', () => {
        const [option] = detectRunOptions(facts(['composer.json', 'artisan']), { port: 9001 });
        expect(option?.port).toBe(9001);
        expect(option?.command).toContain('9001');
    });

    it('ranks a runnable stack above one that only knows its marker', () => {
        // A polyglot repo (a Laravel app with a Vite frontend) should lead with
        // the option that can actually start.
        const options = detectRunOptions(
            facts(['composer.json', 'artisan', 'package.json'], { scripts: {} }),
        );
        expect(options[0]?.stack).toBe('php');
    });
});

describe('detectRunOptions — layer 3: nothing to go on', () => {
    it('returns ONE explicit option that names everything it needs', () => {
        const options = detectRunOptions(facts(['README.md']));
        expect(options).toHaveLength(1);
        expect(options[0]?.runMode).toBe('explicit');
        expect(options[0]?.command).toBeUndefined();
        expect(options[0]?.needs).toMatch(/command/i);
        expect(options[0]?.needs).toMatch(/port/i);
    });
});

describe('recommendedOption', () => {
    it('prefers a CONFIDENT detection over an unbuilt Dockerfile', () => {
        // Order is what gets OFFERED; the recommendation is what would actually
        // start. A Dockerfile still has to be built, so it is offered first and
        // recommended second.
        const options = detectRunOptions(
            facts(['Dockerfile', 'composer.json', 'artisan']),
        );
        expect(options[0]?.runMode).toBe('dockerfile');
        expect(recommendedOption(options)?.runMode).toBe('detected');
    });

    it('recommends the Dockerfile when nothing else can run', () => {
        const options = detectRunOptions(facts(['Dockerfile']));
        expect(recommendedOption(options)?.runMode).toBe('dockerfile');
    });

    it('is null for an empty list', () => {
        expect(recommendedOption([])).toBeNull();
    });
});

describe('resolveSiteRun — a stored config becomes something runnable', () => {
    const base = {
        name: 'web',
        genName: 'web.acme.gen',
        repo: 'app',
        enabled: true,
        kind: 'http' as const,
    };

    it('runs an explicit config in the workspace dev image by default', () => {
        const run = resolveSiteRun(
            { ...base, runMode: 'explicit', command: ['python3', '-m', 'http.server', '8000'], port: 8000 },
            { devImage: 'genie-dev-base:1', workdir: '/workspace' },
        );
        expect(run.ok).toBe(true);
        if (!run.ok) return;
        expect(run.image).toBe('genie-dev-base:1');
        expect(run.command).toEqual(['python3', '-m', 'http.server', '8000']);
        expect(run.workdir).toBe('/workspace/repos/app');
    });

    it('uses the workspace root when the site names no repo', () => {
        const run = resolveSiteRun(
            { ...base, repo: '', runMode: 'explicit', command: ['x'], port: 1 },
            { devImage: 'i', workdir: '/workspace' },
        );
        expect(run.ok && run.workdir).toBe('/workspace');
    });

    it('refuses a config with no port — there would be nothing to publish', () => {
        const run = resolveSiteRun(
            { ...base, runMode: 'explicit', command: ['x'] },
            { devImage: 'i', workdir: '/workspace' },
        );
        expect(run.ok).toBe(false);
        if (run.ok) return;
        expect(run.error).toMatch(/port/i);
    });

    it('refuses a config with no command unless it brings its own image', () => {
        const bare = resolveSiteRun(
            { ...base, runMode: 'explicit', port: 3000 },
            { devImage: 'i', workdir: '/workspace' },
        );
        expect(bare.ok).toBe(false);

        // An image built from the repo's Dockerfile has its own CMD/ENTRYPOINT,
        // so "no command" is the correct spec, not a missing field.
        const built = resolveSiteRun(
            { ...base, runMode: 'dockerfile', image: 'genie-site-web:latest', port: 3000 },
            { devImage: 'i', workdir: '/workspace' },
        );
        expect(built.ok).toBe(true);
        if (!built.ok) return;
        expect(built.image).toBe('genie-site-web:latest');
        expect(built.command).toBeUndefined();
        expect(built.needsBuild).toBe(false);
    });

    it('accepts a dockerfile site with no image YET, and flags the build', () => {
        // The image is the build's OUTPUT. Refusing this shape would make the
        // whole `dockerfile` run mode unreachable — the caller could never get
        // past resolution to the build that produces the tag.
        const run = resolveSiteRun(
            { ...base, runMode: 'dockerfile', port: 3000 },
            { devImage: 'genie-dev-base:1', workdir: '/workspace' },
        );
        expect(run.ok).toBe(true);
        if (!run.ok) return;
        expect(run.needsBuild).toBe(true);
        // NOT the dev image: running that would idle and look healthy forever.
        expect(run.image).toBe('');
    });

    it('refuses a repo name that would climb out of the workspace', () => {
        // The repo name reaches the container as a workdir; `..` there would
        // mount-escape the sandbox's own mount point.
        const run = resolveSiteRun(
            { ...base, repo: '../../etc', runMode: 'explicit', command: ['x'], port: 1 },
            { devImage: 'i', workdir: '/workspace' },
        );
        expect(run.ok).toBe(false);
    });
});
