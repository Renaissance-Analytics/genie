import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ELEMENT_KINDS, ENVELOPE_FIELDS, KIND_SPECS, RESERVED_KINDS, validateDefinition, type KindSpec } from '../src/core/catalog.js';
import { renderSdkDocs } from '../src/core/sdk-docs.js';

/**
 * ADF B7 (Tynn #457; spec .ai/plans/specs/adf-sdk.md, story B7): THE SDK'S DOCS ARE GENERATED FROM THE CATALOG'S OWN
 * SCHEMAS. One table in src/core/catalog.ts (`KIND_SPECS`, `ENVELOPE_FIELDS`) says every contribution family, its
 * fields, which are required and what is filled by default, and whether the family is reserved. The validator reads it,
 * and `npm run docs:sdk` writes docs/sdk/ from it. This test is the drift check: the checked-in docs must be exactly
 * what the generator writes now, so a schema changed without regenerating fails CI.
 */
const DOCS = join(__dirname, '..', 'docs', 'sdk');

/** docs/sdk as checked out, by path relative to it (posix), line endings as written (a Windows checkout adds CR). */
function onDisk(): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) walk(path);
            else out.set(relative(DOCS, path).split(sep).join('/'), readFileSync(path, 'utf8').replace(/\r\n/g, '\n'));
        }
    };
    walk(DOCS);
    return out;
}

const envelope = (spec: KindSpec) => ({
    id: `com.example.docs.${spec.kind.replace(/-/g, '_')}`, kind: spec.kind, version: '1.0.0', packageId: 'com.example.docs', source: 'plugin',
    docs: { name: spec.kind, description: `An example ${spec.kind}.` },
    reach: {
        scopes: ['workspace'], side: (spec.kind === 'panel' ? 'client' : spec.kind === 'editor' ? 'both' : 'host') as string, requiresWindow: false, remote: 'local',
        ...(spec.kind === 'editor' ? { link: { calls: ['files.readBytes', 'files.writeBytes'], events: [] } } : {}),
    } as Record<string, unknown>,
    permissions: { capabilities: [] },
    payload: structuredClone(spec.example),
});

describe('docs/sdk is generated from the catalog schemas, and CI sees drift', () => {
    it('the checked-in docs are exactly what the generator writes now (after a schema change: npm run docs:sdk)', () => {
        const want = renderSdkDocs();
        const have = onDisk();
        expect([...have.keys()].sort()).toEqual([...want.keys()].sort());
        for (const [path, text] of want) expect(have.get(path), `docs/sdk/${path} is stale: run npm run docs:sdk`).toBe(text);
    });

    it('CONTROL: a schema changed without regenerating is drift: the generated page differs, naming the new field', () => {
        const now = renderSdkDocs();
        const changed = KIND_SPECS.map((k) => (k.kind === 'editor'
            ? { ...k, fields: [...k.fields, { name: 'presentMode', type: 'boolean', required: false, default: false, description: 'A field added to the schema.', rule: 'boolean' as const }] }
            : k));
        const drifted = renderSdkDocs(changed);
        expect(drifted.get('kinds/editor.md')).not.toBe(now.get('kinds/editor.md'));
        expect(drifted.get('kinds/editor.md')).toContain('presentMode');
        // Only the changed family's page (and nothing else) moves.
        for (const [path, text] of now) if (path !== 'kinds/editor.md') expect(drifted.get(path), path).toBe(text);
    });
});

describe('what the docs say', () => {
    it('every contribution family has a page; the index lists each, saying which are reserved', () => {
        const docs = renderSdkDocs();
        const kinds = [...ELEMENT_KINDS, ...RESERVED_KINDS];
        expect(KIND_SPECS.map((k) => k.kind).sort()).toEqual([...kinds].sort());
        const index = docs.get('README.md')!;
        for (const kind of kinds) {
            expect(docs.has(`kinds/${kind}.md`), kind).toBe(true);
            expect(index).toContain(`[${kind}](kinds/${kind}.md)`);
        }
        for (const kind of RESERVED_KINDS) {
            expect(KIND_SPECS.find((k) => k.kind === kind)?.status).toBe('reserved');
            expect(index).toMatch(new RegExp(`\\[${kind}\\]\\(kinds/${kind}\\.md\\) \\| reserved`));
            expect(docs.get(`kinds/${kind}.md`)).toMatch(/reserved/i);
        }
        for (const kind of ELEMENT_KINDS) expect(index).toMatch(new RegExp(`\\[${kind}\\]\\(kinds/${kind}\\.md\\) \\| active`));
    });

    it('each family\'s page lists every field, whether it is required, and its default', () => {
        const docs = renderSdkDocs();
        for (const spec of KIND_SPECS) {
            const page = docs.get(`kinds/${spec.kind}.md`)!;
            for (const f of spec.fields) {
                const row = page.split('\n').find((l) => l.startsWith(`| \`${f.name}\` |`));
                expect(row, `${spec.kind}.${f.name}`).toBeDefined();
                expect(row).toContain(f.required ? '| yes |' : '| no |');
                if (f.default !== undefined) expect(row).toContain(`\`${JSON.stringify(f.default)}\``);
            }
            expect(page).toContain(JSON.stringify(spec.example, null, 2));
        }
    });

    it('the envelope page lists every field of the envelope, with the defaults the validator fills', () => {
        const page = renderSdkDocs().get('envelope.md')!;
        for (const f of ENVELOPE_FIELDS) expect(page, f.name).toContain(`| \`${f.name}\` |`);
        // No Genie 1 aliases (the owner's ruling q_d71981d6): the field is gone.
        expect(ENVELOPE_FIELDS.find((f) => f.name === 'aliases')).toBeUndefined();
        expect(ENVELOPE_FIELDS.find((f) => f.name === 'permissions.network')?.default).toEqual([]);
    });
});

describe('each element\'s side: the host, a client, or both (the owner\'s ruling q_d71981d6)', () => {
    // The ADF models the client/host relationship: every element declares where it runs, and an element on both sides
    // declares how its halves talk (`reach.link`). A family Genie runs today allows only the sides it can run on.
    const ALLOWED: Record<string, readonly string[]> = { tool: ['host'], panel: ['client', 'both'], editor: ['both'], 'host-service': ['host', 'both'] };
    const onSide = (spec: KindSpec, side: string) => {
        const def = envelope(spec);
        def.reach = { ...def.reach, side };
        if (side === 'both') def.reach.link = { calls: ['files.readBytes'], events: [] };
        else delete def.reach.link;
        return def;
    };

    it('the index shows every family\'s sides', () => {
        const index = renderSdkDocs().get('README.md')!;
        expect(index).toContain('| Family | Status | Side | What it is |');
        for (const spec of KIND_SPECS) {
            const side = ALLOWED[spec.kind]?.join(' or ') ?? 'per definition';
            expect(index, spec.kind).toContain(`| [${spec.kind}](kinds/${spec.kind}.md) | ${spec.status} | ${side} |`);
        }
    });

    it('each family\'s page says its sides; the envelope page says how an element on both sides talks (reach.link)', () => {
        const docs = renderSdkDocs();
        for (const spec of KIND_SPECS) {
            const page = docs.get(`kinds/${spec.kind}.md`)!;
            const sides = ALLOWED[spec.kind];
            if (sides) expect(page, spec.kind).toContain(`Side: ${sides.map((s) => `**${s}**`).join(' or ')}`);
            else expect(page, spec.kind).toContain('Side: set by each definition\'s `reach.side`');
        }
        const envelope = docs.get('envelope.md')!;
        expect(envelope).toMatch(/both[\s\S]*reach\.link/);
        expect(envelope).toContain('| `reach.link` |');
    });

    it('a definition of a fixed family on a side it does not allow is refused, naming the sides it may be', () => {
        for (const [kind, sides] of Object.entries(ALLOWED)) {
            const spec = KIND_SPECS.find((k) => k.kind === kind)!;
            for (const side of sides) expect(validateDefinition(onSide(spec, side)).ok, `${kind} on ${side}`).toBe(true);
            for (const side of ['host', 'client', 'both'].filter((s) => !sides.includes(s))) {
                const r = validateDefinition(onSide(spec, side));
                expect(r.ok, `${kind} on ${side}`).toBe(false);
                if (!r.ok) expect(r.problems.join('\n')).toContain(`reach.side must be ${sides.map((s) => `"${s}"`).join(' or ')}`);
            }
        }
    });

    it('CONTROL: a family that leaves the side to its definitions accepts any', () => {
        const spec = KIND_SPECS.find((k) => k.kind === 'recipe')!;
        for (const side of ['host', 'client', 'both']) expect(validateDefinition(onSide(spec, side)).ok, side).toBe(true);
    });
});

describe('the docs and the validator read the same schema', () => {
    it('each family\'s documented example validates', () => {
        for (const spec of KIND_SPECS) {
            const r = validateDefinition(envelope(spec));
            expect(r.ok, `${spec.kind}: ${r.ok ? '' : r.problems.join('; ')}`).toBe(true);
        }
    });

    it('each REQUIRED field, taken out of its example, is refused naming that field', () => {
        let required = 0;
        for (const spec of KIND_SPECS) {
            for (const f of spec.fields.filter((x) => x.required)) {
                required++;
                const def = envelope(spec);
                delete (def.payload as Record<string, unknown>)[f.name];
                const r = validateDefinition(def);
                expect(r.ok, `${spec.kind}.${f.name}`).toBe(false);
                if (!r.ok) expect(r.problems.join('\n')).toContain(`payload.${f.name}`);
            }
        }
        // CONTROL: the loop ran over real required fields.
        expect(required).toBeGreaterThanOrEqual(5);
    });

    it('each documented default is the one filled in: a definition without network gets []', () => {
        const spec = KIND_SPECS.find((k) => k.kind === 'tool')!;
        const r = validateDefinition(envelope(spec));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.definition).toMatchObject({ permissions: { network: [] } });
    });

    it('an envelope key the docs do not name is refused, and every key they name is accepted', () => {
        const spec = KIND_SPECS.find((k) => k.kind === 'tool')!;
        const extra = { ...envelope(spec), owner: 'me' };
        const r = validateDefinition(extra);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.problems.join('\n')).toContain('unknown key "owner"');
        const full = { ...envelope(spec), docs: { name: 'x', description: 'y', guide: 'z' }, permissions: { capabilities: [], network: [] } };
        const named = new Set(ENVELOPE_FIELDS.map((f) => f.name));
        for (const key of Object.keys(full)) expect(named.has(key), key).toBe(true);
        expect(validateDefinition(full).ok).toBe(true);
    });
});
