import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { extensionsFrom, toPromptCmds, type ProviderExtensions } from '../src/core/provider-commands.js';
import type { LiveSession } from '../src/core/roster.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { toStreamEvent } from '../src/core/stream-event.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { AgentView, type AgentOpsProps } from '../src/renderer/components/AgentView.js';

/**
 * THE AGENT'S OWN SKILLS AND COMMANDS (the owner, 2026-10-14): "All agents that have the ability to provide their own
 * plugins and skills via their provider cli need to surface those through the genie chat and agent settings (read
 * only)." They arrived as `available_commands_update` and were thrown away; the composer's `/` menu was never fed.
 *
 * The update below is prism-acp 0.13's shape for Claude's `system/init` (its own test maps the real captured frame).
 */
const UPDATE = {
    sessionUpdate: 'available_commands_update',
    availableCommands: [
        { name: 'help', description: 'Command', _meta: { 'particle.academy/command_source': 'command' } },
        { name: 'genie-handoff', description: 'Skill', _meta: { 'particle.academy/command_source': 'skill' } },
        { name: 'plugin-dev:skill-development', description: 'Skill', _meta: { 'particle.academy/command_source': 'skill' } },
    ],
    _meta: {
        'particle.academy/plugins': [{ name: 'code-simplifier', source: 'code-simplifier@example.org', version: '1.0.0' }, { name: 'plugin-dev' }],
        'particle.academy/subagents': ['Explore', 'Plan'],
    },
};

describe('reading the update', () => {
    it('every command and skill, its source, the plugins and the subagents', () => {
        const ext = extensionsFrom(UPDATE)!;
        expect(ext.commands).toEqual([
            { name: 'help', description: 'Command', source: 'command' },
            { name: 'genie-handoff', description: 'Skill', source: 'skill' },
            { name: 'plugin-dev:skill-development', description: 'Skill', source: 'skill' },
        ]);
        expect(ext.plugins).toEqual([
            { name: 'code-simplifier', source: 'code-simplifier@example.org', version: '1.0.0' },
            { name: 'plugin-dev', source: null, version: null },
        ]);
        expect(ext.subagents).toEqual(['Explore', 'Plan']);
    });

    it('a provider’s own update with no _meta: commands, sources unknown, plugins and subagents NOT reported (null, not [])', () => {
        const ext = extensionsFrom({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: '/review', description: 'Review the diff' }] })!;
        expect(ext).toEqual({ commands: [{ name: 'review', description: 'Review the diff', source: null }], plugins: null, subagents: null });
    });

    it('any other update is not one (and stays out of the ledger)', () => {
        expect(extensionsFrom({ sessionUpdate: 'notice', notice: { level: 'info', message: 'x' } })).toBeNull();
        expect(toStreamEvent(UPDATE)).toBeNull();
    });

    it('the composer menu: names with the slash, the description as the hint', () => {
        expect(toPromptCmds(extensionsFrom(UPDATE)!.commands)).toEqual([
            { name: '/help', hint: 'Command' },
            { name: '/genie-handoff', hint: 'Skill' },
            { name: '/plugin-dev:skill-development', hint: 'Skill' },
        ]);
        expect(toPromptCmds(null)).toEqual([]);
    });
});

describe('on the running session', () => {
    let dir: string;
    let host: SessionHost;
    let events: DriverEvents = {};
    const driverFor: DriverFor = () => {
        const factory: SessionDriverFactory = (options) => {
            events = options.events;
            return { start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } };
        };
        return factory;
    };
    const noTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-commands-'));
        host = new SessionHost({ userData: dir, driverFor, clock: () => 1_760_000_000_000, processTree: noTree });
    });
    afterEach(async () => { host.stopAll(); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

    it('null until reported; then the latest report REPLACES the last, and the board is told', () => {
        const r = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        host.start(r, dir);
        let told = 0;
        host.subscribe(() => { told += 1; });
        expect(host.probe(r.id)?.extensions).toBeNull();

        events.onUpdate?.(UPDATE);
        expect(host.probe(r.id)?.extensions?.commands).toHaveLength(3);
        expect(told).toBeGreaterThan(0);

        events.onUpdate?.({ sessionUpdate: 'available_commands_update', availableCommands: [] });
        expect(host.probe(r.id)?.extensions?.commands).toEqual([]);
    });
});

describe('agent settings show them, read-only', () => {
    const ops: AgentOpsProps = {
        deletePreview: null, diagnosis: null, lastOutcome: null, budgetUsd: null, mode: 'manual', accessScope: 'self', model: null,
        onRestart: () => {}, onSwitchDriver: () => {}, onDiagnose: () => {}, onPreviewDelete: () => {}, onConfirmDelete: () => {}, onCancelDelete: () => {}, onSetBudget: () => {},
        onSetMode: () => {}, onSetAccessScope: () => {}, onSetModel: () => {},
    };
    const session = (extensions: ProviderExtensions | null): LiveSession => ({
        running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null,
        lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, model: null, extensions,
    });
    const render = (s: LiveSession) => renderToStaticMarkup(
        <AgentView agent={{ id: 'agent_a', name: 'atlas', provider: 'claude', fidelity: 'declared', cwd: '/w/tynn' }} session={s} rows={[]} tab="settings" settingsSection="skills" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 1} ops={ops} />,
    );

    it('each command and skill by name, the plugins and the subagents — and no control to change them', () => {
        const html = render(session(extensionsFrom(UPDATE)));
        const section = html.slice(html.indexOf('data-rail="extensions"'));
        expect(section).toContain('data-rail-commands="3"');
        expect(section.match(/data-command="/g) ?? []).toHaveLength(3);
        expect(section).toContain('/genie-handoff');
        expect(section).toContain('Plugins: code-simplifier 1.0.0, plugin-dev');
        expect(section).toContain('Subagents: Explore, Plan');
        const own = section.slice(0, section.indexOf('</section>'));
        expect(own.match(/<(button|input|select)\b/g) ?? []).toHaveLength(0);
    });

    it('reported none: says so; never reported: no section (positive control pair)', () => {
        expect(render(session({ commands: [], plugins: null, subagents: null }))).toContain('Its CLI offers none.');
        expect(render(session(null))).not.toContain('data-rail="extensions"');
    });
});

describe('the chat offers them', () => {
    const strip = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    it('the composer is given the menu, and both chats pass the session’s commands', () => {
        expect(strip('../src/renderer/components/ChatFlyout.tsx').match(/commands=\{toPromptCmds\(commands\)\}/g) ?? []).toHaveLength(1);
        expect(strip('../src/renderer/Shell.tsx').match(/commands=\{chatSession\?\.extensions\?\.commands \?\? null\}/g) ?? []).toHaveLength(1);
        expect(strip('../src/renderer/DoctorApp.tsx').match(/commands=\{detail\.session\?\.extensions\?\.commands \?\? null\}/g) ?? []).toHaveLength(1);
    });
});
