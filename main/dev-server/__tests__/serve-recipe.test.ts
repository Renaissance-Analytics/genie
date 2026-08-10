import { describe, expect, it } from 'vitest';
import {
    DEFAULT_STACK_PORTS,
    GENIE_BUILD_DIR,
    detectHostingOptions,
    recommendedOption,
    resolveHostedRun,
    withPort,
} from '../serve-recipe';
import type { RepoFacts } from '../serve-recipe';

/**
 * withPort — stamp a HOST-ALLOCATED free port onto a dev command.
 *
 * The host owns ports now (agents never pass one), so at start it allocates a
 * free port and rewrites the command to bind exactly that. The port lives in a
 * DIFFERENT place per stack (php `--port=`, django `host:port`, node via env/flag),
 * so a blind string replace is wrong — each stack is handled explicitly.
 */
describe('withPort', () => {
    it('php/laravel: rewrites an existing --port and keeps the host', () => {
        const r = withPort(
            ['php', 'artisan', 'serve', '--host=127.0.0.1', '--port=8000'],
            5321,
            { stack: 'php', framework: 'laravel' },
        );
        expect(r.command).toEqual(['php', 'artisan', 'serve', '--host=127.0.0.1', '--port=5321']);
        expect(r.command.filter((a) => a.startsWith('--port=')).length).toBe(1);
    });

    it('php: appends --port when the command carries none', () => {
        const r = withPort(['php', 'artisan', 'serve'], 5321, { stack: 'php', framework: 'laravel' });
        expect(r.command).toContain('--port=5321');
    });

    it('django: rewrites the host:port positional', () => {
        const r = withPort(
            ['python', 'manage.py', 'runserver', '127.0.0.1:8000'],
            5321,
            { stack: 'python', framework: 'django' },
        );
        expect(r.command).toEqual(['python', 'manage.py', 'runserver', '127.0.0.1:5321']);
    });

    it('node/vite: sets PORT and appends -- --port <p> --strictPort (no silent drift)', () => {
        const r = withPort(['npm', 'run', 'dev'], 5321, { stack: 'node', framework: 'vite' });
        expect(r.env.PORT).toBe('5321');
        expect(r.command.join(' ')).toContain('-- --port 5321 --strictPort');
    });

    it('node/next: sets PORT env, no vite flags appended', () => {
        const r = withPort(['npm', 'run', 'dev'], 5321, { stack: 'node', framework: 'next' });
        expect(r.env.PORT).toBe('5321');
        expect(r.command).toEqual(['npm', 'run', 'dev']);
    });

    it('go: sets PORT env, argv unchanged', () => {
        const r = withPort(['go', 'run', '.'], 5321, { stack: 'go' });
        expect(r.env.PORT).toBe('5321');
        expect(r.command).toEqual(['go', 'run', '.']);
    });
});

/**
 * The PRODUCTION build + serve recipe (the Hosting Manager's site model).
 *
 * Genie does not run dev servers. A hosted site is BUILT and then served the way
 * it runs in production, so what is asserted here is that pairing: every recipe
 * produces build steps that make an artifact, and a serve command that is a
 * PRODUCTION server — never `npm run dev`, `artisan serve`, `runserver`, `vite`
 * or `go run`.
 *
 * The layering is unchanged from the dev-server model and still load-bearing: a
 * repo that ships a Dockerfile has already said how it is built and run, so that
 * is offered ahead of any recipe Genie guesses at. What changed is layer 2 —
 * where it used to propose a dev command, it now proposes a build + a production
 * server.
 */

const facts = (entries: string[], extra: Partial<RepoFacts> = {}): RepoFacts => ({
    entries,
    ...extra,
});

/** Every argv this module could ever emit, flattened — for the "no dev server
 *  anywhere" sweep, which is the whole point of the reframe. */
const allArgv = (o: { build?: { command: string[] }[]; serve?: string[] }): string =>
    [...(o.build ?? []).map((s) => s.command.join(' ')), (o.serve ?? []).join(' ')].join(' | ');

describe('layer 1 — the repo brought its own production config', () => {
    it('OFFERS a Dockerfile ahead of any recipe', () => {
        const options = detectHostingOptions(
            facts(['Dockerfile', 'package.json'], { packageJson: { scripts: { build: 'vite build' } } }),
        );
        expect(options[0]?.runMode).toBe('dockerfile');
        // A Dockerfile IS the production build — Genie must not bolt its own
        // build steps onto an image the repo already knows how to make.
        expect(options[0]?.build).toEqual([]);
        expect(options.map((o) => o.runMode)).toContain('recipe');
    });

    it('says compose is not orchestrated yet rather than failing on start', () => {
        const [compose] = detectHostingOptions(facts(['compose.yaml']));
        expect(compose?.runMode).toBe('compose');
        expect(compose?.confident).toBe(false);
        expect(compose?.needs).toMatch(/compose/i);
    });
});

describe('layer 2 — PHP builds for production and serves with FrankenPHP', () => {
    it('installs without dev dependencies and serves the public/ docroot', () => {
        const [php] = detectHostingOptions(facts(['composer.json', 'artisan', 'public']));
        expect(php?.stack).toBe('php');
        expect(php?.server).toBe('frankenphp');
        expect(php?.framework).toBe('laravel');

        // `--no-dev` is the difference between a production install and a dev
        // one, and `--optimize-autoloader` is what production actually runs.
        const composer = php?.build.find((s) => s.command[0] === 'composer');
        expect(composer?.command).toContain('--no-dev');
        expect(composer?.command).toContain('--optimize-autoloader');

        expect(php?.serve?.[0]).toBe('frankenphp');
        expect(php?.serve).toContain('public/');
        // FrankenPHP is not in the workspace dev image, so the recipe names the
        // image it needs — otherwise the site would start and 127 immediately.
        expect(php?.image).toMatch(/frankenphp/);
        expect(allArgv(php!)).not.toMatch(/artisan serve|php -S/);
    });

    it('builds a Laravel app’s front-end assets when it has a package.json', () => {
        const [php] = detectHostingOptions(
            facts(['composer.json', 'artisan', 'public', 'package.json', 'package-lock.json'], {
                packageJson: { scripts: { build: 'vite build' } },
            }),
        );
        const npmBuild = php?.build.find((s) => s.command.join(' ') === 'npm run build');
        expect(npmBuild).toBeTruthy();
        expect(php?.build.some((s) => s.command.join(' ') === 'npm ci')).toBe(true);
        // Assets are built, never SERVED by a dev server.
        expect(allArgv(php!)).not.toMatch(/\bvite\b(?! build)/);
    });

    it('refuses to guess a docroot it cannot see', () => {
        const [php] = detectHostingOptions(facts(['composer.json']));
        expect(php?.confident).toBe(false);
        expect(php?.needs).toMatch(/docroot|public/i);
    });
});

describe('layer 2 — Node SSR serves the app’s own production server', () => {
    it('builds Next and runs `next start`, never `next dev`', () => {
        const [node] = detectHostingOptions(
            facts(['package.json', 'package-lock.json'], {
                packageJson: {
                    scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
                },
            }),
        );
        expect(node?.stack).toBe('node');
        expect(node?.server).toBe('node');
        expect(node?.framework).toBe('next');
        expect(node?.build.map((s) => s.command.join(' '))).toEqual(['npm ci', 'npm run build']);
        expect(node?.serve).toEqual([
            'npm',
            'run',
            'start',
            '--',
            '--hostname',
            '0.0.0.0',
            '--port',
            String(DEFAULT_STACK_PORTS.node),
        ]);
        expect(node?.confident).toBe(true);
        expect(allArgv(node!)).not.toMatch(/next dev|npm run dev/);
    });

    it('runs Nuxt’s built Nitro server off .output, bound by env', () => {
        const [node] = detectHostingOptions(
            facts(['package.json', 'nuxt.config.ts'], {
                packageJson: { scripts: { dev: 'nuxt dev', build: 'nuxt build' } },
            }),
        );
        expect(node?.serve).toEqual(['node', '.output/server/index.mjs']);
        // Nitro takes its bind from the environment; there is no flag.
        expect(node?.env?.HOST).toBe('0.0.0.0');
        expect(node?.env?.PORT).toBe(String(DEFAULT_STACK_PORTS.node));
    });

    it('serves a built SPA as STATIC FILES, not from a dev server', () => {
        // The single most important case of the reframe: a Vite app in
        // production is a directory of files behind nginx. Nothing runs Vite.
        const [node] = detectHostingOptions(
            facts(['package.json', 'package-lock.json', 'index.html'], {
                packageJson: { scripts: { dev: 'vite', build: 'vite build' } },
            }),
        );
        expect(node?.stack).toBe('static');
        expect(node?.server).toBe('nginx');
        expect(node?.image).toMatch(/nginx/);
        expect(node?.build.map((s) => s.command.join(' '))).toEqual(['npm ci', 'npm run build']);
        expect(node?.env?.GENIE_NGINX_ROOT).toBe('dist');
        expect(allArgv(node!)).not.toMatch(/npm run dev|\bvite\b(?! build)/);
    });

    it('installs from the LOCKFILE when there is one, and falls back when there is not', () => {
        // `npm ci` is the production install — exact lockfile, no silent
        // resolution — but it HARD FAILS without a lockfile, which would turn a
        // lockfile-less repo into an unhostable one for no good reason.
        const pkg = { scripts: { build: 'vite build', start: 'node server.js' } };
        const [locked] = detectHostingOptions(
            facts(['package.json', 'package-lock.json'], { packageJson: pkg }),
        );
        const [unlocked] = detectHostingOptions(facts(['package.json'], { packageJson: pkg }));
        expect(locked?.build[0]?.command).toEqual(['npm', 'ci']);
        expect(unlocked?.build[0]?.command).toEqual(['npm', 'install']);
    });

    it('cannot serve a Node repo with no build script', () => {
        const [node] = detectHostingOptions(
            facts(['package.json'], { packageJson: { scripts: { dev: 'vite' } } }),
        );
        expect(node?.confident).toBe(false);
        expect(node?.needs).toMatch(/build/i);
        // A dev script is NOT a fallback. Offering it would be the exact
        // mistake this model exists to correct.
        expect(allArgv(node!)).not.toMatch(/npm run dev/);
    });
});

describe('layer 2 — Python serves with gunicorn, never runserver', () => {
    it('builds a virtualenv, collects static, and runs the Django WSGI app', () => {
        const [py] = detectHostingOptions(
            facts(['manage.py', 'requirements.txt'], { pythonPackage: 'mysite' }),
        );
        expect(py?.stack).toBe('python');
        expect(py?.server).toBe('gunicorn');
        expect(py?.framework).toBe('django');

        const steps = py!.build.map((s) => s.command.join(' '));
        expect(steps[0]).toBe(`uv venv ${GENIE_BUILD_DIR}/venv`);
        expect(steps.some((s) => s.includes('-r requirements.txt'))).toBe(true);
        expect(steps.some((s) => s.includes('gunicorn'))).toBe(true);
        expect(steps.some((s) => s.includes('collectstatic'))).toBe(true);

        expect(py?.serve).toEqual([
            `${GENIE_BUILD_DIR}/venv/bin/gunicorn`,
            'mysite.wsgi:application',
            '--bind',
            `0.0.0.0:${DEFAULT_STACK_PORTS.python}`,
        ]);
        expect(py?.confident).toBe(true);
        expect(allArgv(py!)).not.toMatch(/runserver|flask run/);
    });

    it('collectstatic is OPTIONAL — a project with no STATIC_ROOT still hosts', () => {
        const [py] = detectHostingOptions(
            facts(['manage.py', 'requirements.txt'], { pythonPackage: 'mysite' }),
        );
        expect(py?.build.find((s) => s.command.join(' ').includes('collectstatic'))?.optional).toBe(
            true,
        );
    });

    it('will not guess a Django settings package it could not find', () => {
        const [py] = detectHostingOptions(facts(['manage.py', 'requirements.txt']));
        expect(py?.confident).toBe(false);
        expect(py?.needs).toMatch(/wsgi/i);
        expect(py?.serve).toBeUndefined();
    });

    it('serves an ASGI app with uvicorn workers under gunicorn’s supervision', () => {
        const [py] = detectHostingOptions(facts(['pyproject.toml', 'main.py']));
        expect(py?.server).toBe('uvicorn');
        expect(py?.serve?.join(' ')).toMatch(/uvicorn main:app --host 0\.0\.0\.0/);
        expect(py?.confident).toBe(false);
    });
});

describe('layer 2 — compiled languages serve the COMPILED BINARY', () => {
    it('go builds an executable and runs it', () => {
        const [go] = detectHostingOptions(facts(['go.mod']));
        expect(go?.stack).toBe('go');
        expect(go?.server).toBe('binary');
        expect(go?.build.map((s) => s.command.join(' '))).toEqual([
            `go build -o ${GENIE_BUILD_DIR}/server .`,
        ]);
        expect(go?.serve).toEqual([`${GENIE_BUILD_DIR}/server`]);
        // Nothing in a Go repo declares a listen address, so the port is a
        // default and the recipe says so rather than reporting a working site.
        expect(go?.confident).toBe(false);
        expect(go?.needs).toMatch(/port/i);
        expect(go?.env?.PORT).toBe(String(DEFAULT_STACK_PORTS.go));
        expect(allArgv(go!)).not.toMatch(/go run/);
    });

    it('rust builds --release and runs the named binary', () => {
        const [rust] = detectHostingOptions(facts(['Cargo.toml'], { crateName: 'api' }));
        expect(rust?.build[0]?.command).toEqual([
            'cargo',
            'build',
            '--release',
            '--target-dir',
            `${GENIE_BUILD_DIR}/target`,
        ]);
        expect(rust?.serve).toEqual([`${GENIE_BUILD_DIR}/target/release/api`]);
        expect(allArgv(rust!)).not.toMatch(/cargo run/);
    });

    it('cannot name a Rust binary when Cargo.toml did not parse', () => {
        const [rust] = detectHostingOptions(facts(['Cargo.toml']));
        expect(rust?.serve).toBeUndefined();
        expect(rust?.needs).toMatch(/Cargo\.toml|binary/i);
    });
});

describe('the port threads through every generated command', () => {
    it('a declared port overrides the stack default everywhere it appears', () => {
        const [py] = detectHostingOptions(
            facts(['manage.py', 'requirements.txt'], { pythonPackage: 'mysite' }),
            { port: 9001 },
        );
        expect(py?.port).toBe(9001);
        expect(py?.serve).toContain('0.0.0.0:9001');
    });
});

describe('recommendedOption — what would actually SERVE right now', () => {
    it('prefers a confident recipe over an unbuilt Dockerfile', () => {
        const options = detectHostingOptions(
            facts(['Dockerfile', 'manage.py', 'requirements.txt'], { pythonPackage: 'mysite' }),
        );
        expect(options[0]?.runMode).toBe('dockerfile');
        expect(recommendedOption(options)?.runMode).toBe('recipe');
    });

    it('falls back to the Dockerfile when no recipe can serve', () => {
        const options = detectHostingOptions(facts(['Dockerfile']));
        expect(recommendedOption(options)?.runMode).toBe('dockerfile');
    });

    it('always returns something to act on', () => {
        const options = detectHostingOptions(facts(['README.md']));
        expect(options).toHaveLength(1);
        expect(options[0]?.runMode).toBe('explicit');
        expect(options[0]?.needs).toBeTruthy();
    });
});

describe('resolveHostedRun — a stored site, made runnable', () => {
    const ctx = { devImage: 'genie-dev-base', workdir: '/workspace' };
    const base = {
        name: 'web',
        genName: 'web.acme.gen',
        repo: '',
        runMode: 'recipe' as const,
        kind: 'http' as const,
        enabled: true,
    };

    it('runs the build in the SAME workdir the server will run in', () => {
        const run = resolveHostedRun(
            {
                ...base,
                repo: 'api',
                build: [{ label: 'Compile', command: ['go', 'build'] }],
                serve: ['./server'],
                port: 8080,
            },
            ctx,
        );
        expect(run.ok).toBe(true);
        if (!run.ok) return;
        expect(run.workdir).toBe('/workspace/repos/api');
        expect(run.build).toEqual([{ label: 'Compile', command: ['go', 'build'] }]);
    });

    it('refuses a site with no port — there would be nothing to publish', () => {
        const run = resolveHostedRun({ ...base, serve: ['./server'] }, ctx);
        expect(run.ok).toBe(false);
        if (run.ok) return;
        expect(run.error).toMatch(/port/i);
    });

    it('refuses a site with neither a serve command nor an image that carries one', () => {
        const run = resolveHostedRun({ ...base, port: 8080 }, ctx);
        expect(run.ok).toBe(false);
        if (run.ok) return;
        expect(run.error).toMatch(/serve/i);
    });

    it('lets a repo Dockerfile carry its own server, with no serve argv', () => {
        const run = resolveHostedRun({ ...base, runMode: 'dockerfile', port: 8080 }, ctx);
        expect(run.ok).toBe(true);
        if (!run.ok) return;
        expect(run.needsBuild).toBe(true);
        expect(run.image).toBe('');
        expect(run.build).toEqual([]);
    });

    it('refuses a repo name that would climb out of the workspace mount', () => {
        const run = resolveHostedRun({ ...base, repo: '../etc', serve: ['x'], port: 80 }, ctx);
        expect(run.ok).toBe(false);
    });
});
