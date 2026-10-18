import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { feedbackOutcomeWords, feedbackTargets, type FeedbackOutcome, type FeedbackView } from '../src/core/feedback.js';
import { SETTINGS, carryOverV1 } from '../src/core/settings.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import { sendFeedback } from '../src/main/feedback-send.js';
import { DEFAULT_FEEDBACK_HOTKEY, wireFeedbackHotkey } from '../src/main/feedback-hotkey.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { FeedbackBody, FeedbackWindow } from '../src/renderer/components/FeedbackWindow.js';

/**
 * THE FEEDBACK WINDOW (Tynn #760; Genie 1's FeedbackModal, #249). From anywhere on the computer — Ctrl+Shift+W, a global
 * key — or the tray's "Send feedback…", the person writes what they noticed and Genie files it as an issue in one of
 * THEIR Tynn projects: the projects their workspaces are linked to, the one they are in first. It goes by the Tynn
 * token Genie already holds (Tynn's `POST /api/v1/genie/feedback`). Then it says where it went — "Sent. It's issue #12
 * in tynn." — with Send another and Done. Not signed in, or no workspace linked, is said, never an empty picker.
 */
vi.mock('electron', () => ({ Menu: { buildFromTemplate: vi.fn() }, Tray: vi.fn(), nativeImage: { createFromBuffer: vi.fn() } }));

const WS = [{ id: 'ws_fancy', name: 'fancy' }, { id: 'ws_tynn', name: 'tynn' }, { id: 'ws_loose', name: 'loose' }];
const projectOf = (id: string) => ({ ws_fancy: 'proj_fancy', ws_tynn: 'proj_tynn' } as Record<string, string>)[id] ?? null;

describe('where it can go', () => {
    it('the workspaces linked to a Tynn project, the one you are in first (COUNTED); unlinked ones are not offered', () => {
        expect(feedbackTargets(WS, projectOf, 'ws_tynn')).toEqual([
            { workspaceId: 'ws_tynn', name: 'tynn', projectId: 'proj_tynn' },
            { workspaceId: 'ws_fancy', name: 'fancy', projectId: 'proj_fancy' },
        ]);
        // CONTROL: from an unlinked workspace, the linked ones in their order
        expect(feedbackTargets(WS, projectOf, 'ws_loose').map((t) => t.name)).toEqual(['fancy', 'tynn']);
        expect(feedbackTargets([{ id: 'ws_loose', name: 'loose' }], projectOf, null)).toEqual([]);
    });

    it('what it says after: where it went, by issue number; or why not', () => {
        expect(feedbackOutcomeWords({ ok: true, issueNumber: 12, target: 'tynn' })).toBe('Sent. It’s issue #12 in tynn’s Tynn project.');
        expect(feedbackOutcomeWords({ ok: true, issueNumber: null, target: 'tynn' })).toBe('Sent to tynn’s Tynn project.');
        expect(feedbackOutcomeWords({ ok: false, reason: 'Tynn could not be reached: offline' })).toBe('Not sent: Tynn could not be reached: offline');
    });
});

describe('sending it to Tynn', () => {
    const fetchFake = (status: number, json: unknown) => {
        const calls: Array<{ url: string; init: { method?: string; headers: Record<string, string>; body?: string } }> = [];
        const fetch = async (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => { calls.push({ url, init }); return { ok: status < 300, status, json: async () => json }; };
        return { calls, fetch };
    };
    const creds = () => ({ host: 'https://tynn.example/', token: 'aak_X.secret' });

    it('POSTs the project, the message and its context with the token Genie holds; answers the issue number', async () => {
        const f = fetchFake(200, { id: 'iss_1', issue_number: 12, title: 'The tray' });
        const out = await sendFeedback({ credentials: creds, fetch: f.fetch }, { projectId: 'proj_tynn', message: 'The tray', meta: { genie_version: '2.0.0-beta.31', workspace: 'tynn' } });
        expect(out).toEqual({ ok: true, issueNumber: 12 });
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0]!.url).toBe('https://tynn.example/api/v1/genie/feedback');
        expect(f.calls[0]!.init.method).toBe('POST');
        expect(f.calls[0]!.init.headers.authorization).toBe('Bearer aak_X.secret');
        expect(JSON.parse(f.calls[0]!.init.body!)).toEqual({ project_id: 'proj_tynn', message: 'The tray', meta: { genie_version: '2.0.0-beta.31', workspace: 'tynn' } });
    });

    it('says why not, in words — a project Tynn will not take, a refused token, nothing to say, no network; not signed in asks nothing', async () => {
        const send = async (status: number, json: unknown) => sendFeedback({ credentials: creds, fetch: fetchFake(status, json).fetch }, { projectId: 'p', message: 'm', meta: {} });
        expect(await send(403, { error: 'project-not-accessible' })).toEqual({ ok: false, reason: 'Tynn says that project is not one you can file into.' });
        expect(await send(401, {})).toEqual({ ok: false, reason: 'Tynn did not accept Genie’s token (HTTP 401). Sign in to Tynn again in Settings.' });
        expect(await send(422, { error: 'title-or-message-required' })).toEqual({ ok: false, reason: 'There was nothing to send.' });
        const offline = await sendFeedback({ credentials: creds, fetch: async () => { throw new Error('offline'); } }, { projectId: 'p', message: 'm', meta: {} });
        expect(offline).toEqual({ ok: false, reason: 'Tynn could not be reached: offline' });
        const out = fetchFake(200, {});
        expect(await sendFeedback({ credentials: () => null, fetch: out.fetch }, { projectId: 'p', message: 'm', meta: {} })).toEqual({ ok: false, reason: 'Genie is not signed in to Tynn.' });
        expect(out.calls).toEqual([]);
    });
});

describe('the window’s actions, in main', () => {
    const pty: PtyPort = {
        open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
    };
    let dir: string;
    let services: ComposedServices;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-feedback-'));
        services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0 });
    });
    afterEach(async () => {
        await services.shutdown();
        await rm(dir, { recursive: true, force: true });
    });
    const state = (over: Partial<FeatureState> = {}): FeatureState => ({ toolStatuses: null, knowledgeQuery: '', ...over });
    const ports = (outcome: { ok: true; issueNumber: number | null } | { ok: false; reason: string }) => {
        const sent: Array<{ projectId: string; message: string; meta: Record<string, string> }> = [];
        return {
            sent,
            feedback: {
                targets: (current: string | null) => feedbackTargets(WS, projectOf, current),
                signedIn: () => true,
                send: async (req: { projectId: string; message: string; meta: Record<string, string> }) => { sent.push(req); return outcome; },
            },
        };
    };

    it('open: the window, its targets with the workspace you are in first; close: gone', async () => {
        const p = ports({ ok: true, issueNumber: 12 });
        const opened = await handleFeatureAction(services, { kind: 'feedback.open', workspaceId: 'ws_tynn' }, state(), p);
        expect(opened.feedback).toEqual({ open: true, signedIn: true, targets: feedbackTargets(WS, projectOf, 'ws_tynn'), outcome: null });
    });

    it('send: to the CHOSEN workspace’s project, with its name as context; the outcome is what the window shows', async () => {
        const p = ports({ ok: true, issueNumber: 12 });
        const s = state({ feedbackOpen: true, feedbackWorkspace: 'ws_tynn' });
        const out = await handleFeatureAction(services, { kind: 'feedback.send', workspaceId: 'ws_fancy', message: '  The tray never says  ' }, s, p);
        expect(p.sent).toEqual([{ projectId: 'proj_fancy', message: 'The tray never says', meta: { workspace: 'fancy' } }]);
        expect(out.feedback?.outcome).toEqual({ ok: true, issueNumber: 12, target: 'fancy' } satisfies FeedbackOutcome);
    });

    it('refused before anything is sent: nothing written, or a workspace that is not linked (COUNTED: nothing sent)', async () => {
        const p = ports({ ok: true, issueNumber: 12 });
        const s = state({ feedbackOpen: true });
        expect((await handleFeatureAction(services, { kind: 'feedback.send', workspaceId: 'ws_tynn', message: '   ' }, s, p)).feedback?.outcome).toEqual({ ok: false, reason: 'Write something first.' });
        expect((await handleFeatureAction(services, { kind: 'feedback.send', workspaceId: 'ws_loose', message: 'hi' }, s, p)).feedback?.outcome).toEqual({ ok: false, reason: 'That workspace is not linked to a Tynn project.' });
        expect(p.sent).toEqual([]);
    });
});

describe('the window', () => {
    const view = (over: Partial<FeedbackView> = {}): FeedbackView => ({ open: true, signedIn: true, targets: feedbackTargets(WS, projectOf, 'ws_tynn'), outcome: null, ...over });
    // Fancy's Modal draws through a portal after its enter animation, so the server render of the open window is the BODY.
    const render = (v: FeedbackView) => renderToStaticMarkup(<FeedbackBody view={v} onSend={() => {}} onClose={() => {}} onAgain={() => {}} />);

    it('closed (or never told): the window draws nothing', () => {
        expect(renderToStaticMarkup(<FeedbackWindow view={view({ open: false })} onSend={() => {}} onClose={() => {}} onAgain={() => {}} />)).toBe('');
        expect(renderToStaticMarkup(<FeedbackWindow view={undefined} onSend={() => {}} onClose={() => {}} onAgain={() => {}} />)).toBe('');
    });

    it('open: where it goes (the workspace you are in first), what to say, Send', () => {
        const html = render(view());
        expect(html).toContain('data-feedback-window');
        expect(html.match(/<option[^>]*value="ws_/g)).toHaveLength(2);
        expect(html).toMatch(/<option[^>]*value="ws_tynn"[^>]*>tynn</);
        expect(html).toContain('data-feedback-text');
        expect(html).toMatch(/data-action="feedback-send"/);
    });

    it('says why there is nowhere to send it — signed out, or nothing linked — instead of an empty picker', () => {
        const out = render(view({ signedIn: false }));
        expect(out).toMatch(/Sign in to Tynn in Settings/);
        expect(out).not.toContain('data-action="feedback-send"');
        const none = render(view({ targets: [] }));
        expect(none).toMatch(/No workspace here is linked to a Tynn project/);
        expect(none).not.toContain('data-action="feedback-send"');
    });

    it('after: where it went, with Send another and Done; a refusal keeps what was written to try again', () => {
        const sent = render(view({ outcome: { ok: true, issueNumber: 12, target: 'tynn' } }));
        expect(sent).toMatch(/Sent\. It’s issue #12 in tynn’s Tynn project\./);
        expect(sent).toMatch(/data-action="feedback-again"/);
        expect(sent).toMatch(/data-action="feedback-done"/);
        const refused = render(view({ outcome: { ok: false, reason: 'Tynn could not be reached: offline' } }));
        expect(refused).toMatch(/Not sent: Tynn could not be reached: offline/);
        expect(refused).toContain('data-feedback-text');
    });
});

describe('the global key', () => {
    const settings = (value: string) => {
        let v = value;
        let listener: ((key: string) => void) | null = null;
        return { get: () => v, onChange: (cb: (key: string) => void) => { listener = cb; }, set: (next: string) => { v = next; listener?.('feedback_hotkey'); } };
    };
    const port = (taken: readonly string[] = []) => {
        const registered: string[] = [];
        return {
            registered,
            register: (acc: string, _fn: () => void) => { if (taken.includes(acc)) return false; registered.push(acc); return true; },
            unregister: (acc: string) => { const i = registered.indexOf(acc); if (i >= 0) registered.splice(i, 1); },
        };
    };

    it('Ctrl+Shift+W (⌘ on macOS) by default, Genie 1’s; pressing it opens the window', () => {
        const p = port();
        let pressed = 0;
        let fn: (() => void) | null = null;
        const s = settings('');
        const status = wireFeedbackHotkey(s, { register: (acc, f) => { fn = f; return p.register(acc, f); }, unregister: p.unregister }, () => { pressed += 1; });
        expect(DEFAULT_FEEDBACK_HOTKEY).toBe('CommandOrControl+Shift+W');
        expect(p.registered).toEqual(['CommandOrControl+Shift+W']);
        expect(status()).toEqual({ state: 'registered', accelerator: 'CommandOrControl+Shift+W' });
        fn!();
        expect(pressed).toBe(1);
    });

    it('a new key replaces the old (COUNTED: one registered); taken by another app or unreadable is said, never thrown', () => {
        const p = port(['Alt+F9']);
        const s = settings('');
        const status = wireFeedbackHotkey(s, p, () => {});
        s.set('Control+Alt+F');
        expect(p.registered).toEqual(['Control+Alt+F']);
        s.set('Alt+F9');
        expect(p.registered).toEqual([]);
        expect(status()).toEqual({ state: 'taken', accelerator: 'Alt+F9' });
        s.set('Ctrl+');
        expect(status()).toEqual({ state: 'invalid', accelerator: 'Ctrl+' });
    });
});

describe('the setting, Genie 1’s key, the tray and main', () => {
    it('feedback_hotkey exists (empty = the default) and Genie 1’s global_hotkey carries over to it', () => {
        expect(SETTINGS.find((s) => s.key === 'feedback_hotkey')).toMatchObject({ type: 'string', default: '', scope: 'host' });
        expect(carryOverV1({ global_hotkey: 'Control+Alt+F' }).applied).toEqual({ feedback_hotkey: 'Control+Alt+F' });
    });

    it('the tray offers Send feedback…', async () => {
        const { trayMenuTemplate } = await import('../src/main/tray.js');
        const onFeedback = vi.fn();
        const menu = trayMenuTemplate({ onOpen: vi.fn(), onSettings: vi.fn(), onCheckUpdates: vi.fn(), onQuit: vi.fn(), onFeedback });
        const item = menu.find((m) => m.label === 'Send feedback…');
        item!.click!();
        expect(onFeedback).toHaveBeenCalledTimes(1);
    });

    it('main: the key and the tray open the window over the page you are on; Tynn is asked with the token Genie holds', () => {
        const src = readFileSync('src/main/main.ts', 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
        expect(src).toMatch(/const openFeedback = \(\): void => \{ revealMainWindow\(\); broadcast\('genie:navigate', FEEDBACK_ROUTE\); \};/);
        expect(src).toMatch(/onFeedback: openFeedback,/);
        expect(src).toMatch(/wireFeedbackHotkey\(\{ get: \(\) => composed\.settings\.get\('feedback_hotkey'\), onChange: \(cb\) => composed\.settings\.onChange\(cb\) \}, \{ register: \(acc, fn\) => globalShortcut\.register\(acc, fn\), unregister: \(acc\) => globalShortcut\.unregister\(acc\) \}, openFeedback\)/);
        const app = readFileSync('src/renderer/App.tsx', 'utf8');
        expect(app).toMatch(/if \(route === FEEDBACK_ROUTE\) \{ onFeedback\(\); return; \}/);
    });
});
