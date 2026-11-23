import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_LEVELS, APP_LIMITS } from '../src/core/app-inbox.js';
import { builtinFlowPackage } from '../src/core/builtin-flow-nodes.js';
import { catalogFlowTools } from '../src/core/catalog-projections.js';
import { isSupportedKind, SUPPORTED_KINDS, WAIT_MAX_MS } from '../src/core/flow-canvas.js';
import { OFFICIAL_PLUGINS } from '../src/core/official-plugins.js';
import { KEEPALIVE_STRIKES } from '../src/core/plan-keepalive.js';
import { SETTINGS } from '../src/core/settings.js';
import { GENIE_SKILLS } from '../src/main/agent-skills.js';
import { PERSON_ONLY_ACTIONS, SWITCH_ANSWERS } from '../src/main/approval-queue.js';
import { importFlowDocument } from '../src/main/flow-kinds.js';
import { BUILTIN_TOOLS } from '../src/main/genie-catalog.js';

/**
 * GENIE'S GUIDE FOR AGENTS NAMES ONLY WHAT EXISTS (Tynn #1040; the owner, 2026-11-23: the guide "lets agents access the
 * genie docs so they can fully understand the environment they operate in without bloating the system prompt").
 *
 * The guide is the `genie` skill and its `genie-*` topics (main/agent-skills.ts). It is prose, so nothing stopped it from
 * drifting: before this test the `genie` skill named 14 of the 19 tools Genie serves, and no topic said a process can
 * have a schedule, an app can message an agent, or what an Autonomous agent is still asked for.
 *
 * THE GUIDE'S TWO MARKS, and what each must resolve to:
 * - `backticks`: a name from the code. A tool, a topic, a setting key, a flow step kind; or, for a tool the same topic
 *   names: one of its actions, parameters, enum values, or a word of its own description. `key: value` is checked by
 *   its key.
 * - “curly quotes”: a label the person sees: a setting's label, or a label of the Agent view.
 * Anything else is listed in PROVEN with the source file and the literal that proves it, and that literal is checked.
 * A name nobody can find fails, named with its topic.
 */

interface Declared { readonly name: string; readonly description: string; readonly inputSchema: unknown }

const official: Declared[] = OFFICIAL_PLUGINS.flatMap((p) => {
    const m = p.manifest as { id: string; mcpTools?: ReadonlyArray<{ name: string; description: string; inputSchema: unknown }> };
    return (m.mcpTools ?? []).map((t) => ({ name: `${m.id}.${t.name}`, description: t.description, inputSchema: t.inputSchema }));
});
const TOOLS: readonly Declared[] = [...BUILTIN_TOOLS, ...official];
const toolNames = new Set(TOOLS.map((t) => t.name));

/** Every parameter name and every enum value in a schema, at any depth. */
function walk(node: unknown, props: Set<string>, values: Set<string>): void {
    if (Array.isArray(node)) { for (const v of node) walk(v, props, values); return; }
    if (typeof node !== 'object' || node === null) return;
    const o = node as Record<string, unknown>;
    if (typeof o.properties === 'object' && o.properties !== null) for (const k of Object.keys(o.properties)) props.add(k);
    if (Array.isArray(o.enum)) for (const v of o.enum) if (typeof v === 'string') values.add(v);
    for (const v of Object.values(o)) walk(v, props, values);
}
const declared = new Map(TOOLS.map((t) => {
    const props = new Set<string>();
    const values = new Set<string>();
    walk(t.inputSchema, props, values);
    return [t.name, { props, values, description: t.description }] as const;
}));
function actionsOf(tool: string): string[] {
    const schema = TOOLS.find((t) => t.name === tool)!.inputSchema as { properties?: { action?: { enum?: string[] } } };
    return schema.properties?.action?.enum ?? [];
}

/** `needle` in `text` as a whole word: not inside a longer identifier. */
function wordIn(text: string, needle: string): boolean {
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
        const before = at === 0 ? '' : text[at - 1]!;
        const after = text[at + needle.length] ?? '';
        if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) return true;
    }
    return false;
}

const short = (kind: string) => kind.replace(/^@particle-academy\//, '');
const flowTools = catalogFlowTools(builtinFlowPackage().contributions);
const flowKinds = new Set([...SUPPORTED_KINDS.map(short), ...flowTools.map((t) => `@genie/${t}`)]);
const settingKeys = new Set(SETTINGS.map((s) => s.key));
const settingLabels = new Set(SETTINGS.map((s) => s.label));
const skillNames = new Set(GENIE_SKILLS.map((s) => s.name));

/**
 * NAMES THE DECLARATIONS DO NOT CARRY, each with the file and the literal that proves it. A row is a claim about the
 * code; the last test here reads every file and fails on a literal that is gone.
 */
const AGENT_VIEW = 'src/renderer/components/AgentView.tsx';
const PROVEN: Readonly<Record<string, readonly [file: string, literal: string]>> = {
    // Files and environment an agent is pointed at.
    'RULES.md': ['src/main/agent-routers.ts', 'RULES.md'],
    GENIE_TERMINAL_ID: ['src/main/config-sync-targets.ts', 'GENIE_TERMINAL_ID'],
    GENIE_INBOX_URL: ['src/main/app-inbox-service.ts', 'GENIE_INBOX_URL: input.url'],
    GENIE_INBOX_TOKEN: ['src/main/app-inbox-service.ts', 'GENIE_INBOX_TOKEN: input.token'],
    CLAUDE_CONFIG_DIR: ['src/main/session-host.ts', '!/^(CLAUDE_CONFIG_DIR|CODEX_HOME)$/i.test(key)'],
    CODEX_HOME: ['src/main/session-host.ts', '!/^(CLAUDE_CONFIG_DIR|CODEX_HOME)$/i.test(key)'],
    // The Fancy Dev Kit's MCP server, by the id its tools carry.
    'fancy-ui': ['src/core/genie-protocol.ts', 'no \\`fancy-ui\\` tools are in your list'],
    // The app inbox's door (an API for apps, not an MCP tool).
    'POST /v1/inbox': ['src/main/app-inbox-service.ts', 'POST /v1/inbox'],
    'GET /v1/agents': ['src/main/app-inbox-service.ts', 'GET  /v1/agents'],
    'Authorization: Bearer': ['src/main/app-inbox-service.ts', 'Authorization: Bearer <GENIE_INBOX_TOKEN>'],
    to: ['src/core/app-inbox.ts', '{ to?, subject, body, level?, link?, dedupeKey? }'],
    subject: ['src/core/app-inbox.ts', '{ to?, subject, body, level?, link?, dedupeKey? }'],
    body: ['src/core/app-inbox.ts', '{ to?, subject, body, level?, link?, dedupeKey? }'],
    level: ['src/core/app-inbox.ts', '{ to?, subject, body, level?, link?, dedupeKey? }'],
    link: ['src/core/app-inbox.ts', '{ to?, subject, body, level?, link?, dedupeKey? }'],
    dedupeKey: ['src/core/app-inbox.ts', '{ to?, subject, body, level?, link?, dedupeKey? }'],
    // An agent's mode, and the labels of its Agent view.
    manual: ['src/core/identity.ts', "readonly mode: 'automated' | 'manual';"],
    automated: ['src/core/identity.ts', "readonly mode: 'automated' | 'manual';"],
    Mode: [AGENT_VIEW, '<span className={labelClass}>Mode</span>'],
    Autonomous: [AGENT_VIEW, '<span className={labelClass}>Autonomous</span>'],
    'May manage workspace tabs': [AGENT_VIEW, '<span className={labelClass}>May manage workspace tabs</span>'],
    'May drive pages': [AGENT_VIEW, '<span className={labelClass}>May drive pages</span>'],
    'all tools': [AGENT_VIEW, '<option value="all">all tools</option>'],
    'ask me before shell commands': [AGENT_VIEW, '<option value="ask">ask me before shell commands</option>'],
    'edits only': [AGENT_VIEW, '<option value="edits">edits only'],
    'Script keys': ['src/renderer/components/AppInboxCard.tsx', '<span>Script keys</span>'],
    // Flows: what the `flows` tool's own description does not spell out.
    '@genie/<tool>': ['src/core/flow-canvas.ts', '`@genie/<tool>` kinds'],
    waitForReply: ['src/core/flow-canvas.ts', "key: 'waitForReply'"],
};

/** Statements with no name to mark, pinned to the line of code that makes them true. */
const FACTS: ReadonlyArray<readonly [said: RegExp, skill: string, file: string, literal: string | RegExp]> = [
    [/within 30 minutes/, 'genie-agents', 'src/main/approval-queue.ts', /30 \* 60_000/],
    [/the last 20 runs/, 'genie-flows', 'src/main/flow-store.ts', 'RUN_HISTORY_LIMIT = 20'],
    [/Loops are refused/, 'genie-flows', 'src/core/flow-canvas.ts', 'form a loop'],
    [/no webhook trigger/, 'genie-flows', 'src/core/flow-canvas.ts', 'webhook_trigger (nowhere for a request to land)'],
    [/not stopped and keep your conversation/, 'genie-agents', 'src/core/provider-login.ts', 'your agents are not stopped and keep their conversations'],
    // The launch is prism-acp's; this is where Genie pins that its own launches carry it.
    [/Remote Control is off/, 'genie-agents', 'test/claude-accounts-prepare-1011.test.ts', 'disableRemoteControl: true'],
    [/missed while Genie was closed is not caught up/, 'genie-processes', 'src/main/process-scheduler.ts', 'Missed runs are not caught up'],
    [/skipped while the previous run is still going/, 'genie-processes', 'src/main/process-scheduler.ts', 'A task whose previous run is still going is SKIPPED'],
    [/a stopped agent is started for it/, 'genie-processes', 'src/main/scheduled-nudge.ts', 'a nudge WAKES a stopped agent, as mail does'],
    [/an Origin header/, 'genie-automation', 'src/main/app-inbox-service.ts', 'Any `Origin` header is refused'],
    [/No attachments/, 'genie-automation', 'src/core/app-inbox.ts', 'apps cannot attach files'],
    [/started only if it is automated/, 'genie-automation', 'src/core/app-inbox.ts', "return mode === 'automated' && wakeAllowed ? 'push' : 'push-no-wake';"],
    [/the workspace's default agent/, 'genie-automation', 'src/core/app-inbox.ts', 'this workspace has no default agent; name one with "to"'],
    [/names yours/, 'genie-flows', 'src/main/mcp-tools-flows.ts', 'a flow an agent makes runs only in its own workspace'],
];

const skill = (name: string) => {
    const found = GENIE_SKILLS.find((s) => s.name === name);
    if (!found) throw new Error(`the guide has no \`${name}\` topic`);
    return found;
};
/** A guide's text without its fenced examples (those are checked as what they are, below). */
const prose = (s: { description: string; body: string }) => `${s.description}\n${s.body}`.replace(/```[\s\S]*?```/g, '');
const backticked = (text: string) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
const quotedLabels = (text: string) => [...text.matchAll(/“([^”\n]+)”/g)].map((m) => m[1]!);
const read = (file: string) => readFileSync(file, 'utf8');

/** Why a backticked name in a topic is real, or null. */
function resolved(span: string, text: string): string | null {
    if (toolNames.has(span)) return 'a tool';
    if (skillNames.has(span)) return 'a topic';
    if (settingKeys.has(span)) return 'a setting';
    if (flowKinds.has(span)) return 'a flow step';
    const key = /^(?:\{ )?([A-Za-z]\w*): /.exec(span)?.[1];
    for (const name of toolNames) {
        if (!text.includes(`\`${name}\``)) continue;
        const d = declared.get(name)!;
        if (d.props.has(span) || d.values.has(span)) return `${name}'s`;
        if (key !== undefined && d.props.has(key)) return `${name}'s ${key}`;
        if (wordIn(d.description, span)) return `in ${name}'s description`;
    }
    return Object.hasOwn(PROVEN, span) ? 'proven' : null;
}

describe('every name the guide marks exists', () => {
    it('a backticked name is a tool, a topic, a setting, a flow step, or belongs to a tool its topic names (control: hundreds are checked)', () => {
        const unknown: string[] = [];
        let checked = 0;
        for (const s of GENIE_SKILLS) {
            const text = prose(s);
            for (const span of backticked(text)) {
                checked += 1;
                if (resolved(span, text) === null) unknown.push(`${s.name}: \`${span}\``);
            }
        }
        expect(unknown).toEqual([]);
        expect(checked).toBeGreaterThan(200);
    });

    it('CONTROL: the resolver refuses what is not there — a Genie 1 tool, a made-up action, another tool’s action', () => {
        const processes = prose(skill('genie-processes'));
        expect(resolved('manageProcess', processes)).toBeNull();
        expect(resolved('suspend', processes)).toBeNull();
        // `runNow` is the flows tool's; the processes tool's is `run-now`.
        expect(resolved('run-now', processes)).not.toBeNull();
        expect(resolved('runNow', processes.replaceAll('`flows`', 'flows').replaceAll('`genie-flows`', 'genie-flows'))).toBeNull();
        expect(resolved('scheduleKind: agent-nudge', processes)).not.toBeNull();
        expect(resolved('scheduleMode: agent-nudge', processes)).toBeNull();
    });

    it('a label in curly quotes is a setting’s label or a label of the Agent view (control: some are checked)', () => {
        const unknown: string[] = [];
        let checked = 0;
        for (const s of GENIE_SKILLS) {
            for (const label of quotedLabels(prose(s))) {
                checked += 1;
                if (!settingLabels.has(label) && !Object.hasOwn(PROVEN, label)) unknown.push(`${s.name}: “${label}”`);
            }
        }
        expect(unknown).toEqual([]);
        expect(checked).toBeGreaterThanOrEqual(8);
    });

    it('“`tool` with action `x`” names an action that tool has', () => {
        const wrong: string[] = [];
        let checked = 0;
        for (const s of GENIE_SKILLS) {
            for (const m of prose(s).matchAll(/`([A-Za-z.]+)` with action `?([A-Za-z-]+)`?/g)) {
                checked += 1;
                if (!toolNames.has(m[1]!) || !actionsOf(m[1]!).includes(m[2]!)) wrong.push(`${s.name}: ${m[0]}`);
            }
        }
        expect(wrong).toEqual([]);
        expect(checked).toBeGreaterThanOrEqual(10);
    });
});

describe('the guide is caught up with what Genie serves', () => {
    it('the `genie` skill names every tool Genie serves, the official plugins’ too', () => {
        const body = skill('genie').body;
        expect(TOOLS.map((t) => t.name).filter((name) => !body.includes(`\`${name}\``))).toEqual([]);
        // Positive control: the list this is checked against is the catalog's, and it is not short.
        expect(BUILTIN_TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(['createAgent', 'checkIssues', 'playwright', 'workspaceTabs', 'pages', 'mail', 'plan']));
    });

    it('the `genie` skill lists every topic, and every topic is a `genie-*` skill', () => {
        const body = skill('genie').body;
        const topics = GENIE_SKILLS.map((s) => s.name).filter((n) => n !== 'genie');
        expect(topics.filter((n) => !/^genie-[a-z]+$/.test(n))).toEqual([]);
        expect(topics.filter((n) => !body.includes(`\`${n}\``))).toEqual([]);
        expect(topics).toEqual(expect.arrayContaining(['genie-agents', 'genie-flows', 'genie-automation']));
    });

    /** A topic that is a tool's own says every action that tool has: a new action without its line fails here. */
    const OWN: Readonly<Record<string, readonly string[]>> = {
        'genie-agentinbox': ['agentinbox'],
        'genie-terminals': ['manageTerminals'],
        'genie-services': ['services', 'sites'],
        'genie-processes': ['processes'],
        'genie-flows': ['flows'],
        'genie-knowledge': ['knowledge'],
    };
    it.each(Object.entries(OWN))('%s names every action of its tools', (name, tools) => {
        const body = skill(name).body;
        const missing = tools.flatMap((tool) => {
            const actions = actionsOf(tool);
            expect(actions.length, tool).toBeGreaterThan(1);
            return actions.filter((a) => !body.includes(`\`${a}\``) && !new RegExp(`action ${a}\\b`).test(body)).map((a) => `${tool} ${a}`);
        });
        expect(missing).toEqual([]);
    });

    it('the flows topic names every trigger and step Genie runs, and every tool a flow may call', () => {
        const body = skill('genie-flows').body;
        expect(SUPPORTED_KINDS.length).toBeGreaterThanOrEqual(16);
        expect(SUPPORTED_KINDS.map(short).filter((k) => !body.includes(`\`${k}\``))).toEqual([]);
        const line = body.split('\n').find((l) => l.includes('`@genie/<tool>`')) ?? '';
        const listed = backticked(line).filter((n) => n !== '@genie/<tool>');
        expect([...listed].sort()).toEqual([...flowTools].sort());
        expect(flowTools.length).toBeGreaterThanOrEqual(10);
    });
});

describe('what the guide says about automation is what the code does', () => {
    it('autonomy: the actions it never answers, and what each switch answers, are the approval queue’s own lists', () => {
        // The guide spells these out in words. If either list changes, this fails: change genie-agents and genie-automation with it.
        expect([...PERSON_ONLY_ACTIONS].sort()).toEqual(['agents.create', 'flows.stop', 'page.click', 'page.submit']);
        expect(SWITCH_ANSWERS).toEqual({ 'page.submit': 'drivePages', 'page.click': 'drivePages', 'workspace.tabs': 'manageTabs' });
        const agents = skill('genie-agents').body;
        const never = agents.split('\n').find((l) => l.includes('“Autonomous”')) ?? '';
        expect(never).toMatch(/Never: creating an agent, a page submit or a click that changes or deletes something, and stopping a flow you did not make/);
        expect(agents).toMatch(/“May manage workspace tabs”[^\n]*`workspaceTabs`/);
        expect(agents).toMatch(/“May drive pages”[^\n]*`pages`/);
        expect(skill('genie-automation').body).toMatch(/Arming a flow[^\n]*always the person/);
    });

    it('automated mode: the prompts stop after the keep-alive’s own number of strikes', () => {
        expect(skill('genie-agents').body).toContain(`after ${KEEPALIVE_STRIKES} prompts in a row that complete no step`);
    });

    it('the app inbox’s limits are APP_LIMITS, and its levels APP_LEVELS', () => {
        const body = skill('genie-automation').body;
        expect(body).toContain(`${APP_LIMITS.burst} at once, then one every ${APP_LIMITS.refillMs / 1000} seconds`);
        expect(body).toContain(`${APP_LIMITS.perDay} a day`);
        expect(body).toContain(`a subject of ${APP_LIMITS.subjectChars} characters`);
        expect(body).toContain(`a body of ${APP_LIMITS.bodyBytes / 1024} KB`);
        expect(body).toContain(`${APP_LIMITS.backlog} unread app messages`);
        expect(body).toContain(`within ${APP_LIMITS.dedupeMs / 60_000} minutes`);
        expect(APP_LIMITS.wakeWindowMs).toBe(60 * 60_000);
        expect(body).toContain(`at most ${APP_LIMITS.wakeTurns} turns an hour`);
        expect(body).toContain(`(${APP_LEVELS.join(', ')})`);
    });

    it('a Wait is at most what the runner honours', () => {
        expect(skill('genie-flows').body).toContain(`\`wait\` (at most ${WAIT_MAX_MS / 3_600_000} hours)`);
    });

    it('each stated fact is still a line of the code (control: the guide does state it)', () => {
        const gone: string[] = [];
        for (const [said, name, file, literal] of FACTS) {
            expect(skill(name).body, `${name} no longer says ${String(said)}: drop its row here`).toMatch(said);
            const source = read(file);
            if (typeof literal === 'string' ? !source.includes(literal) : !literal.test(source)) gone.push(`${name} says ${String(said)}, but ${file} no longer has ${String(literal)}`);
        }
        expect(gone).toEqual([]);
    });

    it('the worked flow in the automation topic is one Genie’s store accepts, step by step', () => {
        const fenced = [...skill('genie-automation').body.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!);
        expect(fenced).toHaveLength(1);
        const document = JSON.parse(fenced[0]!) as { graph: { nodes: Array<{ id: string; kind: string }>; edges: Array<{ source: string }> } };
        const result = importFlowDocument(document);
        expect(result.ok ? [] : result.problems).toEqual([]);
        // The store leaves a kind nobody registered to the engine: each kind is checked here by name as well.
        expect(document.graph.nodes.filter((n) => !isSupportedKind(n.kind)).map((n) => n.kind)).toEqual([]);
        // It is the fan-out it is offered as: one step feeds more than one agent prompt.
        const prompts = document.graph.nodes.filter((n) => n.kind === 'genie/agent_prompt').length;
        expect(prompts).toBeGreaterThanOrEqual(2);
        const feeds = new Map<string, number>();
        for (const e of document.graph.edges) feeds.set(e.source, (feeds.get(e.source) ?? 0) + 1);
        expect(Math.max(...feeds.values())).toBeGreaterThanOrEqual(2);
        // CONTROL: the same door refuses a step Genie cannot run.
        const broken = { ...document, graph: { ...document.graph, nodes: [...document.graph.nodes, { id: 'hook', kind: 'webhook_out', position: { x: 0, y: 0 }, config: { url: 'https://example.invalid' } }] } };
        expect(importFlowDocument(broken).ok).toBe(false);
    });
});

describe('how the guide is written', () => {
    const lines = GENIE_SKILLS.flatMap((s) => `${s.description}\n${s.body}`.split('\n').map((line) => ({ skill: s.name, line })));

    it('never sends an agent to the person’s desktop, and names no one workspace’s rules or machines (control: RULES.md is named, generically)', () => {
        expect(lines.filter((l) => /desktop|omarchy|azure|\bVMs?\b/i.test(l.line)).map((l) => `${l.skill}: ${l.line}`)).toEqual([]);
        expect(lines.filter((l) => l.line.includes('`RULES.md`')).length).toBeGreaterThan(0);
    });

    it('every row of PROVEN is used by the guide, and its literal is in its file', () => {
        const all = GENIE_SKILLS.map(prose).join('\n');
        const used = new Set([...backticked(all), ...quotedLabels(all)]);
        expect(Object.keys(PROVEN).filter((name) => !used.has(name))).toEqual([]);
        expect(Object.entries(PROVEN).filter(([, [file, literal]]) => !read(file).includes(literal)).map(([name, [file]]) => `${name}: not in ${file}`)).toEqual([]);
    });

    it('a description is one line a skill list can show, with no colon-space that would break its front matter’s reading', () => {
        // The older descriptions carry one; a new topic's does not.
        for (const name of ['genie-agents', 'genie-flows', 'genie-automation']) {
            const d = skill(name).description;
            expect(d, name).not.toMatch(/: |\n/);
            expect(d.length, name).toBeLessThan(220);
        }
    });
});
