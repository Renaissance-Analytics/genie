// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountsView, type AccountsSnapshot } from '../src/core/accounts-view.js';
import { DESIGN_AUTH_UNKNOWN, DesignAuthBook, DesignOperationTracker, designAuthNext, designAuthView, type DesignAuth } from '../src/core/design-auth.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { RateLimitPills } from '../src/renderer/components/Dashboard.js';
import { AccountsSettings } from '../src/renderer/components/AccountsSettings.js';

/**
 * ACCOUNTS S7 (Tynn #480): CLAUDE DESIGN SIGN-IN, MACHINE-WIDE (decision 5: per-home Design authorization is undocumented
 * and unmeasured, and Claude Design's own refusal says it is per machine). One "Design sign-in" in the one provider home.
 * Genie says "Authorized" only after the operation that needed it succeeds, never because the Design terminal closed: closing
 * it without success leaves "Not authorized", and the next success of that same operation marks it. Fixtures name no person.
 */
const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n');
const REFUSAL = 'DesignSync needs design-system authorization, and /design-login cannot run in this non-interactive session. Ask the user to run /design-login once.';
const tool = (over: Partial<Extract<StreamEvent, { kind: 'tool' }>>): StreamEvent => ({ kind: 'tool', toolCallId: 'c1', name: null, title: null, status: null, toolKind: null, rawInput: null, ...over } as StreamEvent);

describe('S7: what Genie says about the Design authorization', () => {
    const refused: DesignAuth = designAuthNext(DESIGN_AUTH_UNKNOWN, { kind: 'refused', operation: 'DesignSync' });
    it('a refusal for want of /design-login is Not authorized', () => {
        expect(designAuthView(refused)).toMatchObject({ state: 'needed', authorized: false });
        expect(designAuthView(refused).words).toMatch(/^Not authorized/);
    });
    it('closing the Design terminal without success leaves it Not authorized', () => {
        const ran = designAuthNext(refused, { kind: 'login-ended' });
        expect(designAuthView(ran)).toMatchObject({ state: 'login-ran', authorized: false });
        expect(designAuthView(ran).words).toMatch(/^Not authorized/);
    });
    it('a later success of the operation that needed it marks it Authorized', () => {
        const ran = designAuthNext(refused, { kind: 'login-ended' });
        expect(designAuthView(designAuthNext(ran, { kind: 'tool-completed', operation: 'DesignSync' }))).toMatchObject({ state: 'authorized', authorized: true, words: 'Authorized' });
    });
    it('CONTROL: another tool succeeding authorizes nothing', () => {
        const ran = designAuthNext(refused, { kind: 'login-ended' });
        expect(designAuthView(designAuthNext(ran, { kind: 'tool-completed', operation: 'Bash' })).authorized).toBe(false);
    });
    it('refused again after it was authorized: Not authorized again', () => {
        const ok = designAuthNext(designAuthNext(refused, { kind: 'login-ended' }), { kind: 'tool-completed', operation: 'DesignSync' });
        expect(designAuthView(designAuthNext(ok, { kind: 'refused', operation: 'DesignSync' }))).toMatchObject({ state: 'needed', authorized: false });
    });
    it('CONTROL: a refusal naming no operation can never be matched, so nothing completing authorizes it', () => {
        const anon = designAuthNext(designAuthNext(DESIGN_AUTH_UNKNOWN, { kind: 'refused', operation: null }), { kind: 'login-ended' });
        expect(designAuthView(designAuthNext(anon, { kind: 'tool-completed', operation: 'DesignSync' })).authorized).toBe(false);
    });
});

describe('S7: which operation it was, across a tool call\'s updates', () => {
    it('the refused update names nothing, so the call\'s earlier update gives the operation', () => {
        const t = new DesignOperationTracker();
        expect(t.track(tool({ toolCallId: 'c1', name: 'DesignSync', status: 'pending' }))).toBeNull();
        expect(t.track(tool({ toolCallId: 'c1', status: 'failed', output: REFUSAL } as never))).toEqual({ kind: 'refused', operation: 'DesignSync' });
    });
    it('a later call of it that completes is reported, its name remembered from its first update', () => {
        const t = new DesignOperationTracker();
        t.track(tool({ toolCallId: 'c2', title: 'DesignSync', status: 'in_progress' }));
        expect(t.track(tool({ toolCallId: 'c2', status: 'completed' }))).toEqual({ kind: 'tool-completed', operation: 'DesignSync' });
    });
});

describe('S7: one state for the machine, kept across a restart', () => {
    it('applied, saved, and read back', () => {
        let saved: unknown;
        const book = new DesignAuthBook(() => undefined, (s) => { saved = JSON.parse(JSON.stringify(s)); });
        book.apply({ kind: 'refused', operation: 'DesignSync' });
        book.apply({ kind: 'login-ended' });
        expect(new DesignAuthBook(() => saved, () => {}).view()).toMatchObject({ state: 'login-ran', authorized: false });
    });
    it('CONTROL: a saved state that is not one is Not checked', () => {
        expect(new DesignAuthBook(() => 'garbage', () => {}).view()).toMatchObject({ state: 'unknown', authorized: false });
    });
});

describe('S7: where the person sees it and signs in, one click', () => {
    const NOW = new Date(2026, 10, 16, 9, 30).getTime();
    const A = `account_${'a'.repeat(32)}`;
    const snapshot: AccountsSnapshot = {
        providers: accountsView([{ id: A, provider: 'claude', label: 'Work Max', identity: { email: 'work@example.invalid', plan: null } }], [], { claude: A }),
        offers: [],
        design: designAuthView(designAuthNext(DESIGN_AUTH_UNKNOWN, { kind: 'refused', operation: 'DesignSync' })),
    };
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
    afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
    const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    it('the Claude popover says Not authorized, for this machine, with one-click Design sign-in', () => {
        const onDesignSignIn = vi.fn();
        act(() => root.render(<RateLimitPills limits={{}} accounts={snapshot} now={NOW} onDesignSignIn={onDesignSignIn} />));
        click(host.querySelector('[data-account-chip="claude"]')!);
        const row = document.querySelector('[data-account-popover="claude"] [data-design-auth]')!;
        expect(row.getAttribute('data-design-auth')).toBe('needed');
        expect(row.textContent).toMatch(/Not authorized/);
        expect(row.textContent).toMatch(/this machine/i);
        click(row.querySelector('[data-action="design-sign-in"]')!);
        expect(onDesignSignIn).toHaveBeenCalledTimes(1);
    });
    it('Settings → Providers → Accounts shows the same, with Design sign-in', () => {
        const onDesignSignIn = vi.fn();
        act(() => root.render(<AccountsSettings snapshot={snapshot} offerWindows="both" onSetOfferWindows={() => {}} onDesignSignIn={onDesignSignIn} now={NOW} />));
        const row = host.querySelector('[data-design-auth]')!;
        expect(row.textContent).toMatch(/Not authorized/);
        click(row.querySelector('[data-action="design-sign-in"]')!);
        expect(onDesignSignIn).toHaveBeenCalledTimes(1);
    });
});

describe('S7: wired through', () => {
    it('sessions report through the tracker; genie-host keeps the book, applies the login\'s end, and serves it; main and the preload open the sign-in', () => {
        expect(source('src/core/session.ts')).toMatch(/new DesignOperationTracker\(\)/);
        expect(source('src/core/session.ts')).toMatch(/this\.#options\.onDesignAuth\?\.\(/);
        const host = source('src/main/genie-host.ts');
        // Not '...auth.json': the credential guard (account-credential-guard-477) rightly flags any such name under src/. Gate 1116-230736-6aebb1.
        expect(host).toContain("join(home, 'claude-design-state.json')");
        expect(host).toMatch(/onDesignLoginEnded: \(\) => \{ designAuth\.apply\(\{ kind: 'login-ended' \}\);/);
        expect(host).toMatch(/onDesignAuth: \(_agentId, event\) => designAuth\.apply\(event\)/);
        expect(host).toMatch(/design: designAuthNow\?\.view\(\)/);
        // The machine's one design sign-in is genie-host's, for the client that asked (Tynn #896).
        expect(source('src/main/host-sign-ins.ts')).toMatch(/design: async \(context\) => loginFor\(DESIGN_LOGIN, context\)/);
        expect(source('src/renderer/remote-bridge.ts')).toMatch(/designSignIn: \(\) => answer<SignInResult>\('logins\.design'\)/);
    });
});
