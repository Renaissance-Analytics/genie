import { describe, expect, it } from 'vitest';
import { HOST_DIRECTORY_EMPTY, hostDirectory, type HostDirectoryInput } from '../src/core/host-directory.js';

/*
 * THE HOST DIRECTORY (Tynn #1058 L4). A client never starts or replaces a host: it links to the host the launcher gives
 * it, or it shows this list. The local host is one of the hosts, not special; with the host stopped the client still
 * opens and offers Start (`launcher.ensureHost`). Paired hosts are the addresses this computer paired with (the host's
 * `runtime/device-hosts.json`: addresses only, never a token). Tynn hosts join when the client has its own sign-in
 * (step 4); until then the list says nothing about them.
 */
const none: HostDirectoryInput = { profile: 'client', local: { kind: 'none' }, paired: [], launcher: false };

describe('a client with no host', () => {
    it('says the empty state in the spec\'s words, and offers to add a host', () => {
        const view = hostDirectory(none);
        expect(view.empty).toBe(HOST_DIRECTORY_EMPTY);
        expect(HOST_DIRECTORY_EMPTY).toBe('No host on this computer. Pick a host, or add one.');
        expect(view.hosts).toEqual([]);
        expect(view.add).toMatchObject({ label: 'Add a host' });
    });

    it('a client profile never lists a local host, even when a stale host.json is left', () => {
        const view = hostDirectory({ ...none, local: { kind: 'stopped', build: '2026.11.26-1' } });
        expect(view.hosts.filter((h) => h.local)).toEqual([]);
        expect(view.empty).toBe(HOST_DIRECTORY_EMPTY);
    });
});

describe('the local host, in the both profile', () => {
    it('stopped: listed as this computer, stopped, with Start through the launcher', () => {
        const view = hostDirectory({ profile: 'both', local: { kind: 'stopped', build: '2026.11.26-1' }, paired: [], launcher: true });
        expect(view.empty).toBeNull();
        expect(view.hosts).toEqual([expect.objectContaining({ id: 'local', local: true, name: 'This computer', state: 'stopped', action: { kind: 'start', label: 'Start' } })]);
    });

    it('stopped with no launcher running: no Start it cannot honour, and it says why', () => {
        const [row] = hostDirectory({ profile: 'both', local: { kind: 'stopped', build: null }, paired: [], launcher: false }).hosts;
        expect(row).toMatchObject({ state: 'stopped', action: null });
        expect(row?.detail).toMatch(/launcher is not running/i);
    });

    it('one that could not start: its reason, and Open log; never a Start that would just fail again', () => {
        const [row] = hostDirectory({ profile: 'both', local: { kind: 'failed', reason: 'The new host exited before it answered.' }, paired: [], launcher: true }).hosts;
        expect(row).toMatchObject({ state: 'failed', detail: 'The new host exited before it answered.', action: { kind: 'open-log', label: 'Open log' } });
    });

    it('one of an engine protocol this client cannot speak: said, never replaced', () => {
        const [row] = hostDirectory({ profile: 'both', local: { kind: 'incompatible', protocol: 1, mine: 2 }, paired: [], launcher: true }).hosts;
        expect(row).toMatchObject({ state: 'incompatible', action: null });
        expect(row?.detail).toMatch(/update/i);
    });
});

describe('paired hosts', () => {
    const paired = ['wss://studio.example:7443', 'ws://10.0.0.5:7443'];
    it('each is listed by its address, after the local host, in the order paired', () => {
        const view = hostDirectory({ profile: 'both', local: { kind: 'stopped', build: null }, paired, launcher: true });
        expect(view.hosts.map((h) => h.id)).toEqual(['local', ...paired]);
        expect(view.hosts.slice(1).every((h) => h.local === false && h.state === 'paired')).toBe(true);
        expect(view.hosts[1]).toMatchObject({ name: 'studio.example', address: 'wss://studio.example:7443' });
    });

    it('on a client-only computer they are listed, and the list is not empty', () => {
        const view = hostDirectory({ ...none, paired });
        expect(view.empty).toBeNull();
        expect(view.hosts).toHaveLength(2);
    });

    it('opening one needs this computer\'s own sign-in (step 4): one short line, the rest for its info tooltip, never a button that does nothing', () => {
        const [row] = hostDirectory({ ...none, paired: [paired[0]!] }).hosts;
        expect(row?.action).toBeNull();
        expect(row?.detail).toBe('Open from a computer with a host until sign-in arrives');
        expect(row?.more).toMatch(/own Genie sign-in/);
    });

    it('each row says what it is by its icon: this computer, a host at an address, a Tynn relay host', () => {
        const view = hostDirectory({ profile: 'both', local: { kind: 'stopped', build: null }, paired: ['wss://studio.example:7443', 'relay:ws_01'], launcher: true });
        expect(view.hosts.map((h) => h.icon)).toEqual(['monitor', 'server', 'cloud']);
    });
});

describe('the status dot', () => {
    it('green running, amber stopped or needing an update, red could not start, grey when not known', () => {
        const dot = (local: HostDirectoryInput['local']) => hostDirectory({ profile: 'both', local, paired: [], launcher: true }).hosts[0]?.dot;
        expect(dot({ kind: 'running', build: '2026.11.27-1' })).toBe('green');
        expect(dot({ kind: 'stopped', build: null })).toBe('amber');
        expect(dot({ kind: 'incompatible', protocol: 1, mine: 2 })).toBe('amber');
        expect(dot({ kind: 'failed', reason: 'x' })).toBe('red');
        expect(hostDirectory({ ...none, paired: ['ws://10.0.0.5:7443'] }).hosts[0]?.dot).toBe('grey');
    });

    it('running: the local host Start started, said while its window opens, with nothing left to press', () => {
        const [row] = hostDirectory({ profile: 'both', local: { kind: 'running', build: '2026.11.27-1' }, paired: [], launcher: true }).hosts;
        expect(row).toMatchObject({ state: 'running', action: null });
        expect(row?.detail).toMatch(/running/i);
    });

    it('a duplicate or something that is not a host address is not listed', () => {
        const view = hostDirectory({ ...none, paired: ['wss://studio.example:7443', 'wss://studio.example:7443', 'file:///etc/passwd', ''] });
        expect(view.hosts.map((h) => h.id)).toEqual(['wss://studio.example:7443']);
    });
});
