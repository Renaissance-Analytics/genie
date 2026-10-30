import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import { featureOrigin, HostPicks, REMOTE_ORIGIN } from '../src/main/host-picks.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { uploadSender } from '../src/main/uploads.js';

/**
 * ONLY THE HOST'S OWN WINDOW NAMES A PATH ON THE HOST (genie#1354, after genie#1347).
 *
 * The person's AgentInbox attachments are host paths, read and copied at send time. That is right for the person AT the
 * host, picking in the host's own picker. The same feature action is reachable by a client that is NOT at the host — a
 * paired device, a relay connection, a share guest, the mobile web app — through the remote API's `features.act`; such a
 * client may attach only BYTES it uploads (`inbox.sendFile`), never a path on the host. Genie 1 (v0.7.0-beta.342) sent the
 * person's files as inline bytes: main/agentinbox/human.ts `postAsHuman` → main/agentinbox/attachments.ts
 * `storeInlineAttachments`, read in renderer/components/Master/AgentInboxFlyout.tsx `readFileAsBase64`.
 *
 * Locality comes from WHERE the request arrived (main's own IPC, from a window that is not a remote window), never from
 * anything in the request: the default origin is remote, and a field in the action claiming otherwise changes nothing.
 */

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });

let dir: string;
let files: string;
let services: ComposedServices;
let roster: AgentRecord[] = [];
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-remote-attach-'));
    files = await mkdtemp(join(tmpdir(), 'genie2-remote-attach-files-'));
    await writeFile(join(files, 'notes.md'), '# plan\n');
    await writeFile(join(files, 'secret.txt'), 'host secret');
    roster = [{ id: 'agent_a', workspaceId: 'tynn', provider: 'claude', name: 'atlas', instructions: null, threadId: null, createdAt: '2026-10-12T00:00:00.000Z', lastUsedAt: null } as never];
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => roster });
});
afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
    await rm(files, { recursive: true, force: true });
});

const send = (attachments: string[], origin?: Parameters<typeof handleFeatureAction>[4], extra: Record<string, unknown> = {}) =>
    handleFeatureAction(services, { kind: 'inbox.send', to: 'claude:atlas', text: 'see attached', attachments, ...extra } as never, state(), {}, origin);

describe('a remote client names a host path', () => {
    it('is refused, and nothing is delivered or stored', async () => {
        await expect(send([join(files, 'secret.txt')], REMOTE_ORIGIN)).rejects.toThrow(/only from its own window/);
        expect(services.inbox.unread('agent_a' as never)).toEqual([]);
        expect(await readdir(services.inbox.attachmentsDir).catch(() => [])).toEqual([]);
    });

    it('is the DEFAULT: a caller that says nothing about where it came from is remote (the remote API passes nothing)', async () => {
        await expect(send([join(files, 'secret.txt')])).rejects.toThrow(/only from its own window/);
        expect(services.inbox.unread('agent_a' as never)).toEqual([]);
    });

    it('cannot claim to be local from inside the request', async () => {
        for (const claim of [{ origin: 'local' }, { origin: { kind: 'local' } }, { local: true }, { from: 'host' }]) {
            await expect(send([join(files, 'secret.txt')], undefined, claim)).rejects.toThrow(/only from its own window/);
        }
        expect(services.inbox.unread('agent_a' as never)).toEqual([]);
    });

    it('still sends a message with NO attachment (POSITIVE CONTROL: the refusal is about the path, not the sender)', async () => {
        await send([], REMOTE_ORIGIN);
        expect(services.inbox.unread('agent_a' as never).map((m) => m.text)).toEqual(['see attached']);
    });
});

describe('a remote client uploads bytes', () => {
    it('delivers them — the inbox keeps its own copy, and the temp file is gone', async () => {
        const uploads = join(dir, 'uploads');
        const sender = uploadSender({ dir: uploads, resolve: (to) => services.resolveAddress(to), send: (input) => services.inbox.send(input) });
        const r = await sender.sendFile('claude:atlas', 'from my phone', 'photo.png', new TextEncoder().encode('png bytes'));
        expect(r).toMatchObject({ ok: true });
        const [msg] = services.inbox.unread('agent_a' as never);
        expect(msg!.text).toBe('from my phone');
        expect(msg!.attachments.map((a) => a.name)).toEqual(['photo.png']);
        expect((await services.inbox.attachmentBytes('agent_a' as never, msg!.attachments[0]!.id)).toString()).toBe('png bytes');
        expect(await readdir(uploads)).toEqual([]);
    });
});

describe('the host’s own window', () => {
    it('sends what the person picked in its picker', async () => {
        const picks = new HostPicks();
        picks.record([join(files, 'notes.md')]);
        await send([join(files, 'notes.md')], featureOrigin({ remoteWindow: false, picks }));
        const [msg] = services.inbox.unread('agent_a' as never);
        expect(msg!.attachments.map((a) => a.name)).toEqual(['notes.md']);
    });

    it('refuses a path its picker never picked — one unpicked path fails the whole send', async () => {
        const picks = new HostPicks();
        picks.record([join(files, 'notes.md')]);
        await expect(send([join(files, 'notes.md'), join(files, 'secret.txt')], featureOrigin({ remoteWindow: false, picks }))).rejects.toThrow(/secret\.txt was not picked/);
        expect(services.inbox.unread('agent_a' as never)).toEqual([]);
    });

    it('a REMOTE window on this machine (driving another host) is not the host’s own window, even with a pick on record', async () => {
        const picks = new HostPicks();
        picks.record([join(files, 'notes.md')]);
        await expect(send([join(files, 'notes.md')], featureOrigin({ remoteWindow: true, picks }))).rejects.toThrow(/only from its own window/);
    });
});

describe('HostPicks', () => {
    it('remembers what was picked by its resolved path, and nothing else', () => {
        const picks = new HostPicks();
        picks.record([join(files, 'a', '..', 'notes.md')]);
        expect(picks.has(join(files, 'notes.md'))).toBe(true);
        expect(picks.has(join(files, 'secret.txt'))).toBe(false);
        expect(picks.has('')).toBe(false);
    });

    it('ignores what is not an absolute path (a picker returns absolute paths)', () => {
        const picks = new HostPicks();
        picks.record(['notes.md', 42 as never, '' as never]);
        expect(picks.has(resolve('notes.md'))).toBe(false);
    });

    it('is bounded: an old pick falls out rather than the ledger growing forever', () => {
        const picks = new HostPicks(3);
        picks.record([join(files, '1'), join(files, '2'), join(files, '3'), join(files, '4')]);
        expect(picks.has(join(files, '1'))).toBe(false);
        expect(picks.has(join(files, '4'))).toBe(true);
    });
});

/*
 * THE WIRING (main.ts): read as text, comments stripped, because main.ts only runs inside Electron. The remote API's
 * `features.act` must name NO origin (so it is the default, remote); main's own IPC must derive the origin from the
 * SENDER — whether it is one of the remote windows — and record picks only from a window that is not one.
 */
describe('main.ts wiring', () => {
    const source = readFileSync('src/main/main.ts', 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
        .join('\n');

    it('the remote API’s features.act passes no origin', () => {
        expect(source).toMatch(/act: \(action\) => handleFeatureAction\(services!, action, featureState, featurePorts\),/);
    });

    it('main’s own IPC derives the origin from the sender, and records picks only from a window that is not remote', () => {
        expect(source).toMatch(/ipcMain\.handle\(FEATURE_CHANNELS\.act, async \(event, raw: unknown\) => \{[\s\S]{0,400}handleFeatureAction\(composed, action, featureState, featurePorts, featureOrigin\(\{ remoteWindow: isRemoteWindow\(event\.sender\), picks: hostPicks \}\)\)/);
        expect(source).toMatch(/ipcMain\.handle\(FEATURE_CHANNELS\.picked, \(event, raw: unknown\) => \{\s*if \(isRemoteWindow\(event\.sender\)\) return;/);
    });
});
