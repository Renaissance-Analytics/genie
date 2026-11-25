import { remoteOffer } from '../core/protocol-version.js';
import { parseMessage, type ClientTransport } from '../core/remote-protocol.js';
import { CAP_CROSS_STATION, type CrossStationMethod } from '../core/cross-station.js';
import { StationRefused, type StationLink } from './cross-station-host.js';

/**
 * ONE HOST SPEAKING TO ANOTHER OF THE OWNER'S WORKSTATIONS (P9): over a relay member transport (relay-member.ts, end to
 * end since P9.2), the same protocol a remote window speaks: hello as `relay` (the grant already proved who this is),
 * the welcome, then calls. It is a link only when the other host admits it as its OWNER: a guest's "wait for Allow" or a
 * non-owner welcome ends it before any call. A refusal by the other host is a {@link StationRefused}, which a sender
 * settles (it will not change on a retry); anything else (the link dropped, no answer) is an Error worth a retry.
 */
export async function stationLinkOver(transport: ClientTransport, options: { label: string; timeoutMs?: number; build?: string | null }): Promise<StationLink> {
    const timeoutMs = options.timeoutMs ?? 20_000;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    let nextId = 0;
    let closed = false;
    let welcomed: ((ok: true) => void) | null = null;
    let failed: ((e: Error) => void) | null = null;
    const endAll = (why: string) => {
        if (closed) return;
        closed = true;
        failed?.(new Error(why));
        for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(why)); }
        pending.clear();
    };
    const offMessage = transport.onMessage((text) => {
        const parsed = parseMessage(text);
        if (!parsed.ok) return;
        const m = parsed.message;
        if (m.kind === 'welcome') {
            if (!m.isOwner || m.readonly === true) { failed?.(new Error(`${m.host} admitted this workstation, but not as its owner`)); transport.close(); return; }
            if (m.compatible === false) { failed?.(new Error(m.reason ?? `${m.host} runs a Genie outside this one's support window`)); transport.close(); return; }
            welcomed?.(true);
            return;
        }
        if (m.kind === 'pairing') { failed?.(new Error(`${m.host} asked its person to let this workstation in, so it was not admitted as its owner`)); transport.close(); return; }
        if (m.kind === 'refused') { failed?.(new Error(m.reason)); return; }
        if (m.kind === 'result') {
            const p = pending.get(m.id);
            if (!p) return;
            pending.delete(m.id);
            clearTimeout(p.timer);
            if (m.ok) p.resolve(m.value);
            else if (m.code === 'unsupported') p.reject(new StationRefused('that workstation runs an older Genie that carries no mail between workstations; update it'));
            else p.reject(new StationRefused(m.reason));
        }
    });
    const offClose = transport.onClose(() => endAll('the connection to that workstation closed'));
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error('that workstation did not answer')); transport.close(); }, timeoutMs);
        welcomed = () => { clearTimeout(timer); welcomed = null; failed = null; resolve(); };
        failed = (e) => { clearTimeout(timer); welcomed = null; failed = null; reject(e); };
        const offer = remoteOffer('host', options.build ?? null, [`${CAP_CROSS_STATION}@1`]);
        transport.send(JSON.stringify({ kind: 'hello', auth: { kind: 'relay', label: options.label }, label: options.label, ...(offer.track ? { track: offer.track } : {}), ...(offer.build ? { build: offer.build } : {}), schema: offer.schema, minSchema: offer.minSchema, capabilities: offer.capabilities }));
    }).catch((error: unknown) => { offMessage(); offClose(); throw error; });
    return {
        call(method: CrossStationMethod, arg: unknown): Promise<unknown> {
            if (closed) return Promise.reject(new Error('the connection to that workstation closed'));
            const id = ++nextId;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => { pending.delete(id); reject(new Error('that workstation did not answer the call')); }, timeoutMs);
                pending.set(id, { resolve, reject, timer });
                transport.send(JSON.stringify({ kind: 'call', id, method, args: [arg] }));
            });
        },
        close() {
            endAll('the connection to that workstation closed');
            offMessage();
            offClose();
            transport.close();
        },
    };
}
