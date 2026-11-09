import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostDownAnswer, hostDownPlan } from '../src/core/host-down.js';
import { composeServices } from './helpers/compose-alone.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * THE WINDOW NEVER RUNS HOST WORK (Tynn #415, host split P6, forward-only). With no genie-host it says what is wrong and how
 * to fix it, and stops: no in-process engine, no MCP server of its own, no plugin host of its own, no safe mode of its own.
 */
const code = (path: string) => readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('source: nothing in the window can start them', () => {
    const main = code('src/main/main.ts');
    const compose = code('src/main/compose.ts');

    it('no in-process engine, and no spawn host of its own', () => {
        expect(main).not.toMatch(/new SessionHost\(/);
        expect(main).not.toMatch(/host instanceof SessionHost/);
        expect(main).not.toMatch(/startSpawnHost\(/);
    });

    it('no MCP server of its own', () => {
        expect(main).not.toMatch(/genieMcpServer\(/);
    });

    it('no plugin host of its own', () => {
        expect(compose).not.toMatch(/PluginHost\.open\(/);
        expect(compose).not.toMatch(/LocalPlugins/);
        expect(main).not.toMatch(/ownPlugins/);
        expect(code('src/main/plugins-host.ts')).not.toMatch(/class LocalPlugins/);
    });

    it('no safe mode of its own: the window only reads the host’s', () => {
        expect(code('src/main/window-safe-mode.ts')).not.toMatch(/SafeMode\.open\(/);
    });

    it('a host that cannot start stops the window', () => {
        expect(main).toMatch(/if \(agentEngineLink === null\) \{\s*await stopForNoHost\(/);
        expect(main).not.toMatch(/agents run inside the window/);
    });

    it('CONTROL: the patterns read the window’s real sources', () => {
        expect(main).toMatch(/connectAgentEngine\(/);
        expect(compose).toMatch(/input\.plugins/);
    });
});

describe('what the person is told', () => {
    const logFile = 'C:/g/logs/genie-host.log';

    it('what is wrong, the reason when there is one, and how to fix it', () => {
        const plan = hostDownPlan({ reason: 'the runtime could not be copied', logFile });
        expect(plan.title).toBe('Genie could not start its host');
        expect(plan.detail).toContain('the runtime could not be copied');
        expect(plan.detail).toContain('Try again');
        expect(plan.detail).toContain(logFile);
        expect(plan.buttons).toEqual(['Try again', 'Open the log', 'Quit']);
    });

    it('with no reason known it points at the log', () => {
        const plan = hostDownPlan({ reason: null, logFile });
        expect(plan.detail).toContain(logFile);
        expect(plan.detail).not.toContain('null');
    });

    it('each button means what it says; anything else quits', () => {
        expect([0, 1, 2, -1].map((i) => hostDownAnswer(i))).toEqual(['retry', 'open-log', 'quit', 'quit']);
    });
});

describe('composed with no host’s plugins', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-no-host-work-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
    const pty: PtyPort = {
        open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
    };

    it('opens no plugin host: nothing is listed', async () => {
        const services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0 });
        try {
            expect(services.plugins.list()).toEqual([]);
            expect(services.plugins.editors()).toEqual([]);
        } finally {
            await services.shutdown();
        }
    });
});
