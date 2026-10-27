import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Headroom } from '../src/core/headroom.js';
import { HeadroomBoard, headroomBufferMs } from '../src/core/headroom-board.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { SETTINGS } from '../src/core/settings.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { RateLimitPills } from '../src/renderer/components/Dashboard.js';

/**
 * ONE RATE-LIMIT READING PER PROVIDER IN THE DASHBOARD HEADER, AT MOST ONCE A MINUTE (the owner, 2026-10-26: "I need a
 * rate limit indicator in the dashboard header, 1 per provider. They should update anytime an agent reports it in their
 * stream with a 1 min buffer to prevent ui spam if multiple agents are running. do this carefully so we are not
 * increasing ui lag or adding anything that would slow down an agent. if the 1min buffer is active any other rate update
 * is just ignored until the buffer clears. 1 min by default, this should be a host workstation setting"). The buffer is
 * kept in MAIN, before anything reaches the window: an ignored reading costs one comparison and sends nothing.
 */

const h = (leftPct: number, window = '5h'): Headroom => {
    const resetsAtMs = Date.UTC(2026, 9, 26, 14, 0, 0);
    return { plan: null, window, leftPct, resetsAtMs, over: false, windows: [{ window, usedPct: 100 - leftPct, leftPct, resetsAtMs, over: false }] };
};
const T0 = 1_000_000;
const MIN = 60_000;

describe('the buffer', () => {
    it('the first reading shows; any other within the buffer is IGNORED; after it, the next shows', () => {
        const board = new HeadroomBoard();
        expect(board.offer('claude', h(80), T0, MIN)).toBe(true);
        expect(board.offer('claude', h(40), T0 + MIN - 1, MIN)).toBe(false);
        expect(board.view()).toEqual({ claude: h(80) });
        expect(board.offer('claude', h(40), T0 + MIN, MIN)).toBe(true);
        expect(board.view()).toEqual({ claude: h(40) });
    });

    it('one buffer per provider: codex is not held by claude’s', () => {
        const board = new HeadroomBoard();
        board.offer('claude', h(80), T0, MIN);
        expect(board.offer('codex', h(97, '7d'), T0 + 1, MIN)).toBe(true);
        expect(board.view()).toEqual({ claude: h(80), codex: h(97, '7d') });
    });

    it('a host workstation setting, 1 minute by default; the buffer follows it', () => {
        const def = SETTINGS.find((s) => s.key === 'rate_limit_refresh');
        expect(def).toMatchObject({ scope: 'host', group: 'workstation', default: '60' });
        expect(headroomBufferMs({})).toBe(MIN);
        expect(headroomBufferMs({ rate_limit_refresh: '300' })).toBe(5 * MIN);
        expect(headroomBufferMs({ rate_limit_refresh: 'nonsense' })).toBe(MIN);
    });
});

describe('a reading in an agent’s stream reaches the host’s owner with its provider', () => {
    let dir: string;
    let events: DriverEvents | null = null;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-rate-pills-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
    const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };
    const driverFor: DriverFor = () => {
        const factory: SessionDriverFactory = (options) => {
            events = options.events;
            return { start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } };
        };
        return factory;
    };

    it('Codex’s reading → onHeadroom(codex, its headroom); a frame without one → nothing', () => {
        const seen: Array<{ provider: string; leftPct: number }> = [];
        const host = new SessionHost({ userData: dir, driverFor, processTree: noTree, onHeadroom: (provider, room) => seen.push({ provider, leftPct: room.leftPct }) });
        host.start(agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'codex', name: 'kai' }), dir);
        events!.onUpdate?.({ sessionUpdate: 'notice', notice: { level: 'info', message: 'Codex rate limit: 3% used' }, _meta: { 'particle.academy/rate_limit': { primary: { usedPercent: 3, windowDurationMins: 300, resetsAtMs: T0 } } } });
        events!.onUpdate?.({ sessionUpdate: 'notice', notice: { level: 'info', message: 'hello' } });
        expect(seen).toEqual([{ provider: 'codex', leftPct: 97 }]);
        host.stopAll();
    });
});

describe('in the header', () => {
    it('one pill per provider, its share left and window, the reset on hover', () => {
        const html = renderToStaticMarkup(<RateLimitPills limits={{ claude: h(62), codex: h(97, '7d') }} />);
        // The hover card and the pill’s accessible name list every reported window with its reset (genie#1268, rate-limit-detail).
        expect(html).toMatch(/data-rate-limit="claude"[^>]*aria-label="Claude Code rate limits: 5h window: 38% used · 62% left · resets [^"]+"/);
        expect(html).toContain('62%');
        expect(html).toMatch(/data-rate-limit="codex"/);
        expect(html).toContain('97%');
    });

    it('nothing reported yet: nothing drawn', () => {
        expect(renderToStaticMarkup(<RateLimitPills limits={{}} />)).toBe('');
    });
});
