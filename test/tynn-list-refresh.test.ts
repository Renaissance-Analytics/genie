import { describe, expect, it } from 'vitest';
import { watchTynnSignIn } from '../src/renderer/relay-transport.js';
import type { FeatureData } from '../src/renderer/features.js';

/**
 * CONNECT'S TYNN WORKSTATIONS FOLLOW THE SIGN-IN (Tynn #850; the two-VM proof, 2026-10-20, run 7). The list was read
 * once, when the window opened — before the client signed in — so after signing in it still said "sign in to Tynn to
 * see your workstations" and offered nothing to Open. It is read again whenever this Genie's Tynn sign-in changes.
 */
const data = (signedIn: boolean | null) => ({ integrations: signedIn === null ? null : { tynnSignedIn: signedIn } }) as unknown as FeatureData;

function fakeFeatures(initial: boolean | null) {
    const listeners = new Set<(d: FeatureData) => void>();
    return {
        features: {
            snapshot: async () => data(initial),
            subscribe: (l: (d: FeatureData) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
        },
        push: (signedIn: boolean | null) => { for (const l of listeners) l(data(signedIn)); },
    };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('watchTynnSignIn', () => {
    it('says the sign-in at once, then again each time it CHANGES — not on every features push', async () => {
        const f = fakeFeatures(false);
        const seen: boolean[] = [];
        watchTynnSignIn(f.features, (signedIn) => seen.push(signedIn));
        await flush();
        f.push(false); // another features push, same sign-in: nothing
        f.push(true); // signed in: the list is read again
        f.push(true);
        f.push(false); // signed out
        expect(seen).toEqual([false, true, false]);
    });

    it('features not read yet (integrations null) is not "signed out" (CONTROL)', async () => {
        const f = fakeFeatures(null);
        const seen: boolean[] = [];
        watchTynnSignIn(f.features, (signedIn) => seen.push(signedIn));
        await flush();
        f.push(null);
        f.push(true);
        expect(seen).toEqual([true]);
    });

    it('stops when asked', async () => {
        const f = fakeFeatures(false);
        const seen: boolean[] = [];
        const stop = watchTynnSignIn(f.features, (signedIn) => seen.push(signedIn));
        await flush();
        stop();
        f.push(true);
        expect(seen).toEqual([false]);
    });
});
