import { CATALOG_SCHEMA_VERSION, ENVELOPE_FIELDS, KIND_SPECS, type EnvelopeField, type FieldSpec, type KindSpec } from './catalog.js';
import { PACKAGE_FORMAT, PACKAGE_FORMAT_DOC } from './plugin-integrity.js';

/**
 * THE SDK'S DOCS, GENERATED FROM THE CATALOG'S SCHEMAS (ADF B7, Tynn #457) — pure. `KIND_SPECS` and `ENVELOPE_FIELDS`
 * (core/catalog.ts) are the table the host validates every definition against; these pages are that table, written for
 * people. `npm run docs:sdk` (scripts/gen-sdk-docs.ts) writes them to docs/sdk/, and test/adf-b7-sdk-docs.test.ts fails
 * CI when the checked-in pages are not what this writes now.
 *
 * Paths are relative to docs/sdk/, with `/`. Text is LF.
 */
const HEADER = '<!-- Generated from src/core/catalog.ts by `npm run docs:sdk`. Do not edit by hand: change the schema and regenerate. -->';

/** A table cell: one line, no pipe that would end the cell. */
const SIDES = '**Side** is where an element runs: on the **host** (genie-host, which owns the work and keeps running with no window open) or on a **client** (a Genie window, which draws). A family Genie runs today has a fixed side; the others leave it to each definition\'s `reach.side`.';
const BOTH = 'An element with a part on each side (**both**) cannot say so yet: `reach.side` names one side. The catalog\'s model of an element\'s host and client parts comes with A4, the catalog over the engine protocol.';

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const yesNo = (required: boolean) => (required ? 'yes' : 'no');
const defaultOf = (f: { readonly default?: unknown }) => (f.default === undefined ? '—' : `\`${JSON.stringify(f.default)}\``);

function fieldRows(fields: readonly (FieldSpec | EnvelopeField)[]): string[] {
    return [
        '| Field | Type | Required | Default | What it is |',
        '|---|---|---|---|---|',
        ...fields.map((f) => `| \`${f.name}\` | ${cell(f.type)} | ${yesNo(f.required)} | ${defaultOf(f)} | ${cell(f.description)} |`),
    ];
}

function indexPage(specs: readonly KindSpec[]): string {
    return [
        HEADER,
        '',
        '# Genie SDK: the catalog',
        '',
        'Everything Genie is made of — a tool, a panel, an editor, a recipe, a flow node — is one **definition** in Genie\'s catalog, whoever contributes it: Genie itself, a plugin or a GApp. Each definition is the same [envelope](envelope.md) around a **payload** of its family\'s own fields.',
        '',
        'genie-host validates every definition against the schemas these pages are generated from, and registers a package\'s definitions together, or none of them.',
        '',
        `Catalog schema version: ${CATALOG_SCHEMA_VERSION}.`,
        '',
        `A package is signed over every file in it: [the package format](packages.md) (\`${PACKAGE_FORMAT}\`).`,
        '',
        '## Contribution families',
        '',
        '| Family | Status | Side | What it is |',
        '|---|---|---|---|',
        ...specs.map((k) => `| [${k.kind}](kinds/${k.kind}.md) | ${k.status} | ${k.side ?? 'per definition'} | ${cell(k.summary)} |`),
        '',
        SIDES,
        '',
        '**Active** families are run by Genie. **Reserved** families are accepted and registered, so a package that declares one loads, and nothing runs them yet; a later Genie release makes each one run.',
        '',
    ].join('\n');
}

function envelopePage(fields: readonly EnvelopeField[]): string {
    return [
        HEADER,
        '',
        '# The definition envelope',
        '',
        'Every definition, of every family and from every source, has these fields. A key not listed here is refused. Defaults are filled in when the field is left out.',
        '',
        ...fieldRows(fields),
        '',
        'The `payload` holds the family\'s own fields: see [the families](README.md#contribution-families).',
        '',
        '## Side',
        '',
        SIDES,
        '',
        BOTH,
        '',
    ].join('\n');
}

function kindPage(spec: KindSpec): string {
    return [
        HEADER,
        '',
        `# ${spec.kind}`,
        '',
        spec.status === 'reserved'
            ? 'Status: **reserved**. Accepted and registered; nothing runs it yet.'
            : 'Status: **active**.',
        '',
        spec.side === null
            ? 'Side: set by each definition\'s `reach.side` (host or client).'
            : `Side: **${spec.side}**: ${spec.side === 'host' ? 'genie-host runs it' : 'a client (a Genie window, on this machine or another) draws it'}. A definition on the other side is refused.`,
        '',
        spec.summary,
        '',
        '## Payload fields',
        '',
        ...(spec.fields.length === 0
            ? ['This family has no fixed payload fields yet: its payload is any JSON object.']
            : fieldRows(spec.fields)),
        '',
        '## Example payload',
        '',
        '```json',
        JSON.stringify(spec.example, null, 2),
        '```',
        '',
        'Every definition also carries the [envelope](../envelope.md).',
        '',
    ].join('\n');
}

/** Every page of docs/sdk/, by its path there. */
export function renderSdkDocs(specs: readonly KindSpec[] = KIND_SPECS, envelope: readonly EnvelopeField[] = ENVELOPE_FIELDS): Map<string, string> {
    const pages = new Map<string, string>();
    pages.set('README.md', indexPage(specs));
    pages.set('envelope.md', envelopePage(envelope));
    // ADF B4: the package signing format, from the code that checks it (core/plugin-integrity.ts).
    pages.set('packages.md', [HEADER.replace('src/core/catalog.ts', 'src/core/plugin-integrity.ts'), '', `# The package format: ${PACKAGE_FORMAT}`, '', ...PACKAGE_FORMAT_DOC, ''].join('\n'));
    for (const spec of specs) pages.set(`kinds/${spec.kind}.md`, kindPage(spec));
    return pages;
}
