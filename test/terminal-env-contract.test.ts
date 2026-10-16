import { describe, expect, it } from 'vitest';
import { fancyTermPort, type HostBackend } from '../src/main/fancy-term-port.js';

/**
 * `GENIE_TERMINAL_ID` IN EVERY TERMINAL'S ENVIRONMENT (§6.9). The pty port mints the terminal id before the
 * engine spawns, so the shell can be born knowing which terminal it is — the attribution argument every
 * Genie MCP tool requires. Always set, whatever else the caller put in the env; equal to the id the port
 * hands back; never overriding a caller's other variables.
 */

function fakeBackend() {
    const created: Array<{ id: string; env?: Record<string, string> }> = [];
    const backend: HostBackend = {
        create: (opts) => { created.push({ id: opts.id, ...(opts.env ? { env: { ...opts.env } } : {}) }); return { id: opts.id, pid: 7, shell: opts.shell ?? '/bin/sh', existing: false, scrollback: '' }; },
        write: () => true,
        resize: () => true,
        kill: () => true,
        getScrollback: () => '',
        on: (() => backend) as HostBackend['on'],
    };
    return { backend, created };
}

describe('the terminal env contract', () => {
    it('GENIE_TERMINAL_ID equals the id handed back, with or without a caller env; the caller’s variables ride along untouched', () => {
        const { backend, created } = fakeBackend();
        const port = fancyTermPort(backend, { defaultShell: () => ({ command: '/bin/sh', args: [] }) });
        const plain = port.open({ cwd: '/w/tynn' });
        expect(created[0]!.env).toEqual({ GENIE_TERMINAL_ID: plain.id });
        const withEnv = port.open({ cwd: '/w/tynn', env: { GENIE_MCP_URL: 'http://127.0.0.1:7421/mcp', GENIE_MCP_TOKEN: 't', DB_PORT: '54301' } });
        expect(created[1]!.env).toEqual({ GENIE_MCP_URL: 'http://127.0.0.1:7421/mcp', GENIE_MCP_TOKEN: 't', DB_PORT: '54301', GENIE_TERMINAL_ID: withEnv.id });
        expect(plain.id).not.toBe(withEnv.id);
    });

    it('a caller’s own GENIE_TERMINAL_ID wins — the Take Over host mints an attribution id it can resolve back to the agent', () => {
        const { backend, created } = fakeBackend();
        const port = fancyTermPort(backend, { defaultShell: () => ({ command: '/bin/sh', args: [] }) });
        port.open({ cwd: '/w/tynn', env: { GENIE_TERMINAL_ID: 'takeover_abc', GENIE_MCP_URL: 'http://127.0.0.1:7421/mcp' } });
        expect(created[0]!.env).toEqual({ GENIE_TERMINAL_ID: 'takeover_abc', GENIE_MCP_URL: 'http://127.0.0.1:7421/mcp' });
    });
});
