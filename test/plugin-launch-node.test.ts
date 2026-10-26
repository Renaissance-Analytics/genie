import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { subprocessCommand } from '../src/main/plugin-runner.js';

/**
 * A PLUGIN TOOL RUNS AS NODE, NOT AS A SECOND GENIE (genie#871). A plugin's tool is launched with `process.execPath`. In
 * the installed app that is Genie.exe, and without ELECTRON_RUN_AS_NODE it starts a SECOND GENIE instead of running the
 * module: the tool never ran, and the second instance hit the single-instance lock — whose handler REVEALS the main
 * window (answerSecondInstance), pulling Genie to the front while the person was in another app (the owner, 2026-10-26:
 * "something keeps forcing focus back to Genie even when I am in other apps"). Agent launches already set it
 * (session-host); plugin launches did not.
 */

describe('the plugin subprocess launch', () => {
    it('under Electron: Genie’s binary RUN AS NODE on the module, with only the plugin’s minimal env plus that switch', () => {
        const cmd = subprocessCommand({ module: '/p/tool.mjs', process: 'subprocess', env: { PATH: '/bin', GENIE_PLUGIN_ID: 'sheet' } }, { execPath: 'C:/Genie/Genie.exe', electron: true });
        expect(cmd).toEqual({ file: 'C:/Genie/Genie.exe', args: ['/p/tool.mjs'], env: { PATH: '/bin', GENIE_PLUGIN_ID: 'sheet', ELECTRON_RUN_AS_NODE: '1' } });
    });

    it('under plain Node (tests, a headless host): node itself, no Electron switch (CONTROL)', () => {
        const cmd = subprocessCommand({ module: '/p/tool.mjs', process: 'subprocess', env: { PATH: '/bin' } }, { execPath: '/usr/bin/node', electron: false });
        expect(cmd.env).toEqual({ PATH: '/bin' });
    });

    it('the real launch uses it with the running process’s own runtime (source, comment lines dropped)', () => {
        const src = readFileSync(new URL('../src/main/plugin-runner.ts', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
        expect(src).toMatch(/subprocessCommand\(spec, \{ execPath: process\.execPath, electron: Boolean\(process\.versions\.electron\) \}\)/);
        expect(src).not.toMatch(/spawn\(process\.execPath, \[spec\.module\]/);
    });
});
