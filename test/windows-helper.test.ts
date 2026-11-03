import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { HelperLost, WindowsHelper, type HelperChild } from '../src/main/windows-helper.js';

/**
 * ONE LONG-LIVED POWERSHELL (measured on genie-test-windows: a launch is 1.6 to 2.2 s, the same ACL work through a running helper 2 to 16 ms, with the same ACL left behind). The launch was the
 * cost, so there is one, and every request after it costs none. This file holds the rules with a fake child, on every OS; test/windows-helper-real.test.ts has the real one on Windows.
 */
class FakeChild extends EventEmitter implements HelperChild {
    readonly pid = 4242;
    readonly written: string[] = [];
    readonly stdout = new EventEmitter();
    ended = false;
    killed = false;
    readonly stdin = {
        write: (text: string) => { this.written.push(text); return true; },
        end: () => { this.ended = true; },
    };
    kill(): boolean { this.killed = true; this.emit('exit', null, 'SIGTERM'); return true; }
    says(text: string): void { this.stdout.emit('data', Buffer.from(text)); }
    lastId(): string { return /^(\d+) /.exec(this.written.at(-1) ?? '')?.[1] ?? ''; }
}
function rig(options: { deadlineMs?: number } = {}) {
    const children: FakeChild[] = [];
    const launches: { file: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const helper = new WindowsHelper({
        spawn: (file, args, env) => { launches.push({ file, args, env }); const child = new FakeChild(); children.push(child); return child; },
        ...options,
    });
    return { helper, children, launches };
}
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
const decoded = (line: string) => Buffer.from(line.split(' ')[1]!.trim(), 'base64').toString('utf16le');

describe('launches', () => {
    it('one launch, however many requests: the count is the point', async () => {
        const r = rig();
        for (let n = 0; n < 5; n += 1) {
            const request = r.helper.run('Do-Work');
            await settle();
            r.children[0]!.says(`DONE ${r.children[0]!.lastId()} 0\n`);
            await request.completed;
        }
        expect(r.launches).toHaveLength(1);
        expect(r.children[0]!.written).toHaveLength(5);
    });

    it('started as today: the same flags, and no PSModulePath, so a planted module cannot load', () => {
        const before = process.env.PSModulePath;
        process.env.PSModulePath = 'C:/planted';
        try {
            const r = rig();
            void r.helper.run('x').completed.catch(() => {});
            const { file, args, env } = r.launches[0]!;
            expect(file).toMatch(/WindowsPowerShell.v1\.0.powershell\.exe$/);
            expect(args.slice(0, 5)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden']);
            expect(args[5]).toBe('-EncodedCommand');
            expect(Object.keys(env).some((k) => k.toUpperCase() === 'PSMODULEPATH')).toBe(false);
            r.helper.stop();
        } finally {
            if (before === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = before;
        }
    });

    it('the script goes byte for byte, one request a line', async () => {
        const r = rig();
        void r.helper.run('$a = "ünï"\nDo-Work').completed.catch(() => {});
        await settle();
        expect(r.children[0]!.written[0]).toMatch(/^\d+ [A-Za-z0-9+/=]+\n$/);
        expect(decoded(r.children[0]!.written[0]!)).toBe('$a = "ünï"\nDo-Work');
        r.helper.stop();
    });
});

describe('a request', () => {
    it('its output is its own, and the helper\'s READY is nobody\'s', async () => {
        const r = rig();
        const request = r.helper.run('x');
        const heard: string[] = [];
        request.stdout.on('data', (d: string) => heard.push(d));
        await settle();
        r.children[0]!.says('READY\r\nfirst\r\n');
        r.children[0]!.says(`second\r\nDONE ${r.children[0]!.lastId()} 0\r\n`);
        expect((await request.completed).stdout).toBe('first\nsecond\n');
        expect(heard.join('')).toBe('first\nsecond\n');
    });

    it('a request the script refused rejects with its code, and the helper stays', async () => {
        const r = rig();
        const refused = r.helper.run('x');
        await settle();
        r.children[0]!.says(`DONE ${r.children[0]!.lastId()} 1\n`);
        const error = await refused.completed.catch((e: unknown) => e);
        expect(error).toMatchObject({ code: 1 });
        expect(error).not.toBeInstanceOf(HelperLost);
        const next = r.helper.run('y');
        await settle();
        r.children[0]!.says(`DONE ${r.children[0]!.lastId()} 0\n`);
        await next.completed;
        expect(r.launches).toHaveLength(1);
    });

    it('one at a time, in order: the handshake has this stdin to itself', async () => {
        const r = rig();
        const a = r.helper.run('a');
        const b = r.helper.run('b');
        await settle();
        expect(r.children[0]!.written).toHaveLength(1);
        r.children[0]!.says(`DONE ${r.children[0]!.lastId()} 0\n`);
        await a.completed;
        await settle();
        expect(r.children[0]!.written).toHaveLength(2);
        r.children[0]!.says(`DONE ${r.children[0]!.lastId()} 0\n`);
        await b.completed;
    });

    it('its stdin is the handshake\'s: an end says the words and does not close the helper', async () => {
        const r = rig();
        const request = r.helper.run('x');
        await settle();
        request.stdin.end('PRIVATE_CREDENTIAL_STAGED:abc\n');
        expect(r.children[0]!.written.at(-1)).toBe('PRIVATE_CREDENTIAL_STAGED:abc\n');
        expect(r.children[0]!.ended).toBe(false);
        r.children[0]!.says(`DONE ${r.children[0]!.lastId() || '1'} 0\n`);
        r.helper.stop();
    });

    it('garbage is the request\'s output, for its strict check to refuse; it does not end the request', async () => {
        const r = rig();
        const request = r.helper.run('x');
        await settle();
        r.children[0]!.says('not a line anyone said\nDONE 999 0\n');
        r.children[0]!.says(`DONE ${r.children[0]!.lastId()} 0\n`);
        expect((await request.completed).stdout).toBe('not a line anyone said\nDONE 999 0\n');
    });
});

describe('when it fails, nothing passes for done', () => {
    it('killed mid-request: the request is lost, and the next one starts a new helper', async () => {
        const r = rig();
        const request = r.helper.run('x');
        await settle();
        r.children[0]!.emit('exit', 1, null);
        await expect(request.completed).rejects.toBeInstanceOf(HelperLost);
        void r.helper.run('y').completed.catch(() => {});
        await settle();
        expect(r.launches).toHaveLength(2);
        r.helper.stop();
    });

    it('those waiting behind it are lost too, never run by a helper they were not sent to', async () => {
        const r = rig();
        const a = r.helper.run('a');
        const b = r.helper.run('b');
        await settle();
        r.children[0]!.emit('exit', 1, null);
        await expect(a.completed).rejects.toBeInstanceOf(HelperLost);
        await settle();
        const c = r.children.at(-1)!;
        c.says(`DONE ${c.lastId()} 0\n`);
        await b.completed;
    });

    it('hung past the deadline: killed, and the request is lost', async () => {
        const r = rig({ deadlineMs: 5 });
        const request = r.helper.run('x');
        await expect(request.completed).rejects.toBeInstanceOf(HelperLost);
        expect(r.children[0]!.killed).toBe(true);
    });

    it('it cannot be started: the request is lost, not a throw', async () => {
        const helper = new WindowsHelper({ spawn: () => { throw new Error('ENOENT'); } });
        await expect(helper.run('x').completed).rejects.toBeInstanceOf(HelperLost);
    });

    it('a request\'s kill is the helper\'s, and it is lost', async () => {
        const r = rig();
        const request = r.helper.run('x');
        await settle();
        request.kill();
        await expect(request.completed).rejects.toBeInstanceOf(HelperLost);
        expect(r.children[0]!.killed).toBe(true);
    });

    it('stop closes its stdin, which is how it ends, and how it ends with a dead owner', () => {
        const r = rig();
        void r.helper.run('x').completed.catch(() => {});
        r.helper.stop();
        expect(r.children[0]!.ended).toBe(true);
    });
});
