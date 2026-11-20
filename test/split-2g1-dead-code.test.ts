import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WINDOW_ENGINE_INVENTORY } from '../src/core/ipc-inventory.js';

/*
 * CLIENT/HOST SPLIT STEP 2g-1 (Tynn #898, story #952; part of #913). A client is a dumb terminal, and main held replicas of
 * genie-host's services that nothing reads any more: the machine identity, the Tynn page reader, the App Inbox keys and
 * state, the Tynn board's and the new-agent form's ports, the share-link request, the role reader, the relay's status, and
 * a second remote-access apply beside genie-host's own at boot. They go, and with them three engine uses: `workstation`,
 * `tynnPage` and `appInbox`.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

describe('main holds no replica nothing reads (2g-1)', () => {
    const main = code(src('src/main/main.ts'));

    it('the dead replicas and ports are gone from main', () => {
        for (const gone of [
            'machineIdentity', 'readWorkspaceTynnPage', 'function tynnBoardPorts', 'function agentCreatePorts',
            'linkedAppInbox', 'appInboxKeys', 'appInboxState', 'ownWorkstation', 'shareRequest',
            'const readRole', 'relayStatusNow', 'tynnWorkstationNow', 'remoteAccessNow',
        ]) expect(main, gone).not.toContain(gone);
    });

    it('main no longer reaches workstation, tynnPage or appInbox over its engine link; the rows leave both lists', () => {
        for (const use of ['workstation', 'tynnPage', 'appInbox']) {
            expect(main, use).not.toMatch(new RegExp(`client\\??\\.${use}\\(`));
            expect(WINDOW_ENGINE_INVENTORY.map(([u]) => u), use).not.toContain(use);
            expect(src('test/split-2e-window-guard.test.ts'), use).not.toMatch(new RegExp(`\\b${use}: '2g'`));
        }
    });

    it('CONTROL: remote access is applied by genie-host itself at boot and on every change, so nothing is lost', () => {
        const host = code(src('src/main/genie-host.ts'));
        expect(host).toMatch(/\n {4}void remoteSwitch\.apply\(\)\.catch\(/);
        expect(host).toMatch(/if \(key === 'remote_access' && workspaceId === undefined\) void remoteSwitch\.apply\(\)/);
    });
});
