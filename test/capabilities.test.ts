import { describe, expect, it } from 'vitest';
import {
    CAPABILITY_META_KEY,
    capabilityOf,
    describeCapability,
    type Capability,
} from '../src/core/capabilities.js';

/**
 * WHAT A DRIVER SAYS IT CAN DO — AND THE DIFFERENCE BETWEEN "NO" AND "DIDN'T SAY".
 *
 * Guidance from the author of `prism-acp` (2026-10-10), and it is the `null` discipline
 * wearing different clothes:
 *
 * > Branch on the **declaration**, never a provider name. That is what the `_meta` key
 * > exists for, and **absence ≠ false** is deliberate — a driver that does not declare is
 * > *unknown*, not incapable, so do not treat a missing key as a denial.
 *
 * Why it matters concretely. Today `ClaudeDriver` declares `permissionRequests: false` and
 * `CodexDriver` declares `true`. A bridge making Claude's `true` is specced but not started,
 * with no date. If Genie branched on the string `'claude'`, that landing would be a code
 * change here; branching on the declaration, it is none. And if a future driver ships
 * without declaring at all, "unknown" must not silently become "no" — that would hide a
 * capability rather than report that we cannot tell.
 *
 * So capability is **three-state**, and the UI consequence is §5's: a `false` is a stated
 * fact and may be rendered as such; an *unknown* renders NOTHING rather than a denial.
 */
const META = CAPABILITY_META_KEY;

describe('capabilityOf', () => {
    it('reads a declared true and a declared false as themselves', () => {
        expect(capabilityOf({ [META]: { permissionRequests: true } }, 'permissionRequests')).toBe(true);
        expect(capabilityOf({ [META]: { permissionRequests: false } }, 'permissionRequests')).toBe(false);
    });

    it('reads an ABSENT capability as unknown — never as false', () => {
        // The whole point. A missing key is "did not say", and a denial would be a claim we
        // have no basis for.
        expect(capabilityOf({ [META]: { transcriptReplay: true } }, 'permissionRequests')).toBeNull();
        expect(capabilityOf({ [META]: {} }, 'permissionRequests')).toBeNull();
    });

    it('reads absent meta, absent object and malformed meta as unknown', () => {
        expect(capabilityOf({}, 'permissionRequests')).toBeNull();
        expect(capabilityOf(undefined, 'permissionRequests')).toBeNull();
        expect(capabilityOf({ [META]: null }, 'permissionRequests')).toBeNull();
        // A non-boolean is not a declaration either. It is not `true`, and it is not `false`.
        expect(capabilityOf({ [META]: { permissionRequests: 'yes' } }, 'permissionRequests')).toBeNull();
    });

    it('COUNT, not a boolean: nothing undeclared ever reads as a denial', () => {
        // A single-case check passes while another shape still collapses to false. Count
        // every undeclared shape that answers `false`; the only acceptable number is zero.
        const undeclared: unknown[] = [
            undefined, {}, { [META]: {} }, { [META]: null }, { [META]: 'nope' },
            { [META]: { permissionRequests: null } },
            { [META]: { permissionRequests: 0 } },
            { [META]: { permissionRequests: 'false' } },
            { other: { permissionRequests: false } },
        ];

        const readAsDenial = undeclared.filter(
            (m) => capabilityOf(m as Record<string, unknown>, 'permissionRequests') === false,
        );

        expect(readAsDenial).toEqual([]);
    });

    it('POSITIVE CONTROL: a real declaration still reaches us', () => {
        // Without this, "nothing reads as a denial" passes against a function that answers
        // `null` to absolutely everything and can never see a capability at all.
        const claudeToday = { [META]: { permissionRequests: false, transcriptReplay: false } };
        const codexToday = { [META]: { permissionRequests: true, transcriptReplay: true } };

        expect(capabilityOf(claudeToday, 'permissionRequests')).toBe(false);
        expect(capabilityOf(codexToday, 'permissionRequests')).toBe(true);
        expect(capabilityOf(codexToday, 'transcriptReplay')).toBe(true);
    });
});

describe('describeCapability — what the UI is entitled to say', () => {
    it('renders a stated no as a sentence, and an unknown as nothing at all', () => {
        const cases: Array<[Capability, string | null]> = [
            [true, 'supported'],
            [false, 'not supported'],
            [null, null],
        ];

        for (const [value, expected] of cases) {
            expect(describeCapability(value)).toBe(expected);
        }
    });
});
