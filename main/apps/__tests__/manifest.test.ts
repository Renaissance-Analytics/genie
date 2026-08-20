import { describe, expect, it } from 'vitest';
import { validateAppManifest, RESERVED_APP_NAMES } from '../manifest';

/**
 * The GApp manifest — what a Genie App is, and what it may ask for (Tynn #250).
 *
 * A GApp is a whole agentic application: its own workspace, its own hosting, its
 * own front end in its own window, reaching Genie's tools under a consented
 * scope. That makes this file a SECURITY boundary before it is a schema, so it is
 * strict and loud: a bad manifest is rejected at install with itemised reasons,
 * never half-loaded.
 *
 * Shape is grounded in the two real target apps rather than a simplified idea of
 * one. AI Trader ORR Jdun is a `python-fastapi` backend PLUS an
 * `electron-react-ts` front end served static at `orr.gen`; The Ripple Effect is a
 * live artboard at `ripple.gen` pointed at an already-running dev server via
 * `hostPort`. So a GApp is MULTI-COMPONENT and MULTI-STACK, and the manifest
 * declares into the envelope's existing `project.json` sites/services shape
 * instead of inventing a parallel one.
 */

const valid = () => ({
    id: 'com.example.trader',
    slug: 'trader',
    name: 'Example Trader',
    version: '1.0.0',
    frontend: { repo: 'desktop', serve: { mode: 'static', root: 'dist' } },
    permissions: { scope: 'self' },
});

describe('a well-formed GApp', () => {
    it('parses, and keeps what it declared', () => {
        const result = validateAppManifest(valid());

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.slug).toBe('trader');
        expect(result.value.permissions.scope).toBe('self');
    });

    it('accepts a BACKEND SERVICE beside the front end, in another language', () => {
        // ORR's backend is python-fastapi. An SDK that assumed Node would not be
        // able to describe the app it exists to serve.
        const result = validateAppManifest({
            ...valid(),
            services: [
                { name: 'api', repo: 'backend', command: ['uvicorn', 'app:api'], port: 8000 },
            ],
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.services?.[0]?.command).toEqual(['uvicorn', 'app:api']);
    });

    it('accepts a front end that is an ALREADY-RUNNING dev server', () => {
        // The Ripple Effect's artboard is `runMode: host` + `hostPort: 5273`, not a
        // built directory. Both shapes are in live use, so both are describable.
        const result = validateAppManifest({
            ...valid(),
            frontend: { repo: 'app', serve: { mode: 'proxy', hostPort: 5273 } },
        });

        expect(result.ok).toBe(true);
    });
});

describe('rejections that protect the user', () => {
    it('REFUSES a GApp that impersonates Genie', () => {
        // The hard anti-impersonation gate. A GApp that can call itself Genie can
        // trade on Genie's authority to ask for things it was never granted.
        for (const name of RESERVED_APP_NAMES) {
            const result = validateAppManifest({ ...valid(), name });
            expect(result.ok, `"${name}" must be refused`).toBe(false);
            if (result.ok) continue;
            expect(result.errors.join(' ')).toMatch(/reserved|impersonat/i);
        }
    });

    it('refuses a reserved name whatever its casing or spacing', () => {
        // "  GENIE  " is the same claim as "Genie"; a check that only caught the
        // exact string would be trivially defeated.
        const result = validateAppManifest({ ...valid(), name: '  GENIE  ' });
        expect(result.ok).toBe(false);
    });

    it('refuses an unknown permission scope rather than guessing', () => {
        const result = validateAppManifest({
            ...valid(),
            permissions: { scope: 'everything' },
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.join(' ')).toContain('scope');
    });

    it('refuses `workspaces` scope with no workspaces named', () => {
        // An empty allow-list must not read as "all". Fail closed, loudly.
        const result = validateAppManifest({
            ...valid(),
            permissions: { scope: 'workspaces', workspaces: [] },
        });

        expect(result.ok).toBe(false);
    });

    it('defaults to the NARROWEST scope when none is declared', () => {
        const result = validateAppManifest({ ...valid(), permissions: undefined });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Absent must never mean "workstation". A GApp gets the least authority
        // that lets it exist until its manifest asks for more and the user agrees.
        expect(result.value.permissions.scope).toBe('self');
    });

    it('refuses a slug that is not a DNS label — it becomes <slug>.gen', () => {
        // The slug is hosted, so an invalid label would produce a site that cannot
        // be served or, worse, one that collides with another name.
        for (const slug of ['Trader', 'my_app', 'a'.repeat(64), '-lead', '']) {
            expect(validateAppManifest({ ...valid(), slug }).ok, slug).toBe(false);
        }
    });

    it('itemises EVERY problem, rather than stopping at the first', () => {
        // An install that fails one reason at a time wastes the developer's day.
        const result = validateAppManifest({ id: '', slug: '', name: '', version: 'x' });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.length).toBeGreaterThan(2);
    });

    it('rejects a non-object outright', () => {
        for (const raw of [null, undefined, 42, 'a string', []]) {
            expect(validateAppManifest(raw).ok).toBe(false);
        }
    });
});

describe('declaring what the app needs to run', () => {
    it('carries requirements through, with the reason the user will be shown', () => {
        const result = validateAppManifest({
            ...valid(),
            requires: [
                { tool: 'python', version: '3.13.15' },
                { tool: 'docker', reason: 'runs the strategy sandbox' },
            ],
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.requires).toEqual([
            { tool: 'python', version: '3.13.15' },
            { tool: 'docker', reason: 'runs the strategy sandbox' },
        ]);
    });

    it('refuses a requirement that names no tool', () => {
        const result = validateAppManifest({ ...valid(), requires: [{ version: '3.13' }] });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.join(' ')).toContain('requires[0].tool');
    });

    it('leaves requires ABSENT for an app that needs nothing', () => {
        const result = validateAppManifest(valid());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Absent rather than an empty array: an installer that showed an empty
        // "you must install" section would be asking for nothing, loudly.
        expect(result.value.requires).toBeUndefined();
    });
});
