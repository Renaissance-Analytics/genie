import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLIPBOARD_WRITE_CHANNEL } from '../src/core/clipboard-wire.js';
import { IPC_INVENTORY } from '../src/core/ipc-inventory.js';
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

    const KNOWN = /^(protocol:.+|protocol-door|window-port|browser-process|later:.+)$/;
    it('names a protocol method, a window port, the Genie browser process, or the reason it is deferred', () => {
        for (const [, destination] of IPC_INVENTORY) expect(destination).toMatch(KNOWN);
    });

    it('CONTROL: a destination nobody knows is not one', () => {
        expect('browser-proces').not.toMatch(KNOWN);
        expect('later').not.toMatch(KNOWN);
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

        it('a window port is never registered in the browser process\'s file', () => {
            expect(rowsFor('window-port').filter((channel) => browserFile.includes(channel))).toEqual([]);
        });

        it('the site panels and the window\'s opener are window ports', () => {
            const panels = channels(readFileSync(src('site-panels-electron.ts'), 'utf8'), 'site-panels-electron.ts');
            expect(panels.length).toBeGreaterThan(0);
            expect(panels.filter((channel) => !rowsFor('window-port').includes(channel))).toEqual([]);
            expect(rowsFor('window-port')).toContain('genie:browser-window-open');
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
