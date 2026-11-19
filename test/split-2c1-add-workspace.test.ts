import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IPC_INVENTORY } from '../src/core/ipc-inventory.js';
import { REMOTE_METHODS, capabilityOf, type RemoteMethod } from '../src/core/remote-protocol.js';
import { HOST_ALONE_METHODS } from '../src/main/host-alone-api.js';

/*
 * CLIENT/HOST SPLIT STEP 2c-1, ADD WORKSPACE (Tynn #898, story #897; the coordinator's ruling, 2026-11-19). Every client
 * adds a workspace with workspaces.previewAdd / workspaces.confirmAdd, answered by genie-host, the folder chosen in the
 * window's host-disk picker. The old `addWorkspace` method only ever refused ("opens a folder picker on the host; do it
 * there"), and the window's `genie:add-workspace` (a native picker straight into the registry) has no caller. Both go,
 * and with them a refusal; main's workspace lifecycle wiring, kept only for that channel, goes too.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

describe('the old addWorkspace method is retired, and its refusals with it', () => {
    it('is no longer a remote method', () => {
        expect(REMOTE_METHODS as readonly string[]).not.toContain('addWorkspace');
    });

    it('neither the host API nor RemoteHost answers or refuses it', () => {
        expect(code(src('src/main/host-api.ts'))).not.toMatch(/case 'addWorkspace'/);
        expect(code(src('src/main/remote-host.ts'))).not.toMatch(/method === 'addWorkspace'/);
    });

    it('CONTROL: every client still adds a workspace, through previewAdd and confirmAdd, which genie-host answers', () => {
        for (const method of ['workspaces.previewAdd', 'workspaces.confirmAdd'] as RemoteMethod[]) {
            expect(REMOTE_METHODS as readonly string[]).toContain(method);
            expect(HOST_ALONE_METHODS.has(method), method).toBe(true);
            expect(capabilityOf(method)).not.toBe('host-only');
        }
    });
});

describe('the window’s genie:add-workspace is gone', () => {
    const main = code(src('src/main/main.ts'));

    it('no handler in main, no preload line, no bridge member, no inventory row', () => {
        expect(main).not.toContain("ipcMain.handle('genie:add-workspace'");
        expect(code(src('src/main/preload.ts'))).not.toContain("'genie:add-workspace'");
        expect(code(src('src/renderer/bridge.ts'))).not.toMatch(/^\s*addWorkspace\(\): void;/m);
        expect(code(src('src/renderer/remote-bridge.ts'))).not.toMatch(/fire\('addWorkspace'\)/);
        expect(IPC_INVENTORY.map(([c]) => c)).not.toContain('genie:add-workspace');
        expect(src('test/ipc-inventory.test.ts')).not.toMatch(/'genie:add-workspace': '2c'/);
    });

    it('main composes no workspace lifecycle of its own', () => {
        expect(main).not.toMatch(/\bworkspaceLifecyclePorts\(|\blifecycleWiring\b|\bworkspaceOps\b/);
    });
});
