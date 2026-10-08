import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeTynnAuth, type AuthProbePorts } from '../auth-probe';

/**
 * THE SIGN-IN WALL, SECOND COSTUME.
 *
 * Owner decision, asked directly on 2026-10-08: *"fully local mode — everything local works, Tynn
 * features say 'sign in to use this'."* The wall itself went: `master.tsx` no longer returns
 * `SignInPrompt` instead of the app when `authChecked && !signedIn`.
 *
 * What stayed was the gate BEFORE it. The boot effect read
 *
 * ```ts
 * const [t, tHost] = await Promise.all([api().auth.whoami('tynn'), api().tynnHost.get()]);
 * ```
 *
 * with no catch and no timeout, and `setAuthChecked(true)` after it. The window renders
 * *"Checking sign-in…"* until that flag flips — so a REJECTED probe leaves Genie on that screen
 * forever. Offline, a wrong `tynnHost`, an unreachable Tynn: the account is optional and the
 * window still never opens. The same wall, reached by failure instead of by being signed out.
 *
 * ## The rule
 *
 * **A failed probe means NOT SIGNED IN, never UNKNOWN.** That is the one place in this codebase
 * where collapsing "cannot see" into a concrete answer is right, and it is worth saying why,
 * because the opposite rule is written all over the session model (`null` is cannot-see, `[]` is
 * none). The difference is what the answer is FOR. A session's rate limit is reported to a human,
 * who is entitled to know Genie cannot see it. This answer only ever decides whether four palette
 * rows say *"sign in to Tynn to use this"* — and for a probe that failed, that sentence is both
 * true and the correct next step. Guessing wrong costs a hint; refusing to guess costs the app.
 */

const user = { backend: 'tynn' as const, id: 'u1', name: 'Wish Born' };

const ports = (over: Partial<AuthProbePorts> = {}): AuthProbePorts => ({
    whoami: async () => user,
    host: async () => 'https://tynn.ai',
    ...over,
});

describe('probeTynnAuth', () => {
    it('reports the account and the host when both answer', () => {
        return expect(probeTynnAuth(ports())).resolves.toEqual({
            signedIn: true,
            name: 'Wish Born',
            host: 'https://tynn.ai',
        });
    });

    it('reports signed OUT for a null whoami, which is the ordinary local case', async () => {
        const r = await probeTynnAuth(ports({ whoami: async () => null }));
        expect(r).toEqual({ signedIn: false, name: null, host: 'https://tynn.ai' });
    });

    it('RESOLVES when whoami rejects, instead of leaving the window on "Checking sign-in…"', async () => {
        // The defect. `Promise.all` with no catch propagated this, the boot effect threw, and
        // `setAuthChecked(true)` never ran.
        const r = await probeTynnAuth(ports({ whoami: async () => { throw new Error('ENOTFOUND tynn.ai'); } }));
        expect(r.signedIn).toBe(false);
        expect(r.name).toBeNull();
    });

    it('RESOLVES when the HOST lookup rejects, and keeps the account it did get', async () => {
        // Independent failures: a host read is a local settings read and an account check is a
        // network call, so one failing says nothing about the other. `Promise.all` rejected the
        // pair on either, which threw away a perfectly good answer.
        const r = await probeTynnAuth(ports({ host: async () => { throw new Error('db locked'); } }));
        expect(r.signedIn).toBe(true);
        expect(r.name).toBe('Wish Born');
        // And the host falls back to the public one rather than to an empty string: a blank base
        // URL builds requests against the renderer's own origin, which 404s in a way that looks
        // like Tynn being broken.
        expect(r.host).toBe('https://tynn.ai');
    });

    it('resolves when BOTH reject', async () => {
        const r = await probeTynnAuth(
            ports({
                whoami: async () => { throw new Error('offline'); },
                host: async () => { throw new Error('offline'); },
            }),
        );
        expect(r).toEqual({ signedIn: false, name: null, host: 'https://tynn.ai' });
    });

    it('treats a blank or non-string host as absent', async () => {
        // A settings row that exists and is empty. Carried through, it is the same blank base URL
        // as above, arriving by a route no catch would notice.
        for (const bad of ['', '   ', null, undefined, 42]) {
            const r = await probeTynnAuth(ports({ host: async () => bad as never }));
            expect(r.host, JSON.stringify(bad)).toBe('https://tynn.ai');
        }
    });

    it('never throws, whatever the ports do — including returning a non-promise', async () => {
        // The guarantee the boot effect depends on. A port that throws SYNCHRONOUSLY would escape
        // an `await` inside a `try` only if the call itself were outside it.
        const r = await probeTynnAuth({
            whoami: (() => { throw new Error('sync'); }) as never,
            host: (() => { throw new Error('sync'); }) as never,
        });
        expect(r.signedIn).toBe(false);
    });
});

/**
 * AND IT IS WIRED — a source guard, because the opposite is invisible.
 *
 * A perfect `probeTynnAuth` sitting beside a `master.tsx` that still awaits a bare `Promise.all`
 * leaves the defect exactly where it was, and nothing would say so: the typecheck is happy either
 * way, the unit tests above stay green, and the symptom only appears on a machine that is offline
 * at boot. That is this phase's signature failure — built, tested, not wired — so it gets an
 * assertion rather than trust.
 */
describe('the boot path uses it', () => {
    const SRC = readFileSync(
        path.resolve(__dirname, '../../pages/master.tsx'),
        'utf8',
    ).replace(/\r\n/g, '\n');

    it('calls probeTynnAuth and imports it', () => {
        expect(SRC).toContain('await probeTynnAuth({');
        expect(SRC).toContain("from '../lib/auth-probe'");
    });

    it('no longer awaits a BARE Promise.all of whoami and the host', () => {
        // The exact line that caused it. Written as a negative, so the positive control below is
        // what keeps it from being a sentence nobody can fail.
        expect(SRC).not.toContain("await Promise.all([api().auth.whoami('tynn'), api().tynnHost.get()])");
    });

    it('sets authChecked BEFORE the workspace refresh, so a failed refresh still opens the window', () => {
        // Order matters more than presence here: `refresh()` reads the database and can reject, and
        // it used to run between the probe and the flag.
        const flag = SRC.indexOf('setAuthChecked(true)');
        const refresh = SRC.indexOf('await refresh()', flag);
        expect(flag).toBeGreaterThan(-1);
        expect(refresh).toBeGreaterThan(flag);
    });

    it('positive control: this guard reads the real file', () => {
        // Without it every assertion above passes against an empty string — and a negative
        // assertion on a file that failed to load is the emptiest green there is.
        expect(SRC).toContain('const refreshAuth = useCallback');
        expect(SRC.length).toBeGreaterThan(10_000);
    });
});
