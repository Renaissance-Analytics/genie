import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices } from './helpers/compose-alone.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * THE WINDOW NEVER RUNS HOST WORK (Tynn #415, host split P6, forward-only). With no genie-host it shows the host directory
 * (Tynn #1058 L4; its words are test/host-directory.test.ts's) and runs nothing: no in-process engine, no MCP server of its own, no plugin host of its own, no safe mode of its own.
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

    it('with no host the window shows the host directory and runs nothing itself (Tynn #1058 L4)', () => {
        expect(main).toMatch(/if \(agentEngineLink !== null\) break;[\s\S]{0,400}if \(\(await openHostDirectory\(/);
        expect(main).not.toMatch(/stopForNoHost/);
        expect(main).not.toMatch(/agents run inside the window/);
    });

    it('CONTROL: the patterns read the window’s real sources', () => {
        expect(main).toMatch(/connectAgentEngine\(/);
        expect(compose).toMatch(/input\.hosting/);
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
