import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageBridge, type PreloadBridge } from '../src/renderer/bridge.js';

const exposed = vi.hoisted(() => new Map<string, unknown>());
// Keep quoted strings/templates intact while removing comments, including historical explanations.
const mentionsLegacyFlag = (source: string) => /\bGENIE_E2E\b/.test(source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    (piece) => piece.startsWith('//') || piece.startsWith('/*') ? '' : piece));
vi.mock('electron', () => ({
    contextBridge: { exposeInMainWorld: (name: string, value: unknown) => exposed.set(name, value) },
    ipcRenderer: { invoke: async () => null, on: () => {}, removeListener: () => {}, send: () => {} },
}));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); exposed.clear(); });

describe('the native harness uses the actual page bridge only when main enables it', () => {
    it('only main GENIE_PAGE_PROBE=1 supplies the preload argument, on the main window', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        const create = main.slice(main.indexOf('function createWindow('), main.indexOf('// Links open in the browser', main.indexOf('function createWindow(')));
        expect(create.includes("additionalArguments: process.env.GENIE_PAGE_PROBE === '1' ? ['--genie-page-probe'] : []")).toBe(true);
        expect(main.split("['--genie-page-probe']")).toHaveLength(2);
    });
    it('no source code reads the retired GENIE_E2E flag (comments may explain its history)', () => {
        expect(mentionsLegacyFlag('process.env.GENIE_E2E')).toBe(true);
        expect(mentionsLegacyFlag("process.env['GENIE_E2E']")).toBe(true);
        expect(mentionsLegacyFlag('// GENIE_E2E\n/* GENIE_E2E */')).toBe(false);
        const offenders: string[] = [];
        for (const file of readdirSync('src', { recursive: true, encoding: 'utf8' }).filter((file) => /\.tsx?$/.test(file))) {
            if (mentionsLegacyFlag(readFileSync(join('src', file), 'utf8'))) offenders.push(file);
        }
        expect(offenders).toEqual([]);
    });
    it.each([false, true])('preload carries enabled=%s from its main-supplied argument, outside window.genie', async (enabled) => {
        const previous = process.argv;
        try {
            process.argv = ['electron', 'app', ...(enabled ? ['--genie-page-probe'] : [])];
            vi.resetModules(); await import('../src/main/preload.js');
            expect(exposed.get('genieTestMode')).toBe(enabled);
            expect(exposed.has('genieTest')).toBe(false); // The renderer must supply its own shared object.
            const preload = exposed.get('genie') as object;
            expect(preload).toBeDefined();
            expect('genieTest' in preload).toBe(false); expect('agents' in preload).toBe(false);
        } finally { process.argv = previous; }
    });
    it.each([undefined, false, true])('pageBridge exposes its same object only for main flag=%s', (enabled) => {
        const preload = { subscribeAgentWire: () => () => {}, workspaces: {} } as unknown as PreloadBridge;
        const page: Record<string, unknown> = { genie: preload, location: { search: '?GENIE_PAGE_PROBE=1' } };
        // contextBridge exposes an immutable value in the page; its query cannot enable it.
        if (enabled !== undefined) Object.defineProperty(page, 'genieTestMode', { value: enabled, writable: false, configurable: false });
        vi.stubGlobal('window', page);
        const bridge = pageBridge(preload);
        expect(pageBridge(preload)).toBe(bridge);
        expect(page['genieTest']).toBe(enabled === true ? bridge : undefined);
        expect(page['genie']).toBe(preload);
        expect('genieTest' in preload).toBe(false); expect('agents' in preload).toBe(false);
    });
    it.each([
        'agents-hold-no-pty-cdp.mjs', 'agent-key-no-window-cdp.mjs', 'agent-never-minted-cdp.mjs',
        'local-door-cdp.mjs', 'quit-keeps-host-cdp.mjs', 'smoke-cdp.mjs', 'update-cdp.mjs',
        'upgrade-acceptance-mint-cdp.mjs',
    ])('%s drives migrated agent calls through genieTest rather than the retired preload', (script) => {
        const source = readFileSync(`scripts/${script}`, 'utf8');
        expect(source.includes('window.genie.agents.')).toBe(false);
        expect(source.includes('window.genieTest.agents.')).toBe(true);
    });
});
