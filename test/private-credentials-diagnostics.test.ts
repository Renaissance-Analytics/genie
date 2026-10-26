import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { native } = vi.hoisted(() => ({ native: vi.fn() }));
vi.mock('node:child_process', async () => {
    const { promisify } = await import('node:util');
    return { execFile: Object.assign(() => { throw new Error('Unexpected callback invocation'); }, { [promisify.custom]: native }) };
});
import { preparePrivateCredential } from '../src/main/private-credentials.js';
import * as credentials from '../src/main/private-credentials.js';
import { openLifecycleLog } from '../src/main/lifecycle-log.js';

const roots: string[] = [];
const restoreLogs: (() => void)[] = [];
function configureLog(log: (line: string) => void): void {
    // On the first RED run this export is absent; the durable-output assertion must still fail.
    if ('setPrivateCredentialFailureLog' in credentials) {
        restoreLogs.push((credentials.setPrivateCredentialFailureLog as (sink: (line: string) => void) => () => void)(log));
    }
}
afterEach(async () => {
    for (const restore of restoreLogs.splice(0)) restore();
    vi.restoreAllMocks(); native.mockReset();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'win32')('private credential native failure diagnostics', () => {
    it.each([
        { code: null, errno: undefined, killed: true, signal: 'SIGTERM', elapsedMs: 60_021, reason: 'terminated-after-deadline' },
        { code: 1, errno: undefined, killed: false, signal: null, elapsedMs: 73, reason: 'process-exit' },
        { code: 'ENOENT', errno: -4058, killed: false, signal: null, elapsedMs: 12, reason: 'spawn-error' },
        { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', errno: undefined, killed: true, signal: 'SIGTERM', elapsedMs: 60_021, reason: 'output-limit' },
        { code: null, errno: undefined, killed: true, signal: 'SIGTERM', elapsedMs: 200, reason: 'terminated' },
    ])('retains sanitized $reason evidence while refusing storage', async (failure) => {
        const root = await mkdtemp(join(tmpdir(), 'genie-private-diagnostic-')); roots.push(root);
        const directory = join(root, 'private-keys'); const file = join(directory, 'credential.json');
        const secret = 'fixture-secret-must-not-appear-in-diagnostics';
        vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(100 + failure.elapsedMs);
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        native.mockRejectedValueOnce(Object.assign(new Error(secret), { ...failure, stdout: secret, stderr: secret, cmd: secret, path: file, spawnargs: [secret] }));
        await expect(preparePrivateCredential(file)).rejects.toThrow('Private Tynn credential permissions could not be secured.');
        expect(native).toHaveBeenCalledTimes(1);
        expect(native.mock.calls[0]![2]).toMatchObject({ timeout: 60_000, maxBuffer: 65_536, windowsHide: true });
        await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(warning).toHaveBeenCalledExactlyOnceWith('PRIVATE_CREDENTIAL_ACL_FAILURE', {
            operation: 'restrict-private-credential-acl', elapsedMs: failure.elapsedMs, timeoutMs: 60_000,
            reason: failure.reason, code: failure.code, errno: failure.errno ?? null,
            killed: failure.killed, signal: failure.signal,
        });
        expect(JSON.stringify(warning.mock.calls)).not.toContain(secret);
        expect(JSON.stringify(warning.mock.calls)).not.toContain(root);
    });

    it('preserves existing bytes even if writing the diagnostic itself throws', async () => {
        const root = await mkdtemp(join(tmpdir(), 'genie-private-diagnostic-')); roots.push(root);
        const directory = join(root, 'private-keys'); await mkdir(directory);
        const file = join(directory, 'credential.json'); await writeFile(file, 'encrypted fixture bytes');
        vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('Diagnostic sink failure'); });
        configureLog(() => { throw new Error('Durable sink failure'); });
        native.mockRejectedValueOnce(Object.assign(new Error('Native process failed'), { code: 1 }));
        await expect(preparePrivateCredential(file)).rejects.toThrow('Private Tynn credential permissions could not be secured.');
        expect(native).toHaveBeenCalledTimes(1);
        expect(await readFile(file, 'utf8')).toBe('encrypted fixture bytes');
    });

    it('writes sanitized failure evidence through the configured durable log even when console output fails', async () => {
        const root = await mkdtemp(join(tmpdir(), 'genie-private-diagnostic-')); roots.push(root);
        const lines: string[] = [];
        const durable = openLifecycleLog(join(root, 'runtime'), { now: () => 0 });
        configureLog((line) => { lines.push(line); durable(line); });
        vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('Console unavailable'); });
        vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(111);
        native.mockRejectedValueOnce(Object.assign(new Error('secret native message'), { code: 'ENOENT', errno: -4058 }));
        await expect(preparePrivateCredential(join(root, 'private-keys', 'credential.json'))).rejects.toThrow('Private Tynn credential permissions could not be secured.');
        expect(lines, 'durable credential failure log').toHaveLength(1);
        expect(lines[0]).toBe('PRIVATE_CREDENTIAL_ACL_FAILURE ' + JSON.stringify({ operation: 'restrict-private-credential-acl', elapsedMs: 11, timeoutMs: 60_000, reason: 'spawn-error', code: 'ENOENT', errno: -4058, killed: false, signal: null }));
        const recorded = await readFile(join(root, 'runtime', 'lifecycle.log'), 'utf8');
        expect(recorded).toContain(lines[0]); expect(recorded).not.toContain('secret native message'); expect(recorded).not.toContain(root);
    });

    it('does not log successful native ACL operations', async () => {
        const root = await mkdtemp(join(tmpdir(), 'genie-private-diagnostic-')); roots.push(root);
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        native.mockResolvedValueOnce({ stdout: '', stderr: '' });
        await preparePrivateCredential(join(root, 'private-keys', 'credential.json'));
        expect(warning).not.toHaveBeenCalled(); expect(native).toHaveBeenCalledTimes(1);
    });
});
