import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { measureM4Stages } from '../scripts/agent-reads-m4-stages.mjs';

// Execute the exact CDP/inspector expressions in independent worlds; no Electron, sockets or real processes.
function rig(mode: 'door' | 'ipc' = 'door') {
    const main = createContext({}), page = createContext({});
    const port = (world: typeof main) => ({ evaluate: vi.fn(async (expression: string) => runInContext(expression, world) as unknown) });
    const inspector = port(main), cdp = port(page);
    const append = (world: typeof main, stage: string, ms: number) => runInContext(`globalThis[Symbol.for('genie.measure.agent-read-stages')].events.push(${JSON.stringify({ stage, ms })})`, world);
    const openExtra = vi.fn(async () => {
        append(main, 'producer', 7); append(main, 'send', 2);
        if (mode === 'door') { append(page, 'blob', 13); append(page, 'decode', 3); }
        append(page, 'rebuild', 5);
        return { ms: 42, maxGapMs: 11 };
    });
    const clean = () => {
        for (const world of [main, page]) expect(runInContext(`Object.hasOwn(globalThis, Symbol.for('genie.measure.agent-read-stages'))`, world)).toBe(false);
    };
    return { main, page, append, clean, ports: { agentId: 'fixture-agent', mode, inspector, cdp, openExtra } };
}

describe('extra-open stage collection in separate worlds (Tynn #564)', () => {
    it('collects real stage events and the extra open total, then removes both markers', async () => {
        const r = rig(); const value = await measureM4Stages(r.ports);
        expect(value).toMatchObject({ producerMs: 7, sendMs: 2, blobMs: 13, decodeMs: 3, rebuildMs: 5, totalMs: 42, maxGapMs: 11 });
        expect(value.mainEvents).toHaveLength(2); expect(value.pageEvents).toHaveLength(3);
        expect(value.accounting).toMatch(/no cross-clock/); r.clean();
    });

    it('states that IPC has no JSON decoder observation, rather than claiming its copy is free', async () => {
        const r = rig('ipc'); const value = await measureM4Stages(r.ports);
        expect(value.decodeMs).toBe(0); expect(value.decodeStatus).toMatch(/not applicable/);
        expect(value.accounting).toMatch(/native\/contextBridge copy.*not separately timed/); r.clean();
    });

    it('cleans both worlds after an extra open fails and preserves the acquisition error', async () => {
        const r = rig(); r.ports.openExtra.mockRejectedValueOnce(new Error('extra open failed'));
        await expect(measureM4Stages(r.ports)).rejects.toThrow('extra open failed'); r.clean();
    });

    it('refuses missing producer data instead of fabricating a stage duration', async () => {
        const r = rig(); r.ports.openExtra.mockImplementationOnce(async () => { r.append(r.page, 'rebuild', 1); return { ms: 9, maxGapMs: 1 }; });
        await expect(measureM4Stages(r.ports)).rejects.toThrow(/producer/); r.clean();
    });

    it('refuses incomplete blob/decode evidence', async () => {
        const r = rig(); r.ports.openExtra.mockImplementationOnce(async () => {
            r.append(r.main, 'producer', 1); r.append(r.page, 'rebuild', 1); r.append(r.page, 'blob', 2);
            return { ms: 9, maxGapMs: 1 };
        });
        await expect(measureM4Stages(r.ports)).rejects.toThrow(/inconsistent/); r.clean();
    });

    it('does not replace an already installed trace', async () => {
        const r = rig(); runInContext(`globalThis[Symbol.for('genie.measure.agent-read-stages')] = { nonce: 'someone-else', events: [] }`, r.main);
        await expect(measureM4Stages(r.ports)).rejects.toThrow(/already installed/);
        expect(runInContext(`globalThis[Symbol.for('genie.measure.agent-read-stages')].nonce`, r.main)).toBe('someone-else');
        expect(r.ports.openExtra).not.toHaveBeenCalled();
    });

    it('still clears the page marker if inspector cleanup fails, and fails the diagnostic', async () => {
        const r = rig(); const evaluate = r.ports.inspector.evaluate.getMockImplementation()!;
        r.ports.inspector.evaluate.mockImplementation(async (expression) => {
            if (expression.includes('delete globalThis')) throw new Error('inspector cleanup failed');
            return evaluate(expression);
        });
        await expect(measureM4Stages(r.ports)).rejects.toThrow(/inspector cleanup failed/);
        expect(runInContext(`Object.hasOwn(globalThis, Symbol.for('genie.measure.agent-read-stages'))`, r.page)).toBe(false);
    });
});
