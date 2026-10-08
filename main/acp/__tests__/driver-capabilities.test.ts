import { describe, expect, it } from 'vitest';
import { AcpSessionDriver, type DriverDeps } from '../session';

/**
 * WHAT THE DRIVER ON THE OTHER END CAN ACTUALLY DO, read from the session itself.
 *
 * prism-acp 0.6.0 declares its selected driver's measured behaviour on the `initialize`
 * result, in `_meta` under `particle.academy/driver_capabilities`: exactly
 * `permissionRequests` and `transcriptReplay`. Before this, Genie discarded the
 * `initialize` result entirely and inferred both from the provider NAME.
 *
 * ## Why a name is the wrong key, in prism's own words
 *
 * *"Claude reports `permissionRequests: false` today, and that is expected to change when
 * its permission bridge lands. Read this declaration at runtime rather than caching
 * capabilities against a provider name."*
 *
 * So `provider === 'claude' ? false : true` is a correct answer with an expiry date on it,
 * and the day it expires is a release of a package we do not control. The capability is the
 * only thing that can be right on both sides of that change.
 *
 * ## THREE states, not two
 *
 * `null` is not `false`. The README is explicit: *"If the key is absent, capabilities were
 * not declared; absence does not mean `false`."* Absence means the embedder did not identify
 * a driver — we do not know. Collapsing that to `false` would tell the UI "this agent cannot
 * be asked" about an agent that may well ask, which is the same confident-zero-instead-of-
 * honest-null failure the session model already refuses elsewhere.
 */

const META_KEY = 'particle.academy/driver_capabilities';

const deps = (initResult: unknown) => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const d: DriverDeps = {
        request: async (method, params) => {
            calls.push({ method, params });
            if (method === 'initialize') return initResult;
            if (method === 'session/new') return { sessionId: 'sess-1' };
            return {};
        },
        notify: () => {},
        onRequest: () => {},
        onNotification: () => {},
        cancelGraceMs: 1_000,
    };
    return { deps: d, calls };
};

describe('driver capabilities', () => {
    it('reads the declaration off the initialize result', async () => {
        const { deps: d } = deps({
            _meta: { [META_KEY]: { permissionRequests: true, transcriptReplay: false } },
        });
        const driver = new AcpSessionDriver(d);
        await driver.start({ cwd: '/repo' });

        expect(driver.capabilities).toEqual({ permissionRequests: true, transcriptReplay: false });
    });

    it('reports the OTHER combination too, so the fields are not transposed', async () => {
        // The positive control that matters here. Two booleans read from one object are the
        // easiest thing in this file to wire crossways, and a single fixture with one `true`
        // and one `false` cannot tell a correct read from a swapped one.
        const { deps: d } = deps({
            _meta: { [META_KEY]: { permissionRequests: false, transcriptReplay: true } },
        });
        const driver = new AcpSessionDriver(d);
        await driver.start({ cwd: '/repo' });

        expect(driver.capabilities).toEqual({ permissionRequests: false, transcriptReplay: true });
    });

    it('is NULL when the key is absent — absence is not false', async () => {
        const { deps: d } = deps({ _meta: { 'particle.academy/something_else': 1 } });
        const driver = new AcpSessionDriver(d);
        await driver.start({ cwd: '/repo' });

        expect(driver.capabilities).toBeNull();
    });

    it('is NULL when there is no _meta at all', async () => {
        const { deps: d } = deps({});
        const driver = new AcpSessionDriver(d);
        await driver.start({ cwd: '/repo' });

        expect(driver.capabilities).toBeNull();
    });

    it('is NULL rather than a half-read object when a field is missing or mistyped', async () => {
        // A declaration we cannot trust is not a declaration. Accepting a partial object
        // would put `undefined` into a boolean field, and `!undefined` reads as a confident
        // "cannot" at every call site downstream.
        for (const bad of [
            { permissionRequests: true },
            { transcriptReplay: true },
            { permissionRequests: 'yes', transcriptReplay: true },
            { permissionRequests: true, transcriptReplay: null },
            'not an object',
            null,
        ]) {
            const { deps: d } = deps({ _meta: { [META_KEY]: bad } });
            const driver = new AcpSessionDriver(d);
            await driver.start({ cwd: '/repo' });

            expect(driver.capabilities, `should refuse ${JSON.stringify(bad)}`).toBeNull();
        }
    });

    it('starts out null before any handshake has happened', async () => {
        const { deps: d } = deps({
            _meta: { [META_KEY]: { permissionRequests: true, transcriptReplay: true } },
        });
        const driver = new AcpSessionDriver(d);

        // Nothing has been asked yet, so nothing is known yet — and the getter must not
        // invent an answer for a session that has not opened.
        expect(driver.capabilities).toBeNull();

        await driver.start({ cwd: '/repo' });
        expect(driver.capabilities).not.toBeNull();
    });

    it('reads it on RESUME as well, where a restarted client needs it most', async () => {
        // A resume is precisely the case the declaration exists for: the client has
        // restarted, has no memory of the session, and the agent on the other end may be a
        // different build of prism than the one that opened it.
        const { deps: d } = deps({
            _meta: { [META_KEY]: { permissionRequests: true, transcriptReplay: true } },
        });
        const driver = new AcpSessionDriver(d);
        await driver.resume({ cwd: '/repo', sessionId: 'cli-abc' });

        expect(driver.capabilities).toEqual({ permissionRequests: true, transcriptReplay: true });
    });
});
