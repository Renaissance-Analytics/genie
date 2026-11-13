/** Separate, opt-in extra open. Ordinary opens never install these markers or acquire stage data. */
import { randomUUID } from 'node:crypto';

const symbol = JSON.stringify('genie.measure.agent-read-stages');
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export async function measureM4Stages({ agentId, mode, inspector, cdp, openExtra }) {
    if (typeof agentId !== 'string' || agentId.length === 0 || !['ipc', 'door', 'door-revision'].includes(mode)) throw new Error('invalid stage request');
    const nonce = randomUUID(), armed = [];
    const arm = `(() => {
        const key = Symbol.for(${symbol});
        if (Object.prototype.hasOwnProperty.call(globalThis, key)) throw new Error('a stage trace is already installed');
        globalThis[key] = { agentId: ${JSON.stringify(agentId)}, nonce: ${JSON.stringify(nonce)}, events: [] };
        return true;
    })()`;
    const read = `(() => {
        const value = globalThis[Symbol.for(${symbol})];
        if (value?.nonce !== ${JSON.stringify(nonce)} || value.agentId !== ${JSON.stringify(agentId)}) throw new Error('stage trace identity changed');
        return value.events;
    })()`;
    const clear = `(() => {
        const key = Symbol.for(${symbol});
        if (globalThis[key]?.nonce !== ${JSON.stringify(nonce)}) throw new Error('stage cleanup identity changed');
        delete globalThis[key];
        return true;
    })()`;
    let result, failure;
    try {
        for (const port of [inspector, cdp]) {
            // Remember even an arm whose reply is lost: cleanup independently verifies its ownership.
            armed.push(port);
            if (await port.evaluate(arm, 5_000) !== true) throw new Error('stage trace was not armed');
        }
        const observation = await openExtra();
        if (!finite(observation?.ms) || !finite(observation?.maxGapMs)) throw new Error('invalid extra-open observation');
        const mainEvents = await inspector.evaluate(read, 5_000), pageEvents = await cdp.evaluate(read, 5_000);
        for (const events of [mainEvents, pageEvents]) {
            if (!Array.isArray(events) || events.length > 10_000 || !events.every((event) =>
                ['producer', 'send', 'blob', 'decode', 'rebuild'].includes(event?.stage) && finite(event?.ms))) {
                throw new Error('invalid diagnostic stage events');
            }
        }
        const sum = (events, stage) => events.filter((event) => event.stage === stage).reduce((n, event) => n + event.ms, 0);
        const has = (events, stage) => events.some((event) => event.stage === stage);
        if (!has(mainEvents, 'producer') || !has(pageEvents, 'rebuild')) throw new Error('producer or page rebuild stage was not observed');
        const blob = has(pageEvents, 'blob'), decode = has(pageEvents, 'decode');
        if (blob !== decode || (mode === 'ipc' && (blob || decode))) throw new Error('inconsistent blob/decode stage evidence');
        result = {
            producerMs: sum(mainEvents, 'producer'), sendMs: sum(mainEvents, 'send'),
            blobMs: sum(pageEvents, 'blob'), decodeMs: sum(pageEvents, 'decode'), rebuildMs: sum(pageEvents, 'rebuild'),
            totalMs: observation.ms, maxGapMs: observation.maxGapMs, mainEvents, pageEvents,
            decodeStatus: decode ? 'measured: TextDecoder and JSON.parse' : 'not applicable: this open did not decode JSON content',
            accounting: 'Elapsed intervals use their own process clock; no cross-clock subtraction or additive decomposition. IPC native/contextBridge copy and remaining delivery work are not separately timed.',
        };
    } catch (error) { failure = error; }
    // Clear both worlds, even when acquisition or the first cleanup fails. Never overwrite another trace.
    const cleared = await Promise.allSettled(armed.map(async (port) => {
        if (await port.evaluate(clear, 5_000) !== true) throw new Error('stage trace cleanup did not confirm removal');
    }));
    const cleanupFailures = cleared.filter((entry) => entry.status === 'rejected').map((entry) => entry.reason);
    if (cleanupFailures.length > 0) throw new AggregateError([...(failure ? [failure] : []), ...cleanupFailures],
        `diagnostic stage acquisition/cleanup failed: ${[...(failure ? [failure] : []), ...cleanupFailures].map(String).join('; ')}`);
    if (failure) throw failure;
    return result;
}
