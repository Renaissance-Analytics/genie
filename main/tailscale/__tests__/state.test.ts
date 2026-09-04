import { describe, it, expect } from 'vitest';
import {
    classifyTailscaleFailure,
    getTailscaleStatus,
    resolveTailscaleCliPath,
    tailscaleRemedy,
    tailscaleUp,
} from '../index';

/**
 * genie#380 + genie#396 — Linux Tailscale states.
 *
 * Everything platform-dependent is a PURE function fed the platform, the
 * filesystem predicate and the CLI's real output, so the Linux paths are
 * exercised from any dev box. The CLI strings below are Tailscale's ACTUAL
 * messages, quoted from tailscale/tailscale:
 *   - cmd/tailscale/cli/diag.go   — the "failed to connect to local tailscaled" family
 *   - cmd/tailscale/cli/cli.go    — the sudo / `set --operator=$USER` remedy
 *   - client/local/local.go       — the `Access denied: %v` prefix
 */

/** `tailscale status --json` for a healthy, logged-in node. */
const RUNNING_JSON = JSON.stringify({
    BackendState: 'Running',
    Self: { TailscaleIPs: ['100.1.2.3'], HostName: 'omarchy', Online: true },
    Peer: {},
});

/** The error `child_process` raises when the binary does not exist. */
function enoent(bin = 'tailscale'): Error & { code: string } {
    return Object.assign(new Error(`spawn ${bin} ENOENT`), { code: 'ENOENT' });
}

/** The error shape execFile rejects with: a message plus the child's output. */
function cliError(stderr: string, message = 'Command failed'): Error & { stderr: string } {
    return Object.assign(new Error(message), { stdout: '', stderr });
}

describe('resolveTailscaleCliPath — Linux must ESTABLISH presence, not assume it (genie#380)', () => {
    it('returns null on Linux when the binary is on neither PATH nor a well-known dir', () => {
        expect(
            resolveTailscaleCliPath('linux', () => false, '/usr/bin:/usr/local/bin'),
        ).toBeNull();
    });

    it('finds a PATH-installed tailscale on Linux', () => {
        const found = '/usr/bin/tailscale';
        expect(
            resolveTailscaleCliPath('linux', (p) => p === found, '/sbin:/usr/bin:/usr/local/bin'),
        ).toBe(found);
    });

    it('finds Tailscale in a well-known dir that is NOT on PATH (snap / opt installs)', () => {
        const found = '/opt/tailscale/bin/tailscale';
        // A GUI app inherits a minimal PATH — the binary has to be findable anyway.
        expect(resolveTailscaleCliPath('linux', (p) => p === found, '/usr/bin')).toBe(found);
        expect(resolveTailscaleCliPath('linux', (p) => p === '/snap/bin/tailscale', '')).toBe(
            '/snap/bin/tailscale',
        );
    });

    it('keeps the existing Windows / macOS behaviour', () => {
        const win = 'C:\\Program Files\\Tailscale\\tailscale.exe';
        expect(resolveTailscaleCliPath('win32', (p) => p === win, undefined)).toBe(win);
        expect(resolveTailscaleCliPath('win32', () => false, undefined)).toBeNull();
        expect(
            resolveTailscaleCliPath('darwin', (p) => p === '/opt/homebrew/bin/tailscale', undefined),
        ).toBe('/opt/homebrew/bin/tailscale');
        expect(resolveTailscaleCliPath('darwin', () => false, undefined)).toBeNull();
    });
});

describe('classifyTailscaleFailure — the two standard Linux failures (genie#396)', () => {
    it('ENOENT is ABSENT, never "installed but offline"', () => {
        expect(classifyTailscaleFailure(enoent())).toBe('absent');
        expect(classifyTailscaleFailure({ code: 'EACCES', message: 'spawn EACCES' })).toBe('absent');
    });

    it('reads tailscaled-not-running as STOPPED (the post-`pacman -S` state)', () => {
        expect(
            classifyTailscaleFailure(
                cliError(
                    "failed to connect to local tailscaled; it doesn't appear to be running (sudo systemctl start tailscaled ?)",
                ),
            ),
        ).toBe('stopped');
        expect(
            classifyTailscaleFailure(
                cliError("failed to connect to local tailscaled; it doesn't appear to be running"),
            ),
        ).toBe('stopped');
        expect(
            classifyTailscaleFailure(
                cliError(
                    "failed to connect to local tailscaled process; it doesn't appear to be running",
                ),
            ),
        ).toBe('stopped');
    });

    it('reads an access-denied as NEEDS-OPERATOR, not as a stopped daemon', () => {
        const denied = cliError(
            "Access denied: watch IPN bus access denied\n" +
                "Use 'sudo tailscale up'.\n" +
                "To not require root, use 'sudo tailscale set --operator=$USER' once.\n",
        );
        expect(classifyTailscaleFailure(denied)).toBe('needs-operator');
    });

    it('a daemon that IS running but whose socket refuses us is NEEDS-OPERATOR, not stopped', () => {
        // diag.go's "which appears to be running as …" variant: the process was
        // found, so the daemon is up — the connect failed on permissions.
        expect(
            classifyTailscaleFailure(
                cliError(
                    'failed to connect to local tailscaled (which appears to be running as tailscaled, pid 812). ' +
                        'Got error: dial unix /var/run/tailscale/tailscaled.sock: connect: permission denied',
                ),
            ),
        ).toBe('needs-operator');
    });

    it('an auth URL is NEEDS-LOGIN', () => {
        expect(
            classifyTailscaleFailure(
                cliError('To authenticate, visit:\n\n\thttps://login.tailscale.com/a/1234abcd\n'),
            ),
        ).toBe('needs-login');
    });

    it('anything unrecognised stays UNKNOWN — no guessing a remedy', () => {
        expect(classifyTailscaleFailure(cliError('the tailnet is on fire'))).toBe('unknown');
        expect(classifyTailscaleFailure({})).toBe('unknown');
    });
});

describe('tailscaleRemedy — every blocked state NAMES its fix (genie#396)', () => {
    it('names the systemd unit for a stopped daemon, and ONLY for that state', () => {
        const stopped = tailscaleRemedy('stopped', 'linux');
        expect(stopped?.command).toBe('sudo systemctl enable --now tailscaled');
        // Positive control for the negative below: the operator state has a
        // remedy of its own, so "no systemctl" is not passing against nothing.
        const operator = tailscaleRemedy('needs-operator', 'linux');
        expect(operator?.command).toBe('sudo tailscale set --operator=$USER');
        expect(operator?.command).not.toContain('systemctl');
    });

    it('has no shell remedy for a state the user cannot fix from a terminal', () => {
        expect(tailscaleRemedy('running', 'linux')).toBeNull();
        // needs-login is fixed by the auth URL, not a command.
        expect(tailscaleRemedy('needs-login', 'linux')?.command).toBeUndefined();
    });

    it('does not tell a Windows or macOS user to run systemctl', () => {
        // No shell command at all on those platforms…
        expect(tailscaleRemedy('stopped', 'win32')?.command).toBeUndefined();
        expect(tailscaleRemedy('stopped', 'darwin')?.command).toBeUndefined();
        // …but still something actionable about the service being down.
        expect(tailscaleRemedy('stopped', 'win32')?.message ?? '').toMatch(/running/i);
        expect(tailscaleRemedy('stopped', 'darwin')?.message ?? '').toMatch(/running/i);
        // Positive control for the two `toBeUndefined`s: the SAME state on Linux
        // DOES carry the systemctl line, so this is a platform decision rather
        // than a remedy that is empty everywhere.
        expect(tailscaleRemedy('stopped', 'linux')?.command).toContain('systemctl');
    });
});

describe('getTailscaleStatus — five distinguishable states (genie#380, genie#396)', () => {
    it('reports ABSENT (installed:false) when the CLI is not on the machine', async () => {
        const s = await getTailscaleStatus({ cliPath: () => null, platform: 'linux' });
        expect(s.state).toBe('absent');
        expect(s.installed).toBe(false);
        expect(s.running).toBe(false);
    });

    it('an ENOENT from the CLI is ABSENT — the catch must not assert installed:true', async () => {
        const s = await getTailscaleStatus({
            cliPath: () => '/usr/bin/tailscale',
            platform: 'linux',
            run: () => Promise.reject(enoent()),
        });
        expect(s.installed).toBe(false);
        expect(s.state).toBe('absent');
    });

    it('a stopped daemon is STOPPED and installed — with the unit command', async () => {
        const s = await getTailscaleStatus({
            cliPath: () => '/usr/bin/tailscale',
            platform: 'linux',
            run: () =>
                Promise.reject(
                    cliError(
                        "failed to connect to local tailscaled; it doesn't appear to be running (sudo systemctl start tailscaled ?)",
                    ),
                ),
        });
        expect(s.installed).toBe(true);
        expect(s.state).toBe('stopped');
        expect(s.remedy?.command).toBe('sudo systemctl enable --now tailscaled');
    });

    it('an access-denied is NEEDS-OPERATOR and installed — with the operator command', async () => {
        const s = await getTailscaleStatus({
            cliPath: () => '/usr/bin/tailscale',
            platform: 'linux',
            run: () =>
                Promise.reject(
                    cliError(
                        "Access denied: watch IPN bus access denied\nTo not require root, use 'sudo tailscale set --operator=$USER' once.",
                    ),
                ),
        });
        expect(s.installed).toBe(true);
        expect(s.state).toBe('needs-operator');
        expect(s.remedy?.command).toBe('sudo tailscale set --operator=$USER');
    });

    it('still parses the JSON a non-zero `status` prints (stopped node, live daemon)', async () => {
        const needsLogin = JSON.stringify({
            BackendState: 'NeedsLogin',
            AuthURL: 'https://login.tailscale.com/a/abc',
            Self: null,
            Peer: {},
        });
        const s = await getTailscaleStatus({
            cliPath: () => '/usr/bin/tailscale',
            platform: 'linux',
            run: () =>
                Promise.reject(Object.assign(new Error('exit 1'), { stdout: needsLogin, stderr: '' })),
        });
        expect(s.installed).toBe(true);
        expect(s.state).toBe('needs-login');
        expect(s.authUrl).toBe('https://login.tailscale.com/a/abc');
    });

    it('reports RUNNING off a healthy status', async () => {
        const s = await getTailscaleStatus({
            cliPath: () => '/usr/bin/tailscale',
            platform: 'linux',
            run: () => Promise.resolve({ stdout: RUNNING_JSON, stderr: '' }),
        });
        expect(s.state).toBe('running');
        expect(s.running).toBe(true);
        expect(s.installed).toBe(true);
        expect(s.self?.ip).toBe('100.1.2.3');
        expect(s.remedy).toBeNull();
    });

    it('an unrecognised failure keeps installed:true but does NOT invent a state', async () => {
        const s = await getTailscaleStatus({
            cliPath: () => '/usr/bin/tailscale',
            platform: 'linux',
            run: () => Promise.reject(cliError('the tailnet is on fire')),
        });
        expect(s.installed).toBe(true);
        expect(s.state).toBe('unknown');
    });
});

describe('tailscaleUp — classifies its failure and names the remedy (genie#396)', () => {
    it('succeeds', async () => {
        const r = await tailscaleUp({
            cliPath: () => '/usr/bin/tailscale',
            platform: 'linux',
            run: () => Promise.resolve({ stdout: '', stderr: '' }),
        });
        expect(r.ok).toBe(true);
    });

    it('surfaces the auth URL exactly as before', async () => {
        const r = await tailscaleUp({
            cliPath: () => '/usr/bin/tailscale',
            platform: 'linux',
            run: () =>
                Promise.reject(
                    cliError('To authenticate, visit:\n\n\thttps://login.tailscale.com/a/1234abcd\n'),
                ),
        });
        expect(r.ok).toBe(false);
        expect(r.authUrl).toBe('https://login.tailscale.com/a/1234abcd');
        expect(r.state).toBe('needs-login');
    });

    it('names `systemctl enable --now tailscaled` for a stopped daemon', async () => {
        const r = await tailscaleUp({
            cliPath: () => '/usr/bin/tailscale',
            platform: 'linux',
            run: () =>
                Promise.reject(
                    cliError(
                        "failed to connect to local tailscaled; it doesn't appear to be running (sudo systemctl start tailscaled ?)",
                    ),
                ),
        });
        expect(r.ok).toBe(false);
        expect(r.state).toBe('stopped');
        expect(r.command).toBe('sudo systemctl enable --now tailscaled');
        expect(r.message).toMatch(/tailscaled/);
    });

    it('names `tailscale set --operator=$USER` when the user is not an operator', async () => {
        const r = await tailscaleUp({
            cliPath: () => '/usr/bin/tailscale',
            platform: 'linux',
            run: () =>
                Promise.reject(
                    cliError(
                        "Access denied: watch IPN bus access denied\nUse 'sudo tailscale up'.\nTo not require root, use 'sudo tailscale set --operator=$USER' once.",
                    ),
                ),
        });
        expect(r.ok).toBe(false);
        expect(r.state).toBe('needs-operator');
        expect(r.command).toBe('sudo tailscale set --operator=$USER');
    });

    it('an unrecognised failure still surfaces the raw error (the fallback stays)', async () => {
        const r = await tailscaleUp({
            cliPath: () => '/usr/bin/tailscale',
            platform: 'linux',
            run: () => Promise.reject(cliError('the tailnet is on fire', 'boom')),
        });
        expect(r.ok).toBe(false);
        expect(r.state).toBe('unknown');
        expect(r.command).toBeUndefined();
        expect(r.message).toContain('boom');
    });

    it('never surfaces `spawn tailscale ENOENT` — an absent CLI says so in words', async () => {
        const r = await tailscaleUp({
            cliPath: () => '/usr/bin/tailscale',
            platform: 'linux',
            run: () => Promise.reject(enoent()),
        });
        expect(r.ok).toBe(false);
        expect(r.state).toBe('absent');
        expect(r.message).not.toContain('ENOENT');
        // Positive control: the message is real text, not an empty string that
        // would pass the assertion above for free.
        expect(r.message).toMatch(/not installed/i);
    });
});
