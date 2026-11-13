import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RemoteAccessStatus } from '../src/main/remote-access-host.js';
import { RemoteAccessReplica } from '../src/main/remote-access-replica.js';

/**
 * THE WINDOW FORWARDS ONLY WHAT GENIE-HOST'S REMOTE CONNECTIONS WANT (Tynn #662).
 *
 * The memory soak on the beta.62 line (Azure, Windows, 30 min, the owner's estate): window main allocated about 50 GB
 * every 5 minutes, and genie-host received 71 G characters over its link — lines of up to 10 M characters, 12 a second.
 * The heap profile named them: every agent change built the agent's WHOLE detail (its ledger of thousands of rows) and
 * sent it to genie-host as a remote-access `event`, every 50 ms per changed agent, whether or not anything was connected
 * to receive it. The host's RemoteHost already said which agents it wants (`wantsAgent`: a phone's watched ones, every one
 * for a desktop window); the window never heard it. Now the host's status says what its connections want, and the window
 * builds and sends only that: nothing at all with nobody connected.
 */

const STATUS: RemoteAccessStatus = { host: 'alphar', url: null, unavailable: null, locked: false, pin: null, devices: [], connections: [], pairRequests: [] };

function rig() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const replica = new RemoteAccessReplica('alphar', async (method, args) => { calls.push({ method, args }); return true; });
    let listener: ((channel: string, payload: unknown) => void) | null = null;
    let options: { wantsAgent?: (agentId: string) => boolean } | undefined;
    replica.forwardEvents((l, o) => { listener = l; options = o; return () => { listener = null; }; });
    const emit = (channel: string) => listener!(channel, { big: true });
    const sent = () => calls.filter((c) => c.method === 'event').map((c) => c.args[0]);
    return { replica, emit, sent, wants: (id: string) => options?.wantsAgent?.(id) };
}

describe('the window forwards only what genie-host’s remote connections want (Tynn #662)', () => {
    it('nobody connected: no agent’s detail is even built, and nothing is sent', () => {
        const r = rig();
        r.replica.deliver({ kind: 'status', status: { ...STATUS, wants: { remote: false, all: false, agents: [], local: false } } });
        expect(r.wants('agent_a')).toBe(false);
        r.emit('agent:agent_a');
        r.emit('snapshot');
        r.emit('features');
        r.emit('local-files');
        expect(r.sent()).toEqual([]);
    });

    it('a phone watching one agent: that agent and the snapshot cross; another agent is not built; local events stay', () => {
        const r = rig();
        r.replica.deliver({ kind: 'status', status: { ...STATUS, wants: { remote: true, all: false, agents: ['agent_a'], local: false } } });
        expect(r.wants('agent_a')).toBe(true);
        expect(r.wants('agent_b')).toBe(false);
        r.emit('agent:agent_a');
        r.emit('agent:agent_b');
        r.emit('snapshot');
        r.emit('local-files');
        expect(r.sent()).toEqual(['agent:agent_a', 'snapshot']);
    });

    it('a desktop window connected wants every agent; a local connection hears the local events', () => {
        const r = rig();
        r.replica.deliver({ kind: 'status', status: { ...STATUS, wants: { remote: true, all: true, agents: [], local: true } } });
        expect(r.wants('agent_b')).toBe(true);
        r.emit('agent:agent_b');
        r.emit('local-files');
        expect(r.sent()).toEqual(['agent:agent_b', 'local-files']);
    });

    it('CONTROL: a host that does not say what it wants (an older status) is forwarded everything, as before', () => {
        const r = rig();
        r.replica.deliver({ kind: 'status', status: STATUS });
        expect(r.wants('agent_b')).toBe(true);
        r.emit('agent:agent_b');
        r.emit('local-files');
        expect(r.sent()).toEqual(['agent:agent_b', 'local-files']);
    });

    it('wired: genie-host says it in its status, and window main hands the window’s events the wants', () => {
        const access = readFileSync('src/main/remote-access-host.ts', 'utf8');
        expect(access).toMatch(/wants: r\.wanted\(\)/);
        const main = readFileSync('src/main/main.ts', 'utf8');
        expect(main).toMatch(/linkedRemote\.forwardEvents\(\(listener, options\) => api\.onEvent\(listener, options\)\);/);
    });
});
