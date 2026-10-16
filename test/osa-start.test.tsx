import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { headerActions } from '../src/core/agent-view.js';
import { draftSendVia } from '../src/core/chat-view.js';
import type { LiveSession } from '../src/core/roster.js';
import { osaHomeDir } from '../src/main/paths.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * THE GENIE OSA CAN BE STARTED, AND IT LIVES ON THE WORKSTATION (the owner, 2026-10-12: "the current (at least
 * installed) build doesn't have a way to start the genie agent. The genie osa agent no longer runs on a workspace at all
 * but on the whole workstation. Its prompts are baked into the genie"). Nothing started it: the rail only navigated to
 * it, the Agent view had no Start, a chat message became a draft whose "restart and send" was a GRACEFUL restart — which
 * a fresh install refuses (no thread to resume). Now:
 *  - the Agent view offers Start for any declared agent that is not running (not while it runs, not when it is broken —
 *    broken has its own restart);
 *  - a draft to an agent that was never started, or stopped, STARTS it and sends; only a broken one restarts;
 *  - the OSA runs in `~/.genie/osa`, written at boot from the baked-in instructions and the diagnostics skill.
 */
const session = (over: Partial<LiveSession> = {}): LiveSession => ({ running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, plan: null, ...over } as LiveSession);

describe('Start', () => {
    it('offered for a declared agent that is not running; not while it runs; not when broken; never for an observed one', () => {
        expect(headerActions(null, 'declared').start).toBe(true);
        expect(headerActions(session({ running: false, turnState: 'stopped' }), 'declared').start).toBe(true);
        expect(headerActions(session(), 'declared').start).toBe(false);
        expect(headerActions(session({ turnState: 'working' }), 'declared').start).toBe(false);
        expect(headerActions(session({ failure: { reason: 'x', fixes: [] } }), 'declared').start).toBe(false);
        expect(headerActions(null, 'observed').start).toBe(false);
    });

    it('the Agent view draws it and it starts that agent (positive control: a running agent has no Start)', () => {
        const started: string[] = [];
        const render = (s: LiveSession | null) => renderToStaticMarkup(
            <AgentView agent={{ id: 'agent_osa', name: 'genie', provider: 'claude', fidelity: 'declared', cwd: '/h/.genie/osa' }} session={s} rows={[]} tab="stream" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} onStart={(id) => started.push(id)} />,
        );
        expect(render(null)).toContain('data-action="start"');
        expect(render(session())).not.toContain('data-action="start"');
    });
});

describe('a message to an agent that is not running', () => {
    it('starts it and sends; only a broken session restarts', () => {
        expect(draftSendVia(null)).toBe('start');
        expect(draftSendVia(session({ running: false, turnState: 'stopped' }))).toBe('start');
        expect(draftSendVia(session({ failure: { reason: 'ACP stream closed', fixes: [] } }))).toBe('restart');
    });
});

describe('the OSA’s home', () => {
    it('is ~/.genie/osa, on the workstation — not Chromium’s per-user folder, not a workspace', () => {
        expect(osaHomeDir('/home/u').replace(/\\/g, '/')).toBe('/home/u/.genie/osa');
    });

    it('Genie runs the OSA there and writes its home there at boot, in normal mode', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        expect(main).toMatch(/OS_WORKSPACE\) return osaHomeDir\(\)/);
        expect(main).toMatch(/osaHomeFiles\('normal'/);
        expect(main).not.toMatch(/OS_WORKSPACE\) return app\.getPath\('userData'\)/);
    });
});
