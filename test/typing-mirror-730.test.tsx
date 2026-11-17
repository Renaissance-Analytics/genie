import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forwardedCallContext, inMemoryPair, LOCAL_EVENTS, parseMessage, TYPING_EVENT, type CallContext, type PreAuth, type ServerConnection, type WireMessage } from '../src/core/remote-protocol.js';
import { draftChange, readTypingEvent, TYPING_FADE_MS, TYPING_SEND_MS, TYPING_SHOWN_CHARS, TypingBoard, TypingSender, typingTail, type TypingEvent } from '../src/core/typing-mirror.js';
import type { ChatDraft } from '../src/core/chat-drafts.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { hostRemoteApi, RemoteAccessHost, RemoteAccessService } from '../src/main/remote-access-host.js';
import { RemoteAccessReplica } from '../src/main/remote-access-replica.js';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';

/**
 * WHAT THE OTHER PERSON IS TYPING (Tynn #730; the client call 2026-11-16, 00:06:49: "Do you see my typing at all?" "No, I
 * don't see any typing."). A Pilot drove a client's Genie over a share link and typed into an agent's composer; the
 * client, on the same agent, saw nothing until it was sent. A draft lived only in the window typing it — the host's own
 * window kept its drafts on its own machine, and the Pilot's window kept none at all (remote-bridge.ts: drafts for a local
 * window only), so no keystroke ever crossed. Names are fixtures, never real ones.
 */

/** A clock the test turns by hand. */
function handClock() {
    let now = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let next = 0;
    return {
        clock: {
            setTimer: (fn: () => void, ms: number) => { timers.set(++next, { at: now + ms, fn }); return next; },
            clearTimer: (t: unknown) => { timers.delete(t as number); },
        },
        advance(ms: number) {
            now += ms;
            for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now) { timers.delete(id); t.fn(); }
        },
    };
}

describe('the sender: one send per pause, never one per keystroke', () => {
    it('the first keystroke goes at once', () => {
        const sent: string[][] = [];
        const h = handClock();
        new TypingSender((a, t) => sent.push([a, t]), h.clock).change('agent_kai', 'h');
        expect(sent).toEqual([['agent_kai', 'h']]);
    });

    it('keystrokes inside the window are one trailing send of the latest text', () => {
        const sent: string[][] = [];
        const h = handClock();
        const s = new TypingSender((a, t) => sent.push([a, t]), h.clock);
        s.change('agent_kai', 'h');
        s.change('agent_kai', 'he');
        s.change('agent_kai', 'hel');
        expect(sent).toEqual([['agent_kai', 'h']]);
        h.advance(TYPING_SEND_MS);
        expect(sent).toEqual([['agent_kai', 'h'], ['agent_kai', 'hel']]);
        h.advance(TYPING_SEND_MS * 4);
        expect(sent).toHaveLength(2);
    });

    it('a clear (a send, an emptied box) goes at once and drops the text still waiting', () => {
        const sent: string[][] = [];
        const h = handClock();
        const s = new TypingSender((a, t) => sent.push([a, t]), h.clock);
        s.change('agent_kai', 'h');
        s.change('agent_kai', 'he');
        s.change('agent_kai', '');
        expect(sent).toEqual([['agent_kai', 'h'], ['agent_kai', '']]);
        h.advance(TYPING_SEND_MS * 4);
        expect(sent).toEqual([['agent_kai', 'h'], ['agent_kai', '']]);
    });

    it('each agent has its own window', () => {
        const sent: string[][] = [];
        const h = handClock();
        const s = new TypingSender((a, t) => sent.push([a, t]), h.clock);
        s.change('agent_kai', 'a');
        s.change('agent_mo', 'b');
        expect(sent).toEqual([['agent_kai', 'a'], ['agent_mo', 'b']]);
    });

    it('CONTROL: nothing typed, nothing sent', () => {
        const sent: string[][] = [];
        const h = handClock();
        new TypingSender((a, t) => sent.push([a, t]), h.clock);
        h.advance(TYPING_SEND_MS * 10);
        expect(sent).toEqual([]);
    });
});

const PILOT_TYPES: TypingEvent = { agentId: 'agent_kai', text: 'can you see this', source: 'window-pilot', label: 'Pilot laptop' };

describe('the board: what the other person sees', () => {
    it('another window’s typing shows, with who typed it', () => {
        const b = new TypingBoard('window-client');
        expect(b.apply(PILOT_TYPES, 1)).toBe(true);
        expect(b.line('agent_kai', 2)).toEqual({ label: 'Pilot laptop', text: 'can you see this' });
        expect(b.line('agent_mo', 2)).toBeNull();
    });

    it('an emptied draft clears it', () => {
        const b = new TypingBoard('window-client');
        b.apply(PILOT_TYPES, 1);
        expect(b.line('agent_kai', 2)).not.toBeNull();
        expect(b.apply({ ...PILOT_TYPES, text: '' }, 3)).toBe(true);
        expect(b.line('agent_kai', 4)).toBeNull();
    });

    it('it fades once nobody has typed for a while', () => {
        const b = new TypingBoard('window-client');
        b.apply(PILOT_TYPES, 1000);
        expect(b.line('agent_kai', 1000 + TYPING_FADE_MS - 1)).not.toBeNull();
        expect(b.line('agent_kai', 1000 + TYPING_FADE_MS)).toBeNull();
    });

    it('CONTROL: this window’s own typing is never shown back to it', () => {
        const b = new TypingBoard('window-pilot');
        expect(b.apply(PILOT_TYPES, 1)).toBe(false);
        expect(b.line('agent_kai', 2)).toBeNull();
    });

    it('CONTROL: what is not a typing event is refused', () => {
        for (const junk of [null, 'x', {}, { agentId: 'agent_kai' }, { agentId: 1, text: 'a', source: 's', label: null }, { agentId: 'a', text: 'b', source: 's', label: 7 }]) expect(readTypingEvent(junk)).toBeNull();
    });

    it('a relayed event is read back; a long draft shows its newest words', () => {
        expect(readTypingEvent({ ...PILOT_TYPES })).toEqual(PILOT_TYPES);
        expect(readTypingEvent({ ...PILOT_TYPES, label: null })).toEqual({ ...PILOT_TYPES, label: null });
        const long = `${'a'.repeat(300)}the end`;
        const tail = typingTail(long);
        expect(tail.endsWith('the end')).toBe(true);
        expect(tail.length).toBeLessThanOrEqual(TYPING_SHOWN_CHARS + 1);
        expect(tail.startsWith('…')).toBe(true);
        expect(typingTail('short')).toBe('short');
    });
});

const draft = (text: string): ChatDraft => ({ text, pills: [], attachments: [] } as unknown as ChatDraft);

describe('the composer reports every change', () => {
    it('with no kept drafts (the Pilot’s window keeps none), a change still reaches the typing line', () => {
        const typed: string[][] = [];
        draftChange(undefined, 'agent_kai', (a, t) => typed.push([a, t]))(draft('hel'));
        expect(typed).toEqual([['agent_kai', 'hel']]);
    });

    it('with kept drafts, the keeper and the typing line both hear it', () => {
        const kept: string[] = [];
        const typed: string[][] = [];
        draftChange({ change: (_a, d) => kept.push(d.text) }, 'agent_kai', (a, t) => typed.push([a, t]))(draft('hel'));
        expect(kept).toEqual(['hel']);
        expect(typed).toEqual([['agent_kai', 'hel']]);
    });
});

// ---- The whole path: the Pilot's window → genie-host on the client → the client's window process, and back. ----

const OWNER: PreAuth = { label: 'Pilot laptop', isOwner: true, workspaceId: null, readonly: false };
const GUEST_HERE: PreAuth = { label: 'Guest tablet', isOwner: false, workspaceId: 'ws_shop', readonly: false };
const GUEST_ELSEWHERE: PreAuth = { label: 'Other tablet', isOwner: false, workspaceId: 'ws_other', readonly: false };
const KAI = { id: 'agent_kai', workspaceId: 'ws_shop', provider: 'claude', name: 'kai' };
const WINDOW = 'conn_window';
const LOCAL_WINDOW: CallContext = { connectionId: 'conn_1', origin: 'local-window', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: 'client-box' };

type Listener = (channel: string, payload: unknown) => void;

/** The client's window process's own host API (main.ts `remoteApiNow`), real, over fakes of the parts it reads. */
function windowHostApi() {
    const none = () => () => {};
    const deps = {
        snapshot: () => ({ agents: [], workspaces: [{ id: 'ws_shop', path: '/w/shop', agentsKnown: true }], deckItems: [], signals: {} }),
        subscribeSnapshot: none,
        subscribeAgentRecords: none,
        find: (id: string) => (id === KAI.id ? KAI : null),
        detailFor: () => null,
        cwdFor: () => '/w/shop',
        host: { subscribe: none },
        terminals: { onData: none, onExit: none, list: () => [] },
        features: {},
        updates: null,
        workspaceOps: {},
        agentOps: {},
    } as unknown as HostApiDeps;
    return buildHostApi(deps);
}

let home = '';
let access: RemoteAccessHost;
let connections: Array<(c: ServerConnection) => void> = [];
let windowApi: ReturnType<typeof windowHostApi>;
let localHeard: unknown[] = [];

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'genie-730-typing-'));
    connections = [];
    localHeard = [];
    windowApi = windowHostApi();
    // The client's own window hears its local channel (main's RemoteHost sends it to this machine's windows).
    windowApi.onEvent((channel, payload) => { if (channel === LOCAL_EVENTS.typing) localHeard.push(payload); });
    const remoteWindowEvents = new Set<Listener>();
    const api = hostRemoteApi({
        hostName: 'client-box',
        own: {},
        // The engine link's reverse call: genie-host hands the window what it does not own, with the caller's context.
        window: { connected: () => true, invoke: (method, args, context) => windowApi.invoke(method, args, forwardedCallContext(context)) },
        onEvent: (listener) => { remoteWindowEvents.add(listener); return () => { remoteWindowEvents.delete(listener); }; },
        workspaceOfAgent: (agentId) => (agentId === KAI.id ? 'ws_shop' : null),
    });
    access = await RemoteAccessHost.open({ home, hostName: 'client-box', api, transport: { onConnection: (cb) => { connections.push(cb); return () => {}; } }, now: () => 1_000_000 });
    let service: RemoteAccessService | null = null;
    const replica = new RemoteAccessReplica('client-box', (method, args) => service!.call(WINDOW, method, args));
    service = new RemoteAccessService(access, {
        switch: { apply: async () => {}, restart: async () => {}, stop: async () => {} },
        newestWindow: () => WINDOW,
        windowEvent: (channel, payload) => { for (const l of [...remoteWindowEvents]) l(channel, payload); },
        send: (owner, event) => { if (owner === null || owner === WINDOW) replica.deliver(event); },
    });
    replica.forwardEvents((listener) => windowApi.onEvent(listener));
    await replica.refresh();
});
afterEach(async () => { await access.close(); await rm(home, { recursive: true, force: true }); });

function visitor(preAuth: PreAuth) {
    const pair = inMemoryPair();
    for (const cb of connections) cb({ ...pair.server, remoteAddress: `relay:${preAuth.label}`, preAuth });
    const heard: WireMessage[] = [];
    pair.client.onMessage((text) => { const r = parseMessage(text); if (r.ok) heard.push(r.message); });
    let n = 0;
    return {
        heard,
        hello: () => pair.client.send(JSON.stringify({ kind: 'hello', auth: { kind: 'relay' }, label: preAuth.label })),
        call: (method: string, ...args: unknown[]) => { const id = ++n; pair.client.send(JSON.stringify({ kind: 'call', id, method, args })); return id; },
        result: (id: number) => heard.find((m) => m.kind === 'result' && (m as { id?: number }).id === id) as { ok: boolean; reason?: string } | undefined,
        typing: () => heard.filter((m) => m.kind === 'event' && (m as { channel?: string }).channel === TYPING_EVENT).map((m) => (m as unknown as { payload: unknown }).payload),
    };
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };

async function drivingPilot() {
    const p = visitor(OWNER);
    p.hello();
    await settle();
    const take = p.call('baton.take');
    await settle();
    expect(p.result(take)?.ok).toBe(true);
    return p;
}

describe('the whole path: the Pilot’s typing on the client, and the client’s on the Pilot', () => {
    it('CONTROL: a Pilot who is not driving may not type (it is a write, on the baton, like a send)', async () => {
        const p = visitor(OWNER);
        p.hello();
        await settle();
        const id = p.call('agents.typing', KAI.id, 'hello', 'window-pilot');
        await settle();
        expect(p.result(id)?.ok).toBe(false);
        expect(localHeard).toEqual([]);
    });

    it('the driving Pilot’s typing reaches the client’s window, named, as it is typed', async () => {
        const p = await drivingPilot();
        const id = p.call('agents.typing', KAI.id, 'can you see', 'window-pilot');
        await settle();
        expect(p.result(id)?.ok).toBe(true);
        expect(localHeard).toEqual([{ agentId: KAI.id, text: 'can you see', source: 'window-pilot', label: 'Pilot laptop' }]);
    });

    it('the client’s typing reaches the Pilot (the host’s own window is named by nobody: null)', async () => {
        const p = await drivingPilot();
        await windowApi.invoke('agents.typing', [KAI.id, 'yes I see it', 'window-client'], LOCAL_WINDOW);
        await settle();
        expect(p.typing()).toEqual([{ agentId: KAI.id, text: 'yes I see it', source: 'window-client', label: null }]);
    });

    it('a guest of the agent’s workspace hears it', async () => {
        const g = visitor(GUEST_HERE);
        g.hello();
        await settle();
        await windowApi.invoke('agents.typing', [KAI.id, 'for the shop', 'window-client'], LOCAL_WINDOW);
        await settle();
        expect(g.typing()).toEqual([{ agentId: KAI.id, text: 'for the shop', source: 'window-client', label: null }]);
    });

    it('CONTROL: a guest of another workspace never hears an agent outside it', async () => {
        const g = visitor(GUEST_ELSEWHERE);
        g.hello();
        await settle();
        await windowApi.invoke('agents.typing', [KAI.id, 'not yours', 'window-client'], LOCAL_WINDOW);
        await settle();
        expect(g.typing()).toEqual([]);
    });

    it('CONTROL: typing on an agent the host does not have is relayed to nobody', async () => {
        const p = await drivingPilot();
        await windowApi.invoke('agents.typing', ['agent_nobody', 'lost', 'window-client'], LOCAL_WINDOW);
        await settle();
        expect(p.typing()).toEqual([]);
        expect(localHeard).toEqual([]);
    });
});

describe('the window shows it without moving anything', () => {
    const thread: ChatThread = { agentId: KAI.id, name: 'kai', fidelity: 'declared', unread: null, context: null, messages: [] };
    const flyout = (peerTyping: { label: string; text: string } | null) => renderToStaticMarkup(
        <ChatFlyout thread={thread} onSend={() => {}} onClose={() => {}} onRestartAndSend={() => {}} peerTyping={peerTyping} onTyping={() => {}} />,
    );

    it('another person typing: a line over the composer, floating (it takes no space), with who and what', () => {
        const html = flyout({ label: 'Pilot laptop', text: 'can you see' });
        expect(html).toMatch(/data-peer-typing=""[^>]*class="[^"]*\babsolute\b/);
        expect(html).toContain('Pilot laptop is typing');
        expect(html).toContain('can you see');
        // The composer's frame is what it floats over, so nothing under it moves.
        expect(html).toMatch(/class="relative shrink-0 border-t/);
    });

    it('CONTROL: nobody else typing, nothing there', () => {
        expect(flyout(null)).not.toMatch(/data-peer-typing/);
    });

    it('wired end to end: both bridges carry it, the window feeds the chat, the composer reports through draftChange', async () => {
        const remoteBridge = await readFile('src/renderer/remote-bridge.ts', 'utf8');
        expect(remoteBridge).toMatch(/typing: \(agentId, text, source\) => answer\('agents\.typing', agentId, text, source\)/);
        expect(remoteBridge).toMatch(/onTyping: [\s\S]{0,200}on\(local \? LOCAL_EVENTS\.typing : TYPING_EVENT/);
        const localSession = await readFile('src/renderer/local-session.ts', 'utf8');
        expect(localSession).toMatch(/typing: \(id, text, source\) => requestAgent\(/);
        expect(localSession).toMatch(/onTyping: \(listener\) => subscribe\(/);
        const app = await readFile('src/renderer/App.tsx', 'utf8');
        expect(app).toMatch(/useTypingMirror\(bridge/);
        const shell = await readFile('src/renderer/Shell.tsx', 'utf8');
        expect(shell).toMatch(/onTyping=\{onTyping\}/);
        expect(shell).toMatch(/peerTyping=\{/);
        const flyoutSource = await readFile('src/renderer/components/ChatFlyout.tsx', 'utf8');
        expect(flyoutSource).toMatch(/onDraftChange: draftChange\(/);
    });
});
