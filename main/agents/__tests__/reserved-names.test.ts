import { describe, expect, it } from 'vitest';
import {
    RESERVED_AGENT_NAMES,
    isReservedAgentName,
    reservedNameRefusal,
} from '../reserved-names';

/**
 * Reserved agent names — the block list (genie#324 follow-on, Tynn story #262).
 *
 * `general` was never a name anyone CHOSE. `normalizePurpose` returned it for
 * any agent that joined without a stated purpose, so an unnamed terminal became
 * `{tui}:general` — indistinguishable from a deliberate name. On this
 * workstation that minted **7 of 29 agents** across seven workspaces.
 *
 * #326 stopped the mint. This stops the term coming back BY HAND, and extends
 * the rule to the two other terms that name the products themselves.
 *
 * The owner's rule: *"NO GENERAL. WE need a term block list. so no genie or
 * tynn either (except tynn is allowed in this specific workspace of course)"*.
 *
 * The exemption is deliberately NOT a hard-coded `tynn`. A SACRED workspace
 * carries `sacred_name` — the ONE reserved term it is permitted to use — so the
 * Tynn workspace may hold an agent named `tynn` and nothing else anywhere may,
 * and a second sacred workspace needs no code change to be granted its own name.
 *
 * It is NOT keyed on the workspace slug, which was the first design and was
 * wrong twice over: the Tynn workspace's slug is `tynn-ai` (from `project.json`'s
 * `tynn.project: "Tynn.ai"`), so the agent the owner explicitly said must be
 * allowed would have been refused; and `slug.ts` documents the slug as
 * display-only and NOT unique across workspaces, which makes it the wrong key
 * for a rule that decides what may exist.
 */

describe('the reserved-term block list', () => {
    it('blocks exactly general, genie and tynn', () => {
        expect([...RESERVED_AGENT_NAMES].sort()).toEqual(['general', 'genie', 'tynn']);
    });

    it('recognises each reserved term', () => {
        expect(isReservedAgentName('general')).toBe(true);
        expect(isReservedAgentName('genie')).toBe(true);
        expect(isReservedAgentName('tynn')).toBe(true);
    });

    it('leaves ordinary names alone', () => {
        expect(isReservedAgentName('tynn-builder')).toBe(false);
        expect(isReservedAgentName('frontend')).toBe(false);
        expect(isReservedAgentName('moic-slave')).toBe(false);
    });

    it('matches the WHOLE name, never a substring', () => {
        // `tynnbuilder` is not `tynn`, exactly as `terminalsToStopFor` matches
        // whole names so `tynnbuilder` is never stopped as `tynn`'s sidecar.
        expect(isReservedAgentName('tynnbuilder')).toBe(false);
        expect(isReservedAgentName('genie-cloud')).toBe(false);
        expect(isReservedAgentName('general-purpose')).toBe(false);
    });
});

describe('refusing a reserved name', () => {
    it('allows an ordinary name in an ordinary workspace', () => {
        expect(reservedNameRefusal({ name: 'frontend', sacredName: null })).toBeNull();
    });

    it('refuses a reserved name in an ordinary workspace, naming the term', () => {
        const refusal = reservedNameRefusal({ name: 'general', sacredName: null });
        expect(refusal).toContain('general');
    });

    it('refuses genie and tynn in an ordinary workspace', () => {
        expect(reservedNameRefusal({ name: 'genie', sacredName: null })).not.toBeNull();
        expect(reservedNameRefusal({ name: 'tynn', sacredName: null })).not.toBeNull();
    });

    it('treats a missing grant the same as no grant', () => {
        expect(reservedNameRefusal({ name: 'tynn' })).not.toBeNull();
    });
});

describe('the sacred-workspace exemption', () => {
    it('lets a workspace granted `tynn` hold an agent named tynn', () => {
        expect(reservedNameRefusal({ name: 'tynn', sacredName: 'tynn' })).toBeNull();
    });

    it('is NOT a skeleton key — the grant covers ONE term', () => {
        // The Tynn workspace may be `tynn`; it may not therefore also be
        // `genie` or `general`.
        expect(reservedNameRefusal({ name: 'genie', sacredName: 'tynn' })).not.toBeNull();
        expect(reservedNameRefusal({ name: 'general', sacredName: 'tynn' })).not.toBeNull();
    });

    it('generalises to any granted term, with nothing hard-coded', () => {
        expect(reservedNameRefusal({ name: 'genie', sacredName: 'genie' })).toBeNull();
        expect(reservedNameRefusal({ name: 'tynn', sacredName: 'genie' })).not.toBeNull();
    });

    it('cannot be used to grant a term that was never reserved', () => {
        // A grant is an exemption from the block list, not a claim on a name.
        // `frontend` was already allowed everywhere; granting it changes nothing
        // and must not read as reserving it.
        expect(reservedNameRefusal({ name: 'frontend', sacredName: 'frontend' })).toBeNull();
        expect(reservedNameRefusal({ name: 'backend', sacredName: 'frontend' })).toBeNull();
    });

    it('ignores a grant that is not itself a reserved term', () => {
        // A workspace granted `frontend` gets no power over the real list.
        expect(reservedNameRefusal({ name: 'tynn', sacredName: 'frontend' })).not.toBeNull();
    });

    it('is case- and whitespace-insensitive on both sides', () => {
        expect(reservedNameRefusal({ name: 'Tynn', sacredName: ' TYNN ' })).toBeNull();
    });
});
