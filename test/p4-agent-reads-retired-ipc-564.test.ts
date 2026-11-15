import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildHostApi } from '../src/main/host-api.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';

const source = (path: string) => readFileSync(path, 'utf8');

describe('family 9a has one read/watch path after the paired acceptance (Tynn #564)', () => {
    it.each(['genie:snapshot', 'genie:agent-detail', 'genie:agent-watch'])('%s has no native registration, preload forwarding or inventory row', channel => {
        expect(source('src/main/main.ts')).not.toMatch(new RegExp(`ipcMain\\.(?:handle|on)\\('${channel}'`));
        expect(source('src/main/preload.ts')).not.toContain(`'${channel}'`);
        expect(source('src/core/ipc-inventory.ts')).not.toContain(`['${channel}',`);
    });

    it('neither main nor preload produces or receives the retired snapshot and agent push channels', () => {
        for (const path of ['src/main/main.ts', 'src/main/preload.ts']) {
            expect(source(path), path).not.toContain('genie:agent-changed:');
            expect(source(path), path).not.toContain("'genie:changed'");
        }
    });

    it('production has no IPC-baseline or forced-revision measurement switch', () => {
        for (const path of ['src/main/main.ts', 'src/main/preload.ts', 'src/renderer/bridge.ts', 'src/main/remote-host.ts']) {
            for (const flag of ['GENIE_AGENT_READS', 'genie-agent-reads-ipc', 'genieAgentReadsIpc', 'GENIE_SNAPSHOT_PUSH']) {
                expect(source(path), `${path}: ${flag}`).not.toContain(flag);
            }
        }
    });

    it('CONTROL: the window still has its native overlay-color read and the protocol frame door', () => {
        expect(source('src/main/main.ts')).toContain("ipcMain.handle('genie:window-overlay-colors-current'");
        expect(source('src/main/preload.ts')).toContain("ipcRenderer.invoke('genie:window-overlay-colors-current'");
        expect(source('src/core/ipc-inventory.ts')).toContain("['genie:window-overlay-colors-current', 'window-port']");
        expect(source('src/main/preload.ts')).toContain('LOCAL_FRAME_CHANNELS.toHost');
    });

    it('the shared local agent source forwards chat changes as well as session and record changes, and unsubscribes all three', () => {
        const sessions = new Set<(id: string) => void>(), records = new Set<(id: string) => void>(), chat = new Set<(id: string) => void>();
        const subscribe = (listeners: Set<(id: string) => void>) => (listener: (id: string) => void) => {
            listeners.add(listener); return () => { listeners.delete(listener); };
        };
        const deps = protocolContractDeps('/fixture');
        Object.assign(deps.host, { subscribe: subscribe(sessions) });
        Object.assign(deps, { subscribeAgentRecords: subscribe(records), subscribeAgentChat: subscribe(chat) });
        const heard = vi.fn(), off = buildHostApi(deps).localAgents!.onChanged(heard);
        for (const [listeners, id] of [[sessions, 'session-agent'], [records, 'record-agent'], [chat, 'mail-agent']] as const) {
            for (const listener of listeners) listener(id);
        }
        expect(heard.mock.calls).toEqual([['session-agent'], ['record-agent'], ['mail-agent']]);
        off(); heard.mockClear();
        for (const listeners of [sessions, records, chat]) {
            expect(listeners.size).toBe(0);
            for (const listener of listeners) listener('after-unsubscribe');
        }
        expect(heard).not.toHaveBeenCalled();
        // The composition root supplies the real inbox hook, rather than keeping it on the deleted native producer.
        expect(source('src/main/main.ts')).toMatch(/subscribeAgentChat:\s*\(\w+\)\s*=>\s*wireInboxChatUpdates\(composed\.inbox,\s*\w+\)/);
    });
});
