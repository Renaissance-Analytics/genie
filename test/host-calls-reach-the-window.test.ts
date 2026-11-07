import { afterEach, describe, expect, it } from 'vitest';
import type { PrivilegedStep } from '../src/main/elevate.js';
import type { ForwardedToolCall } from '../src/main/mcp-host-tools.js';
import { hostingRig, type HostingRig } from './helpers/hosting-rig.js';

/**
 * WHAT GENIE-HOST ASKS OF A WINDOW REACHES A WINDOW (Tynn #444, beta.60).
 *
 * The host forwards a window tool's call (`client.toolCall`) and asks an elevation (`client.elevate`) of a connected
 * window. The Genie browser's own process links to the host too, for its pages and cookies, and answers neither. On
 * beta.60 the host asked the NEWEST link, which was the browser's: every forwarded tool failed for every agent with
 * "Genie's window closed before it answered (this window runs no tools)".
 */

const step: PrivilegedStep = { id: 'hosts', label: 'update the hosts file', step: { command: 'true', args: [] } as never };
const call: ForwardedToolCall = { name: 'checkIssues', args: { action: 'list' }, headers: {}, caller: null };

let rig: HostingRig | null = null;
afterEach(async () => { await rig?.close(); rig = null; });

describe('the host asks the window, never the browser\'s link', () => {
    it('a forwarded tool call is answered by the window when the browser linked after it', async () => {
        rig = await hostingRig();
        await rig.window({ client: { onToolCall: async (c) => ({ text: `window ran ${c.name}`, isError: false }) } });
        await rig.window({ browser: true });
        await expect(rig.server.forwardTool(call)).resolves.toEqual({ text: 'window ran checkIssues', isError: false });
    });

    it('an elevation is asked of the window when the browser linked after it', async () => {
        rig = await hostingRig();
        await rig.window({ client: { onToolCall: async () => ({ text: 'x', isError: false }) } });
        await rig.window({ browser: true });
        const before = rig.elevationsAsked.length;
        await expect(rig.server.elevate([step])).resolves.toEqual({ ok: true });
        expect(rig.elevationsAsked.length).toBe(before + 1);
    });

    it('with only the browser linked, no window is connected: the tools say the window is closed instead of failing mid-call', async () => {
        rig = await hostingRig();
        await rig.window({ browser: true });
        expect(rig.server.windowConnected()).toBe(false);
        expect(rig.server.localWindowConnected()).toBe(false);
    });

    it('CONTROL: a window alone is connected, and answers', async () => {
        rig = await hostingRig();
        await rig.window({ client: { onToolCall: async (c) => ({ text: `window ran ${c.name}`, isError: false }) } });
        expect(rig.server.windowConnected()).toBe(true);
        expect(rig.server.localWindowConnected()).toBe(true);
        await expect(rig.server.forwardTool(call)).resolves.toEqual({ text: 'window ran checkIssues', isError: false });
    });
});
