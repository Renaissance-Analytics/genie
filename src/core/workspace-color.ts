import { formatLike } from './envelope-sites.js';
import { SCHEMA_REVISION, stampSchema } from './workspace-model.js';

/**
 * WORKSPACE COLOURS (genie#1300) — the pure half.
 *
 * The owner, 2026-10-20: "We need workspace color customization so it's always easy to tell who a user is talking to";
 * 2026-10-21: the colour lives in project.json, "this also lets the agent see and set this if needed". Genie 1 had no
 * workspace colour (checked against its code), so this is new rather than a port.
 *
 * - **Where it lives:** `appearance.color` in the workspace's project.json, six-digit sRGB hex — Civicognita/shared-schemas
 *   v0.3.0 (issue #2). Writing it stamps that revision; a manifest on a NEWER revision is never rewritten (stampSchema).
 * - **Automatic:** a workspace without one gets a palette colour — every palette colour once before any repeats, never
 *   the colour of the row beside it, and, once written, never moved.
 * - **Seen on both themes:** every palette colour stands 3:1 (WCAG 1.4.11, non-text contrast) against every surface of
 *   the light and the dark theme. A custom colour that does not is allowed, and Settings says which theme it is faint on.
 */

/**
 * The palette, in the order it is handed out: neighbours in this list are far apart in hue, and no two entries are
 * closer than ΔE 24 (CIELAB). Tailwind 500–700 stops, chosen for their luminance (0.14–0.25) — the band that clears 3:1
 * on both themes' surfaces. A colour added here must pass `workspace-color.test.ts` (distinct AND visible).
 */
export const WORKSPACE_PALETTE: readonly string[] = [
    '#3b82f6', // blue-500
    '#ea580c', // orange-600
    '#059669', // emerald-600
    '#c026d3', // fuchsia-600
    '#a16207', // yellow-700
    '#0891b2', // cyan-600
    '#e11d48', // rose-600
    '#8b5cf6', // violet-500
    '#4d7c0f', // lime-700
    '#64748b', // slate-500
    '#db2777', // pink-600
];

/** The surfaces a workspace colour is drawn on (tokens.css `--bg-0` … `--bg-2`), per theme. */
export const THEME_SURFACES = {
    light: ['#ffffff', '#fafafa', '#f4f4f5'],
    dark: ['#0a0a0c', '#15151a', '#1e1e24'],
} as const;

export type Theme = keyof typeof THEME_SURFACES;

/** WCAG 1.4.11: a graphical object that identifies something needs 3:1 against what it sits on. */
export const MIN_CONTRAST = 3;

const HEX = /^#[0-9A-Fa-f]{6}$/;

/** The schema's own pattern: `^#[0-9A-Fa-f]{6}$`. */
export function isWorkspaceColor(value: unknown): value is string {
    return typeof value === 'string' && HEX.test(value);
}

/** One spelling for comparing and drawing: lower case. */
const norm = (color: string): string => color.toLowerCase();

function luminance(color: string): number {
    const channel = (i: number) => {
        const v = parseInt(color.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** The WCAG contrast ratio of two hex colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
    const x = luminance(a);
    const y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The themes on which a colour falls under 3:1 against any of their surfaces — `[]` when it is visible on both. */
export function lowContrastThemes(color: string): Theme[] {
    return (Object.keys(THEME_SURFACES) as Theme[]).filter((theme) => THEME_SURFACES[theme].some((bg) => contrastRatio(color, bg) < MIN_CONTRAST));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** project.json's `appearance.color`, or `null` — a malformed value is ignored, never guessed at (the schema's rule). */
export function manifestColor(manifest: unknown): string | null {
    if (!isRecord(manifest) || !isRecord(manifest.appearance)) return null;
    const color = manifest.appearance.color;
    return isWorkspaceColor(color) ? norm(color) : null;
}

/** The manifest with `appearance.color` set — every other key, and every other `appearance` member, carried through. */
export function withManifestColor(manifest: Record<string, unknown>, color: string): Record<string, unknown> {
    const appearance = isRecord(manifest.appearance) ? manifest.appearance : {};
    return { ...manifest, appearance: { ...appearance, color: norm(color) } };
}

/**
 * Every workspace's colour, in the order given (the rail's): one it has is kept; one without gets the palette colour
 * used least so far, never the colour of the row before it or after it, the earliest in the palette on a tie.
 * A function of its input — so feeding its answer back changes nothing, and a workspace added later moves no one.
 */
export function assignWorkspaceColors(workspaces: readonly { readonly id: string; readonly color: string | null }[]): Record<string, string> {
    const resolved: (string | null)[] = workspaces.map((w) => (isWorkspaceColor(w.color) ? norm(w.color) : null));
    const uses = new Map<string, number>();
    for (const c of resolved) if (c !== null) uses.set(c, (uses.get(c) ?? 0) + 1);
    for (let i = 0; i < resolved.length; i++) {
        if (resolved[i] !== null) continue;
        const beside = new Set([resolved[i - 1], resolved[i + 1]].filter((c): c is string => typeof c === 'string'));
        let best: string | null = null;
        for (const c of WORKSPACE_PALETTE) {
            if (beside.has(c)) continue;
            if (best === null || (uses.get(c) ?? 0) < (uses.get(best) ?? 0)) best = c;
        }
        const pick = best ?? WORKSPACE_PALETTE[0]!;
        resolved[i] = pick;
        uses.set(pick, (uses.get(pick) ?? 0) + 1);
    }
    return Object.fromEntries(workspaces.map((w, i) => [w.id, resolved[i]!]));
}

export type ColorWrite =
    | { ok: true; text: string; changed: boolean; backup: { name: string; text: string } | null }
    | { ok: false; reason: string };

/**
 * project.json's text with `appearance.color` set — Genie's writer: stamped with this Genie's schema revision, in the
 * file's own indentation and line endings, every other key carried through. Refuses (and so writes nothing) for a
 * missing or unreadable file, a colour that is not hex, and a manifest on a NEWER schema than this Genie writes.
 *
 * The backup: MIGRATIONS.md asks for one only when an UNSTAMPED legacy file is first stamped. v0.2.0 → v0.3.0 only adds
 * an optional key, so a stamped file is rewritten without one — an untracked `.bak` in every envelope a colour reached
 * would be litter, not safety.
 */
export function colorWrite(text: string | null, color: string, revision: string = SCHEMA_REVISION): ColorWrite {
    if (!isWorkspaceColor(color)) return { ok: false, reason: `${color} is not a colour (#rrggbb)` };
    if (text === null) return { ok: false, reason: 'This workspace has no project.json' };
    let manifest: unknown;
    try { manifest = JSON.parse(text); } catch { return { ok: false, reason: 'project.json is not valid JSON' }; }
    if (!isRecord(manifest)) return { ok: false, reason: 'project.json is not a JSON object' };
    const stamp = stampSchema(manifest, revision);
    if (!stamp.ok) return stamp;
    if (manifestColor(manifest) === norm(color) && stamp.backup === null) return { ok: true, text, changed: false, backup: null };
    const next = withManifestColor(stamp.manifest, color);
    const backup = stamp.from === null && stamp.backup !== null ? { name: stamp.backup, text } : null;
    return { ok: true, text: formatLike(text, next), changed: true, backup };
}
