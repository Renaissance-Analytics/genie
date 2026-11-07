import { randomUUID } from 'node:crypto';
import type { LocalTerminalMethod } from '../core/local-terminals.js';
import { decodeTerminalNativeArguments } from '../core/local-terminals.js';
import { splitTerminalText } from '../core/terminal-stream.js';
import { TerminalViewStreams, type TerminalStreamEvent } from './terminal-streams.js';
import { LocalTerminalInputs } from './local-terminal-input.js';
import type { NativeTerminalAttachment, NativeTerminalPort } from './local-terminal-native.js';

interface View { ready: Promise<void>; release(): void; sequence: number; ack: { sequence: number; release(): void } | null }
interface Owner { views: Map<string, View>; commands: Map<string, { workspaceId: unknown; options: Record<string, unknown>; chunks: string[] }>; send(channel: string, payload: unknown): void }
const closed = () => new Error('terminal connection is closed');

/** Per-connection interest and ACKs, shared producer refs and input ordering. No cleanup path kills a pty. */
export class LocalTerminalServer {
    readonly #port: NativeTerminalPort;
    readonly #inputs: LocalTerminalInputs;
    readonly #streams: TerminalViewStreams;
    readonly #owners = new Map<string, Owner>();
    constructor(port: NativeTerminalPort) {
        this.#port = port; this.#inputs = new LocalTerminalInputs(port);
        this.#streams = new TerminalViewStreams({ snapshot: () => null,
            listen: (data, exit) => port.listen?.(data, exit) ?? (() => {}),
            send: (owner, view, event) => this.#send(owner, view, event),
        });
    }
    async call(ownerId: string, method: LocalTerminalMethod, args: unknown[], send: Owner['send']): Promise<unknown> {
        let owner = this.#owners.get(ownerId);
        if (!owner) { owner = { views: new Map(), commands: new Map(), send }; this.#owners.set(ownerId, owner); }
        switch (method) {
            case 'terminals.localBegin': {
                const request = args[0] as { kind?: unknown; id?: unknown; workspaceId?: unknown; options?: unknown } | null;
                if (request?.kind === 'write' && typeof request.id === 'string') return this.#inputs.begin(ownerId, request.id);
                if (request?.kind !== 'open') throw closed();
                const ticket = randomUUID(), options = request.options && typeof request.options === 'object' ? { ...request.options } : {};
                owner.commands.set(ticket, { workspaceId: request.workspaceId, options, chunks: [] }); return ticket;
            }
            case 'terminals.localChunk': {
                const ticket = args[0], data = args[1];
                if (typeof ticket !== 'string' || typeof data !== 'string') throw closed();
                const chunks = splitTerminalText(data); chunks.next(); if (!chunks.next().done) throw new Error('terminal connection closed: oversized input chunk');
                const command = owner.commands.get(ticket);
                if (command) command.chunks.push(data); else await this.#inputs.chunk(ownerId, ticket, data);
                return true;
            }
            case 'terminals.localFinish': {
                if (typeof args[0] !== 'string') throw closed();
                const command = owner.commands.get(args[0]);
                if (!command) { await this.#inputs.finish(ownerId, args[0]); return true; }
                owner.commands.delete(args[0]);
                if (args[1] === true) return false;
                return this.#port.invoke('open', decodeTerminalNativeArguments('open', [command.workspaceId, { ...command.options, command: command.chunks.join('') }]));
            }
            case 'terminals.localWatch': {
                const [view, workspaceId, id] = args;
                if (typeof view !== 'string' || typeof id !== 'string' || (workspaceId !== null && typeof workspaceId !== 'string')) throw closed();
                this.#unwatch(ownerId, view);
                let release!: () => void;
                const state: View = { ready: new Promise<void>(resolve => { release = resolve; }), release: () => release(), sequence: 0, ack: null };
                owner.views.set(view, state); let attachment: NativeTerminalAttachment | null = null;
                try {
                    const snapshot = await this.#streams.watchFresh(ownerId, view, id, async () => {
                        attachment = await this.#port.snapshot(workspaceId, id);
                        return attachment ? { id, tail: attachment.value.scrollback, epoch: attachment.position?.epoch ?? null, endOffset: attachment.position?.endOffset ?? null } : null;
                    });
                    if (!snapshot || owner.views.get(view) !== state) { if (owner.views.get(view) === state) this.#unwatch(ownerId, view); return null; }
                    return attachment;
                } catch (error) { if (owner.views.get(view) === state) this.#unwatch(ownerId, view); throw error; }
            }
            case 'terminals.localReady': this.#view(owner, args[0]).release(); return true;
            case 'terminals.localAck': {
                const view = this.#view(owner, args[0]);
                const ack = view.ack;
                if (!ack || ack.sequence !== args[1]) throw closed();
                ack.release(); view.ack = null; return true;
            }
            case 'terminals.localUnwatch': if (typeof args[0] === 'string') this.#unwatch(ownerId, args[0]); return true;
            default: {
                const name = method.slice('terminals.local'.length).toLowerCase();
                const nativeArgs = decodeTerminalNativeArguments(name, args);
                if (['write', 'resize', 'close'].includes(name) && typeof nativeArgs[0] === 'string') return this.#inputs.run(ownerId, nativeArgs[0], name, nativeArgs);
                return this.#port.invoke(name, nativeArgs);
            }
        }
    }
    dropOwner(ownerId: string): void {
        const owner = this.#owners.get(ownerId); if (!owner) return;
        for (const view of [...owner.views.keys()]) this.#unwatch(ownerId, view);
        owner.commands.clear(); this.#owners.delete(ownerId); this.#inputs.dropOwner(ownerId);
    }
    #view(owner: Owner, id: unknown): View {
        const view = typeof id === 'string' ? owner.views.get(id) : undefined;
        if (!view) throw closed(); return view;
    }
    #unwatch(ownerId: string, view: string): void {
        const owner = this.#owners.get(ownerId), state = owner?.views.get(view);
        if (!state) return;
        owner!.views.delete(view); this.#streams.unwatch(ownerId, view); state.release(); state.ack?.release(); state.ack = null;
    }
    async #send(ownerId: string, view: string, event: TerminalStreamEvent): Promise<void> {
        const owner = this.#owners.get(ownerId), state = owner?.views.get(view); if (!owner || !state) throw closed();
        await state.ready; if (owner.views.get(view) !== state) throw closed();
        const sequence = ++state.sequence;
        const consumed = new Promise<void>(release => { state.ack = { sequence, release }; });
        owner.send(event.kind === 'exit' ? 'terminal-exit' : 'terminal-data', { view, sequence, event });
        await consumed;
    }
}
