/**
 * EVERY SIGN-IN IS A FRESH LINK, AND A FAILED CONNECT SAYS WHY (Tynn #675, genie#708). On Linux after an upgrade the
 * Tailscale row's Sign in opened a login page that said the link had expired, and Connect showed an error with no reason.
 *
 * A Tailscale login link is issued for one login and expires. `tailscale status --json` keeps reporting the daemon's LAST
 * one (`AuthURL`) until a login completes, so a link read from status may be long dead; Tailscale's own `up` treats it
 * that way (cmd/tailscale/cli/up.go: with `--force-reauth` it never prints the URL status already held). A bare
 * `tailscale up` on a node that still has a node key but needs a login does not ask for a new login at all
 * (`StartLoginInteractive` runs only `if upArgs.forceReauth || !st.HaveNodeKey`), so it prints nothing and waits until
 * Genie's timeout kills it. The documented way to ask for a new login is `tailscale up --force-reauth`.
 *
 * The fake below models just that much of the daemon: no network, no real Tailscale.
 */
import { describe, expect, it } from 'vitest';
import { getTailscaleStatus, tailscaleUp, type TailscaleCliDeps } from '../src/main/tailscale-cli.js';

const CLI = '/usr/bin/tailscale';
const EXPIRED = 'https://login.tailscale.com/a/expired0000';

/** The error execFile rejects with when its timeout kills the child: Node's own shape. */
function killed(args: string[], stderr: string): Error {
    return Object.assign(new Error(`Command failed: ${CLI} ${args.join(' ')}\n${stderr}`), { killed: true, signal: 'SIGTERM', code: null, stdout: '', stderr });
}

/** A Tailscale daemon as `tailscale up` sees it. */
function fakeDaemon(start: { backend: 'NeedsLogin' | 'Stopped'; haveNodeKey: boolean; pending: string | null }) {
    let pending = start.pending;
    let issued = 0;
    const calls: string[][] = [];
    const run: NonNullable<TailscaleCliDeps['run']> = async (_cli, args) => {
        calls.push(args);
        if (args[0] === 'status') {
            return { stdout: JSON.stringify({ BackendState: start.backend, AuthURL: pending ?? '', Self: null, Peer: {} }), stderr: '' };
        }
        if (args[0] === 'up') {
            if (start.backend === 'Stopped') return { stdout: '', stderr: '' };
            const forceReauth = args.includes('--force-reauth');
            if (forceReauth || !start.haveNodeKey) {
                // StartLoginInteractive: control issues a NEW link, `up` prints it and waits for the login.
                issued += 1;
                pending = `https://login.tailscale.com/a/fresh${String(issued).padStart(4, '0')}`;
                throw killed(args, `\nTo authenticate, visit:\n\n\t${pending}\n\n`);
            }
            // A node key and no new login asked for: nothing new to print; `up` waits until it is killed.
            throw killed(args, '');
        }
        throw new Error(`unexpected tailscale ${args.join(' ')}`);
    };
    return { run, calls };
}

describe('Tailscale sign-in: a freshly issued link every time (Tynn #675)', () => {
    it('a second sign-in, after the first link would have expired, asks Tailscale for a NEW link and opens that', async () => {
        const daemon = fakeDaemon({ backend: 'NeedsLogin', haveNodeKey: true, pending: EXPIRED });
        const first = await tailscaleUp({ cliPath: () => CLI, platform: 'linux', run: daemon.run });
        const second = await tailscaleUp({ cliPath: () => CLI, platform: 'linux', run: daemon.run });
        expect(first.authUrl).toBe('https://login.tailscale.com/a/fresh0001');
        expect(second.authUrl).toBe('https://login.tailscale.com/a/fresh0002');
        expect([first.authUrl, second.authUrl]).not.toContain(EXPIRED);
        expect(second.state).toBe('needs-login');
    });

    it('the status Genie keeps never carries a sign-in link (the one Tailscale reports may be long dead)', async () => {
        const daemon = fakeDaemon({ backend: 'NeedsLogin', haveNodeKey: true, pending: EXPIRED });
        const s = await getTailscaleStatus({ cliPath: () => CLI, platform: 'linux', run: daemon.run });
        expect(s.state).toBe('needs-login');
        expect(JSON.stringify(s)).not.toContain(EXPIRED);
        expect('authUrl' in s).toBe(false);
    });

    it('CONTROL: a first sign-in on a fresh install opens the link it was given', async () => {
        const daemon = fakeDaemon({ backend: 'NeedsLogin', haveNodeKey: false, pending: null });
        const r = await tailscaleUp({ cliPath: () => CLI, platform: 'linux', run: daemon.run });
        expect(r.ok).toBe(false);
        expect(r.state).toBe('needs-login');
        expect(r.authUrl).toBe('https://login.tailscale.com/a/fresh0001');
    });

    it('CONTROL: a signed-in node that is only down connects with a plain `up`, no forced re-login', async () => {
        const daemon = fakeDaemon({ backend: 'Stopped', haveNodeKey: true, pending: null });
        const r = await tailscaleUp({ cliPath: () => CLI, platform: 'linux', run: daemon.run });
        expect(r).toMatchObject({ ok: true, state: 'running' });
        expect(daemon.calls.filter((a) => a[0] === 'up')).toEqual([['up']]);
    });
});

describe('Tailscale connect: a failure says its reason in words (Tynn #675)', () => {
    it('`up` that never comes online says so, never a bare "Command failed"', async () => {
        const r = await tailscaleUp({ cliPath: () => CLI, platform: 'linux', run: (_c, args) => Promise.reject(killed(args, '')) });
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/did not come online within 30 seconds/i);
        expect(r.message).not.toMatch(/Command failed/);
    });

    it("Tailscale's own reason is what the person reads: the settings `up` will not drop, with the command it asks for", async () => {
        const stderr =
            "Error: changing settings via 'tailscale up' requires mentioning all\nnon-default flags. To proceed, either re-run your command with --reset or\n" +
            'use the command below to explicitly mention the current value of\nall non-default settings:\n\n\ttailscale up --accept-routes --operator=someone\n\n';
        const run: NonNullable<TailscaleCliDeps['run']> = (_c, args) =>
            args[0] === 'status'
                ? Promise.resolve({ stdout: JSON.stringify({ BackendState: 'NeedsLogin', Self: null, Peer: {} }), stderr: '' })
                : Promise.reject(Object.assign(new Error(`Command failed: ${CLI} ${args.join(' ')}\n${stderr}`), { code: 1, stdout: '', stderr }));
        const r = await tailscaleUp({ cliPath: () => CLI, platform: 'linux', run });
        expect(r.ok).toBe(false);
        // Not the operator remedy: this user may drive Tailscale; `up` refused to drop settings it was not given.
        expect(r.state).toBe('unknown');
        expect(r.command).toBeUndefined();
        expect(r.message).toContain("changing settings via 'tailscale up' requires mentioning all");
        expect(r.message).toContain('tailscale up --accept-routes --operator=someone');
        expect(r.message).not.toMatch(/Command failed/);
    });

    it('CONTROL: a connect that succeeds says connected', async () => {
        const r = await tailscaleUp({ cliPath: () => CLI, platform: 'linux', run: () => Promise.resolve({ stdout: '', stderr: '' }) });
        expect(r).toMatchObject({ ok: true, state: 'running' });
    });
});
