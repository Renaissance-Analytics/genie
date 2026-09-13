import { describe, expect, it } from 'vitest';
import {
    SHUTTLE_WIRE_GENERATION,
    upgradeDepth,
    type SystemGeneration,
} from '../system-generation';

/**
 * DEEP vs SHALLOW — the mechanical definition an upgrade is judged by
 * (`.ai/plans/genie-mcp-shuttle-spec.md` §8, Phase 0 of genie#346).
 *
 * The owner allows terminal restarts for a DEEP system upgrade and for nothing
 * else, so "is this deep?" cannot be a judgement call made at release time. It
 * has to be a function of two build descriptors, and a test has to pin it.
 *
 * An upgrade is DEEP if and only if one of four things changes:
 *
 *   1. the shuttle's wire generation (its publish/dispatch protocol)
 *   2. the MCP protocol revision it terminates — every connected client talks that
 *   3. the shipped standalone Node runtime
 *   4. the pty-host's own identity (fancy-term-host + node-pty — its native ABI)
 *
 * EVERYTHING ELSE IS SHALLOW, including every routine release: new tools, changed
 * schemas, new plugins, renderer changes, migrations, prompts. A shallow upgrade
 * restarts nothing but the Genie process itself.
 */

/** A build as it is today. */
const BASE: SystemGeneration = {
    wireGeneration: 1,
    mcpProtocolRevision: '2024-11-05',
    runtimeKey: 'node22.12.0-win32-x64-caddy2.10.0',
    ptyHostKey: 'fth0.9.1-npty1.0.0',
};

describe('the spec’s own acceptance test (§8)', () => {
    it('does NOT call a routine release deep', () => {
        // "A build differing only in `version` and tool descriptors is NOT deep."
        // Version and tools are deliberately not fields of the descriptor at all:
        // two builds that share all four values ARE the same system, whatever
        // else moved. So a routine release is the identical descriptor.
        const depth = upgradeDepth(BASE, { ...BASE });
        expect(depth.deep).toBe(false);
        expect(depth.reasons).toEqual([]);
    });

    it('POSITIVE CONTROL — a bumped wire generation IS deep', () => {
        // The spec names this control and says why it is mandatory: "Without that
        // control the test passes against a function that always returns false."
        const depth = upgradeDepth(BASE, { ...BASE, wireGeneration: 2 });
        expect(depth.deep).toBe(true);
        expect(depth.reasons).toEqual(['wire-generation']);
    });
});

describe('each of the four conditions is deep on its own', () => {
    // One case per condition, because a function that checks three of the four
    // would pass a test that only ever bumps one.
    it('the MCP protocol revision the shuttle terminates', () => {
        const depth = upgradeDepth(BASE, { ...BASE, mcpProtocolRevision: '2025-06-18' });
        expect(depth).toEqual({ deep: true, reasons: ['mcp-protocol'] });
    });

    it('the shipped Node runtime', () => {
        const depth = upgradeDepth(BASE, { ...BASE, runtimeKey: 'node24.1.0-win32-x64-caddy2.10.0' });
        expect(depth).toEqual({ deep: true, reasons: ['runtime'] });
    });

    it('the pty-host’s identity — a node-pty rebuild is a new native ABI', () => {
        const depth = upgradeDepth(BASE, { ...BASE, ptyHostKey: 'fth0.9.1-npty1.1.0' });
        expect(depth).toEqual({ deep: true, reasons: ['pty-host'] });
    });

    it('names EVERY change, not just the first', () => {
        // The notice built on this (Phase 2) has to say what actually changed.
        // Reporting only the first reason would tell a user their runtime moved
        // when their pty-host also did — the "report WHAT, not THAT" rule.
        const depth = upgradeDepth(BASE, {
            ...BASE,
            wireGeneration: 2,
            ptyHostKey: 'fth1.0.0-npty1.1.0',
        });
        expect(depth.deep).toBe(true);
        expect(depth.reasons).toEqual(['wire-generation', 'pty-host']);
    });
});

describe('an unknown build is treated as deep', () => {
    // A build from before Phase 0 carries no descriptor. That is not evidence the
    // upgrade is shallow — it is the absence of evidence, and the two failure
    // costs are not symmetric:
    //
    //   - wrongly DEEP    → one unnecessary warning before an upgrade
    //   - wrongly SHALLOW → terminals restart with nobody told, which is the exact
    //                       thing the owner has been hitting
    //
    // So "cannot tell" resolves to deep, and says why.
    it('when the INSTALLED build has no descriptor', () => {
        expect(upgradeDepth(null, BASE)).toEqual({ deep: true, reasons: ['unknown-installed'] });
    });

    it('when the INCOMING build has no descriptor', () => {
        expect(upgradeDepth(BASE, null)).toEqual({ deep: true, reasons: ['unknown-incoming'] });
    });

    it('when a descriptor is present but malformed', () => {
        // A half-written or hand-edited descriptor is no more trustworthy than a
        // missing one. `undefined` fields must not compare equal to each other and
        // read as "unchanged".
        const broken = { wireGeneration: 1 } as unknown as SystemGeneration;
        expect(upgradeDepth(BASE, broken)).toEqual({ deep: true, reasons: ['unknown-incoming'] });
    });
});

describe('this build’s own descriptor', () => {
    it('carries a wire generation, because every other comparison starts from it', () => {
        expect(Number.isInteger(SHUTTLE_WIRE_GENERATION)).toBe(true);
        expect(SHUTTLE_WIRE_GENERATION).toBeGreaterThanOrEqual(1);
    });
});
