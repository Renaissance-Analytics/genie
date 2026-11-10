// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { IW_DELIVERIES, IW_EVENT_KINDS, type IssueWatchPrefs, type IssueWatchSetting } from '../src/core/issue-watch.js';
import { IssueWatchSettings } from '../src/renderer/components/AgentView.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/*
 * THE ISSUEWATCH TAB (Tynn #590; the owner: its labels overlapped, the long security label running into the next column).
 * Fancy controls, only the words needed, and every change says what happened to it where the person made it.
 */

type Answer = { ok: true } | { ok: false; reason: string };
type Props = Parameters<typeof IssueWatchSettings>[0];

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean };
let host: HTMLDivElement;
let root: Root;
const PREFS: IssueWatchPrefs = { delivery: 'push', kinds: ['issue.new'], chosen: true };

beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

/** A save the test answers when it chooses. */
function pendingSave() {
    const sent: IssueWatchSetting[] = [];
    let answer: (a: Answer) => void = () => {};
    return { sent, onSet: (s: IssueWatchSetting) => { sent.push(s); return new Promise<Answer>((r) => { answer = r; }); }, finish: (a: Answer) => act(async () => { answer(a); await Promise.resolve(); }) };
}
function mount(onSet: Props['onSet'], prefs = PREFS) {
    act(() => root.render(<IssueWatchSettings name="atlas" prefs={prefs} onSet={onSet} />));
}
const box = (kind: string) => host.querySelector(`[data-issue-watch-kind="${kind}"] input`) as HTMLInputElement;
const toggle = (kind: string) => act(() => { box(kind).click(); });
const status = () => host.querySelector('[data-iw-save]');

describe('each change says what happened', () => {
    it('saving, then saved', async () => {
        const save = pendingSave();
        mount(save.onSet);
        toggle('pr.new');
        expect(save.sent).toEqual([{ delivery: 'push', kinds: ['issue.new', 'pr.new'] }]);
        expect(status()?.getAttribute('data-iw-save')).toBe('saving');
        await save.finish({ ok: true });
        expect(status()?.getAttribute('data-iw-save')).toBe('saved');
    });

    it('the box follows the click at once, and goes back if the save fails', async () => {
        const save = pendingSave();
        mount(save.onSet);
        toggle('pr.new');
        expect(box('pr.new').checked).toBe(true);
        await save.finish({ ok: false, reason: 'Genie did not answer' });
        expect(box('pr.new').checked).toBe(false);
    });

    it('failed: the reason beside the control, and a Retry that sends the same change', async () => {
        const save = pendingSave();
        mount(save.onSet);
        toggle('pr.new');
        await save.finish({ ok: false, reason: 'Genie did not answer' });
        expect(status()?.getAttribute('data-iw-save')).toBe('failed');
        expect(status()?.textContent).toContain('Genie did not answer');
        const retry = status()?.querySelector('button') as HTMLButtonElement;
        expect(retry.textContent).toBe('Retry');
        act(() => { retry.click(); });
        expect(save.sent).toEqual([{ delivery: 'push', kinds: ['issue.new', 'pr.new'] }, { delivery: 'push', kinds: ['issue.new', 'pr.new'] }]);
        expect(status()?.getAttribute('data-iw-save')).toBe('saving');
        await save.finish({ ok: true });
        expect(status()?.getAttribute('data-iw-save')).toBe('saved');
    });

    it('a save that throws is a failure, not a spinner forever', async () => {
        mount(() => Promise.reject(new Error('the connection closed')));
        await act(async () => { box('pr.new').click(); await Promise.resolve(); });
        expect(status()?.getAttribute('data-iw-save')).toBe('failed');
        expect(status()?.textContent).toContain('the connection closed');
    });

    it('before any change, it says nothing (CONTROL)', () => {
        mount(pendingSave().onSet);
        expect(status()).toBeNull();
    });

    it('two quick changes: the second builds on the first, and only the last answer speaks', async () => {
        const answers: Array<(a: Answer) => void> = [];
        const sent: IssueWatchSetting[] = [];
        mount((s) => { sent.push(s); return new Promise<Answer>((r) => { answers.push(r); }); });
        toggle('pr.new');
        toggle('comment');
        expect(sent[1]).toEqual({ delivery: 'push', kinds: ['issue.new', 'pr.new', 'comment'] });
        await act(async () => { answers[0]!({ ok: false, reason: 'stale' }); await Promise.resolve(); });
        expect(status()?.getAttribute('data-iw-save')).toBe('saving');
        await act(async () => { answers[1]!({ ok: true }); await Promise.resolve(); });
        expect(status()?.getAttribute('data-iw-save')).toBe('saved');
    });
});

describe('the words and the layout', () => {
    const source = () => { const all = readFileSync('src/renderer/components/AgentView.tsx', 'utf8'); return all.slice(all.indexOf('function IssueWatchSettings')); };

    it('Fancy Select and Checkbox, no bare controls', () => {
        const code = source().split('\nfunction ')[0]!;
        expect(code).toContain('<Select');
        expect(code).toContain('<Checkbox');
        expect(code).not.toMatch(/<select\b|<input\b/);
    });

    it('no label can run into the next column: nothing truncates without room to shrink', () => {
        mount(pendingSave().onSet);
        expect(host.querySelector('[data-issue-watch] .truncate')).toBeNull();
        const fieldsets = [...host.querySelectorAll('fieldset')];
        expect(fieldsets).toHaveLength(3);
        for (const f of fieldsets) expect(f.className).toContain('min-w-0');
        for (const k of IW_EVENT_KINDS) expect(host.querySelector(`[data-issue-watch-kind="${k.kind}"]`)?.className).toContain('min-w-0');
    });

    it('only the words needed', () => {
        expect(IW_EVENT_KINDS.filter((k) => k.label.includes('('))).toEqual([]);
        for (const k of IW_EVENT_KINDS) expect(k.label.length, k.kind).toBeLessThanOrEqual(24);
        for (const d of IW_DELIVERIES) expect(d.label.length, d.value).toBeLessThanOrEqual(16);
        expect(new Set(IW_EVENT_KINDS.map((k) => k.label)).size).toBe(IW_EVENT_KINDS.length);
    });
});

describe('every choice round-trips through the real store and survives reopening', () => {
    let dir = '';
    let registry: Registry;
    let atlas: AgentRecord;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-iw-'));
        registry = new Registry(new Store(dir));
        await registry.load({ name: 'alphar', healthy: true });
        await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
        atlas = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
    const reopened = async () => { const r = new Registry(new Store(dir)); await r.load({ name: 'alphar', healthy: true }); return r.find(atlas.id)!.issueWatch; };

    it.each(IW_DELIVERIES.map((d) => d.value))('delivery %s', async (delivery) => {
        await registry.setIssueWatch(atlas.id, { delivery, kinds: ['issue.new'] });
        expect(await reopened()).toEqual({ delivery, kinds: ['issue.new'] });
    });

    it.each(IW_EVENT_KINDS.map((k) => k.kind))('kind %s', async (kind) => {
        await registry.setIssueWatch(atlas.id, { delivery: 'push', kinds: [kind] });
        expect(await reopened()).toEqual({ delivery: 'push', kinds: [kind] });
    });
});
