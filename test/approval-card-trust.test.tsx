// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTONOMY_UNTRUSTED } from '../src/core/agent-ops.js';
import { ApprovalCard } from '../src/renderer/components/ApprovalCard.js';
import { control } from './helpers/control-markup.js';

/**
 * THE APPROVAL CARD (Tynn #618; the owner, 2026-11-11). Two things: Allow and Deny stay in view however long the command
 * is (they sat under it, off the bottom), and a card that asks only because "this workspace isn't trusted" offers Trust
 * this workspace right there, with its progress, then that it is trusted, or why not with Retry.
 */
type Props = ComponentProps<typeof ApprovalCard>;
const options = [{ id: 'allow', label: 'Allow', tone: 'ok' as const }, { id: 'deny', label: 'Deny', tone: 'bad' as const }];
const LONG = `bash -lc '${'echo a-very-long-command-line && '.repeat(900)}true'`;
const base = (over: Record<string, unknown> = {}) => ({ approval: { question: 'Run a command', tool: 'Bash', command: LONG, options, why: null }, answering: null, onAnswer: () => {}, agentName: 'atlas', ...over }) as unknown as Props;

describe('Allow and Deny stay in view', () => {
    const html = renderToStaticMarkup(<ApprovalCard {...base()} />);
    const body = html.indexOf('data-approval-body');
    const actions = html.indexOf('data-approval-actions');

    it('the question and the command scroll inside the card, at a bounded height', () => {
        expect(body).toBeGreaterThan(0);
        const open = html.slice(html.lastIndexOf('<', body), html.indexOf('>', body));
        expect(open).toMatch(/overflow-y-auto/);
        expect(open).toMatch(/max-h-\[/);
        expect(html.indexOf('data-approval-command')).toBeGreaterThan(body);
        expect(html.indexOf('data-approval-command')).toBeLessThan(actions);
    });

    it('the options are outside what scrolls, after it, in a footer that does not shrink', () => {
        expect(actions).toBeGreaterThan(body);
        const open = html.slice(html.lastIndexOf('<', actions), html.indexOf('>', actions));
        expect(open).toMatch(/shrink-0/);
        expect(html.indexOf('data-approval-option="allow"')).toBeGreaterThan(actions);
        expect(html.indexOf('data-approval-option="deny"')).toBeGreaterThan(actions);
        // The whole command is still there to read.
        expect(html.length).toBeGreaterThan(LONG.length);
    });
});

describe('Trust this workspace, on the card', () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
    afterEach(() => { act(() => root.unmount()); host.remove(); });
    const q = (s: string) => document.querySelector<HTMLElement>(s);
    const settle = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((ok) => setTimeout(ok, 0)); });
    const untrusted = (onTrustWorkspace: () => Promise<unknown>) => base({ approval: { question: 'Run a command', tool: 'Bash', command: 'npm test', options, why: AUTONOMY_UNTRUSTED }, onTrustWorkspace });

    it('asked because the workspace isn\'t trusted: the card offers it, as a react-fancy Button', () => {
        const html = renderToStaticMarkup(<ApprovalCard {...untrusted(async () => undefined)} />);
        expect(html).toContain('this workspace isn’t trusted');
        expect(control(html, 'data-action="approval-trust-workspace"')).toMatchObject({ tag: 'button', fancy: true, text: 'Trust this workspace' });
    });

    it('CONTROL: asked for another reason, or with no way to trust from here: no such button', () => {
        expect(renderToStaticMarkup(<ApprovalCard {...base({ onTrustWorkspace: async () => undefined })} />)).not.toContain('approval-trust-workspace');
        expect(renderToStaticMarkup(<ApprovalCard {...base({ approval: { question: 'q', tool: null, options, why: 'Some other reason.' }, onTrustWorkspace: async () => undefined })} />)).not.toContain('approval-trust-workspace');
        expect(renderToStaticMarkup(<ApprovalCard {...({ ...untrusted(async () => undefined), onTrustWorkspace: undefined } as unknown as Props)} />)).not.toContain('approval-trust-workspace');
    });

    it('pressed: it trusts, shows its progress, then says it is trusted and that this request still wants an answer', async () => {
        let finish: () => void = () => undefined;
        const trust = vi.fn(() => new Promise<void>((ok) => { finish = ok; }));
        act(() => { root.render(<ApprovalCard {...untrusted(trust)} />); });
        act(() => { q('[data-action="approval-trust-workspace"]')!.click(); });
        await settle();
        expect(trust).toHaveBeenCalledTimes(1);
        expect((q('[data-action="approval-trust-workspace"]') as HTMLButtonElement).disabled).toBe(true);
        act(() => { finish(); });
        await settle();
        expect(q('[data-approval-trusted]')!.textContent).toMatch(/trusted/i);
        expect(q('[data-action="approval-trust-workspace"]')).toBeNull();
        // Allow and Deny are still the answer to THIS request.
        expect(q('[data-approval-option="allow"]')).not.toBeNull();
    });

    it('it could not be trusted: why, in words, with Retry; Retry tries again', async () => {
        const trust = vi.fn<() => Promise<unknown>>().mockRejectedValueOnce(new Error('EROFS: the record could not be saved')).mockResolvedValueOnce({ ok: false, reason: 'There is no workspace to trust.' }).mockResolvedValueOnce(undefined);
        act(() => { root.render(<ApprovalCard {...untrusted(trust)} />); });
        act(() => { q('[data-action="approval-trust-workspace"]')!.click(); });
        await settle();
        expect(q('[data-approval-trust-failed]')!.textContent).toContain('the record could not be saved');
        act(() => { q('[data-action="approval-trust-retry"]')!.click(); });
        await settle();
        // A refusal that comes back as an answer, not a throw, is a failure too.
        expect(q('[data-approval-trust-failed]')!.textContent).toContain('There is no workspace to trust.');
        act(() => { q('[data-action="approval-trust-retry"]')!.click(); });
        await settle();
        expect(trust).toHaveBeenCalledTimes(3);
        expect(q('[data-approval-trusted]')).not.toBeNull();
    });
});
