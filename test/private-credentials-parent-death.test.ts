import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { transform } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { preparePrivateCredential } from '../src/main/private-credentials.js';

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

describe.skipIf(process.platform !== 'win32')('credential verifier parent lifetime', () => {
    it('exits when its parent dies during staging and refuses the unfinished write on the next start', async () => {
        const root = await mkdtemp(join(tmpdir(), 'genie-credential-death-'));
        const file = join(root, 'private-keys', 'credential.json');
        const source = await readFile(new URL('../src/main/private-credentials.ts', import.meta.url), 'utf8');
        const compiled = await transform(source, { loader: 'ts', format: 'cjs', target: 'node22' });
        await writeFile(join(root, 'helper.cjs'), compiled.code);
        await writeFile(join(root, 'parent.cjs'), `
const cp = require('node:child_process');
const fs = require('node:fs/promises');
const { promisify } = require('node:util');
let nativePid;
const real = cp.execFile;
function tracked(...args) { return Reflect.apply(real, this, args); }
Object.defineProperty(tracked, promisify.custom, { value: function (...args) {
    const work = Reflect.apply(real[promisify.custom], this, args);
    nativePid = work.child.pid;
    return work;
} });
cp.execFile = tracked;
const open = fs.open;
fs.open = async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith('.tmp')) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
            await close();
            process.send({ staged: true, nativePid });
            await new Promise(() => {});
        };
    }
    return handle;
};
require('./helper.cjs').writePrivateCredential(process.argv[2], 'encrypted fixture bytes')
    .then(() => process.send({ unexpectedCompletion: true }), () => { process.send({ refusedBeforeStage: true }); process.exit(2); });
`);
        const parent = fork(join(root, 'parent.cjs'), [file], { execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        let nativePid: number | undefined;
        try {
            nativePid = await new Promise<number>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('The owned parent did not reach its staged-file barrier.')), 75_000);
                parent.once('error', (error) => { clearTimeout(timer); reject(error); });
                parent.once('exit', () => { clearTimeout(timer); reject(new Error('The owned parent exited before its staged-file barrier.')); });
                parent.once('message', (message) => {
                    clearTimeout(timer);
                    const status = message as { staged?: unknown; nativePid?: unknown };
                    if (status.staged === true && typeof status.nativePid === 'number' && status.nativePid > 0) resolve(status.nativePid);
                    else reject(new Error('The owned parent did not report its native verifier.'));
                });
            });
            const exited = once(parent, 'exit');
            parent.kill('SIGKILL');
            await exited;
            const deadline = performance.now() + 60_000;
            while (alive(nativePid) && performance.now() < deadline) await delay(100);
            expect(alive(nativePid), 'the native child exits on parent stdin EOF within the unchanged native bound').toBe(false);
            await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
            expect((await readdir(root, { recursive: true })).some((name) => name.endsWith('.tmp')), 'the killed parent left a real uncommitted stage').toBe(true);
            await expect(preparePrivateCredential(file)).rejects.toThrow('Private Tynn credential permissions could not be secured.');
            await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            if (parent.exitCode === null && parent.signalCode === null) { const exited = once(parent, 'exit'); parent.kill('SIGKILL'); await exited; }
            if (nativePid && alive(nativePid)) process.kill(nativePid, 'SIGKILL');
            await rm(root, { recursive: true, force: true });
        }
    }, 180_000);
});
