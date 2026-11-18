import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAIN_ERROR_DECK_PREFIX } from '../src/core/main-errors.js';
import type { FeatureAction } from '../src/renderer/features.js';
import { CALLER_A, CALLER_B, deferred, item, presentationFixture, type PresentationFixture } from './helpers/features-host-presentation.js';

let f: PresentationFixture;
beforeEach(async () => { f = await presentationFixture(); });
afterEach(async () => { await f?.close(); vi.restoreAllMocks(); });
const ownWindow = /caller.*own.*(?:admitted|local).*window/i;

describe('host features present only in the requesting window (Tynn #720)', () => {
    it('an existing flow editor opens only for caller A even when B connected later', async () => {
        await f.answer({ kind: 'flows.openEditor', flowId: 'flow / one' });
        expect(f.calls).toEqual([{ owner: CALLER_A.connectionId, effect: 'flow', value: 'genie://flow/flow%20%2F%20one' }]);
        expect(f.resolve).toHaveBeenCalledWith(CALLER_A);
    });
    it('a new flow route is encoded and goes only to caller B', async () => {
        await f.answer({ kind: 'flows.newFlow', workspaceId: 'work / two' }, CALLER_B);
        expect(f.calls).toEqual([{ owner: CALLER_B.connectionId, effect: 'flow', value: 'genie://flow/new?workspace=work%20%2F%20two' }]);
    });
    it('opening a real declared site uses only the caller browser and retains its URL there', async () => {
        const site = await f.seedSite();
        await f.answer({ kind: 'hosting.openSite', siteId: site.id });
        expect(f.calls).toEqual([{ owner: CALLER_A.connectionId, effect: 'site', value: 'https://fixture.gen/' }]);
        expect((await f.snapshot()).browser.url).toBe('https://fixture.gen/');
        expect((await f.snapshot(CALLER_B)).browser.url).toBeNull();
    });
    it('browser navigation keeps canonical route validation and reports an unavailable caller pane', async () => {
        await f.seedSite();
        await f.answer({ kind: 'browser.navigate', url: 'https://fixture.gen/path?q=one' });
        expect(f.calls).toEqual([{ owner: CALLER_A.connectionId, effect: 'navigate', value: 'https://fixture.gen/path?q=one' }]);
        expect((await f.snapshot()).browser.url).toBe('https://fixture.gen/path?q=one');
        expect((await f.snapshot(CALLER_B)).browser.url).toBeNull();
    });
    it('Back uses the own pane history and answers its measured URL', async () => {
        await f.answer({ kind: 'browser.back' });
        expect(f.calls).toEqual([{ owner: CALLER_A.connectionId, effect: 'back' }]);
        expect((await f.snapshot()).browser).toMatchObject({ url: 'https://previous.gen/', canGoForward: true });
    });
    it('Forward uses the own pane history and answers its measured URL', async () => {
        await f.answer({ kind: 'browser.forward' }, CALLER_B);
        expect(f.calls).toEqual([{ owner: CALLER_B.connectionId, effect: 'forward' }]);
        expect((await f.snapshot(CALLER_B)).browser).toMatchObject({ url: 'https://next.gen/', canGoBack: true });
    });
    it('Reload touches only the requesting pane', async () => {
        await f.answer({ kind: 'browser.reload' });
        expect(f.calls).toEqual([{ owner: CALLER_A.connectionId, effect: 'reload' }]);
    });
    it('a refreshed browser history is read from that caller rather than a shared last URL', async () => {
        f.history.get(CALLER_A.connectionId)!.url = 'https://a.gen/';
        f.history.get(CALLER_B.connectionId)!.url = 'https://b.gen/';
        expect((await f.snapshot()).browser.url).toBe('https://a.gen/');
        expect((await f.snapshot(CALLER_B)).browser.url).toBe('https://b.gen/');
    });
    it('the brought-back renderer notice is dismissed only in its own window', async () => {
        await f.answer({ kind: 'rendererNotice.dismiss' });
        expect(f.calls).toEqual([{ owner: CALLER_A.connectionId, effect: 'renderer-notice' }]);
    });
    it('the Claude Code login maps its CLI row to Claude and opens only for its caller', async () => {
        const answer = await f.answer({ kind: 'toolchain.login', tool: 'claude-code' });
        expect(f.calls).toEqual([{ owner: CALLER_A.connectionId, effect: 'login', value: 'claude' }]);
        expect(answer.toolchain?.refusals ?? []).toEqual([]);
    });
    it('a login refusal stays on its row with its actual reason', async () => {
        Object.assign(f.a, { login: async () => ({ ok: false, reason: 'fixture caller login closed' }) });
        await f.answer({ kind: 'toolchain.check', force: true });
        const answer = await f.answer({ kind: 'toolchain.login', tool: 'codex' });
        expect(answer.toolchain?.refusals).toEqual([{ tool: 'codex', reason: 'fixture caller login closed' }]);
        expect(f.calls).toEqual([]);
    });
    it('a GitHub page is handed to only the admitted caller presentation port', async () => {
        await f.answer({ kind: 'integrations.githubOpen', target: { page: 'authorizations' } });
        expect(f.calls).toEqual([{ owner: CALLER_A.connectionId, effect: 'github', value: { page: 'authorizations' } }]);
        expect(f.accountCalls).toEqual([]);
    });
    it('the real Linux Tailscale install plan presents its download page only to that caller', async () => {
        const answer = await f.answer({ kind: 'tailscale.install' });
        expect(f.calls).toEqual([{ owner: CALLER_A.connectionId, effect: 'external', value: 'https://tailscale.com/download' }]);
        expect(answer.remote?.tailscaleOutcome).toBe('Tailscale’s download page opened in your browser.');
    });
    it('no admitted window refuses a UI effect visibly rather than queuing success', async () => {
        f.windows.clear();
        expect(await f.invoke({ kind: 'flows.openEditor', flowId: 'fixture' })).toMatchObject({ ok: false, reason: expect.stringMatching(ownWindow) });
        expect(f.calls).toEqual([]);
    });
    it('an unknown caller cannot borrow the newest existing window', async () => {
        expect(await f.invoke({ kind: 'browser.reload' }, { ...CALLER_A, connectionId: 'unknown-window' }))
            .toMatchObject({ ok: false, reason: expect.stringMatching(ownWindow) });
        expect(f.calls).toEqual([]);
    });
    for (const origin of ['remote-window', 'device', 'relay'] as const) {
        it(`a ${origin} caller cannot acquire local presentation even if the resolver has a matching id`, async () => {
            const caller = { ...CALLER_A, origin }; // deliberately shares an id: origin must still be checked.
            expect(await f.invoke({ kind: 'flows.newFlow', workspaceId: 'work' }, caller))
                .toMatchObject({ ok: false, reason: expect.stringMatching(ownWindow) });
            expect(f.calls).toEqual([]);
        });
    }
    it('an effect rejected by a closed caller link preserves the refusal and never tries B', async () => {
        Object.assign(f.a, { openFlowEditor: async () => { throw new Error('fixture caller connection closed'); } });
        expect(await f.invoke({ kind: 'flows.openEditor', flowId: 'fixture' }))
            .toEqual({ ok: false, reason: 'fixture caller connection closed' });
        expect(f.calls).toEqual([]);
    });
    it('an asynchronous own-window effect must finish before the action can report success', async () => {
        const finish = deferred(); f.holds.push(() => finish.resolve()); let ended = false;
        Object.assign(f.a, { openFlowEditor: async () => { f.record(CALLER_A.connectionId, 'held-flow'); await finish.promise; } });
        const pending = f.invoke({ kind: 'flows.openEditor', flowId: 'fixture' }).then(result => { ended = true; return result; });
        await f.settle();
        try { expect(f.calls).toEqual([{ owner: CALLER_A.connectionId, effect: 'held-flow' }]); expect(ended).toBe(false); }
        finally { finish.resolve(); await pending; }
        expect(await pending).toMatchObject({ ok: true });
    });
    for (const [option, effect] of [['dismiss', 'error-dismiss'], ['retry', 'host-copy'], ['open-log', 'log'], ['report', 'report']] as const) {
        it(`the window error action ${option} reaches only the caller error owner`, async () => {
            const error = item({ id: MAIN_ERROR_DECK_PREFIX + 'fixture', source: 'genie', agentId: null,
                answer: { kind: 'inline', options: ['dismiss', 'retry', 'open-log', 'report'].map(id => ({ id, label: id, tone: 'neutral' as const })) } });
            // The caller's own window holds its error record (Tynn #861: an answer is resolved against the record held).
            Object.assign(f.a.mainErrors!, { deckItems: () => [error] });
            await f.answer({ kind: 'deck.answer', item: error, optionId: option });
            expect(f.calls).toEqual([{ owner: CALLER_A.connectionId, effect, value: error.id }]);
        });
    }
    it('CONTROL: presentation adapters themselves distinguish the two actual fixture callers', async () => {
        await f.a.openFlowEditor!('genie://flow/a'); await f.b.openFlowEditor!('genie://flow/b');
        expect(f.calls.map(call => [call.owner, call.value])).toEqual([[CALLER_A.connectionId, 'genie://flow/a'], [CALLER_B.connectionId, 'genie://flow/b']]);
    });
    it('CONTROL: the canonical Linux Tailscale planner supplies its real page without a download', async () => {
        expect(await f.a.tailscaleInstall!()).toEqual({ started: false, url: 'https://tailscale.com/download' });
        expect(f.calls[0]?.owner).toBe(CALLER_A.connectionId);
    });
    it('CONTROL: host business operations still work with every presentation window absent', async () => {
        f.windows.clear(); await f.answer({ kind: 'settings.set', key: 'publisher_checks_off', value: false });
        expect(f.settings.get('publisher_checks_off')).toBe(false); expect(f.calls).toEqual([]);
    });
    it('CONTROL: the historical browser policy refuses a non-HTTPS scheme before presentation', async () => {
        await expect(f.legacy({ kind: 'browser.navigate', url: 'file:///fixture' })).rejects.toThrow();
        expect(f.calls).toEqual([]);
    });
});
