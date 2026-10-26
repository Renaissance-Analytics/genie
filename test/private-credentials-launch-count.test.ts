import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({
    launches: [] as { args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[],
    fault: null as 'exit-without-verification' | 'unexpected-output' | 'premature-verification' | 'replayed-nonce' | 'die-after-staging' | 'hang-after-staging' | 'closed-stdin' | 'stdin-eof' | null,
    challenges: [] as string[],
    nativeFailures: [] as { killed: boolean; code: unknown; signal: unknown }[],
    nativeAliveAtEof: false,
    payload: null as string | null,
    payloadInStdin: false,
    stagingOpened: false,
    children: [] as import('node:child_process').ChildProcess[],
    elapsedMs: [] as number[],
}));
vi.mock('node:child_process', async (original) => {
    const actual = await original<typeof import('node:child_process')>();
    const { promisify } = await import('node:util');
    const execFile = function (...args: Parameters<typeof actual.execFile>) { return actual.execFile(...args); };
    Object.defineProperty(execFile, promisify.custom, {
        value: (...args: [string, readonly string[], { env?: NodeJS.ProcessEnv }]) => {
            const nativeArgs = [...args[1]];
            if (observed.fault && observed.fault !== 'closed-stdin' && observed.fault !== 'stdin-eof') {
                const index = nativeArgs.indexOf('-EncodedCommand') + 1;
                const originalScript = Buffer.from(nativeArgs[index]!, 'base64').toString('utf16le');
                const verification = "Send-PrivateSignal ('PRIVATE_CREDENTIAL_VERIFIED:'+$stageId)";
                if (['die-after-staging', 'hang-after-staging', 'replayed-nonce'].includes(observed.fault) && !originalScript.includes(verification)) throw new Error('Late-stage fault requires the actual staged verifier');
                const oldNonce = observed.challenges[0];
                if (observed.fault === 'replayed-nonce' && !oldNonce) throw new Error('Replay requires a prior completed write');
                const script = observed.fault === 'exit-without-verification' ? 'exit 0'
                    : observed.fault === 'premature-verification'
                        ? "[Console]::Out.WriteLine('PRIVATE_CREDENTIAL_PREPARED');[Console]::Out.WriteLine('PRIVATE_CREDENTIAL_VERIFIED');exit 0"
                        : observed.fault === 'replayed-nonce' ? originalScript.replace(verification, `Send-PrivateSignal 'PRIVATE_CREDENTIAL_VERIFIED:${oldNonce}'`)
                            : observed.fault === 'die-after-staging' ? originalScript.replace(verification, "throw 'Fixture stopped after staging';")
                            : observed.fault === 'hang-after-staging' ? originalScript.replace(verification, `Start-Sleep -Seconds 70;${verification}`)
                                : `[Console]::Out.WriteLine('unexpected fixture output');\n${originalScript}`;
                nativeArgs[index] = Buffer.from(script, 'utf16le').toString('base64');
            }
            observed.launches.push({ args: nativeArgs, env: args[2].env });
            const began = performance.now();
            const work = (actual.execFile as unknown as Record<symbol, (...values: unknown[]) => unknown>)[promisify.custom]!(args[0], nativeArgs, args[2]) as Promise<unknown> & { child: import('node:child_process').ChildProcess };
            void work.then(() => { observed.elapsedMs.push(performance.now() - began); }, (error: { killed?: boolean; code?: unknown; signal?: unknown }) => {
                observed.elapsedMs.push(performance.now() - began);
                observed.nativeFailures.push({ killed: error.killed === true, code: error.code, signal: error.signal });
            });
            observed.children.push(work.child);
            const input = work.child.stdin;
            if (input) for (const method of ['write', 'end'] as const) {
                const originalMethod = input[method];
                Object.defineProperty(input, method, { configurable: true, writable: true, value: function (this: typeof input, ...values: unknown[]) {
                    const bytes = values[0];
                    const text = typeof bytes === 'string' ? bytes : Buffer.isBuffer(bytes) ? bytes.toString() : '';
                    if (observed.payload && text.includes(observed.payload)) observed.payloadInStdin = true;
                    const challenge = /^PRIVATE_CREDENTIAL_STAGED:([0-9a-f-]{36})\n$/.exec(text);
                    if (challenge) observed.challenges.push(challenge[1]!);
                    return Reflect.apply(originalMethod, this, values);
                } });
            }
            return work;
        },
    });
    return { ...actual, execFile };
});

vi.mock('node:fs/promises', async (original) => {
    const actual = await original<typeof import('node:fs/promises')>();
    return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
        const handle = await actual.open(...args);
        if (String(args[0]).endsWith('.tmp')) {
            observed.stagingOpened = true;
            if (observed.fault === 'closed-stdin' || observed.fault === 'stdin-eof') {
                const close = handle.close.bind(handle);
                handle.close = async () => {
                    await close();
                    for (const child of observed.children) {
                        if (observed.fault !== 'stdin-eof') { child.stdin?.end(); continue; }
                        // Keep Node's stage paused so protocol refusal cannot kill the child for us.
                        observed.nativeAliveAtEof = child.pid !== undefined && alive(child.pid);
                        await new Promise<void>((resolve, reject) => {
                            const timer = setTimeout(() => reject(new Error('Owned native EOF barrier timed out.')), 75_000);
                            child.once('close', () => { clearTimeout(timer); resolve(); });
                            child.stdin?.end();
                        });
                    }
                };
            }
        }
        return handle;
    } };
});

import { preparePrivateCredential, setPrivateCredentialFailureLog, writePrivateCredential } from '../src/main/private-credentials.js';

const roots: string[] = [];
function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
afterEach(async () => {
    observed.launches.length = 0;
    observed.fault = null;
    observed.payload = null; observed.payloadInStdin = false; observed.stagingOpened = false; observed.children.length = 0; observed.elapsedMs.length = 0;
    observed.challenges.length = 0;
    observed.nativeFailures.length = 0; observed.nativeAliveAtEof = false;
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'win32')('credential write native launch budget', () => {
    it.each(['new', 'existing'] as const)('secures and atomically writes a %s credential with one native process', async (kind) => {
        const root = await mkdtemp(join(tmpdir(), 'genie-acl-launch-')); roots.push(root);
        const directory = join(root, 'private-keys');
        const file = join(directory, 'credential.json');
        if (kind === 'existing') { await mkdir(directory); await writeFile(file, 'previous encrypted bytes'); }
        const payload = JSON.stringify({ encrypted: 'fixture-payload-never-in-process-arguments-or-environment' });
        observed.payload = payload;

        await writePrivateCredential(file, payload);

        expect(await readFile(file, 'utf8')).toBe(payload);
        expect(await readdir(directory)).toEqual(['credential.json']);
        expect(observed.launches.length, 'one ACL process covers preparation AND staged-file verification for each durable write').toBe(1);
        expect(observed.payloadInStdin, 'the native verifier receives no credential bytes on stdin').toBe(false);
        for (const launch of observed.launches) {
            const encoded = launch.args[launch.args.indexOf('-EncodedCommand') + 1]!;
            expect(Buffer.from(encoded, 'base64').toString('utf16le').includes(payload)).toBe(false);
            expect(JSON.stringify(launch.args).includes(payload)).toBe(false);
            expect(Object.values(launch.env ?? {}).includes(payload)).toBe(false);
        }
    }, 180_000);

    it.each((['exit-without-verification', 'unexpected-output', 'premature-verification', 'die-after-staging', 'closed-stdin'] as const)
        .flatMap((fault) => (['new', 'existing'] as const).map((kind) => [fault, kind] as const)))('refuses %s for a %s credential without leaving staging files', async (fault, kind) => {
        const root = await mkdtemp(join(tmpdir(), 'genie-acl-protocol-')); roots.push(root);
        const directory = join(root, 'private-keys');
        const file = join(directory, 'credential.json');
        const previous = 'previous encrypted bytes';
        if (kind === 'existing') { await mkdir(directory); await writeFile(file, previous); }
        observed.fault = fault;

        await expect(writePrivateCredential(file, 'new encrypted fixture bytes')).rejects.toThrow('Private Tynn credential permissions could not be secured.');

        if (fault === 'die-after-staging' || fault === 'closed-stdin') expect(observed.stagingOpened, 'the fault occurred after the real exclusive staging open').toBe(true);
        expect((await readdir(root, { recursive: true })).some((name) => name.endsWith('.tmp')), 'no staging file remains anywhere below the root').toBe(false);
        expect(observed.children.every((child) => child.exitCode !== null || child.signalCode !== null), 'the owned native children have exited').toBe(true);
        if (kind === 'existing') {
            expect(await readFile(file, 'utf8')).toBe(previous);
            expect(await readdir(directory)).toEqual(['credential.json']);
        } else {
            const exists = await stat(directory).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
            expect(exists, 'failed new credential directory is removed after owned staging cleanup').toBe(false);
        }
    }, 180_000);

    it('refuses a replayed nonce from an earlier write after staging without logging either challenge', async () => {
        const root = await mkdtemp(join(tmpdir(), 'genie-acl-replay-')); roots.push(root);
        const directory = join(root, 'private-keys');
        const file = join(directory, 'credential.json');
        await writePrivateCredential(file, 'previous encrypted bytes');
        expect(observed.challenges.length, 'the positive write supplied one real staging challenge').toBe(1);
        observed.fault = 'replayed-nonce';
        observed.stagingOpened = false;
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const lines: string[] = [];
        const restore = setPrivateCredentialFailureLog((line) => { lines.push(line); });
        try {
            await expect(writePrivateCredential(file, 'replacement encrypted bytes')).rejects.toThrow('Private Tynn credential permissions could not be secured.');
            expect(observed.stagingOpened, 'the replay followed real exclusive staging').toBe(true);
            expect(observed.challenges.length).toBe(2);
            expect(observed.challenges[0] !== observed.challenges[1], 'each completed stage receives a fresh challenge').toBe(true);
            const diagnostic = JSON.stringify({ warning: warning.mock.calls, lines });
            expect(observed.challenges.every((nonce) => !diagnostic.includes(nonce)), 'diagnostics never include either challenge').toBe(true);
            expect(await readFile(file, 'utf8')).toBe('previous encrypted bytes');
            expect(await readdir(directory)).toEqual(['credential.json']);
            expect(observed.children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
        } finally { restore(); }
    }, 180_000);

    it('refuses actual stdin EOF while Node is still staging without relying on native timeout termination', async () => {
        const root = await mkdtemp(join(tmpdir(), 'genie-acl-eof-')); roots.push(root);
        const directory = join(root, 'private-keys'); await mkdir(directory);
        const file = join(directory, 'credential.json'); await writeFile(file, 'previous encrypted bytes');
        observed.fault = 'stdin-eof';

        await expect(writePrivateCredential(file, 'replacement encrypted bytes')).rejects.toThrow('Private Tynn credential permissions could not be secured.');

        expect(observed.nativeAliveAtEof, 'the process scan finds the live verifier before closing its stdin').toBe(true);
        expect(observed.nativeFailures.length).toBe(1);
        expect(observed.nativeFailures[0]!.killed, 'stdin EOF must refuse without relying on timeout termination').toBe(false);
        expect(observed.nativeFailures[0]!.code).toBe(1);
        expect(observed.nativeFailures[0]!.signal).toBeNull();
        expect(observed.children.every((child) => child.pid !== undefined && !alive(child.pid))).toBe(true);
        expect(await readFile(file, 'utf8')).toBe('previous encrypted bytes');
        expect((await readdir(root, { recursive: true })).some((name) => name.endsWith('.tmp'))).toBe(false);
    }, 180_000);

    it('refuses an unfinished staging file on the next preparation without changing or deleting stored data', async () => {
        const root = await mkdtemp(join(tmpdir(), 'genie-acl-restart-')); roots.push(root);
        const directory = join(root, 'private-keys'); await mkdir(directory);
        const file = join(directory, 'credential.json'); await writeFile(file, 'previous encrypted bytes');
        const temp = `${file}.00000000-0000-4000-8000-000000000000.tmp`; await writeFile(temp, 'unfinished encrypted bytes');

        await expect(preparePrivateCredential(file)).rejects.toThrow('Private Tynn credential permissions could not be secured.');

        expect(observed.launches.length, 'startup refuses the orphan before changing any ACL').toBe(0);
        expect(await readFile(file, 'utf8')).toBe('previous encrypted bytes');
        expect(await readFile(temp, 'utf8')).toBe('unfinished encrypted bytes');
    }, 180_000);

    it('refuses a bounded late-stage hang in words, preserves the old credential and cleans the owned stage', async () => {
        const root = await mkdtemp(join(tmpdir(), 'genie-acl-hang-')); roots.push(root);
        const directory = join(root, 'private-keys'); await mkdir(directory);
        const file = join(directory, 'credential.json'); await writeFile(file, 'previous encrypted bytes');
        observed.fault = 'hang-after-staging';

        await expect(writePrivateCredential(file, 'new encrypted fixture bytes')).rejects.toThrow('Private Tynn credential permissions could not be secured.');

        expect(observed.stagingOpened, 'the native hang occurs after Node staged the bytes').toBe(true);
        expect(observed.elapsedMs.length).toBe(1);
        expect(observed.elapsedMs[0]).toBeGreaterThanOrEqual(60_000);
        expect(observed.elapsedMs[0], 'the unchanged 60 s native deadline allows only OS notification overhead').toBeLessThan(65_000);
        expect(observed.children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
        expect(await readFile(file, 'utf8')).toBe('previous encrypted bytes');
        expect((await readdir(root, { recursive: true })).some((name) => name.endsWith('.tmp'))).toBe(false);
    }, 180_000);
});
