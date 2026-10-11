import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HUMAN } from '../src/core/inbox.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { featureSnapshot, handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * THE HUMAN SENDS ATTACHMENTS (§6.4). From the AgentInbox surface the person sends mail with files: the
 * store keeps BYTE COPIES (content-addressed), never a path the recipient could not read; an executable
 * is refused at the send and the whole send fails with the file named; what the person receives shows its
 * attachments by name and size. The paths come from the host's own file picker, never typed into a terminal.
 */

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });

let dir: string;
let files: string;
let services: ComposedServices;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-inbox-att-'));
    files = await mkdtemp(join(tmpdir(), 'genie2-inbox-files-'));
    await writeFile(join(files, 'notes.md'), '# plan\nship it\n');
    await writeFile(join(files, 'tool.exe'), 'MZ');
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0 });
    services.registerAgentName('agent_a' as never, { name: 'atlas', workspaceId: 'tynn' });
    services.registerAgentAddress('claude:atlas', 'agent_a' as never);
});
afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
    await rm(files, { recursive: true, force: true });
});

describe('inbox.send with attachments', () => {
    it('stores byte copies the recipient can fetch, with name, size and sha256; the path itself is not kept', async () => {
        await handleFeatureAction(services, { kind: 'inbox.send', to: 'claude:atlas', text: 'read this', attachments: [join(files, 'notes.md')] }, state());
        const [msg] = services.inbox.unread('agent_a' as never);
        expect(msg!.attachments).toHaveLength(1);
        const a = msg!.attachments[0]!;
        expect(a).toMatchObject({ name: 'notes.md', size: Buffer.byteLength('# plan\nship it\n'), sha256: createHash('sha256').update('# plan\nship it\n').digest('hex') });
        expect(JSON.stringify(msg)).not.toContain(files.replace(/\\/g, '/'));
        expect((await services.inbox.attachmentBytes('agent_a' as never, a.id)).toString()).toBe('# plan\nship it\n');
    });

    it('an executable is refused at the send and nothing is delivered', async () => {
        await expect(handleFeatureAction(services, { kind: 'inbox.send', to: 'claude:atlas', text: 'run this', attachments: [join(files, 'tool.exe')] }, state())).rejects.toThrow(/tool\.exe/);
        expect(services.inbox.unread('agent_a' as never)).toEqual([]);
    });

    it('mail to the human carries its attachments into the snapshot', async () => {
        await services.inbox.send({ from: 'agent_a' as never, to: HUMAN, text: 'done, see the diff', attachments: [join(files, 'notes.md')] });
        const snap = await featureSnapshot(services, state());
        expect(snap.inbox!.unread[0]!.attachments[0]).toMatchObject({ name: 'notes.md', size: Buffer.byteLength('# plan\nship it\n') });
    });
});
