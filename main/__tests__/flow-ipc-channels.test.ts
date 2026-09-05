import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Two unrelated things called Flows must not fight over one IPC namespace.
 *
 * Genie has two:
 *
 *  - `main/flows/` — the AUTOMATION system. A Flow is a Recipe, the Triggers
 *    that start it and the Scope it may touch. Workstation-wide. This is the
 *    thing the Flow Manager manages.
 *  - `main/apps/flows/` — a GApp's node-graph CANVAS, one fancy-flow workflow
 *    owned by one Genie App.
 *
 * v67 already separated them in the database: the automation table took the name
 * `flows` and the canvas table was renamed `gapp_flows`. The IPC and the
 * renderer API were left behind on the old name, so the canvas still owned
 * `flows:list`, `flows:run` and `flows:set-enabled` — exactly the three the
 * manager needs.
 *
 * ## Why this is a test and not a code review note
 *
 * `ipcMain.handle` THROWS on a second registration for the same channel
 * ("Attempted to register a second handler for 'flows:list'"). Both modules
 * register at boot, so the collision is not a subtle bug that shows up under
 * load — it is Genie failing to start. And nothing in the type system can see
 * it: the channel is a string in one file and a string in another.
 *
 * A disjointness assertion is the only thing that catches it before a person
 * launches the app, which is why it lives here rather than being remembered.
 */

const MAIN = path.join(__dirname, '..');

/** Every channel string a module passes to `ipcMain.handle`. */
function handledChannels(relPath: string): string[] {
    const source = fs.readFileSync(path.join(MAIN, relPath), 'utf8');
    return [...source.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1] as string);
}

const managerChannels = handledChannels('ipc.ts').filter((c) => c.startsWith('flows:'));
const canvasChannels = handledChannels('apps/flows/ipc.ts');

describe('the Flow Manager and the GApp flow canvas own separate channels', () => {
    it('finds channels in both modules to compare (control)', () => {
        // Without this, two empty lists would be trivially disjoint and the
        // assertion below would pass against a regex that matches nothing.
        expect(managerChannels.length).toBeGreaterThan(0);
        expect(canvasChannels.length).toBeGreaterThan(0);
    });

    it('registers no channel twice', () => {
        const clash = managerChannels.filter((c) => canvasChannels.includes(c));
        expect(
            clash,
            `Both main/ipc.ts and main/apps/flows/ipc.ts register ${clash.join(', ')}. ` +
                `ipcMain.handle throws on the second one, so Genie would not boot.`,
        ).toEqual([]);
    });

    it('gives the GApp canvas the `gapp-flows:` prefix, matching its `gapp_flows` table', () => {
        // The automation system owns the bare name at every layer — table, IPC,
        // renderer API — so a reader who finds `flows:` anywhere lands on the
        // same thing every time.
        const notPrefixed = canvasChannels.filter((c) => !c.startsWith('gapp-flows:'));
        expect(notPrefixed).toEqual([]);
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
