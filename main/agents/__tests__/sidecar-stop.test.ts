import { describe, expect, it } from 'vitest';
import { sidecarNamesOf, isSidecarName, sidecarNameFor } from '../sidecar';

/**
 * Stopping an agent stops its sidecars.
 *
 * A sidecar is a second agent that drives the same work under a different TUI,
 * registered by its driver and named `<driver>-slave` — the convention already
 * in use by hand on this workstation (`codex:tynn-slave`, `codex:fancy-slave`,
 * `codex:moic-slave`, and so on, each paired with a `claude` agent of the same
 * base name).
 *
 * `deleteRegisteredAgent` killed only the agent's OWN terminals — its
 * `terminal_spec_id` plus every `agent_runtimes` binding. A sidecar is a
 * separate `workspace_agents` row, so it was untouched: unmounting or deleting
 * `moic` left `moic-slave` running against work whose driver no longer exists.
 *
 * The owner's rule: *"Unmounting and deleting stops the agents and its
 * sidecars."*
 */

describe('sidecar naming', () => {
    it('derives a sidecar name from its driver', () => {
        expect(sidecarNameFor('tynn')).toBe('tynn-slave');
    });

    it('recognises a sidecar by its suffix', () => {
        expect(isSidecarName('tynn-slave')).toBe(true);
        expect(isSidecarName('moic-slave')).toBe(true);
    });

    it('does not mistake an ordinary agent for one', () => {
        // POSITIVE CONTROL: over-matching here would make a normal agent get
        // stopped as somebody else's sidecar.
        expect(isSidecarName('tynn')).toBe(false);
        expect(isSidecarName('slave')).toBe(false);
        expect(isSidecarName('enslaved')).toBe(false);
    });

    it('does not treat a sidecar as its own driver', () => {
        // `tynn-slave-slave` is not a thing; a sidecar has no sidecar.
        expect(sidecarNameFor('tynn-slave')).toBeNull();
    });
});

describe('finding the sidecars to stop', () => {
    const roster = [
        { id: '1', name: 'tynn' },
        { id: '2', name: 'tynn-slave' },
        { id: '3', name: 'moic' },
        { id: '4', name: 'moic-slave' },
        { id: '5', name: 'tynnbuilder' },
    ];

    it('finds the sidecar belonging to this driver', () => {
        expect(sidecarNamesOf('tynn', roster).map((a) => a.id)).toEqual(['2']);
    });

    it('never returns another agent’s sidecar', () => {
        // POSITIVE CONTROL: stopping `tynn` must not stop `moic-slave`.
        expect(sidecarNamesOf('tynn', roster).map((a) => a.name)).not.toContain('moic-slave');
    });

    it('never returns an agent whose name merely starts the same', () => {
        // `tynnbuilder` is a different agent, not `tynn`'s sidecar.
        expect(sidecarNamesOf('tynn', roster).map((a) => a.name)).not.toContain('tynnbuilder');
    });

    it('returns nothing for an agent with no sidecar', () => {
        expect(sidecarNamesOf('tynnbuilder', roster)).toEqual([]);
    });

    it('returns nothing when asked for a sidecar’s sidecars', () => {
        expect(sidecarNamesOf('tynn-slave', roster)).toEqual([]);
    });
});
