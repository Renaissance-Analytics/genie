import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { commandGroups, type ProviderCommand, type ProviderExtensions } from '../src/core/provider-commands.js';
import { SkillsAndCommands } from '../src/renderer/components/AgentSkills.js';

/**
 * AN AGENT'S SETTINGS → SKILLS, READABLE (Tynn #628, issue #696; the owner, beta.61: "the agent skills UX is still
 * garbage"). The list was two columns of rows in which the description never shrank and the name was the only part that
 * could: a long description squeezed its name to "/…" or to nothing and ran into the next column. A row showed the word
 * "skill" or "command" in place of the description, and skills, plugin skills and commands were one list.
 */
const LONG = 'Use when building or scaffolding a whole application with Fancy UI — not dropping in one component, but choosing the stack and structuring the app. ENDS-HERE';
const cmd = (name: string, source: ProviderCommand['source'], description = `What ${name} does.`): ProviderCommand => ({ name, description, source });
const EXT: ProviderExtensions = {
    commands: [
        cmd('release-notes', 'command'),
        cmd('fancy-ui:building-apps', 'skill', LONG),
        cmd('genie-agentinbox', 'skill'),
        cmd('housekeeping', 'skill'),
        cmd('genie-own:genie', 'skill'),
        cmd('fancy-ui:components', 'skill'),
        cmd('mcp__tynn__next-work', 'command'),
        cmd('code-review:review', 'command'),
        cmd('compact', 'command'),
        cmd('mystery', null),
    ],
    plugins: [{ name: 'fancy-ui', source: null, version: '1.2.0' }, { name: 'code-review', source: null, version: null }],
    subagents: ['Explore', 'Plan'],
};
const shape = (query?: string) => commandGroups(EXT, { provider: 'claude', ...(query === undefined ? {} : { query }) }).map((g) => `${g.label} [${g.kind}]: ${g.items.map((i) => i.name).join(', ')}`);
const draw = (more: Partial<Parameters<typeof SkillsAndCommands>[0]> = {}) => renderToStaticMarkup(<SkillsAndCommands extensions={EXT} provider="claude" {...more} />).replace(/&#x27;/g, '\'');
const row = (html: string, name: string) => { const at = html.indexOf(`data-command="${name}"`); return html.slice(at, html.indexOf('</li>', at)); };

describe('grouped by where each comes from', () => {
    it('Genie’s own, skills, each plugin by name, the provider’s commands, a connector’s, the rest', () => {
        expect(shape()).toEqual([
            'Genie [genie]: genie-agentinbox, genie-own:genie',
            'Skills in this workspace or your account [skills]: housekeeping',
            'Plugin: code-review [plugin]: code-review:review',
            'Plugin: fancy-ui 1.2.0 [plugin]: fancy-ui:building-apps, fancy-ui:components',
            'Claude Code’s commands [commands]: compact, release-notes',
            'Connector: tynn [connector]: mcp__tynn__next-work',
            'Not said by the provider [other]: mystery',
        ]);
    });

    it('nothing is lost or listed twice', () => {
        const names = commandGroups(EXT, { provider: 'claude' }).flatMap((g) => g.items.map((i) => i.name));
        expect([...names].sort()).toEqual(EXT.commands.map((c) => c.name).sort());
    });

    it('another provider’s commands carry its name', () => {
        expect(commandGroups({ commands: [cmd('review', 'command')], plugins: null, subagents: null }, { provider: 'codex' }).map((g) => g.label)).toEqual(['Codex’s commands']);
    });

    it('search reads names and descriptions, any case; a group with no match is gone', () => {
        expect(shape('FANCY')).toEqual(['Plugin: fancy-ui 1.2.0 [plugin]: fancy-ui:building-apps, fancy-ui:components']);
        expect(shape('scaffolding')).toEqual(['Plugin: fancy-ui 1.2.0 [plugin]: fancy-ui:building-apps']);
        expect(shape('no such thing')).toEqual([]);
    });
});

describe('the page', () => {
    it('one row per item, each with its FULL name', () => {
        const html = draw();
        expect(html).toContain('data-rail-commands="10"');
        for (const c of EXT.commands) expect(row(html, c.name)).toContain(`>/${c.name}<`);
    });

    it('the name is never cut; the description is one line, cut inside its own cell, whole on hover', () => {
        const r = row(draw(), 'fancy-ui:building-apps');
        const name = r.match(/<span[^>]*data-command-name=""[^>]*>/)?.[0] ?? '';
        const about = r.match(/<[a-z]+[^>]*data-command-about=""[^>]*>/)?.[0] ?? '';
        expect(name).not.toBe('');
        expect(name).not.toMatch(/truncate/);
        expect(name).toMatch(/shrink-0/);
        expect(about).toMatch(/truncate/);
        expect(about).toMatch(/min-w-0/);
        expect(about).toContain(`title="${LONG}"`);
    });

    it('opened, the whole description wraps under no cut', () => {
        const r = row(draw({ initiallyOpen: ['fancy-ui:building-apps'] }), 'fancy-ui:building-apps');
        const about = r.match(/<[a-z]+[^>]*data-command-about=""[^>]*>/)?.[0] ?? '';
        expect(about).not.toMatch(/truncate/);
        expect(about).toMatch(/whitespace-normal/);
        expect(r).toContain('ENDS-HERE');
    });

    it('one column: no second column for a description to run into', () => {
        const html = draw();
        expect(html).not.toMatch(/grid-cols-2/);
    });

    it('a row shows its description AND what it is; the kind no longer replaces the description', () => {
        const r = row(draw(), 'housekeeping');
        expect(r).toContain('What housekeeping does.');
        expect(r).toMatch(/data-command-kind="skill"/);
        expect(row(draw(), 'compact')).toMatch(/data-command-kind="command"/);
    });

    it('each group has its name and its count; the heading has the total', () => {
        const html = draw();
        expect(html).toMatch(/data-command-group="plugin:fancy-ui"[^>]*data-command-group-count="2"/);
        expect(html).toMatch(/data-command-group="genie"[^>]*data-command-group-count="2"/);
        expect(html).toContain('Plugin: fancy-ui 1.2.0');
        expect(html).toMatch(/data-commands-total="10"/);
    });

    it('a search box; searched, the count says how many of how many', () => {
        expect(draw()).toMatch(/<input[^>]*data-field="command-search"/);
        const html = draw({ initialQuery: 'fancy' });
        expect(html.match(/data-command="/g) ?? []).toHaveLength(2);
        expect(html).toContain('2 of 10');
        expect(draw({ initialQuery: 'no such thing' })).toContain('Nothing matches “no such thing”.');
    });

    it('CONTROL: an agent whose CLI offers none says so', () => {
        expect(renderToStaticMarkup(<SkillsAndCommands extensions={{ commands: [], plugins: null, subagents: null }} provider="claude" />)).toContain('Its CLI offers none.');
    });

    it('the agent’s view draws this page, and no list of its own', () => {
        const view = readFileSync('src/renderer/components/AgentView.tsx', 'utf8');
        expect(view).toMatch(/<SkillsAndCommands extensions=\{session\.extensions\} provider=\{agent\.provider\} \/>/);
        expect(view).not.toMatch(/data-rail-commands=/);
    });
});
