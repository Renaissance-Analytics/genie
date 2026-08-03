import { describe, expect, it } from 'vitest';
import { detectFramework, planHostAllowlist } from '../host-allowlist';
import { detectHostingOptions } from '../serve-recipe';

/**
 * The HOST-HEADER ALLOWLIST — the sharp edge the `.gen` routing leaves.
 *
 * A hosted site is served at `https://web.acme.gen`, so the carrier sends
 * `Host: web.acme.gen` upstream. Several frameworks check that header against a
 * list they cannot possibly know about and answer a "Blocked request" page —
 * with a 200-ish container, a bound port, and a `ready` probe that passed. The
 * site is up, the route is right, and the user sees a wall of text about
 * `server.allowedHosts`.
 *
 * The mitigation of last resort is `upstreamHost`: send `Host: localhost`. It works
 * and it costs the app its real origin — absolute URLs, cookie domains and CSRF
 * origin checks all start pointing at `localhost` while the browser is at
 * `.gen`. So the goal here is to keep the real Host and make the FRAMEWORK
 * accept it, and to be honest about the cases where that is not possible.
 *
 * The honesty is the point of the `status` field. `solved` means Genie sets
 * something the framework definitely reads. `documented` means it does not, and
 * the note says what the user has to change. Reporting the second as the first
 * is how someone spends an hour on a wall they were told was gone.
 */

describe('detecting which framework will check the Host header', () => {
    it('reads it off the argv for an EXPLICIT site nobody detected', () => {
        // The escape-hatch case: the user typed the command themselves, so
        // there is no stored framework — but the argv still says what it runs.
        expect(detectFramework({ command: ['npx', 'vite', '--host', '0.0.0.0'] })).toBe('vite');
        expect(detectFramework({ command: ['python3', 'manage.py', 'runserver', '0.0.0.0:8000'] }))
            .toBe('django');
        expect(detectFramework({ command: ['php', 'artisan', 'serve', '--host', '0.0.0.0'] }))
            .toBe('laravel');
        expect(detectFramework({ command: ['npm', 'run', 'start', '--', 'next', 'dev'] })).toBe('next');
        expect(detectFramework({ command: ['go', 'run', '.'] })).toBe('none');
        expect(detectFramework({})).toBe('none');
    });

    it('prefers the STORED framework, because `npm run dev` hides what it runs', () => {
        // The case argv detection cannot solve: `npm run dev -- --host 0.0.0.0`
        // contains no token saying "vite". Detection knew (it read the script
        // body to decide those flags were safe), so it records what it knew.
        expect(
            detectFramework({
                framework: 'vite',
                command: ['npm', 'run', 'dev', '--', '--host', '0.0.0.0', '--port', '5173'],
            }),
        ).toBe('vite');
        expect(detectFramework({ command: ['npm', 'run', 'dev', '--', '--host', '0.0.0.0'] }))
            .toBe('none');
    });

    it('records the framework on the recipe that generated the serve command', () => {
        // The seam that makes the stored value exist at all: a production serve
        // argv says even less than a dev one did. `gunicorn mysite.wsgi` does
        // not contain the token "django", and Django is the one framework whose
        // host allowlist still applies once the app is served for real.
        const django = detectHostingOptions({
            entries: ['manage.py', 'requirements.txt'],
            pythonPackage: 'mysite',
        }).find((o) => o.stack === 'python');
        expect(django?.framework).toBe('django');
        expect(django?.serve?.join(' ')).not.toMatch(/django/i);

        const laravel = detectHostingOptions({ entries: ['composer.json', 'artisan', 'public'] })
            .find((o) => o.stack === 'php');
        expect(laravel?.framework).toBe('laravel');
    });

    it('a BUILT front end has no framework to allow-list — nothing is running', () => {
        // The reframe, visible here: a Vite app in production is nginx over
        // `dist/`. There is no dev server left to reject a Host header, so
        // claiming a Vite allowlist fix would be describing a process that does
        // not exist.
        const built = detectHostingOptions({
            entries: ['package.json', 'index.html'],
            packageJson: { scripts: { dev: 'vite', build: 'vite build' } },
        })[0];
        expect(built?.stack).toBe('static');
        expect(built?.framework).toBeUndefined();
    });
});

describe('planning what to inject', () => {
    const genName = 'web.acme.gen';

    it('SOLVES Vite for the one case that can still run it — an explicit site', () => {
        // A recipe-built front end never runs Vite. Someone who pointed an
        // `explicit` site at a dev server themselves still gets the fix.
        const plan = planHostAllowlist({ genName, framework: 'vite' });
        expect(plan.status).toBe('solved');
        expect(plan.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS).toBe(genName);
    });

    it('does NOT claim to solve Django — nothing in Django reads an env var by itself', () => {
        // `DJANGO_ALLOWED_HOSTS` is a project CONVENTION (cookiecutter, the
        // official Docker guide), not something Django reads. Injecting it helps
        // the many settings.py files that do read it, and claiming that as
        // "solved" would mislead everyone whose does not.
        const plan = planHostAllowlist({ genName, framework: 'django' });
        expect(plan.status).toBe('documented');
        expect(plan.env.DJANGO_ALLOWED_HOSTS).toBe(genName);
        expect(plan.note).toMatch(/ALLOWED_HOSTS/);
        expect(plan.upstreamHostFallback).toBe('localhost');
    });

    it('reports Next as unblocked, because `next start` checks no Host', () => {
        // This was `documented` while Genie ran `next dev`. Building the app and
        // serving it the production way is what removed the problem — so the
        // warning has to go with it, or it becomes a false one.
        const plan = planHostAllowlist({ genName, framework: 'next' });
        expect(plan.status).toBe('not-needed');
        expect(plan.env).toEqual({});
        expect(plan.upstreamHostFallback).toBeUndefined();
    });

    it('reports Laravel as unblocked, and lines its generated URLs up with the browser', () => {
        // FrankenPHP has no Host allowlist and Laravel's TrustHosts is opt-in,
        // so nothing is blocked. What DOES go wrong is APP_URL: every asset(),
        // url() and signed route would otherwise be built from 127.0.0.1 while
        // the browser is at `.gen`, which breaks assets and signature checks.
        const plan = planHostAllowlist({ genName, framework: 'laravel' });
        expect(plan.status).toBe('not-needed');
        expect(plan.env.APP_URL).toBe('https://web.acme.gen');
    });

    it('injects nothing for a stack with no allowlist at all', () => {
        // nginx, uvicorn, a compiled Go or Rust binary: none of them check the
        // Host. Inventing env for them would be noise a user has to reason
        // about.
        const plan = planHostAllowlist({ genName, framework: 'none' });
        expect(plan.status).toBe('not-needed');
        expect(plan.env).toEqual({});
    });

    it('STANDS DOWN when the user already overrode upstreamHost', () => {
        // They took the manual escape. Injecting an allowlist for a name that is
        // no longer being sent would be dead config, and an APP_URL naming an
        // origin the app is not being addressed as would be actively wrong.
        const plan = planHostAllowlist({ genName, framework: 'vite', upstreamHost: 'localhost' });
        expect(plan.env).toEqual({});
        expect(plan.status).toBe('not-needed');
        expect(plan.note).toMatch(/upstreamHost|overrid/i);
    });
});
