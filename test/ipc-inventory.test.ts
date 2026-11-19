import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLIPBOARD_WRITE_CHANNEL } from '../src/core/clipboard-wire.js';
import { IPC_INVENTORY, MOVE_STEPS, WINDOW_CAPABILITIES } from '../src/core/ipc-inventory.js';
import { LOCAL_FRAME_CHANNELS } from '../src/core/local-frame.js';
import { FEATURE_CHANNELS } from '../src/renderer/bridge.js';

const bindings: Readonly<Record<string, unknown>> = { CLIPBOARD_WRITE_CHANNEL, FEATURE_CHANNELS, LOCAL_FRAME_CHANNELS };
const registrationKinds = new Set(['handle', 'on', 'once', 'handleOnce']);

function channels(source: string, file: string): string[] {
    // Strings stay whole and comments disappear: a mention of a channel is not a registration.
    // The compiler package ships a checker, not a JavaScript parser API; this guard needs no extra dependency.
    const tokens = [...source.matchAll(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g)]
        .map((match) => match[0]).filter((token) => !token.startsWith('//') && !token.startsWith('/*'));
    const found: string[] = [];
    for (let i = 0; i < tokens.length - 4; i++) {
        const kind = tokens[i + 2];
        if (tokens[i] !== 'ipcMain' || tokens[i + 1] !== '.' || kind === undefined || !registrationKinds.has(kind) || tokens[i + 3] !== '(') continue;
        const expression: string[] = [];
        let end = i + 4;
        while (end < tokens.length && tokens[end] !== ',' && tokens[end] !== ')') expression.push(tokens[end++]!);
        let channel: unknown;
        const first = expression[0];
        if (expression.length === 1 && first && /^(['"`])[A-Za-z0-9:._-]+\1$/.test(first)) {
            channel = first.slice(1, -1);
        } else if (first) {
            channel = bindings[first];
            for (let part = 1; part < expression.length; part += 2) {
                channel = expression[part] === '.' && expression[part + 1] && channel && typeof channel === 'object'
                    ? (channel as Record<string, unknown>)[expression[part + 1]!] : undefined;
            }
        }
        if (typeof channel !== 'string') throw new Error(`${file}: unresolved IPC channel ${expression.join('')}`);
        found.push(channel);
    }
    return found;
}

function sourceChannels(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? sourceChannels(path) : entry.name.endsWith('.ts') ? channels(readFileSync(path, 'utf8'), path) : [];
    });
}

function differences(registered: readonly string[], inventoried: readonly string[]) {
    return {
        unlisted: registered.filter((channel) => !inventoried.includes(channel)).sort(),
        stale: inventoried.filter((channel) => !registered.includes(channel)).sort(),
    };
}

describe('P4 IPC inventory', () => {
    const registered = sourceChannels(fileURLToPath(new URL('../src/main/', import.meta.url)));
    const inventoried = IPC_INVENTORY.map(([channel]) => channel);

    it('classifies every actual main-process registration, without a stale table row', () => {
        expect(registered.length).toBeGreaterThan(0);
        expect(differences(registered, inventoried)).toEqual({ unlisted: [], stale: [] });
    });

    it('records each channel exactly once on both sides', () => {
        expect(new Set(registered).size).toBe(registered.length);
        expect(new Set(inventoried).size).toBe(inventoried.length);
    });

    /*
     * THE GUARD (Tynn #898 step 2e, story #899). A client is a dumb terminal: the window keeps only what is the window's own.
     * Every row is the protocol door, another process's, a NAMED window capability, or a NAMED step that moves it onto the
     * one protocol. "window-port" and "later:" said neither what the window keeps nor why, and are gone.
     */
    const KNOWN = new RegExp(`^(protocol-door|browser-process|doctor-process|window:(${WINDOW_CAPABILITIES.join('|')})|move:(${MOVE_STEPS.join('|')}))$`);
    it('names the protocol door, another process, a window capability, or the step that moves it', () => {
        for (const [channel, destination] of IPC_INVENTORY) expect(destination, channel).toMatch(KNOWN);
    });

    it('the window capabilities are exactly the window-local operations, and nothing that reaches the host', () => {
        expect([...WINDOW_CAPABILITIES].sort()).toEqual(['chrome', 'clipboard', 'feature-effect', 'file-dialog', 'gapp-window', 'host-wait', 'os-shell', 'pop-out', 'site-panel', 'stall-report', 'take-over-window', 'trash'].sort());
    });

    it('CONTROL: a destination nobody knows is not one', () => {
        expect('browser-proces').not.toMatch(KNOWN);
        expect('window-port').not.toMatch(KNOWN);
        expect('later:question window').not.toMatch(KNOWN);
        expect('window:agents').not.toMatch(KNOWN);
        expect('move:2z').not.toMatch(KNOWN);
        expect('window:chrome').toMatch(KNOWN);
        expect('move:2b').toMatch(KNOWN);
    });

    /*
     * THE RATCHET: what still reaches a host feature off the one protocol, frozen here, by the step that moves it (the
     * coordinator, 2026-11-19). This list only shrinks: a channel leaves it in the PR that moves it. A new row cannot join
     * it, and a row on it cannot be re-labelled a window capability while its handler is still registered.
     */
    const STILL_TO_MOVE: Readonly<Record<string, string>> = {
        // 2b (#896): sign-ins, Take Over and the share link.
        'genie:connect-link': '2b',
        // 2c (#897): the crash report, the provider's program, the scratch terminal and Add workspace.
        'genie:crash-report-draft': '2c', 'genie:crash-report-send': '2c', 'genie:provider-choose-program': '2c',
        'genie:scratch-terminal-open': '2c', 'genie:add-workspace': '2c',
        // 2f (#912): the question window's answers and reads, the device/relay frame path, the relay browser open, host-wait's act.
        'question:answer': '2f', 'question:dismiss': '2f', 'question:files': '2f', 'question:file': '2f', 'question:visuals': '2f',
        'genie:device-open': '2f', 'genie:relay-open': '2f', 'genie:relay-send': '2f', 'genie:relay-close': '2f',
        'genie:browser-window-open': '2f', 'host-wait:act': '2f',
    };
    const moveRows = (rows: readonly (readonly [string, string])[]) => rows.filter(([, d]) => d.startsWith('move:')).map(([c, d]) => [c, d.slice('move:'.length)] as const);
    const ratchet = (rows: readonly (readonly [string, string])[], registeredNow: readonly string[]) => ({
        joined: moveRows(rows).filter(([c, step]) => STILL_TO_MOVE[c] !== step).map(([c]) => c).sort(),
        relabelled: Object.keys(STILL_TO_MOVE).filter((c) => registeredNow.includes(c) && !moveRows(rows).some(([m]) => m === c)).sort(),
    });

    it('THE RATCHET: every still-to-move row is on the frozen list under its step, and every frozen channel still registered is still to move', () => {
        expect(ratchet(IPC_INVENTORY, registered)).toEqual({ joined: [], relabelled: [] });
    });

    it('CONTROL: the ratchet notices a new still-to-move row and a frozen one re-labelled a window capability', () => {
        expect(ratchet([['genie:new-host-thing', 'move:2b']], []).joined).toEqual(['genie:new-host-thing']);
        expect(ratchet([['question:answer', 'move:2c']], []).joined).toEqual(['question:answer']);
        expect(ratchet([['question:answer', 'window:pop-out']], ['question:answer']).relabelled).toEqual(['question:answer']);
        // A frozen channel whose handler is gone needs no row (the stale check removes it): the list shrinks.
        expect(ratchet([], [])).toEqual({ joined: [], relabelled: [] });
    });

    // Tynn #562: which process answers each browser row. The browser process runs genie-browser-electron.ts; the window keeps
    // only its fallback copy of that file until P6, and the site panels are webviews in the window by design.
    describe('the two processes', () => {
        const src = (name: string) => fileURLToPath(new URL(`../src/main/${name}`, import.meta.url));
        const browserFile = channels(readFileSync(src('genie-browser-electron.ts'), 'utf8'), 'genie-browser-electron.ts');
        const rowsFor = (destination: string) => IPC_INVENTORY.filter(([, d]) => d === destination).map(([channel]) => channel);

        it('no row waits on P2b any more', () => {
            expect(IPC_INVENTORY.filter(([, d]) => d.startsWith('later:P2b')).map(([channel]) => channel)).toEqual([]);
        });

        it('browser-process is exactly what genie-browser-electron.ts registers, and that is what the browser process runs', () => {
            expect(browserFile.length).toBeGreaterThan(0);
            expect(rowsFor('browser-process').sort()).toEqual([...browserFile].sort());
            expect(readFileSync(src('browser-process.ts'), 'utf8')).toContain("from './genie-browser-electron.js'");
        });

        const windowRows = () => IPC_INVENTORY.filter(([, d]) => d.startsWith('window:')).map(([channel]) => channel);

        it('a window capability is never registered in the browser process\'s file', () => {
            expect(windowRows().filter((channel) => browserFile.includes(channel))).toEqual([]);
        });

        it('doctor-process is exactly what doctor mode registers besides the clipboard, and no window row is doctor\'s', () => {
            const doctorFile = channels(readFileSync(src('doctor.ts'), 'utf8'), 'doctor.ts').filter((channel) => channel !== CLIPBOARD_WRITE_CHANNEL);
            expect(doctorFile.length).toBeGreaterThan(0);
            expect(rowsFor('doctor-process').sort()).toEqual([...doctorFile].sort());
        });

        it('the site panels are the window\'s site-panel capability; the window\'s opener moves in 2f (its relay mode)', () => {
            const panels = channels(readFileSync(src('site-panels-electron.ts'), 'utf8'), 'site-panels-electron.ts');
            expect(panels.length).toBeGreaterThan(0);
            expect(panels.filter((channel) => !rowsFor('window:site-panel').includes(channel))).toEqual([]);
            expect(rowsFor('move:2f')).toContain('genie:browser-window-open');
        });
    });

    it('reserves protocol-door for the frame channel and requires that channel', () => {
        const doorChannels = (rows: readonly (readonly [string, string])[]) => rows.filter(([, destination]) => destination === 'protocol-door').map(([channel]) => channel);
        expect(doorChannels(IPC_INVENTORY)).toEqual([LOCAL_FRAME_CHANNELS.toHost]);
        const unapproved = doorChannels([['genie:unapproved', 'protocol-door']]).filter((channel) => channel !== LOCAL_FRAME_CHANNELS.toHost);
        expect(unapproved).toEqual(['genie:unapproved']);
    });

    it('CONTROL: notices an added registration and a removed registration', () => {
        expect(differences(['new:channel'], [])).toEqual({ unlisted: ['new:channel'], stale: [] });
        expect(differences([], ['old:channel'])).toEqual({ unlisted: [], stale: ['old:channel'] });
    });

    it.each(['handle', 'on', 'once', 'handleOnce'])('CONTROL: an ipcMain.%s call cannot go unlisted', (kind) => {
        const found = channels(`ipcMain.${kind}('control:channel', () => {});`, 'control.ts');
        expect(found).toEqual(['control:channel']);
        expect(differences(found, [])).toEqual({ unlisted: ['control:channel'], stale: [] });
    });

    it('CONTROL: scans calls, not comments, and resolves the real channel constants', () => {
        expect(channels(`// ipcMain.handle('not:a:call', () => {});
            const text = "ipcMain.handle('not:a:call', () => {})";
            ipcMain.handle(CLIPBOARD_WRITE_CHANNEL, () => {});
            ipcMain.handle(FEATURE_CHANNELS.browserBounds, () => {});`, 'control.ts'))
            .toEqual([CLIPBOARD_WRITE_CHANNEL, FEATURE_CHANNELS.browserBounds]);
        expect(() => channels('ipcMain.handle(unlistedBinding, () => {});', 'control.ts')).toThrow('unresolved IPC channel');
    });
});
