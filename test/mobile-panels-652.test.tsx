// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatThreadFrom } from '../src/core/chat-view.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import type { DeckItem } from '../src/core/deck.js';
import { MOBILE_PANELS, SWIPE_MIN_PX, panelAfter, swipeStep } from '../src/core/mobile.js';
import type { AgentDetail } from '../src/renderer/bridge.js';
import { ChatFlyout } from '../src/renderer/components/ChatFlyout.js';
import { MobileAgent, MobileShell } from '../src/renderer/components/MobileShell.js';
import { Stream } from '../src/renderer/components/Stream.js';
import { answerDeckForm } from '../src/renderer/deck-answer.js';
import { control } from './helpers/control-markup.js';

/**
 * GENIE ON THE PHONE (Tynn story #652; the owner, 2026-11-12, from his phone: "I should have full chat stream and work
 * streams as slideable panels and ability answer any FTQ. I also need the ability to attach files and use my camera.")
 *
 *  1. the full chat stream — the DESKTOP chat's rows for the same agent, not a phone summary;
 *  2. the agent list, the chat and the work stream as panels you swipe between (and tabs, and the arrow keys);
 *  3. every question answerable: options, multi-select and free text, the picked state clear — through the desktop's form
 *     and the desktop's one bridge call;
 *  4. a photo from the camera or a file into the chat as an attachment;
 *  5. still no terminal on the phone (the owner, 2026-10-11).
 */

const T = 1_760_000_000_000;
const agentRow = (over: Partial<AgentRow> = {}): AgentRow => ({
    id: 'agent_a', name: 'atlas', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'working', duration: '2m', ask: null, reason: null, fixes: [], step: null,
    target: null, activity: null, delivery: null, collaborators: null, commsAgeSec: null, ...over,
} as AgentRow);
const rows = [agentRow(), agentRow({ id: 'agent_w', name: 'wren', state: 'waiting', ask: 'Allow migrate?' })];

const detail: AgentDetail = {
    agent: { id: 'agent_a', name: 'atlas', provider: 'claude', fidelity: 'declared', cwd: '/w/tynn' },
    session: { running: true, turnState: 'working', pendingApproval: null, failure: null, plan: null, startedAt: null } as unknown as AgentDetail['session'],
    rows: [
        { id: 'e1', at: T, event: { kind: 'message', speaker: 'you', peerName: null, text: 'Fix the login bug' } },
        { id: 'e2', at: T + 1_000, event: { kind: 'tool', toolCallId: 't1', name: 'Bash', title: 'npm test', status: 'completed', toolKind: 'execute', rawInput: null } },
        { id: 'e3', at: T + 2_000, event: { kind: 'message', speaker: 'agent', peerName: null, text: 'Found it: the **cookie** expired early.' } },
        { id: 'e4', at: T + 3_000, event: { kind: 'tool', toolCallId: 't2', name: 'Edit', title: 'src/auth.ts', status: 'completed', toolKind: 'edit', rawInput: null } },
        { id: 'e5', at: T + 4_000, event: { kind: 'message', speaker: 'agent', peerName: null, text: 'Fixed and tested.' } },
    ] as AgentDetail['rows'],
    comms: [{ id: 'm1', from: 'agent_a', to: 'agent_w', text: 'login fix is in', sentAt: new Date(T + 3_500).toISOString(), readAt: null }],
    turns: 1, cost: null, refusal: null,
} as AgentDetail;

const inline: DeckItem = {
    id: 'i1', source: 'agent-question', agentId: 'agent_a', agentName: 'atlas', workspaceId: 'tynn', title: 'Allow npm publish?', blocking: true, priority: 'normal', at: T,
    answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }, { id: 'deny', label: 'Deny', tone: 'bad' }] }, forwardedFrom: null,
};
const form: DeckItem = {
    id: 'q1', source: 'agent-question', agentId: 'agent_a', agentName: 'atlas', workspaceId: 'tynn', title: 'Before I deploy', blocking: true, priority: 'normal', at: T,
    answer: {
        kind: 'form', fields: 3, questions: [
            { header: 'Deploy', question: 'Ship it tonight?', options: [{ label: 'Yes' }, { label: 'No' }] },
            { header: 'Hosts', question: 'Which hosts?', options: [{ label: 'web' }, { label: 'worker' }, { label: 'cron' }], multiSelect: true },
            { header: 'Notes', question: 'Anything else?', options: [{ label: 'Nothing' }, { label: 'Later' }] },
        ],
    },
    forwardedFrom: null,
};

const noop = () => {};
const agentView = (over: Partial<Parameters<typeof MobileAgent>[0]> = {}): ReactElement => (
    <MobileAgent detail={detail} sending={false} onBack={noop} onSend={noop} onStart={noop} onResumeLimit={noop} needs={[]} answering={null} onAnswer={noop}
        agents={{ rows, onOpen: noop }} {...over} />
);
const parse = (html: string): Document => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
/** The chat's rows as the person reads them: which message, and who said it. */
const chatRows = (doc: ParentNode) => [...doc.querySelectorAll('[data-chat-message]')].map((el) => [el.getAttribute('data-chat-message'), el.getAttribute('data-who')]);
/** The work stream's rows: which ledger row, and what kind. */
const streamRows = (doc: ParentNode) => [...doc.querySelectorAll('[data-stream-row]')].map((el) => el.getAttribute('data-stream-row'));

const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const mount = (el: ReactElement) => act(() => root.render(el));
const q = <E extends Element = HTMLElement>(s: string) => document.querySelector<E>(s);
const shown = (): string | null => q('[data-mobile-panel]')?.getAttribute('data-mobile-panel') ?? null;
const key = (k: string) => act(() => { q('[data-mobile-agent-view]')!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
const touch = (type: 'touchstart' | 'touchend', x: number, y: number) => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    const point = [{ clientX: x, clientY: y, identifier: 0 }];
    Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : point });
    Object.defineProperty(ev, 'changedTouches', { value: point });
    return ev;
};
const swipe = (fromX: number, toX: number, y = 300) => act(() => {
    const target = q('[data-mobile-panel]')!;
    target.dispatchEvent(touch('touchstart', fromX, y));
    target.dispatchEvent(touch('touchend', toX, y + 4));
});

describe('2. the agent list, the chat and the work stream are panels you swipe between', () => {
    it('the swipe rule: a sideways move past the threshold steps one panel; a short or mostly-vertical move does not', () => {
        expect(MOBILE_PANELS).toEqual(['agents', 'chat', 'work']);
        expect(swipeStep(-(SWIPE_MIN_PX + 40), 10)).toBe(1);
        expect(swipeStep(SWIPE_MIN_PX + 40, -10)).toBe(-1);
        expect(swipeStep(-(SWIPE_MIN_PX - 10), 0)).toBe(0);
        // A scroll down the chat that drifts sideways is a scroll, not a swipe.
        expect(swipeStep(-(SWIPE_MIN_PX + 40), SWIPE_MIN_PX + 80)).toBe(0);
        expect(panelAfter('chat', 1)).toBe('work');
        expect(panelAfter('chat', -1)).toBe('agents');
        expect(panelAfter('work', 1)).toBe('work');
        expect(panelAfter('agents', -1)).toBe('agents');
    });

    it('opens on the chat, with Agents / Chat / Work as tabs (react-fancy), the one in view selected, each at least 44 px', () => {
        const html = renderToStaticMarkup(agentView());
        const doc = parse(html);
        expect(doc.querySelector('[data-mobile-panel]')?.getAttribute('data-mobile-panel')).toBe('chat');
        for (const p of MOBILE_PANELS) {
            const tab = control(html, `data-mobile-panel-tab="${p}"`);
            expect(tab, p).toMatchObject({ tag: 'button', tab: true });
            expect(tab!.open, p).toMatch(/min-h-11|h-11|min-h-\[44px\]/);
        }
        expect(control(html, 'data-mobile-panel-tab="chat"')!.open).toContain('aria-selected="true"');
        expect(control(html, 'data-mobile-panel-tab="work"')!.open).toContain('aria-selected="false"');
    });

    it('a swipe left moves chat → work, a swipe right moves back and on to the agent list; it stops at the ends', () => {
        mount(agentView());
        expect(shown()).toBe('chat');
        swipe(300, 120);
        expect(shown()).toBe('work');
        swipe(300, 120);
        expect(shown()).toBe('work');
        swipe(100, 300);
        expect(shown()).toBe('chat');
        swipe(100, 300);
        expect(shown()).toBe('agents');
        // A short drag is nothing.
        swipe(200, 180);
        expect(shown()).toBe('agents');
    });

    it('the arrow keys and the tabs move too; typing in the composer never does', () => {
        mount(agentView());
        key('ArrowRight');
        expect(shown()).toBe('work');
        key('ArrowLeft');
        key('ArrowLeft');
        expect(shown()).toBe('agents');
        act(() => { q('[data-mobile-panel-tab="chat"]')!.click(); });
        expect(shown()).toBe('chat');
        act(() => { q('textarea[name="text"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
        expect(shown()).toBe('chat');
    });

    it('the agent list panel lists every agent with its state; tapping one opens it', () => {
        const onOpen = vi.fn();
        mount(agentView({ agents: { rows, onOpen } }));
        key('ArrowLeft');
        expect(shown()).toBe('agents');
        expect(q('[data-mobile-agent="agent_w"]')?.getAttribute('data-state')).toBe('waiting');
        act(() => { q('[data-mobile-agent="agent_w"]')!.click(); });
        expect(onOpen).toHaveBeenCalledWith('agent_w');
    });
});

describe('1. the full chat stream — the desktop chat’s rows for the same agent', () => {
    it('the chat panel draws the same messages, in the same order, as the desktop chat for this fixture', () => {
        const desktop = chatRows(parse(renderToStaticMarkup(<ChatFlyout thread={chatThreadFrom(detail, 'agent_a', rows, () => T)} onSend={noop} />)));
        expect(desktop.length).toBeGreaterThanOrEqual(4);
        expect(desktop.map(([, who]) => who)).toContain('mail');
        const phone = chatRows(parse(renderToStaticMarkup(agentView())));
        expect(phone).toEqual(desktop);
    });

    it('the work panel draws the desktop Stream’s rows — the tool calls among them', () => {
        const desktop = streamRows(parse(renderToStaticMarkup(<Stream rows={detail.rows} lanes={null} at={null} selectedId={null} onSelect={noop} agentName="atlas" />)));
        expect(desktop).toEqual(expect.arrayContaining(['e2', 'e4']));
        const html = renderToStaticMarkup(agentView({ initialPanel: 'work' }));
        expect(parse(html).querySelector('[data-mobile-panel]')?.getAttribute('data-mobile-panel')).toBe('work');
        expect(streamRows(parse(html))).toEqual(desktop);
        expect(html).toContain('data-kind="Bash"');
        expect(html).toContain('data-kind="Edit"');
    });
});

describe('3. every question is answerable on the phone', () => {
    const typeInto = (el: HTMLTextAreaElement, text: string) => act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    it('a form with options, multi-select and free text: picked options read as picked, and the answer is the desktop form’s', () => {
        const onAnswerForm = vi.fn();
        mount(agentView({ needs: [form], onAnswerForm }));
        expect(q('[data-mobile-elsewhere]')).toBeNull();
        expect(q('[data-deck-form="q1"]')).not.toBeNull();
        const option = (label: string) => q(`[data-deck-form="q1"] [data-question-option="${label}"]`)!;
        act(() => { option('Yes').click(); });
        act(() => { option('web').click(); });
        act(() => { option('cron').click(); });
        expect(option('Yes').getAttribute('aria-pressed')).toBe('true');
        expect(option('No').getAttribute('aria-pressed')).toBe('false');
        expect(option('web').getAttribute('aria-pressed')).toBe('true');
        expect(option('cron').getAttribute('aria-pressed')).toBe('true');
        expect(option('worker').getAttribute('aria-pressed')).toBe('false');
        // The third is answered by words alone.
        typeInto(q<HTMLTextAreaElement>('[data-deck-form="q1"] [data-question-note="2"]')!, 'back up the db first');
        act(() => { q('[data-deck-form="q1"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        expect(onAnswerForm).toHaveBeenCalledTimes(1);
        expect(onAnswerForm).toHaveBeenCalledWith(form, [['Yes'], ['web', 'cron'], []], ['', '', 'back up the db first']);
    });

    it('the dashboard’s Needs you answers a form in place too, never "answer them on the host’s screen"', () => {
        const html = renderToStaticMarkup(<MobileShell host="alphar" locked={false} refusal={null} items={[form]} answering={null} onAnswer={noop} onAnswerForm={noop} onDisconnect={noop} />);
        expect(html).toContain('data-deck-form="q1"');
        expect(html).not.toContain('data-mobile-elsewhere');
        expect(html).not.toMatch(/answer them on/);
    });

    it('a form’s options and Answer are thumb-sized (44 px)', () => {
        const html = renderToStaticMarkup(agentView({ needs: [form], onAnswerForm: noop }));
        const wrap = parse(html).querySelector('[data-mobile-question="q1"]');
        expect(wrap).not.toBeNull();
        expect(wrap!.getAttribute('class') ?? '').toMatch(/\[&_button\]:min-h-11/);
    });

    it('an inline question is still answered with its option and a note', () => {
        const onAnswer = vi.fn();
        mount(agentView({ needs: [inline], onAnswer }));
        act(() => { q('[data-approval-option="allow"]')!.click(); });
        expect(onAnswer).toHaveBeenCalledWith(inline, 'allow', '');
    });

    it('the phone’s answer is the desktop’s one call: features.act deck.answerForm with the labels and one note per question', async () => {
        const act_ = vi.fn(async () => ({}) as never);
        await answerDeckForm({ act: act_ }, form, [['Yes'], ['web'], []], ['', '', 'later']);
        expect(act_).toHaveBeenCalledWith({ kind: 'deck.answerForm', item: form, selections: [['Yes'], ['web'], []], notes: ['', '', 'later'], note: '' });
    });

    it('the desktop and the phone both answer a form through answerDeckForm — there is no second copy of the call', () => {
        const app = readFileSync(join(__dirname, '../src/renderer/App.tsx'), 'utf8');
        expect((app.match(/answerDeckForm\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
        expect(app).not.toMatch(/kind: 'deck\.answerForm'/);
        const mobileApp = app.slice(app.indexOf('function MobileApp('), app.indexOf('function MobileFilesScreen('));
        expect(mobileApp).toMatch(/answerDeckForm\(/);
        expect(mobileApp).toMatch(/onAnswerForm=/);
    });
});

describe('4. a photo from the camera, or a file, into the chat', () => {
    const pickInto = (selector: string, file: File) => act(() => {
        const input = q<HTMLInputElement>(selector)!;
        Object.defineProperty(input, 'files', { value: [file], configurable: true });
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    it('the camera input asks for the back camera; a photo taken is a pill, and Send carries it with the words', () => {
        const onSend = vi.fn();
        mount(agentView({ onSend }));
        const camera = q<HTMLInputElement>('input[data-attach="camera"]')!;
        expect(camera.getAttribute('type')).toBe('file');
        expect(camera.getAttribute('accept')).toBe('image/*');
        expect(camera.getAttribute('capture')).toBe('environment');
        const photo = new File([new Uint8Array([1, 2, 3])], 'IMG_0042.jpg', { type: 'image/jpeg' });
        pickInto('input[data-attach="camera"]', photo);
        expect(q('[data-pending-attachment="IMG_0042.jpg"]')).not.toBeNull();
        const log = new File([new Uint8Array([4])], 'host.log', { type: 'text/plain' });
        pickInto('input[data-attach="file"]', log);
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(q<HTMLTextAreaElement>('textarea[name="text"]')!, 'this is what I see');
        act(() => { q('[data-mobile-composer]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        expect(onSend).toHaveBeenCalledTimes(1);
        const [text, files] = onSend.mock.calls[0]! as [string, File[]];
        expect(text).toBe('this is what I see');
        expect(files.map((f) => f.name)).toEqual(['IMG_0042.jpg', 'host.log']);
        expect(q('[data-pending-attachment]')).toBeNull();
    });

    it('the composer is there on the work panel too, so a screenshot can be sent from wherever you are', () => {
        const html = renderToStaticMarkup(agentView({ initialPanel: 'work' }));
        expect(html).toContain('data-mobile-composer');
        expect(html).toContain('data-attach="camera"');
    });
});

describe('5. no terminal on the phone', () => {
    it('no panel draws a terminal, a shell or terminal bytes', () => {
        for (const p of MOBILE_PANELS) {
            const html = renderToStaticMarkup(agentView({ initialPanel: p, needs: [form, inline] }));
            expect(html, p).not.toMatch(/data-terminal|data-shell|xterm|terminal-pane/i);
        }
        expect(MOBILE_PANELS).not.toContain('terminal' as never);
    });
});
