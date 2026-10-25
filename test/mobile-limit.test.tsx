import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentDetail } from '../src/renderer/bridge.js';
import { MobileAgent } from '../src/renderer/components/MobileShell.js';

/**
 * A HELD AGENT, ON THE PHONE (Tynn #794, story #287; the owner: the phone is "the minimum needed to respond to agents and
 * keep them going"). An agent its provider's limit holds says so on its page — the same words as every other surface
 * (core/limit-words.ts) — with Resume now, which opens the login at once. The list already says Paused (it shares
 * statusOf with the Dashboard); this is the one-agent page.
 */
const RESUMES = Date.UTC(2026, 9, 18, 14, 31);
const detail = (limit: unknown): AgentDetail => ({
    agent: { id: 'agent_kai', name: 'kai', provider: 'claude', fidelity: 'declared', cwd: '/w/tynn' } as AgentDetail['agent'],
    session: { running: true, state: 'idle', ...(limit === undefined ? {} : { limit }) } as unknown as AgentDetail['session'],
    rows: [],
    turns: 3,
    cost: null,
    refusal: null,
});
const render = (d: AgentDetail) => renderToStaticMarkup(<MobileAgent detail={d} sending={false} onBack={() => {}} onSend={() => {}} onStart={() => {}} onResumeLimit={() => {}} />);

describe('the phone’s agent page, held by the rate limit', () => {
    it('says it is paused and until when, with Resume now', () => {
        const html = render(detail({ state: 'paused', resumeAtMs: RESUMES }));
        expect(html).toContain('data-mobile-limit');
        expect(html).toMatch(/title="Resumes [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, \d{4} at \d{1,2}:\d\d [AP]M"[^>]*>Paused · rate limit · resumes \d{1,2}:\d\d [AP]M</);
        expect(html).toMatch(/data-action="resume-limit"[^>]*>Resume now</);
    });

    it('on the no-reset backoff: the next try; needing the person: says so (COUNTED: one Resume now each)', () => {
        const retrying = render(detail({ state: 'retrying', nextTryAtMs: RESUMES, attempt: 1, message: null }));
        expect(retrying).toMatch(/rate limit · next try \d{1,2}:\d\d [AP]M/);
        expect(retrying.match(/data-action="resume-limit"/g)).toHaveLength(1);
        const needs = render(detail({ state: 'needs-person', message: 'Add credits to continue' }));
        expect(needs).toMatch(/needs you: Add credits to continue/);
    });

    it('CONTROL: open, or never reported — no line and no Resume now', () => {
        for (const html of [render(detail({ state: 'open' })), render(detail(undefined))]) {
            expect(html).not.toContain('data-mobile-limit');
            expect(html).not.toContain('data-action="resume-limit"');
        }
    });
});

describe('the phone wires Resume now to the host', () => {
    const src = readFileSync('src/renderer/App.tsx', 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
    it('MobileAgent’s Resume now asks the host to resume THIS agent’s login', () => {
        expect(src).toMatch(/onResumeLimit=\{\(\) => \{ void bridge!\.resumeLimit\(agentId\); \}\}/);
    });
});
