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
 * `up` prints the link and then WAITS for the login to complete (it "blocks forever" unless given `--timeout`), so the
 * link is read as `up` writes it: the login page opens at once, and `up` is left to finish the login.
 *
 * The fake below models just that much of the daemon: no network, no real Tailscale.
 */
import { describe, expect, it } from 'vitest';
import { getTailscaleStatus, tailscaleUp, type TailscaleCliDeps } from '../src/main/tailscale-cli.js';

const CLI = '/usr/bin/tailscale';
const EXPIRED = 'https://login.tailscale.com/a/expired0000';

/** The failure a `tailscale up` that Genie stopped leaves: execFile's shape (`killed`), whatever it had written. */
function killed(args: string[], stderr: string): Error {
    return Object.assign(new Error(`Command failed: ${CLI} ${args.join(' ')}\n${stderr}`), { killed: true, signal: 'SIGTERM', code: null, stdout: '', stderr });
}

/** A failure `up` exits with on its own (exit code 1), having written `stderr`. */
function exited(args: string[], stderr: string): Error {
    return Object.assign(new Error(`Command failed: ${CLI} ${args.join(' ')}\n${stderr}`), { code: 1, stdout: '', stderr });
}

type Start = NonNullable<TailscaleCliDeps['start']>;

/** A `tailscale up` that writes `said` at once, then ends as `end` says: exit 0, a failure, or never (it waits). */
function upThat(said: string, end: 'ok' | Error | 'waits'): Start {
    return () => {
        const listeners: ((text: string) => void)[] = [];
        const done = new Promise<void>((resolve, reject) => {
            setTimeout(() => {
                if (said) for (const l of listeners) l(said);
                if (end === 'ok') resolve();
                else if (end !== 'waits') reject(end);
            }, 0);
        });
        return { onOutput: (l) => void listeners.push(l), done };
    };
}

/** A Tailscale daemon as `tailscale up` sees it. */
function fakeDaemon(at: { backend: 'NeedsLogin' | 'Stopped'; haveNodeKey: boolean; pending: string | null }) {
    let pending = at.pending;
    let issued = 0;
    let waiting = 0;
    const calls: string[][] = [];
    const logins: (() => void)[] = [];
    const statusRun: NonNullable<TailscaleCliDeps['run']> = async (_cli, args) => {
        calls.push(args);
        if (args[0] === 'status') return { stdout: JSON.stringify({ BackendState: at.backend, AuthURL: pending ?? '', Self: null, Peer: {} }), stderr: '' };
        // `up` the old way, through execFile: its output is only read once the command ENDS, which for a login is
        // Genie's timeout killing it, the link it printed carried in the failure.
        if (at.backend === 'Stopped') return { stdout: '', stderr: '' };
        if (args.includes('--force-reauth') || !at.haveNodeKey) throw killed(args, `\nTo authenticate, visit:\n\n\t${issue()}\n\n`);
        throw killed(args, '');
    };
    function issue(): string {
        issued += 1;
        pending = `https://login.tailscale.com/a/fresh${String(issued).padStart(4, '0')}`;
        return pending;
    }
    const start: Start = (_cli, args) => {
        calls.push(args);
        const listeners: ((text: string) => void)[] = [];
        const done = new Promise<void>((resolve) => {
            setTimeout(() => {
                if (at.backend === 'Stopped') return resolve();
                // StartLoginInteractive: control issues a NEW link; `up` prints it and waits for the login to complete.
                // With a node key and no new login asked for, there is nothing new to print; it just waits.
                if (args.includes('--force-reauth') || !at.haveNodeKey) for (const l of listeners) l(`\nTo authenticate, visit:\n\n\t${issue()}\n\n`);
                waiting += 1;
                logins.push(() => {
                    waiting -= 1;
                    resolve();
                });
            }, 0);
        });
        return { onOutput: (l) => void listeners.push(l), done };
    };
    return {
        deps: { cliPath: () => CLI, platform: 'linux' as const, run: statusRun, start },
        calls,
        /** How many `up` runs are still waiting for their login. */
        waiting: () => waiting,
        /** The person finishes the login in the browser: every waiting `up` sees Running and exits 0. */
        completeLogin: () => logins.splice(0).forEach((f) => f()),
    };
}

describe('Tailscale sign-in: a freshly issued link every time (Tynn #675)', () => {
    it('a second sign-in, after the first link would have expired, asks Tailscale for a NEW link and opens that', async () => {
        const daemon = fakeDaemon({ backend: 'NeedsLogin', haveNodeKey: true, pending: EXPIRED });
        const first = await tailscaleUp(daemon.deps);
        const second = await tailscaleUp(daemon.deps);
        expect(first.authUrl).toBe('https://login.tailscale.com/a/fresh0001');
        expect(second.authUrl).toBe('https://login.tailscale.com/a/fresh0002');
        expect([first.authUrl, second.authUrl]).not.toContain(EXPIRED);
        expect(second.state).toBe('needs-login');
    });

    it('the status Genie keeps never carries a sign-in link (the one Tailscale reports may be long dead)', async () => {
        const daemon = fakeDaemon({ backend: 'NeedsLogin', haveNodeKey: true, pending: EXPIRED });
        const s = await getTailscaleStatus(daemon.deps);
        expect(s.state).toBe('needs-login');
        expect(JSON.stringify(s)).not.toContain(EXPIRED);
        expect('authUrl' in s).toBe(false);
    });

    it('CONTROL: a first sign-in on a fresh install opens the link it was given', async () => {
        const daemon = fakeDaemon({ backend: 'NeedsLogin', haveNodeKey: false, pending: null });
        const r = await tailscaleUp(daemon.deps);
        expect(r.ok).toBe(false);
        expect(r.state).toBe('needs-login');
        expect(r.authUrl).toBe('https://login.tailscale.com/a/fresh0001');
    });

    it('CONTROL: a signed-in node that is only down connects with a plain `up`, no forced re-login', async () => {
        const daemon = fakeDaemon({ backend: 'Stopped', haveNodeKey: true, pending: null });
        const r = await tailscaleUp(daemon.deps);
        expect(r).toMatchObject({ ok: true, state: 'running' });
        expect(daemon.calls.filter((a) => a[0] === 'up').map((a) => a.filter((x) => !x.startsWith('--timeout=')))).toEqual([['up']]);
    });
});

describe('Tailscale sign-in: the login page opens the moment Tailscale prints its link (Tynn #675)', () => {
    it('the link is handed back while `up` is still waiting for the login, not after it ends', async () => {
        const daemon = fakeDaemon({ backend: 'NeedsLogin', haveNodeKey: true, pending: EXPIRED });
        const r = await tailscaleUp(daemon.deps);
        expect(r.authUrl).toBe('https://login.tailscale.com/a/fresh0001');
        // `up` was not stopped to read the link: it is still there to finish the login.
        expect(daemon.waiting()).toBe(1);
    });

    it('the login still completes: `up` is left running and Genie hears when the node comes online', async () => {
        const daemon = fakeDaemon({ backend: 'NeedsLogin', haveNodeKey: true, pending: EXPIRED });
        const r = await tailscaleUp(daemon.deps);
        expect(r.online).toBeInstanceOf(Promise);
        daemon.completeLogin();
        await expect(r.online).resolves.toBe(true);
        expect(daemon.waiting()).toBe(0);
    });

    it('the wait is bounded by Tailscale\'s own `--timeout`, five minutes', async () => {
        const daemon = fakeDaemon({ backend: 'NeedsLogin', haveNodeKey: true, pending: EXPIRED });
        await tailscaleUp(daemon.deps);
        expect(daemon.calls.find((a) => a[0] === 'up')).toEqual(['up', '--force-reauth', '--timeout=300s']);
    });

    it('a login that never completes ends as not online (Tailscale\'s timeout), never as connected', async () => {
        const args = ['up', '--force-reauth', '--timeout=300s'];
        const start: Start = () => {
            const listeners: ((text: string) => void)[] = [];
            const done = new Promise<void>((_resolve, reject) => {
                setTimeout(() => {
                    for (const l of listeners) l('\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/fresh0001\n\n');
                    setTimeout(() => reject(exited(args, 'timeout waiting for Tailscale service to enter a Running state; check health with "tailscale status"\n')), 0);
                }, 0);
            });
            return { onOutput: (l) => void listeners.push(l), done };
        };
        const r = await tailscaleUp({ cliPath: () => CLI, platform: 'linux', run: () => Promise.resolve({ stdout: JSON.stringify({ BackendState: 'NeedsLogin' }), stderr: '' }), start });
        expect(r.authUrl).toBe('https://login.tailscale.com/a/fresh0001');
        await expect(r.online).resolves.toBe(false);
    });
});

describe('Tailscale connect: a failure says its reason in words (Tynn #675)', () => {
    it('`up` that Genie had to stop, having printed nothing, says it did not come online, never a bare "Command failed"', async () => {
        const r = await tailscaleUp({ cliPath: () => CLI, platform: 'linux', run: (_c, args) => Promise.reject(killed(args, '')), start: (_c, args) => upThat('', killed(args, ''))(_c, args, 0) });
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/did not come online within 5 minutes/i);
        expect(r.message).not.toMatch(/Command failed/);
    });

    it("Tailscale's own timeout is shown in its words", async () => {
        const said = 'timeout waiting for Tailscale service to enter a Running state; check health with "tailscale status"\n';
        const r = await tailscaleUp({ cliPath: () => CLI, platform: 'linux', run: (_c, args) => Promise.reject(exited(args, said)), start: (_c, args) => upThat(said, exited(args, said))(_c, args, 0) });
        expect(r.ok).toBe(false);
        expect(r.message).toContain('timeout waiting for Tailscale service to enter a Running state');
        expect(r.message).not.toMatch(/Command failed/);
    });

    it("Tailscale's own reason is what the person reads: the settings `up` will not drop, with the command it asks for", async () => {
        const stderr =
            "Error: changing settings via 'tailscale up' requires mentioning all\nnon-default flags. To proceed, either re-run your command with --reset or\n" +
            'use the command below to explicitly mention the current value of\nall non-default settings:\n\n\ttailscale up --accept-routes --operator=someone\n\n';
        const run: NonNullable<TailscaleCliDeps['run']> = (_c, args) =>
            args[0] === 'status'
                ? Promise.resolve({ stdout: JSON.stringify({ BackendState: 'NeedsLogin', Self: null, Peer: {} }), stderr: '' })
                : Promise.reject(exited(args, stderr));
        const r = await tailscaleUp({ cliPath: () => CLI, platform: 'linux', run, start: (_c, args) => upThat(stderr, exited(args, stderr))(_c, args, 0) });
        expect(r.ok).toBe(false);
        // Not the operator remedy: this user may drive Tailscale; `up` refused to drop settings it was not given.
        expect(r.state).toBe('unknown');
        expect(r.command).toBeUndefined();
        expect(r.message).toContain("changing settings via 'tailscale up' requires mentioning all");
        expect(r.message).toContain('tailscale up --accept-routes --operator=someone');
        expect(r.message).not.toMatch(/Command failed/);
    });

    it('CONTROL: a connect that succeeds says connected', async () => {
        const r = await tailscaleUp({ cliPath: () => CLI, platform: 'linux', run: () => Promise.resolve({ stdout: '', stderr: '' }), start: upThat('', 'ok') });
        expect(r).toMatchObject({ ok: true, state: 'running' });
    });
});
