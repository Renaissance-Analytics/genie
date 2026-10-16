import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OsaFacts } from '../src/core/osa-home.js';
import { DoctorApp, type DoctorDetail } from '../src/renderer/DoctorApp.js';

/**
 * THE DOCTOR WINDOW (`genie --doctor`, the owner 2026-10-12): Genie with ONLY the Genie OSA. One window: the facts of
 * the install, genie's Stream (what it is doing — thoughts, tool calls) and the chat with genie, the composer always
 * there; the line Claude Code connects with. No rail, no Dashboard, no workspace — doctor mode has not opened any of
 * that. A genie that is not running says so and offers to start it.
 *
 * The page has its own preload (`genieDoctor`): it is not handed Genie's bridge, which doctor mode does not serve.
 */
const facts: OsaFacts = { version: '2.0.0-beta.20', platform: 'win32', installDir: 'C:/Program Files/Genie', genieHome: 'C:/Users/u/.genie', userData: 'C:/Users/u/AppData/Roaming/genie2' };
const T = 1_700_000_000_000;
const detail = (over: Partial<DoctorDetail> = {}): DoctorDetail => ({
    agent: { id: 'agent_osa', name: 'genie', provider: 'claude', fidelity: 'declared', cwd: 'C:/Users/u/AppData/Roaming/genie2-doctor/osa' },
    session: { running: true, turnState: 'idle', startedAt: T, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, plan: null } as DoctorDetail['session'],
    rows: [
        { id: 'e1', event: { kind: 'message', speaker: 'you', peerName: null, text: 'Genie will not start.' }, at: T },
        { id: 'e2', event: { kind: 'tool', toolCallId: 't1', name: 'Bash', title: 'Get-Content agents.json', status: 'completed' } as never, at: T + 1_000 },
        { id: 'e3', event: { kind: 'message', speaker: 'agent', peerName: null, text: '`agents.json` does not parse.' }, at: T + 2_000 },
    ],
    turns: 1,
    cost: null,
    ...over,
});
const render = (d: DoctorDetail | null, connect: string | null = 'claude mcp add --transport http genie-doctor http://127.0.0.1:4100/mcp --header "Authorization: Bearer t"') =>
    renderToStaticMarkup(<DoctorApp facts={facts} connect={connect} detail={d} onSend={() => {}} onStart={() => {}} onAnswerApproval={() => {}} />);

describe('the doctor window', () => {
    it('says it is doctor mode, with the facts of the install and the line Claude Code connects with', () => {
        const html = render(detail());
        expect(html).toContain('data-doctor=""');
        expect(html).toMatch(/doctor mode/i);
        for (const v of Object.values(facts)) expect(html).toContain(v);
        expect(html).toContain('data-doctor-connect');
        expect(html).toContain('claude mcp add --transport http genie-doctor');
    });

    it('genie\u2019s Stream and its chat with a composer — and nothing of Genie\u2019s rail, Dashboard or workspaces', () => {
        const html = render(detail());
        expect(html).toContain('data-chat-message="e1"');
        expect(html).toContain('data-chat-message="e3"');
        expect(html).toContain('placeholder="Message genie"');
        expect(html).toContain('data-stream-row="e2"');
        expect(html).not.toContain('data-surface="dashboard"');
        // Its only doors are into genie's own Stream (`?at=<row>`, which this window follows) — none to Genie's surfaces.
        expect(html).not.toMatch(/data-nav="genie:\/\/(dashboard|deck|workspace|settings)/);
        // No control with nothing behind it: the chat is already on the page, and this window cannot open a Take Over.
        expect(html).not.toContain('data-action="chat"');
        expect(html).not.toContain('data-action="take-over');
    });

    it('a genie that is not running says so and offers Start (positive control: a running one does not)', () => {
        const stopped = render(detail({ session: null }));
        expect(stopped).toContain('data-doctor-start');
        expect(stopped).toMatch(/genie is not running/i);
        expect(render(detail())).not.toContain('data-doctor-start');
    });

    it('before the first read: a skeleton, not "not running"', () => {
        const first = render(null);
        expect(first).toContain('data-doctor-loading');
        expect(first).not.toContain('data-doctor-start');
    });

    it('no connect line until the channel is listening', () => {
        expect(render(detail(), null)).not.toContain('claude mcp add');
    });
});

describe('the page and its preload', () => {
    it('a page of its own, loading the doctor renderer; the preload exposes genieDoctor and never Genie\u2019s bridge', () => {
        expect(readFileSync('doctor.html', 'utf8')).toMatch(/src="\/src\/renderer\/doctor-main\.tsx"/);
        const preload = readFileSync('src/main/doctor-preload.ts', 'utf8');
        expect(preload).toMatch(/exposeInMainWorld\('genieDoctor'/);
        expect(preload).not.toMatch(/exposeInMainWorld\('genie'/);
        // Positive control: Genie's own preload does expose `genie`.
        expect(readFileSync('src/main/preload.ts', 'utf8')).toMatch(/exposeInMainWorld\('genie'/);
    });
});
