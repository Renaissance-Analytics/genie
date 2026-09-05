import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS } from '../registry';

/**
 * No `main/` file may RESTATE the whole provider set as a type union
 * (genie#261, category A).
 *
 * The registry exports `AgentTuiId`. Writing
 * `'claude' | 'codex' | 'kilo' | 'genie' | 'custom'` out by hand instead is the
 * category the issue calls "the good ones" — the compiler does walk you through
 * them when the union widens — and that is exactly why they survived the
 * registry landing: nothing was broken, so nothing was fixed. They were still
 * nine hand-maintained copies of one fact, `mobile/api.ts` holding two of them,
 * and every copy is a place a new provider is added by hand.
 *
 * They also decay in a way the compiler does not simply solve for you. Widening
 * the registry without widening a copy makes that surface REJECT a valid
 * provider, and the error surfaces at whatever boundary happens to assign across
 * it — not at the copy that is wrong.
 *
 * SOURCE-LEVEL, and the sibling of
 * `renderer/lib/__tests__/provider-literal-guard.test.ts`, which catches the
 * RUNTIME shape (`a === 'x' || a === 'y'`). This one catches the TYPE shape,
 * `'x' | 'y'`, which that regex deliberately does not match.
 *
 * ## The predicate is "restates AgentTuiId", not "mentions two providers"
 *
 * A union is an offender only when it contains EVERY id in `PROVIDER_IDS` —
 * because that, and only that, is a copy of `AgentTuiId`. A NARROWER union is a
 * different type and converting it would be a widening nobody asked for:
 *
 *   - `mcp/agent-config.ts`'s `'codex' | 'claude'` names the two providers whose
 *     MCP configuration Genie writes. `kilo` and `genie` have no such file to
 *     sync, so admitting them would make the signature lie.
 *   - `agents/agent-manager-types.ts` unions `'cursor'`, which is not a Genie
 *     provider at all.
 *
 * ## What is deliberately NOT covered
 *
 * Category C — the per-provider `if` chains (`agent !== 'codex'` in
 * `session-registration.ts`, the MCP-config branches, the codex `-c` TOML
 * overrides) — is still open on #261. Those branch on behaviour that has no home
 * on `TuiDef` yet, and forbidding the literal before the fact it encodes has
 * somewhere to live would turn an open ticket into a red suite rather than into
 * a registry.
 */

const MAIN = path.resolve(__dirname, '../..');

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) sourceFiles(full, out);
        else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
}

/**
 * Comments stripped, for the same reason the renderer's guard strips them: the
 * comment saying "this used to be written out as `'claude' | 'codex' | …`" is
 * the sentence that stops the next reader putting it back, and a guard that
 * punishes the explanation trains people to delete the explanation.
 *
 * LINE-BASED, deliberately, rather than the `/\*[\s\S]*?\*\/` span the renderer's
 * guard uses. A span regex cannot tell a real block comment from a `/*` inside a
 * string literal, and one such literal earlier in a large file swallows
 * everything after it up to the next `*` + `/`. That is not hypothetical: the
 * span version of this guard read `main/ipc.ts` and reported it clean while
 * line 1785 held the union in plain code. A guard with a silent blind spot is
 * worse than no guard, because it is believed.
 */
function codeOnly(src: string): string {
    return src
        .split('\n')
        .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line.replace(/\/\/.*$/, '')))
        .join('\n');
}

/**
 * Any chain of quoted lowercase words joined by `|` — a string-literal union.
 *
 * A single pipe, so the runtime `||` shape stays with the renderer's guard.
 * Membership is decided afterwards, from the ids the chain actually contains,
 * rather than by baking the registry into the pattern — which would make the
 * regex a second copy of the very list this file exists to keep singular.
 */
const LITERAL_UNION = /'[a-z][a-z-]*'(?:\s*\|\s*'[a-z][a-z-]*')+/g;

/** The unions that name EVERY provider — i.e. hand-written `AgentTuiId`. */
export function providerUnions(src: string): string[] {
    const hits: string[] = [];
    for (const match of codeOnly(src).match(LITERAL_UNION) ?? []) {
        const named = new Set(match.match(/'([a-z][a-z-]*)'/g)?.map((q) => q.slice(1, -1)) ?? []);
        if (PROVIDER_IDS.every((id) => named.has(id))) hits.push(match);
    }
    return hits;
}

describe('main never restates the provider set as a type union', () => {
    it('POSITIVE CONTROL: the scan actually reads main sources', () => {
        // An empty file list passes "no file contains X" perfectly, which is how
        // a structural guard rots into a no-op.
        const files = sourceFiles(MAIN);
        expect(files.length).toBeGreaterThan(50);
        expect(files.map((f) => path.relative(MAIN, f).replace(/\\/g, '/'))).toContain('db.ts');
    });

    it('POSITIVE CONTROL: the pattern matches the shape it exists to catch', () => {
        // Without this, a typo in the regex reports "no offenders" forever.
        const whole = PROVIDER_IDS.map((id) => `'${id}'`).join(' | ');
        expect(providerUnions(`agent?: ${whole};`)).toHaveLength(1);
        expect(providerUnions(`type T = ${whole} | null;`)).toHaveLength(1);
        // A NARROWER union is a different type, not a copy of AgentTuiId.
        expect(providerUnions(`type T = 'codex' | 'claude';`)).toEqual([]);
        // …and neither a runtime OR, nor separate statements, nor a comment.
        expect(providerUnions(`a === 'claude' || a === 'codex'`)).toEqual([]);
        expect(providerUnions(`const a = 'claude';\nconst b = 'codex';`)).toEqual([]);
        expect(providerUnions(`// was: ${whole}`)).toEqual([]);
        // The registry's own tuple is a runtime array, not a union.
        expect(providerUnions(`export const PROVIDER_IDS = ['claude', 'codex'] as const;`)).toEqual(
            [],
        );
        // THE BLIND SPOT THAT MADE THIS LINE-BASED. A `/*` inside a string
        // literal opens a comment as far as a span regex is concerned, and
        // everything after it goes unread — which is how the first version of
        // this guard read `main/ipc.ts` and called it clean.
        expect(
            providerUnions(`const glob = "/*.ts";\ninterface T { agent: ${whole}; }`),
        ).toHaveLength(1);
    });

    it('has no file writing the provider union out by hand', () => {
        const offenders: string[] = [];
        for (const file of sourceFiles(MAIN)) {
            for (const hit of providerUnions(fs.readFileSync(file, 'utf8'))) {
                offenders.push(`${path.relative(MAIN, file).replace(/\\/g, '/')}: ${hit}`);
            }
        }
        expect(
            offenders,
            'each of these is a hand-maintained copy of `AgentTuiId`; import the type from `agents/registry` instead',
        ).toEqual([]);
    });
});
