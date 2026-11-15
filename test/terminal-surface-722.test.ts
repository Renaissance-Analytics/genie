import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { sharedProtocol } from '../src/core/genie-protocol.js';
import { needsPerson, showTerminalRoute } from '../src/core/terminal-surface.js';
import { KnowledgeStore } from '../src/main/knowledge-store.js';
import { moreGenieTools, type TerminalsPort } from '../src/main/mcp-tools-more.js';
import type { Caller, ToolContext } from '../src/main/mcp-tools.js';

/**
 * A TERMINAL AN AGENT STARTS FOR THE PERSON IS SHOWN TO THEM, AND THE AGENT IS TOLD TRUTHFULLY WHETHER IT IS ON SCREEN
 * (Tynn #722; the owner, 2026-11-14: the prism agent said "The publish is running in a Genie terminal you can see. It's
 * paused at npm's two-factor step", but no terminal had opened anywhere the owner could see).
 */
const atlas: Caller = { agentId: mintAgentId(), agentName: 'atlas', workspaceId: 'tynn', workspacePath: '/w/tynn' };
const ctx: ToolContext = { server: 'genie', tool: 'manageTerminals', headers: {} };

function rig(options: { surface?: boolean | 'absent' } = {}) {
    const surfaced: Array<{ workspaceId: string; terminalId: string; agentName: string }> = [];
    const listeners = new Set<(id: string, data: string) => void>();
    const port: TerminalsPort = {
        list: () => [],
        open: () => ({ id: 'term_1', pid: 101, shell: 'bash', scrollback: '' }),
        write: () => true,
        scrollback: () => '',
        scrollbackCap: 50,
        onData: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    const tools = moreGenieTools({
        knowledge: KnowledgeStore.open(mkdtempSync(join(tmpdir(), 'genie2-terminal-surface-722-'))),
        terminals: port,
        approve: async () => 'allowed',
        resolveCaller: () => atlas,
        ...(options.surface === 'absent' ? {} : { surface: (request: { workspaceId: string; terminalId: string; agentName: string }) => { surfaced.push(request); return options.surface !== false; } }),
    } as Parameters<typeof moreGenieTools>[0]);
    const create = async (args: JsonObject) => {
        const reg = tools.find((t) => t.definition.name === 'manageTerminals')!;
        const r = await reg.handler({ terminalId: 't', action: 'create', ...args }, ctx);
        return JSON.parse(r.text) as { ok: boolean; visibility?: string; onScreen?: boolean; note?: string };
    };
    return { create, surfaced, print: (data: string) => { for (const l of [...listeners]) l('term_1', data); }, listening: () => listeners.size };
}

describe('the terminal tool says whether the terminal is on screen', () => {
    it('with nothing that can show it, the result says it is only running in the BACKGROUND, and not on screen', async () => {
        const r = await rig({ surface: 'absent' }).create({ command: 'npm test' });
        expect(r).toMatchObject({ ok: true, visibility: 'background', onScreen: false });
        expect(r.note).toMatch(/background/i);
    });

    it('a terminal made for the person is put in front of them, in its workspace, and the result says what was done', async () => {
        const h = rig();
        const r = await h.create({ command: 'npm publish', forPerson: true });
        expect(h.surfaced).toEqual([{ workspaceId: 'tynn', terminalId: 'term_1', agentName: 'atlas', reason: expect.any(String) }]);
        expect(r.visibility).toBe('offered');
        // Honest: a Show terminal button is in front of them; the terminal itself is not on screen until they click.
        expect(r.onScreen).toBe(false);
        expect(r.note).toMatch(/Show terminal/);
    });

    it('control: no window connected means nothing was shown, and the result says background', async () => {
        const r = await rig({ surface: false }).create({ command: 'npm publish', forPerson: true });
        expect(r).toMatchObject({ visibility: 'background', onScreen: false });
    });

    it('control: an ordinary terminal raises nothing', async () => {
        const h = rig();
        await h.create({ command: 'npm test' });
        expect(h.surfaced).toEqual([]);
    });

    it('an interactive prompt in its output (a 2FA step) raises the surface, once', async () => {
        const h = rig();
        await h.create({ command: 'npm publish' });
        h.print('Publishing...\n');
        expect(h.surfaced).toEqual([]);
        h.print('npm notice Enter one-time password: ');
        h.print('Enter one-time password: ');
        expect(h.surfaced).toHaveLength(1);
        expect(h.surfaced[0]).toMatchObject({ workspaceId: 'tynn', terminalId: 'term_1' });
        expect(h.listening()).toBe(0);
    });
});

describe('what counts as a prompt for the person', () => {
    it.each(['Enter one-time password:', 'Password: ', 'Enter passphrase for key', 'Continue? [y/N]', 'Username for https://github.com:', 'Enter verification code', 'Press Enter to open the browser'])('%s', (text) => {
        expect(needsPerson(text)).toBe(true);
    });
    it.each(['Compiling 12 files', 'npm WARN deprecated foo', '12 passed (3s)', 'passwords.ts updated'])('control: %s is not', (text) => {
        expect(needsPerson(text)).toBe(false);
    });
});

describe('Show terminal opens the workspace’s Terminals tab', () => {
    it('is the workspace route on its terminals view', () => {
        expect(showTerminalRoute('ws_01HTYNN')).toBe('genie://workspace/ws_01HTYNN?view=terminals');
    });
});

describe('the protocol', () => {
    it('says never to tell the person something is on their screen unless the tool said so', () => {
        expect(sharedProtocol([])).toContain('Never tell the person something is on their screen unless the tool said so');
    });
});

describe('Genie wires it', () => {
    const strip = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    it('the host hands the tool a surface that signals the window, and main puts it in front of the focused window', () => {
        expect(strip('../src/main/host-mcp.ts')).toMatch(/kind:\s*'terminal-needs-you'/);
        expect(strip('../src/main/main.ts')).toMatch(/signal\.kind === 'terminal-needs-you'/);
    });
    it('the terminals port the host gives the tool can be watched for output', () => {
        expect(strip('../src/main/genie-host.ts')).toMatch(/onData:\s*\(listener\)\s*=>\s*terminalHost\.onData/);
    });
});
