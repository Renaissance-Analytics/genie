import { describe, expect, it } from 'vitest';
import { drainedCliUpdate, type CliDrainAgent, type CliDrainPorts } from '../src/core/cli-update-drain.js';

/**
 * A PROVIDER CLI UPDATE DRAINS FIRST (Tynn #1067, owner 2026-11-26: "when updating cli it should send a stop command to all
 * running agents like genie upgrade process"). Every running agent of THAT provider is asked to reach a safe point (the
 * host-update drain, P6-2), stopped, the CLI updated, and each started again ONCE with its conversation — the one cut
 * mid-turn told to carry on. A stop that leaves a process running refuses the update (the old program is still locked) and
 * starts again what was stopped; a failed update restores the agents too, and says why. Every step is a log line, in order.
 */

interface Rig {
    readonly ports: CliDrainPorts;
    readonly events: string[];
    readonly logs: string[];
    readonly steps: string[];
}

const agents = (): CliDrainAgent[] => [
    { id: 'a1', name: 'atlas', provider: 'claude', running: true, inTurn: true },
    { id: 'a2', name: 'vega', provider: 'claude', running: true, inTurn: false },
    { id: 'a3', name: 'nova', provider: 'codex', running: true, inTurn: true },
    { id: 'a4', name: 'orion', provider: 'claude', running: false, inTurn: false },
];

function rig(over: Partial<CliDrainPorts> = {}, roster: CliDrainAgent[] = agents()): Rig {
    const events: string[] = [];
    const logs: string[] = [];
    const steps: string[] = [];
    const ports: CliDrainPorts = {
        agents: () => roster,
        waitForSafe: async (ids) => { events.push(`wait ${ids.join(',')}`); return { interrupted: ids.filter((id) => roster.find((a) => a.id === id)?.inTurn === true) }; },
        stop: async (id) => { events.push(`stop ${id}`); return { ok: true }; },
        start: async (id, resume) => { events.push(`start ${id}${resume ? ' resume' : ''}`); return { ok: true }; },
        progress: (step) => { steps.push(step); },
        log: (line) => { logs.push(line); },
        ...over,
    };
    return { ports, events, logs, steps };
}

const repaired = async () => ({ kind: 'repaired' as const, from: '2.1.0', to: '2.2.0' });
const failedOf = (o: { kind: string; reason?: string }) => (o.kind === 'repaired' ? null : o.reason ?? o.kind);

describe('the drain around a CLI update', () => {
    it('waits for, stops, updates, then starts again ONLY that provider’s running agents — in that order, each once', async () => {
        const r = rig();
        const updated: string[] = [];
        const result = await drainedCliUpdate('claude', 'Claude Code', r.ports, async () => { r.events.push('update'); updated.push('claude'); return repaired(); }, failedOf);
        expect(r.events).toEqual(['wait a1,a2', 'stop a1', 'stop a2', 'update', 'start a1 resume', 'start a2']);
        expect(updated).toEqual(['claude']);
        expect(result).toMatchObject({ kind: 'ran', outcome: { kind: 'repaired', to: '2.2.0' }, restarted: ['atlas', 'vega'], notRestarted: [] });
        // Codex's agent and the stopped Claude agent are never touched (control).
        expect(r.events.some((e) => e.includes('a3') || e.includes('a4'))).toBe(false);
    });

    it('the lifecycle log says each step in the order it happened, naming the agents', async () => {
        const r = rig();
        await drainedCliUpdate('claude', 'Claude Code', r.ports, repaired, failedOf);
        expect(r.logs).toEqual([
            'cli drain provider=claude agents=atlas,vega: waiting for a safe point',
            'cli drain provider=claude stopped=atlas,vega mid-turn=atlas',
            'cli drain provider=claude update=ok',
            'cli drain provider=claude restarted=atlas,vega',
        ]);
        expect(r.steps).toEqual(['Asking atlas and vega to finish their turns', 'Stopping atlas and vega', 'Updating Claude Code', 'Starting atlas and vega again']);
    });

    it('no agent of that provider running: the update runs at once, nothing is waited for or stopped', async () => {
        const r = rig({}, agents().filter((a) => a.provider !== 'claude' || !a.running));
        const result = await drainedCliUpdate('claude', 'Claude Code', r.ports, async () => { r.events.push('update'); return repaired(); }, failedOf);
        expect(r.events).toEqual(['update']);
        expect(result).toMatchObject({ kind: 'ran', restarted: [], notRestarted: [] });
    });

    it('an agent that does NOT stop refuses the update, naming it; what was stopped starts again; the updater is never called', async () => {
        const r = rig({ stop: async (id) => { r.events.push(`stop ${id}`); return id === 'a2' ? { ok: false, reason: 'claude (pid 41) is still running' } : { ok: true }; } });
        let called = 0;
        const result = await drainedCliUpdate('claude', 'Claude Code', r.ports, async () => { called += 1; return repaired(); }, failedOf);
        expect(called).toBe(0);
        expect(result.kind).toBe('refused');
        expect(result.kind === 'refused' && result.reason).toMatch(/vega did not stop \(claude \(pid 41\) is still running\), so Claude Code was not updated/);
        expect(r.events).toEqual(['wait a1,a2', 'stop a1', 'stop a2', 'start a1 resume']);
        expect(result).toMatchObject({ restarted: ['atlas'] });
        expect(r.logs.at(-1)).toBe('cli drain provider=claude refused: vega did not stop; restarted=atlas');
    });

    it('an update that FAILS restores every agent anyway and says why (the old CLI is what they run)', async () => {
        const r = rig();
        const result = await drainedCliUpdate('claude', 'Claude Code', r.ports, async () => ({ kind: 'unchanged' as const, installed: '2.1.0', reason: 'claude update exited 1' }), failedOf);
        expect(r.events.slice(-2)).toEqual(['start a1 resume', 'start a2']);
        expect(result).toMatchObject({ kind: 'ran', outcome: { kind: 'unchanged' }, restarted: ['atlas', 'vega'] });
        expect(r.logs).toContain('cli drain provider=claude update=failed: claude update exited 1');
    });

    it('an update that THROWS restores every agent, then the error goes on to the caller', async () => {
        const r = rig();
        await expect(drainedCliUpdate('claude', 'Claude Code', r.ports, async () => { throw new Error('installer vanished'); }, failedOf)).rejects.toThrow('installer vanished');
        expect(r.events.slice(-2)).toEqual(['start a1 resume', 'start a2']);
        expect(r.logs).toContain('cli drain provider=claude update=failed: installer vanished');
    });

    it('a start that is refused is named with its reason; the others still start', async () => {
        const r = rig({ start: async (id, resume) => { r.events.push(`start ${id}${resume ? ' resume' : ''}`); return id === 'a1' ? { ok: false, reason: 'its workspace is asleep' } : { ok: true }; } });
        const result = await drainedCliUpdate('claude', 'Claude Code', r.ports, repaired, failedOf);
        expect(result).toMatchObject({ kind: 'ran', restarted: ['vega'], notRestarted: [{ name: 'atlas', reason: 'its workspace is asleep' }] });
        expect(r.logs.at(-1)).toBe('cli drain provider=claude restarted=vega not-restarted=atlas (its workspace is asleep)');
    });

    it('who resumes is who the drain STOPPED mid-turn, not who was mid-turn before the wait (a turn that ended at the safe point is not told)', async () => {
        const r = rig({ waitForSafe: async (ids) => { r.events.push(`wait ${ids.join(',')}`); return { interrupted: [] }; } });
        await drainedCliUpdate('claude', 'Claude Code', r.ports, repaired, failedOf);
        expect(r.events.filter((e) => e.startsWith('start'))).toEqual(['start a1', 'start a2']);
    });
});
