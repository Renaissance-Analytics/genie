import { describe, expect, it } from 'vitest';
import {
    WORKSPACE_PALETTE,
    assignWorkspaceColors,
    colorWrite,
    contrastRatio,
    isWorkspaceColor,
    lowContrastThemes,
    manifestColor,
    THEME_SURFACES,
    withManifestColor,
} from '../src/core/workspace-color.js';
import { SCHEMA_REVISION } from '../src/core/workspace-model.js';

/**
 * WORKSPACE COLOURS (genie#1300) — the pure half: the palette, how a workspace without a colour gets one, how
 * project.json carries it (`appearance.color`, Civicognita/shared-schemas v0.3.0), and that every colour can be seen
 * on both themes.
 */

const SCHEMA = (v: string) => `https://raw.githubusercontent.com/Civicognita/shared-schemas/v${v}/schemas/workspace/project.schema.json`;

/** CIE L*a*b* ΔE76 — how far apart two colours look. */
function deltaE(a: string, b: string): number {
    const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const lab = (hex: string) => {
        const [r, g, bl] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
        const x = (r * 0.4124 + g * 0.3576 + bl * 0.1805) / 0.95047;
        const y = r * 0.2126 + g * 0.7152 + bl * 0.0722;
        const z = (r * 0.0193 + g * 0.1192 + bl * 0.9505) / 1.08883;
        const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
        return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))] as const;
    };
    const p = lab(a);
    const q = lab(b);
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

describe('the palette', () => {
    it('has enough colours to tell a screenful of workspaces apart, every one a valid colour', () => {
        expect(WORKSPACE_PALETTE.length).toBeGreaterThanOrEqual(10);
        for (const c of WORKSPACE_PALETTE) expect(isWorkspaceColor(c)).toBe(true);
    });

    it('holds no two colours a person could mix up (ΔE ≥ 20 between every pair)', () => {
        let closest = Infinity;
        for (let i = 0; i < WORKSPACE_PALETTE.length; i++) {
            for (let j = i + 1; j < WORKSPACE_PALETTE.length; j++) closest = Math.min(closest, deltaE(WORKSPACE_PALETTE[i]!, WORKSPACE_PALETTE[j]!));
        }
        expect(closest).toBeGreaterThanOrEqual(20);
    });

    it('every colour stands out at 3:1 (WCAG non-text contrast) on every surface of the light AND the dark theme', () => {
        for (const c of WORKSPACE_PALETTE) {
            for (const bg of [...THEME_SURFACES.light, ...THEME_SURFACES.dark]) expect(contrastRatio(c, bg), `${c} on ${bg}`).toBeGreaterThanOrEqual(3);
            expect(lowContrastThemes(c)).toEqual([]);
        }
    });
});

describe('contrast', () => {
    it('computes WCAG ratios (black on white is 21, a colour on itself is 1)', () => {
        expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
        expect(contrastRatio('#7c3aed', '#7C3AED')).toBeCloseTo(1, 5);
    });

    it('names the theme a custom colour is hard to see on — and only that one', () => {
        expect(lowContrastThemes('#fde047')).toEqual(['light']); // a pale yellow vanishes on white
        expect(lowContrastThemes('#1e1b4b')).toEqual(['dark']); // a deep indigo vanishes on near-black
        expect(lowContrastThemes('#3b82f6')).toEqual([]);
    });
});

describe('isWorkspaceColor — the schema\'s pattern, ^#[0-9A-Fa-f]{6}$', () => {
    it('accepts six-digit hex in either case and nothing else', () => {
        for (const ok of ['#7C3AED', '#7c3aed', '#000000']) expect(isWorkspaceColor(ok)).toBe(true);
        for (const bad of ['purple', '#7C3', '#7C3AED80', '7C3AED', '', null, 7, undefined]) expect(isWorkspaceColor(bad)).toBe(false);
    });
});

describe('manifestColor / withManifestColor — appearance.color in project.json', () => {
    it('reads appearance.color, and ignores a malformed one rather than guessing', () => {
        expect(manifestColor({ appearance: { color: '#7C3AED' } })).toBe('#7c3aed');
        expect(manifestColor({ appearance: { color: 'purple' } })).toBeNull();
        expect(manifestColor({ appearance: 'purple' })).toBeNull();
        expect(manifestColor({})).toBeNull();
        expect(manifestColor(null)).toBeNull();
    });

    it('sets the colour and carries every other key — and every other appearance member — through', () => {
        const before = { $schema: SCHEMA('0.3.0'), name: 'Tynn', repos: [{ name: 'a' }], appearance: { icon: 'rocket' }, futureOwner: { keep: true } };
        const after = withManifestColor(before, '#0891B2');
        expect(after).toEqual({ ...before, appearance: { icon: 'rocket', color: '#0891b2' } });
        expect(before.appearance).toEqual({ icon: 'rocket' });
    });
});

describe('assignWorkspaceColors — automatic, stable, distinct from its neighbours', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `w${i}`, color: null as string | null }));

    it('gives every workspace without one a palette colour; one that has a colour keeps it', () => {
        const got = assignWorkspaceColors([{ id: 'a', color: '#123456' }, { id: 'b', color: null }, { id: 'c', color: null }]);
        expect(got.a).toBe('#123456');
        expect(WORKSPACE_PALETTE).toContain(got.b);
        expect(WORKSPACE_PALETTE).toContain(got.c);
    });

    it('is a function of its input: the same list gives the same colours', () => {
        expect(assignWorkspaceColors(ids(7))).toEqual(assignWorkspaceColors(ids(7)));
    });

    it('is stable: feeding its answer back changes nothing, and a workspace added later moves no one else', () => {
        const first = assignWorkspaceColors(ids(5));
        const again = assignWorkspaceColors(ids(5).map((w) => ({ id: w.id, color: first[w.id]! })));
        expect(again).toEqual(first);
        const grown = assignWorkspaceColors([...ids(5).map((w) => ({ id: w.id, color: first[w.id]! })), { id: 'new', color: null }]);
        for (const w of ids(5)) expect(grown[w.id]).toBe(first[w.id]);
    });

    it('uses every palette colour once before any repeats', () => {
        const got = assignWorkspaceColors(ids(WORKSPACE_PALETTE.length));
        expect(new Set(Object.values(got)).size).toBe(WORKSPACE_PALETTE.length);
    });

    it('never gives two neighbours the same colour — even past the palette, and next to a colour someone chose', () => {
        for (const n of [2, WORKSPACE_PALETTE.length + 1, WORKSPACE_PALETTE.length * 3 + 2]) {
            const list = ids(n);
            const got = assignWorkspaceColors(list);
            for (let i = 1; i < n; i++) expect(got[list[i]!.id], `w${i - 1} / w${i}`).not.toBe(got[list[i - 1]!.id]);
        }
        // The first palette colour is already taken by the NEXT row (chosen by a person): the new one must not repeat it.
        const chosen = assignWorkspaceColors([{ id: 'x', color: null }, { id: 'y', color: WORKSPACE_PALETTE[0]!.toUpperCase() }]);
        expect(chosen.x).not.toBe(WORKSPACE_PALETTE[0]);
    });
});

describe('colorWrite — through project.json, Genie\'s writer (no side file)', () => {
    const v02 = `{\n    "$schema": "${SCHEMA('0.2.0')}",\n    "name": "Tynn",\n    "repos": []\n}\n`;

    it('writes appearance.color, moves $schema to this Genie\'s revision, keeps the file\'s indentation, and asks for no backup for an additive bump', () => {
        const r = colorWrite(v02, '#0891b2');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(SCHEMA_REVISION).toBe('0.3.0');
        expect(JSON.parse(r.text)).toEqual({ $schema: SCHEMA('0.3.0'), name: 'Tynn', repos: [], appearance: { color: '#0891b2' } });
        expect(r.text).toContain('\n    "name": "Tynn"');
        expect(r.text.endsWith('}\n')).toBe(true);
        expect(r.backup).toBeNull();
        expect(r.changed).toBe(true);
    });

    it('an unstamped (legacy) file gets the MIGRATIONS backup of its original text', () => {
        const legacy = '{\n  "name": "Old"\n}\n';
        const r = colorWrite(legacy, '#0891b2');
        expect(r.ok && r.backup).toEqual({ name: 'project.json.pre-schema-0.3.0.bak', text: legacy });
    });

    it('the same colour again changes nothing', () => {
        const once = colorWrite(v02, '#0891B2');
        if (!once.ok) throw new Error(once.reason);
        const twice = colorWrite(once.text, '#0891b2');
        expect(twice).toMatchObject({ ok: true, changed: false, text: once.text });
    });

    it('refuses — and writes nothing — for no project.json, a file that is not JSON, a bad colour, or a NEWER schema', () => {
        expect(colorWrite(null, '#0891b2')).toMatchObject({ ok: false });
        expect(colorWrite('{ nope', '#0891b2')).toMatchObject({ ok: false });
        expect(colorWrite(v02, 'teal')).toMatchObject({ ok: false });
        const newer = `{ "$schema": "${SCHEMA('9.0.0')}", "name": "Future" }`;
        expect(colorWrite(newer, '#0891b2')).toMatchObject({ ok: false, reason: expect.stringContaining('newer') });
    });
});
