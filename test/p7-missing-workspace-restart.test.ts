import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import * as ops from '../src/main/workspace-ops-host.js';

/**
 * P7.3b — A RESTART IS A START TOO (Tynn #419). A workspace whose folder is gone starts nothing: `startRefusal` holds that
 * for every start a person or a flow asks for. genie-host has one more start that does not go through it: `trustRestart`
 * (a workspace's trust verdict changed, or a sign-in landed, while its agent ran): stop, then start on the same
 * conversation. In a missing workspace that stopped a running agent and then started it in a folder that is not there.
 * It is refused BEFORE the stop, in the same words, and the agent is left as it was.
 */

interface WithMissing { missingFolderRefusal(missing: { pathIfMissing(workspaceId: string): string | null } | undefined, record: { workspaceId: string; name: string }): string | null }
const missingFolderRefusal = (ops as unknown as WithMissing).missingFolderRefusal;
const record = agentRecord({ id: mintAgentId(), workspaceId: 'ws-gone', provider: 'claude', name: 'builder' });
const missing = { pathIfMissing: (id: string): string | null => (id === 'ws-gone' ? '/mnt/drive/ws-gone' : null) };

describe('the refusal for a workspace whose folder is gone, on its own', () => {
    it('says the workspace, the folder and the agent; nothing for a workspace that is there, or where no such flag is kept', () => {
        expect(missingFolderRefusal(missing, record)).toBe('ws-gone\'s folder is not there (/mnt/drive/ws-gone): locate it from the Dashboard before starting builder');
        // CONTROL: the same agent in a workspace that is there.
        expect(missingFolderRefusal(missing, { ...record, workspaceId: 'ws-here' })).toBeNull();
        expect(missingFolderRefusal(undefined, record)).toBeNull();
    });

    it('is the one startRefusal gives: one sentence, one place', () => {
        const registry = { workspace: (id: string) => ({ id }) };
        expect(ops.startRefusal({ registry, missing } as never, record)).toBe(missingFolderRefusal(missing, record));
    });
});

describe('wired: trustRestart refuses before it stops anything', () => {
    // The working tree's line ends are the machine's (CRLF on Windows): read as LF.
    const src = readFileSync('src/main/genie-host.ts', 'utf8').split(String.fromCharCode(13)).join('');
    const start = src.indexOf('const trustRestart = async');
    const body = src.slice(start, src.indexOf('\n    };\n', start));

    it('CONTROL: the slice is the function, and it does stop and start', () => {
        expect(start).toBeGreaterThan(0);
        expect(body).toMatch(/host\.stop\(id\)/);
        expect(body).toMatch(/host\.start\(record, /);
    });

    it('asks for the missing-folder refusal with this host’s flag, and returns it, before host.stop', () => {
        const asked = body.indexOf('missingFolderRefusal(missingWorkspaces, record)');
        expect(asked).toBeGreaterThan(0);
        expect(asked).toBeLessThan(body.indexOf('host.stop(id)'));
        expect(body.slice(asked, body.indexOf('host.stop(id)'))).toMatch(/return \{ ok: false, reason: \w+ \}/);
    });
});
