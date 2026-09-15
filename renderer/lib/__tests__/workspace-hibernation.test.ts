import { describe, expect, it } from 'vitest';
import {
    awakeSpecs,
    hibernateOutcome,
    isHibernated,
    wakeOutcome,
} from '../workspace-hibernation';

/**
 * What the window does with a HIBERNATING workspace (genie#672).
 *
 * The owner: "A Hibernated workspace is styled grey with a set of 3 zzz in front
 * of the agent avatar … Hibernated workspaces have all processes and terminals
 * completely shut down and do not wake up after upgrades or restarts, only when a
 * user manually wakes them up."
 *
 * PURE, so the rules the rail, the floor and the menu share are tested without a
 * DOM; the E2E drives the real window through them.
 */

describe('isHibernated', () => {
    it('is asleep only when the row carries a hibernation time', () => {
        expect(isHibernated({ hibernated_at: 1_757_900_000_000 })).toBe(true);
        // Zero is a time, not "unset" — a truthiness check would wake it.
        expect(isHibernated({ hibernated_at: 0 })).toBe(true);
        expect(isHibernated({ hibernated_at: null })).toBe(false);
        expect(isHibernated({})).toBe(false);
        expect(isHibernated(undefined)).toBe(false);
    });
});

describe('awakeSpecs — no panel mounts for a sleeping workspace', () => {
    const rows = new Map([
        ['awake', { hibernated_at: null }],
        ['asleep', { hibernated_at: 1 }],
    ]);
    const spec = (id: string, workspace_id: string | null) => ({ id, workspace_id });

    it('drops the panels of a hibernating workspace and keeps every other', () => {
        const specs = [spec('a1', 'awake'), spec('s1', 'asleep'), spec('a2', 'awake')];
        // A mounted panel asks for its pty; in a sleeping workspace that is refused,
        // and the panel would show an error where the floor should show it asleep.
        expect(awakeSpecs(specs, rows).map((s) => s.id)).toEqual(['a1', 'a2']);
    });

    it('keeps a panel that belongs to no workspace, or to one the window has not loaded', () => {
        const specs = [spec('loose', null), spec('unknown', 'not-loaded')];
        expect(awakeSpecs(specs, rows).map((s) => s.id)).toEqual(['loose', 'unknown']);
    });
});

describe('hibernateOutcome — what the person is told once it is asleep', () => {
    it('says it is asleep, and which agents saved a handoff', () => {
        const msg = hibernateOutcome('Prism', {
            ok: true,
            handoffs: [
                { agent: 'docs', saved: true },
                { agent: 'labs', saved: true },
            ],
            stoppedTerminals: 4,
            purgedMessages: 2,
            errors: [],
        });
        expect(msg.tone).toBe('ok');
        expect(msg.text).toMatch(/Prism is hibernating/);
        expect(msg.text).toMatch(/2 agents saved a handoff/);
    });

    it('names an agent that did not answer — its next run starts from nothing', () => {
        const msg = hibernateOutcome('Prism', {
            ok: true,
            handoffs: [
                { agent: 'docs', saved: true },
                { agent: 'labs', saved: false },
            ],
            stoppedTerminals: 2,
            purgedMessages: 0,
            errors: [],
        });
        expect(msg.tone).toBe('warn');
        expect(msg.text).toMatch(/labs did not save a handoff/);
    });

    it('reports a step that failed rather than a clean sleep', () => {
        const msg = hibernateOutcome('Prism', {
            ok: true,
            handoffs: [],
            stoppedTerminals: 0,
            purgedMessages: 0,
            errors: ['docker: network in use'],
        });
        expect(msg.tone).toBe('warn');
        expect(msg.text).toMatch(/docker: network in use/);
    });

    it('passes a refusal through as an error', () => {
        expect(hibernateOutcome('Prism', { ok: false, error: 'Prism is already hibernating.' })).toEqual({
            tone: 'error',
            text: 'Prism is already hibernating.',
        });
    });
});

describe('wakeOutcome', () => {
    it('says it is awake, or what did not come back', () => {
        expect(wakeOutcome('Prism', { ok: true, errors: [] })).toEqual({ tone: 'ok', text: 'Prism is awake.' });
        const partial = wakeOutcome('Prism', { ok: true, errors: ['no container runtime'] });
        expect(partial.tone).toBe('warn');
        expect(partial.text).toMatch(/no container runtime/);
        expect(wakeOutcome('Prism', { ok: false, error: 'Prism is not hibernating.' }).tone).toBe('error');
    });
});
