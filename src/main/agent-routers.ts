/**
 * THE AGENT ROUTERS AND RULES.md (the owner: Genie 2 manages every workspace agent file and upgrades Genie 1's).
 *
 * AGENTS.md (codex) and CLAUDE.md (claude) are ROUTERS: they import README.md, RULES.md, the protocol
 * (`.agents/_genie/shared.md`) and the provider file. A person's own instructions live in RULES.md.
 *
 * What Genie 1 got wrong, and what this does instead:
 *  - it wrote CLAUDE.md THROUGH a git symlink to AGENTS.md (AGENTS.md ended up holding the Claude router) — a symlinked
 *    harness file is unlinked and written as a real file;
 *  - it recognised its routers by exact text, so every older router shape (and any CRLF) was migrated into RULES.md
 *    again, each time as a new `### Source 1` block — a file is a router when EVERY line is a router line of any Genie
 *    shape (headings, `@` imports, the prose router, list items naming the instruction files, Genie's markers);
 *  - it left unbalanced `GENIE MCP` markers inside migrated text — inside Genie's migration blocks they are dropped,
 *    router-only and duplicate sections are dropped, and the blocks become one. Nothing outside those blocks changes.
 * A person's text moves to RULES.md once (compared with line endings and spacing ignored), and every file rewritten
 * from a person's content is backed up first under `.agents/_genie/backups/`.
 */
export interface RouterFs {
    read(path: string): Promise<string | null>;
    write(path: string, text: string): Promise<void>;
    isSymlink(path: string): Promise<boolean>;
    unlink(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
}

const BEGIN = '<!-- BEGIN GENIE INSTRUCTION MIGRATION -->';
const END = '<!-- END GENIE INSTRUCTION MIGRATION -->';
const BLOCK = /<!-- BEGIN GENIE INSTRUCTION MIGRATION -->\n[\s\S]*?<!-- END GENIE INSTRUCTION MIGRATION -->\n?/g;
const MANAGED = /<!-- BEGIN GENIE MCP[^>]*-->[\s\S]*?<!-- END GENIE MCP[^>]*-->\n?/g;
const MARKER_LINE = /^<!-- (BEGIN|END) GENIE MCP[^>]*-->$/;

const lf = (t: string): string => t.replace(/\r\n?/g, '\n');
const squash = (t: string): string => lf(t).split('\n').map((l) => l.trim()).filter((l) => l !== '').join('\n');

/** One line of a Genie router, of any version. */
function isRouterLine(raw: string): boolean {
    const l = raw.trim();
    return (
        l === '' ||
        l === '# Agent instructions' ||
        l === 'AGENTS.md' ||
        /^@\S+$/.test(l) ||
        MARKER_LINE.test(l) ||
        l.startsWith('Before doing work, read and follow these instruction sources') ||
        /^- `?(README\.md|RULES\.md|AGENTS\.md|CLAUDE\.md|\.agents\/_genie\/\S+?)`?$/.test(l) ||
        /^## Claude Code <!--/.test(l)
    );
}

/** A person's own text in a harness file: Genie's managed blocks and router lines removed; '' when there is none. */
export function personsText(text: string): string {
    const body = lf(text).replace(MANAGED, '');
    if (body.split('\n').every(isRouterLine)) return '';
    return body.split('\n').filter((l) => !(MARKER_LINE.test(l.trim()))).join('\n').trim();
}

/**
 * Repair Genie's migration blocks: each section's text without Genie's markers; router-only and duplicate sections
 * dropped; the survivors in ONE block where the first block was. Text outside the blocks is untouched.
 */
export function repairRules(text: string): string {
    const n = lf(text);
    const blocks = n.match(BLOCK);
    if (!blocks) return text;
    const seen = new Set<string>();
    const kept: Array<{ heading: string | null; body: string }> = [];
    for (const block of blocks) {
        const inner = block.slice(block.indexOf('\n') + 1, block.lastIndexOf(END)).replace(/^## Migrated agent instructions\n/, '');
        // [text before the first heading, heading, body, heading, body, …]
        const parts = inner.split(/^### (Source \d+|From .+)$/m);
        for (let i = 0; i < parts.length; i += 2) {
            const heading = i === 0 ? null : parts[i - 1]!;
            const body = parts[i]!.split('\n').filter((l) => !MARKER_LINE.test(l.trim())).join('\n').trim();
            if (body === '' || body.split('\n').every(isRouterLine)) continue;
            const key = squash(body);
            if (seen.has(key)) continue;
            seen.add(key);
            kept.push({ heading, body });
        }
    }
    const first = n.indexOf(BEGIN);
    const without = n.replace(BLOCK, '\u0000');
    // `From <file>` headings are kept as they are; the `Source n` ones are renumbered in order — so a second repair of a
    // repaired file changes nothing.
    let source = 0;
    const merged = kept.length === 0 ? '' : migrationBlock(kept.map((k) => ({ heading: k.heading?.startsWith('From ') ? k.heading : `Source ${++source}`, body: k.body })));
    let placed = false;
    const out = without.replace(/\u0000/g, () => { if (placed || first < 0) return ''; placed = true; return merged; }).replace(/\n{3,}/g, '\n\n');
    return text.includes('\r\n') ? out.replace(/\n/g, '\r\n') : out;
}

function migrationBlock(sections: ReadonlyArray<{ heading: string; body: string }>): string {
    return `${BEGIN}\n## Migrated agent instructions\n\n${sections.map((s) => `### ${s.heading}\n\n${s.body}\n`).join('\n')}${END}\n`;
}

function routerText(harness: 'codex' | 'claude', has: { readme: boolean; operator: boolean }): string {
    return ['# Agent instructions', '', ...(has.readme ? ['@README.md'] : []), '@RULES.md', '@.agents/_genie/shared.md', `@.agents/_genie/genie-${harness}.md`, ...(has.operator ? ['@.agents/_genie/operator.md'] : []), ''].join('\n');
}

export async function writeAgentRouters(input: { workspacePath: string; fs: RouterFs; stamp: string }): Promise<void> {
    const { fs } = input;
    const at = (...parts: string[]) => [input.workspacePath, ...parts].join('/');
    const backup = async (name: string, text: string) => { await fs.write(at('.agents', '_genie', 'backups', `${name}.${input.stamp}.bak`), text); };
    const has = { readme: await fs.exists(at('README.md')), operator: await fs.exists(at('.agents', '_genie', 'operator.md')) };
    const harnesses = [{ file: 'AGENTS.md', harness: 'codex' as const }, { file: 'CLAUDE.md', harness: 'claude' as const }];

    // A person's text in either harness file (a symlinked one only mirrors its target, so it says nothing of its own).
    const persons: Array<{ file: string; text: string; original: string }> = [];
    for (const h of harnesses) {
        if (await fs.isSymlink(at(h.file))) continue;
        const original = await fs.read(at(h.file));
        if (original === null) continue;
        const text = personsText(original);
        if (text !== '') persons.push({ file: h.file, text, original });
    }

    // RULES.md: repaired, then each person's text appended once.
    const rulesBefore = await fs.read(at('RULES.md'));
    let rules = rulesBefore === null ? '# Workspace rules\n' : repairRules(rulesBefore);
    const have = squash(rules);
    const fresh = persons.filter((p, i) => !have.includes(squash(p.text)) && persons.findIndex((q) => squash(q.text) === squash(p.text)) === i);
    if (fresh.length > 0) {
        const n = lf(rules);
        const sections = fresh.map((p) => ({ heading: `From ${p.file}`, body: p.text }));
        if (n.includes(END)) {
            const added = sections.map((s) => `### ${s.heading}\n\n${s.body}\n`).join('\n');
            rules = n.replace(END, `${added}\n${END}`);
        } else {
            rules = `${n}${n.endsWith('\n') ? '' : '\n'}\n${migrationBlock(sections)}`;
        }
        // In the one form the repair produces, so the next sync finds nothing to change.
        rules = repairRules(rules);
    }
    if (rules !== rulesBefore) {
        if (rulesBefore !== null) await backup('RULES.md', rulesBefore);
        await fs.write(at('RULES.md'), rules);
    }

    // The routers: a symlinked harness file is replaced by a real one, never written through.
    for (const h of harnesses) {
        const path = at(h.file);
        const want = routerText(h.harness, has);
        if (await fs.isSymlink(path)) { await fs.unlink(path); await fs.write(path, want); continue; }
        const current = await fs.read(path);
        if (current === want) continue;
        const person = persons.find((p) => p.file === h.file);
        if (person) await backup(h.file, person.original);
        await fs.write(path, want);
    }
}
