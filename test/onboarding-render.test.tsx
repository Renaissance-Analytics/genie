import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Onboarding } from '../src/renderer/components/Onboarding.js';

/**
 * ONBOARDING (§6.9) — two steps, two decisions: pick a folder, meet an agent. Everything else is a
 * LINE with a route to fix it, never a gate. Target: first agent reply in under two minutes. When
 * both steps are done the component renders NOTHING — the Dashboard is the screen.
 */

const state = (over: Partial<Parameters<typeof Onboarding>[0]['state']> = {}) => ({ workspaces: 0, agents: 0, providers: [], githubConnected: false, tynnSignedIn: false, ...over });

describe('the two steps', () => {
    it('nothing set up: step one is the folder and is the only enabled action; step two waits', () => {
        const html = renderToStaticMarkup(<Onboarding state={state()} onAddWorkspace={() => {}} onAddAgent={() => {}} onNavigate={() => {}} />);
        expect(html).toContain('data-onboarding');
        expect(html).toMatch(/data-step="pick-folder"[^>]*data-active="true"/);
        expect(html).toMatch(/data-step="meet-agent"[^>]*data-active="false"/);
        expect(html).toMatch(/Pick a folder/);
        expect(html).toMatch(/Meet your first agent/);
    });

    it('a folder picked: step two is active and offers the agent; step one is marked done', () => {
        const html = renderToStaticMarkup(<Onboarding state={state({ workspaces: 1, providers: ['claude'] })} onAddWorkspace={() => {}} onAddAgent={() => {}} onNavigate={() => {}} />);
        expect(html).toMatch(/data-step="pick-folder"[^>]*data-done="true"/);
        expect(html).toMatch(/data-step="meet-agent"[^>]*data-active="true"/);
    });

    it('both done: renders nothing at all — not an empty frame', () => {
        expect(renderToStaticMarkup(<Onboarding state={state({ workspaces: 1, agents: 1, providers: ['claude'], githubConnected: true, tynnSignedIn: true })} onAddWorkspace={() => {}} onAddAgent={() => {}} onNavigate={() => {}} />)).toBe('');
    });
});

describe('the lines', () => {
    it('each unmet, non-gating fact is one line with its route — COUNTED, and none of them is a button that blocks the steps', () => {
        const html = renderToStaticMarkup(<Onboarding state={state()} onAddWorkspace={() => {}} onAddAgent={() => {}} onNavigate={() => {}} />);
        expect(html.match(/data-line="/g) ?? []).toHaveLength(3);
        expect(html).toContain('data-line="no-provider"');
        expect(html).toContain('data-route="genie://settings/agents"');
        expect(html).toContain('data-route="genie://settings/github"');
        expect(html).toContain('data-route="genie://settings/tynn"');
        expect(html).toMatch(/optional/i);
    });

    it('with a provider and GitHub connected, only the Tynn line remains, and the steps still show', () => {
        const html = renderToStaticMarkup(<Onboarding state={state({ providers: ['claude'], githubConnected: true })} onAddWorkspace={() => {}} onAddAgent={() => {}} onNavigate={() => {}} />);
        expect(html.match(/data-line="/g) ?? []).toHaveLength(1);
        expect(html).toContain('data-line="tynn"');
    });
});
