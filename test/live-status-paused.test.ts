import { afterEach, describe, expect, it } from 'vitest';
import { LIVE_STATUS_PAUSED, LinkGate } from '../src/main/linked-stream.js';
import type { DockerEventsPort } from '../src/main/service-driver.js';
import { hostingRig, tick, type HostingRig } from './helpers/hosting-rig.js';

/**
 * THE ENGINES' LIVE STATUS SAYS WHEN IT IS PAUSED. genie-host's `docker events` runs under its `supervised` spawn-host
 * child (one owner for every process the host starts); while that child's link is down — it never came up, or it exited
 * and is not back — the watch cannot run, and Hosting SHOWS why, in words. It clears when the link returns, and the watch
 * resumes. Rows:
 *  (1) the link never comes up: Hosting shows the reason;
 *  (2) the link drops: the reason appears; it returns: the reason clears and the watch starts again;
 *  (3) POSITIVE CONTROL: the link up, no reason.
 */

const rigs: HostingRig[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); });

/** `docker events` as the spawn-host client carries it: each start counted; a link that goes down ends the live ones. */
function eventsOver(gate: LinkGate) {
    const live = new Set<(reason: string) => void>();
    let starts = 0;
    const inner = (_binary: string, _args: readonly string[], _onLine: (line: string) => void, onEnd: (reason: string) => void) => {
        starts += 1;
        live.add(onEnd);
        return { stop: () => { live.delete(onEnd); } };
    };
    gate.onChange(() => { if (!gate.up()) for (const end of [...live]) { live.delete(end); end('the spawn host is unreachable'); } });
    const stream = gate.stream(inner);
    const port: DockerEventsPort = (args, onLine, onEnd) => stream('docker', args, onLine, onEnd);
    return { port, starts: () => starts };
}

async function hostWith(gate: LinkGate) {
    const events = eventsOver(gate);
    const r = await hostingRig({ hosting: { dockerEvents: events.port, liveStatusLink: gate } });
    rigs.push(r);
    return { r, events };
}

describe('the engines’ live status, while the process helper is down', () => {
    it('(1) the link never comes up: Hosting shows the reason, and no watch runs', async () => {
        const gate = new LinkGate();
        const { r, events } = await hostWith(gate);
        const w = await r.window();
        expect(r.stack.hostingProblems()).toContain(LIVE_STATUS_PAUSED);
        expect(w.replica.hostingProblems()).toContain(LIVE_STATUS_PAUSED);
        expect(events.starts()).toBe(0);
    });

    it('(2) the link drops: the reason appears; it returns: the reason clears and the watch starts again', async () => {
        const gate = new LinkGate();
        gate.setUp(true);
        const { r, events } = await hostWith(gate);
        const w = await r.window();
        expect(events.starts()).toBe(1);
        expect(w.replica.hostingProblems()).not.toContain(LIVE_STATUS_PAUSED);

        gate.setUp(false);
        await tick(30);
        expect(r.stack.hostingProblems()).toContain(LIVE_STATUS_PAUSED);
        expect(w.replica.hostingProblems()).toContain(LIVE_STATUS_PAUSED);

        gate.setUp(true);
        await tick(30);
        expect(w.replica.hostingProblems()).not.toContain(LIVE_STATUS_PAUSED);
        // The driver asks again after its stream ended (its first re-watch is 5 s): the ask waited for the link, and runs.
        const deadline = Date.now() + 15_000;
        while (events.starts() < 2 && Date.now() < deadline) await new Promise((res) => setTimeout(res, 100));
        expect(events.starts()).toBe(2);
    }, 30_000);

    it('(3) CONTROL: the link up, no reason', async () => {
        const gate = new LinkGate();
        gate.setUp(true);
        const { r } = await hostWith(gate);
        const w = await r.window();
        expect(r.stack.hostingProblems()).not.toContain(LIVE_STATUS_PAUSED);
        expect(w.replica.hostingProblems()).not.toContain(LIVE_STATUS_PAUSED);
    });
});
