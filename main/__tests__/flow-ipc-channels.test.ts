import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The flow IPC surface, checked at both ends.
 *
 * ★ This file used to assert that two unrelated things called Flows did not
 * fight over one namespace — `main/ipc.ts` owned `flows:*` for the recipe
 * engine, `main/apps/flows/ipc.ts` owned `gapp-flows:*` for the canvas, and
 * `ipcMain.handle` THROWS on a second registration, so a collision was Genie
 * failing to start.
 *
 * **There is one system now.** A GApp's flow is a flow whose SCOPE is `gapp`;
 * `flows:list` takes the vantage asking rather than there being a second channel
 * for a second kind, because there is no second kind. So the collision this file
 * guarded against is now impossible by construction rather than by assertion,
 * and what remains is the half that was always the harder failure to see.
 *
 * ## A push channel drifts SILENTLY
 *
 * A wrong `ipcMain.handle` name throws. A wrong `broadcastLocal` name does not:
 * the send goes out, nobody is listening, and the header simply never animates.
 * No error, no failed call, nothing in a log — the feature is quietly dead,
 * which is the exact failure mode an automation system must not have.
 *
 * A wrong `ipcRenderer.invoke` name is nearly as quiet: it rejects at run time,
 * in a promise a component usually catches into a muted "could not load".
 *
 * So both ends are compared as strings, here, rather than trusted to a person
 * noticing.
 */

const MAIN = path.join(__dirname, '..');

/** Every channel string a module passes to `ipcMain.handle`. */
function handledChannels(relPath: string): string[] {
    const source = fs.readFileSync(path.join(MAIN, relPath), 'utf8');
    return [...source.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1] as string);
}

function invokedChannels(relPath: string): string[] {
    const source = fs.readFileSync(path.join(MAIN, relPath), 'utf8');
    return [...source.matchAll(/ipcRenderer\.invoke\(\s*'(flows:[^']+)'/g)].map((m) => m[1] as string);
}

describe('every flow channel the preload calls is one main answers', () => {
    const handled = [...new Set(handledChannels('flows/ipc.ts'))].sort();
    const invoked = [...new Set(invokedChannels('preload.ts'))].sort();

    it('finds channels at both ends to compare (control)', () => {
        // Without this, two empty lists would match trivially and the assertion
        // below would pass against a regex that matches nothing.
        expect(handled.length).toBeGreaterThan(0);
        expect(invoked.length).toBeGreaterThan(0);
    });

    it('matches them exactly, in both directions', () => {
        // A preload calling a channel nothing handles rejects at run time, in a
        // promise a component usually catches into a muted "could not load". A
        // handler nothing calls is dead code that reads as a live feature.
        expect(invoked).toEqual(handled);
    });

    it('leaves no `gapp-flows:` CHANNEL anywhere — there is one system', () => {
        // Matches a quoted channel string, not the bare word: the docblocks here
        // and in `flows/ipc.ts` legitimately name the old namespace when
        // explaining why it is gone, and a guard that reads prose as code fails
        // for the wrong reason.
        //
        // Deliberately NOT done by stripping comments first. A regex that tries
        // to remove block comments will happily eat a `/*` that lives inside a
        // string, blinding the guard over whatever follows — and a guard that
        // then reports "clean" is worse than no guard.
        const CHANNEL = /['"]gapp-flows:/;
        for (const file of ['ipc.ts', 'preload.ts', 'flows/ipc.ts']) {
            const source = fs.readFileSync(path.join(MAIN, file), 'utf8');
            expect(CHANNEL.test(source), `${file} still uses a gapp-flows: channel`).toBe(false);
        }
    });

    it('would notice one — the channel guard is not vacuous', () => {
        const CHANNEL = /['"]gapp-flows:/;
        expect(CHANNEL.test("invoke('gapp-flows:list')")).toBe(true);
        expect(CHANNEL.test('a docblock naming `gapp-flows:*` in prose')).toBe(false);
    });

    it('registers the flow channels in ONE module', () => {
        // `ipcMain.handle` throws on a second registration for the same channel,
        // so two modules both owning `flows:*` is Genie failing to boot — which
        // is exactly what happened when the two systems shared the name.
        const elsewhere = handledChannels('ipc.ts').filter((c) => c.startsWith('flows:'));
        expect(elsewhere).toEqual([]);
    });
});

/**
 * The push channels, where a drift is SILENT.
 *
 * A wrong `ipcMain.handle` name throws. A wrong `broadcastLocal` name does not:
 * the send goes out, nobody is listening, and the header simply never animates.
 * There is no error, no failed call and nothing in a log — the feature is just
 * quietly dead, which is the exact failure mode `main/flows/` says it exists to
 * avoid for Flows themselves.
 *
 * So the two ends are compared as strings, here, rather than trusted to a person
 * noticing.
 */
function broadcastChannels(relPath: string): string[] {
    const source = fs.readFileSync(path.join(MAIN, relPath), 'utf8');
    return [...source.matchAll(/broadcastLocal\(\s*'(flows:[^']+)'/g)].map((m) => m[1] as string);
}

function listenedChannels(relPath: string): string[] {
    const source = fs.readFileSync(path.join(MAIN, relPath), 'utf8');
    return [...source.matchAll(/ipcRenderer\.on\(\s*'(flows:[^']+)'/g)].map((m) => m[1] as string);
}

describe('every Flow broadcast has a listener on the same channel', () => {
    const sent = [...new Set(broadcastChannels('flows/index.ts'))].sort();
    const heard = [...new Set(listenedChannels('preload.ts'))].sort();

    it('finds broadcasts and listeners to compare (control)', () => {
        expect(sent.length).toBeGreaterThan(0);
        expect(heard.length).toBeGreaterThan(0);
    });

    it('matches them exactly, in both directions', () => {
        // Both directions: a broadcast nobody hears is a dead feature, and a
        // listener for a channel nothing sends is a subscription that will never
        // fire — usually the leftover of a rename that only got halfway.
        expect(sent).toEqual(heard);
    });
});
