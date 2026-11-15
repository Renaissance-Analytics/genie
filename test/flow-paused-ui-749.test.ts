import { describe, expect, it } from 'vitest';
import { flowPills, pausedWords } from '../src/core/flow-pills.js';
import { flowPillSignals } from '../src/core/flow-pill-signals.js';
import { viewerStatuses } from '../src/core/flow-canvas.js';

/** TYNN #749: a run paused at its agent's provider limit reads Paused with its resume time, never Failed or held. */
const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const AT = Date.UTC(2026, 10, 15, 21, 30, 0);

describe('a run paused at a limit', () => {
    it('says Paused with the time it resumes, or says the time is not stated', () => {
        expect(pausedWords(AT, clock)).toBe('Paused · limit, resumes 21:30');
        expect(pausedWords(null, clock)).toBe('Paused · limit, resume time not stated');
    });

    it('the host reports it live with its pause, and the header pill is `paused`, not running', () => {
        const flows = [{ id: 'f1', workspaceId: 'ws', name: 'nightly', inFlight: { at: '2026-11-15T20:00:00.000Z', pause: { resumesAtMs: AT, agent: 'atlas' } }, runs: [] }];
        const { flowsLive } = flowPillSignals(flows, AT);
        expect(flowsLive).toEqual([{ flowId: 'f1', name: 'nightly', workspaceId: 'ws', at: '2026-11-15T20:00:00.000Z', pause: { resumesAtMs: AT, agent: 'atlas' } }]);
        expect(flowPills({ live: flowsLive, ended: [], now: AT }).shown).toEqual([{ flowId: 'f1', name: 'nightly', workspaceId: 'ws', state: 'paused', resumesAtMs: AT }]);
    });

    it('CONTROL: a run with no pause is a running pill, as before', () => {
        const flows = [{ id: 'f1', workspaceId: 'ws', name: 'nightly', inFlight: { at: '2026-11-15T20:00:00.000Z' }, runs: [] }];
        const { flowsLive } = flowPillSignals(flows, AT);
        expect(flowPills({ live: flowsLive, ended: [], now: AT }).shown[0]).toMatchObject({ state: 'running' });
    });

    it('a paused step is drawn on the canvas as running, never failed', () => {
        expect(viewerStatuses({ s: 'paused' })).toEqual({ s: 'running' });
    });
});
