import { CodexDriver } from '@particle-academy/prism-acp';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it.each(['start', 'resume'] as const)('the Codex app-server fixture supports real SDK %s with Genie’s session bearer', async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), 'genie-codex-mcp-startup-'));
    const journal = join(dir, 'requests.log');
    const problems: string[] = [];
    const driver = new CodexDriver({
        cwd: dir, binary: process.execPath, binaryArgs: [resolve('scripts/stub-codex.mjs'), '--record-methods', journal],
        parentEnv: { ...process.env, CODEX_HOME: dir },
        ...(mode === 'resume' ? { resumeSessionId: 'stub_thread_0001' } : {}),
        mcpServers: [{ type: 'http', name: 'genie', url: 'http://127.0.0.1:1/mcp', headers: [{ name: 'Authorization', value: 'Bearer fixture-session-token' }] }],
    }, { onProtocolError: (problem) => problems.push(problem) });
    try {
        driver.start();
        await driver.ready;
        // The fixture journals synchronously before its response, independent of the SDK's withheld stderr.
        const methods = (await readFile(journal, 'utf8')).trim().split(/\r?\n/);
        const unexpectedRequests = methods.filter((method) => method.startsWith('unhandled:')).map((method) => method.slice('unhandled:'.length));
        expect(methods).toContain('config/read');
        expect(problems, `unexpected fixture requests: ${unexpectedRequests.join(', ')}`).toEqual([]);
        expect(unexpectedRequests).toEqual([]);
        expect(methods).toContain(mode === 'resume' ? 'thread/resume' : 'thread/start');
        if (mode === 'resume') {
            expect(methods).toContain('thread/turns/list');
            expect(methods).toContain('thread/items/list');
        }
        expect(driver.cliSessionId).toBe('stub_thread_0001');
    } finally {
        const stopped = await driver.stop({ graceMs: 0 });
        expect(stopped.empty).toBe(true);
        if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('genie-codex-mcp-startup-')) throw new Error('Refusing fixture cleanup outside its temporary root');
        await rm(dir, { recursive: true, force: true });
    }
});

it('the preparation fixture completes the pinned SDK config handshake with a private Tynn bearer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genie-prepared-sdk-'));
    const problems: string[] = [];
    const driver = new CodexDriver({ cwd: dir, binary: process.execPath, binaryArgs: [resolve('test/live/fixtures/prepared-provider.mjs')],
        mcpServers: [{ type: 'http', name: 'tynn', url: 'https://tynn.ai/mcp/tynn', headers: [{ name: 'Authorization', value: 'Bearer synthetic-private' }] }],
    }, { onProtocolError: (problem) => problems.push(problem) });
    try {
        driver.start();
        await expect(driver.ready).resolves.toBeUndefined();
        expect(problems).toEqual([]);
        expect(driver.cliSessionId).toBe('prepared-native-thread');
    } finally {
        const stopped = await driver.stop({ graceMs: 0 }); expect(stopped.empty).toBe(true);
        if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('genie-prepared-sdk-')) throw new Error('Refusing fixture cleanup outside its temporary root');
        await rm(dir, { recursive: true, force: true });
    }
});
