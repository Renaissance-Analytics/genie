import { describe, expect, it } from 'vitest';
import { validateAppManifest, appToolName, RESERVED_APP_NAMES } from '../manifest';

/**
 * The GApp manifest — what a Genie App is, and what it may ask for (Tynn #250).
 *
 * A GApp is a whole agentic application: its own workspace, its own hosting, its
 * own front end in its own window, reaching Genie's tools under a consented
 * scope. That makes this file a SECURITY boundary before it is a schema, so it is
 * strict and loud: a bad manifest is rejected at install with itemised reasons,
 * never half-loaded.
 *
 * Shape is grounded in the two real target apps rather than a simplified idea of
 * one. AI Trader ORR Jdun is a `python-fastapi` backend PLUS an
 * `electron-react-ts` front end served static at `orr.gen`; The Ripple Effect is a
 * live artboard at `ripple.gen` pointed at an already-running dev server via
 * `hostPort`. So a GApp is MULTI-COMPONENT and MULTI-STACK, and the manifest
 * declares into the envelope's existing `project.json` sites/services shape
 * instead of inventing a parallel one.
 */

const valid = () => ({
    id: 'com.example.trader',
    slug: 'trader',
    name: 'Example Trader',
    version: '1.0.0',
    frontend: { repo: 'desktop', serve: { mode: 'static', root: 'dist' } },
    permissions: { scope: 'self' },
});

describe('a well-formed GApp', () => {
    it('parses, and keeps what it declared', () => {
        const result = validateAppManifest(valid());

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.slug).toBe('trader');
        expect(result.value.permissions.scope).toBe('self');
    });

    it('accepts a BACKEND SERVICE beside the front end, in another language', () => {
        // ORR's backend is python-fastapi. An SDK that assumed Node would not be
        // able to describe the app it exists to serve.
        const result = validateAppManifest({
            ...valid(),
            services: [
                { name: 'api', repo: 'backend', command: ['uvicorn', 'app:api'], port: 8000 },
            ],
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.services?.[0]?.command).toEqual(['uvicorn', 'app:api']);
    });

    it('accepts a front end that is an ALREADY-RUNNING dev server', () => {
        // The Ripple Effect's artboard is `runMode: host` + `hostPort: 5273`, not a
        // built directory. Both shapes are in live use, so both are describable.
        const result = validateAppManifest({
            ...valid(),
            frontend: { repo: 'app', serve: { mode: 'proxy', hostPort: 5273 } },
        });

        expect(result.ok).toBe(true);
    });
});

describe('rejections that protect the user', () => {
    it('REFUSES a GApp that impersonates Genie', () => {
        // The hard anti-impersonation gate. A GApp that can call itself Genie can
        // trade on Genie's authority to ask for things it was never granted.
        for (const name of RESERVED_APP_NAMES) {
            const result = validateAppManifest({ ...valid(), name });
            expect(result.ok, `"${name}" must be refused`).toBe(false);
            if (result.ok) continue;
            expect(result.errors.join(' ')).toMatch(/reserved|impersonat/i);
        }
    });

    it('refuses a reserved name whatever its casing or spacing', () => {
        // "  GENIE  " is the same claim as "Genie"; a check that only caught the
        // exact string would be trivially defeated.
        const result = validateAppManifest({ ...valid(), name: '  GENIE  ' });
        expect(result.ok).toBe(false);
    });

    it('refuses an unknown permission scope rather than guessing', () => {
        const result = validateAppManifest({
            ...valid(),
            permissions: { scope: 'everything' },
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.join(' ')).toContain('scope');
    });

    it('refuses `workspaces` scope with no workspaces named', () => {
        // An empty allow-list must not read as "all". Fail closed, loudly.
        const result = validateAppManifest({
            ...valid(),
            permissions: { scope: 'workspaces', workspaces: [] },
        });

        expect(result.ok).toBe(false);
    });

    it('defaults to the NARROWEST scope when none is declared', () => {
        const result = validateAppManifest({ ...valid(), permissions: undefined });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Absent must never mean "workstation". A GApp gets the least authority
        // that lets it exist until its manifest asks for more and the user agrees.
        expect(result.value.permissions.scope).toBe('self');
    });

    it('refuses a slug that is not a DNS label — it becomes <slug>.gen', () => {
        // The slug is hosted, so an invalid label would produce a site that cannot
        // be served or, worse, one that collides with another name.
        for (const slug of ['Trader', 'my_app', 'a'.repeat(64), '-lead', '']) {
            expect(validateAppManifest({ ...valid(), slug }).ok, slug).toBe(false);
        }
    });

    it('itemises EVERY problem, rather than stopping at the first', () => {
        // An install that fails one reason at a time wastes the developer's day.
        const result = validateAppManifest({ id: '', slug: '', name: '', version: 'x' });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.length).toBeGreaterThan(2);
    });

    it('rejects a non-object outright', () => {
        for (const raw of [null, undefined, 42, 'a string', []]) {
            expect(validateAppManifest(raw).ok).toBe(false);
        }
    });
});

describe('declaring what the app needs to run', () => {
    it('carries requirements through, with the reason the user will be shown', () => {
        const result = validateAppManifest({
            ...valid(),
            requires: [
                { tool: 'python', version: '3.13.15' },
                { tool: 'docker', reason: 'runs the strategy sandbox' },
            ],
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.requires).toEqual([
            { tool: 'python', version: '3.13.15' },
            { tool: 'docker', reason: 'runs the strategy sandbox' },
        ]);
    });

    it('refuses a requirement that names no tool', () => {
        const result = validateAppManifest({ ...valid(), requires: [{ version: '3.13' }] });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.join(' ')).toContain('requires[0].tool');
    });

    it('leaves requires ABSENT for an app that needs nothing', () => {
        const result = validateAppManifest(valid());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Absent rather than an empty array: an installer that showed an empty
        // "you must install" section would be asking for nothing, loudly.
        expect(result.value.requires).toBeUndefined();
    });
});

describe('the permissions a GApp asks the user for', () => {
    it('carries the declared capabilities through', () => {
        const result = validateAppManifest({
            ...valid(),
            permissions: { scope: 'self', capabilities: ['hosting', 'knowledge'] },
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.permissions.capabilities).toEqual(['hosting', 'knowledge']);
    });

    it('declares NOTHING when the manifest asks for nothing', () => {
        const result = validateAppManifest(valid());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // An app that asked for no capability reaches no tool. Silence is not a
        // shorthand for "the usual set".
        expect(result.value.permissions.capabilities).toEqual([]);
    });

    it('refuses a capability that does not exist', () => {
        // Typos and invented names must fail at install rather than resolve to
        // something adjacent — or, worse, be ignored and read as harmless.
        const result = validateAppManifest({
            ...valid(),
            permissions: { scope: 'self', capabilities: ['hosting', 'root'] },
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.join(' ')).toContain('root');
    });

    it('refuses a tool NAME where a capability belongs', () => {
        // `manageTerminals` is a tool, not a capability. Accepting it would put a
        // second, unclassified vocabulary into the permission model.
        const result = validateAppManifest({
            ...valid(),
            permissions: { scope: 'self', capabilities: ['manageTerminals'] },
        });
        expect(result.ok).toBe(false);
    });

    it('names the capability that GOVERNS a tool the manifest asked for by name', () => {
        // Refusing is not enough. The SDK README lists capabilities and the Genie
        // MCP lists tools, so reaching for a tool name is the obvious mistake to
        // make — and "manageTerminals is not a Genie App capability" leaves the
        // developer to work out what is, from a message that sounds like the tool
        // is off limits entirely.
        const result = validateAppManifest({
            ...valid(),
            permissions: { scope: 'self', capabilities: ['manageTerminals'] },
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        const message = result.errors.join(' ');
        expect(message).toContain('manageTerminals');
        // The answer, not just the refusal.
        expect(message).toContain('terminals');
    });

    it('says plainly that an UNGRANTABLE tool is not on offer at any level', () => {
        // `submitFeedback` posts to the user's Tynn project in their name. No
        // capability covers it and none ever will, so a developer who asks for it
        // needs to be told that — not sent looking for the capability that grants
        // it, because there is not one.
        const result = validateAppManifest({
            ...valid(),
            permissions: { scope: 'self', capabilities: ['submitFeedback'] },
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        const message = result.errors.join(' ');
        expect(message).toContain('submitFeedback');
        expect(message).toMatch(/no app|never|not available/i);
        // And WHY, because a refusal with a reason is one a developer can design around.
        expect(message).toMatch(/impersonat|in their name/i);
    });

    it('drops a duplicate rather than asking the user twice', () => {
        const result = validateAppManifest({
            ...valid(),
            permissions: { scope: 'self', capabilities: ['hosting', 'hosting'] },
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.permissions.capabilities).toEqual(['hosting']);
    });
});

describe('the window a GApp gets — panels and tabs', () => {
    it('declares how many agent panels it wants, and of what kind', () => {
        // A GApp that runs several agent sessions at once needs to say so: the
        // Agent tab is Genie's panel management, and how much of it to lay out is
        // the app's call, not a guess.
        const result = validateAppManifest({
            ...valid(),
            panels: { agents: 3, kinds: ['terminal', 'files'] },
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.panels).toEqual({ agents: 3, kinds: ['terminal', 'files'] });
    });

    it('gives an app that says nothing ONE agent panel', () => {
        // The Agent tab exists for every GApp, so the default is a working one —
        // not zero, which would render an empty tab nobody asked for.
        const result = validateAppManifest(valid());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.panels.agents).toBe(1);
    });

    it('refuses a panel count that is not a sane number', () => {
        for (const agents of [0, -1, 1.5, 99, 'two']) {
            expect(validateAppManifest({ ...valid(), panels: { agents } }).ok, String(agents)).toBe(
                false,
            );
        }
    });

    it('refuses a panel kind Genie does not have', () => {
        const result = validateAppManifest({
            ...valid(),
            panels: { agents: 1, kinds: ['terminal', 'holodeck'] },
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.join(' ')).toContain('holodeck');
    });

    it('carries the UI tabs the app serves, in the order it listed them', () => {
        // They render to the RIGHT of the Agent tab, so the order is the app's.
        const result = validateAppManifest({
            ...valid(),
            tabs: [
                { title: 'Board', path: '/' },
                { title: 'Settings', path: '/settings' },
            ],
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.tabs?.map((t) => t.title)).toEqual(['Board', 'Settings']);
    });

    it('refuses a tab with no title, since the tab strip has to say something', () => {
        const result = validateAppManifest({ ...valid(), tabs: [{ path: '/' }] });
        expect(result.ok).toBe(false);
    });

    it('refuses a tab path that leaves the app’s own origin', () => {
        // A tab is served from <slug>.gen. An absolute URL here would put another
        // origin inside Genie's chrome wearing this app's name.
        for (const path of ['https://example.com/', '//example.com', 'javascript:x']) {
            expect(
                validateAppManifest({ ...valid(), tabs: [{ title: 'X', path }] }).ok,
                path,
            ).toBe(false);
        }
    });

    it('leaves tabs ABSENT for an app that serves one surface', () => {
        const result = validateAppManifest(valid());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.tabs).toBeUndefined();
    });
});

/**
 * The tab strip is Genie's, so what an app may WRITE INTO IT is a security gate
 * (genie#264).
 *
 * The strip is `[Agent (Genie's)] [app tabs…] [Flows (Genie's)]`, every button
 * styled identically — the only thing that varies is which one is active. So a
 * declared tab titled "Flows" lands immediately left of the real Flows tab
 * wearing the same treatment, and a human has nothing to tell them apart.
 *
 * `gapp.tsx` says why Flows is Genie's: "an app must not be able to paint the
 * screen that says what it is allowed to do." An app cannot paint the REAL one.
 * Until this gate existed it could put a convincing twin beside it.
 *
 * The same reasoning covers SIZE. An over-long title, or a hundred of them,
 * pushes Genie's own Flows tab out of the window — the app does not have to
 * imitate the trusted surface if it can shove it off-screen instead.
 */
describe('what an app may write into Genie’s tab strip', () => {
    it('REFUSES a tab titled like one of Genie’s own strip tabs — and keeps an honest one', () => {
        // The positive control matters as much as the rejection: a gate that
        // refuses everything would pass the negative half of this test while
        // making the tab strip useless.
        for (const title of ['Agent', 'Flows', '  flows  ', 'AGENT']) {
            const result = validateAppManifest({ ...valid(), tabs: [{ title, path: '/' }] });
            expect(result.ok, `"${title}" must be refused`).toBe(false);
            if (result.ok) continue;
            expect(result.errors.join(' ')).toMatch(/reserved|impersonat|Genie/i);
        }

        const honest = validateAppManifest({
            ...valid(),
            tabs: [{ title: 'Render Queue', path: '/queue' }],
        });
        expect(honest.ok, 'a legitimate tab title must still pass').toBe(true);
    });

    it('REFUSES a tab that claims a reserved product name', () => {
        // `name` has been gated against these since the manifest existed; the tab
        // strip is the same screen, reached by an easier route.
        for (const name of RESERVED_APP_NAMES) {
            const result = validateAppManifest({ ...valid(), tabs: [{ title: name, path: '/' }] });
            expect(result.ok, `tab "${name}" must be refused`).toBe(false);
        }
    });

    it('REFUSES an app NAMED like a Genie strip tab, because the name IS a tab', () => {
        // `appWindowTabs` labels the single app tab with `manifest.name` when no
        // tabs are declared. Gating only `tabs[].title` would leave the same
        // twin-tab attack open through the simpler manifest — declare nothing.
        for (const name of ['Flows', 'agent']) {
            const result = validateAppManifest({ ...valid(), name });
            expect(result.ok, `an app named "${name}" must be refused`).toBe(false);
        }

        expect(validateAppManifest({ ...valid(), name: 'Flow State' }).ok).toBe(true);
    });

    it('caps how LONG a tab title may be', () => {
        // Genie's own Flows tab is appended LAST in a flex strip with no overflow
        // handling, so a title long enough to fill the window pushes the trusted
        // tab out of sight without imitating anything.
        const result = validateAppManifest({
            ...valid(),
            tabs: [{ title: 'x'.repeat(200), path: '/' }],
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.join(' ')).toMatch(/tabs\[0\]\.title/);
    });

    it('caps how MANY tabs an app may declare', () => {
        // Same failure, reached by repetition rather than length.
        const many = Array.from({ length: 40 }, (_, i) => ({ title: `Tab ${i}`, path: `/${i}` }));
        expect(validateAppManifest({ ...valid(), tabs: many }).ok).toBe(false);
    });
});

/**
 * The agents a GApp ships (Tynn #250, owner-directed 2026-08-22).
 *
 * A `.gapp` envelope holds a `.agents/` folder — the persona and config for each
 * agent the app can run. It pairs with `panels.agents`: the manifest says how many
 * agent panels the window lays out, `.agents/` says who those agents ARE.
 *
 * They are DECLARED here rather than discovered from the folder, and the reason is
 * the whole point of this block. A GApp's agents run under the app's GRANTED
 * capabilities, so a file appearing in `.agents/` would add an agent nobody agreed
 * to, and a consent screen cannot describe a set it has to go looking for.
 * Declaration is also what every other GApp capability already does —
 * `capabilities`, `panels`, `tabs`, `services`, `requires` — so this keeps one
 * rule rather than two.
 */
describe('the agents a GApp ships', () => {
    it('declares each one, with the persona file it runs from', () => {
        const result = validateAppManifest({
            ...valid(),
            agents: [
                { name: 'Strategist', persona: 'strategist.md', description: 'Designs trades.' },
                { name: 'Reviewer', persona: 'reviewer.md' },
            ],
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.agents).toEqual([
            { name: 'Strategist', persona: 'strategist.md', description: 'Designs trades.' },
            { name: 'Reviewer', persona: 'reviewer.md' },
        ]);
    });

    it('leaves `agents` ABSENT for an app that ships none', () => {
        // Absent, not empty. Most GApps ship no agent of their own, and an empty
        // array would read as a roster that happens to be empty this time.
        const result = validateAppManifest(valid());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.agents).toBeUndefined();
    });

    it('refuses an agent with no name, since the consent screen has to name it', () => {
        const result = validateAppManifest({ ...valid(), agents: [{ persona: 'x.md' }] });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.join(' ')).toContain('agents[0].name');
    });

    it('refuses an agent with no persona file', () => {
        // Without one there is nothing to check against the folder, and the
        // declaration would be a name with nothing behind it.
        const result = validateAppManifest({ ...valid(), agents: [{ name: 'Reviewer' }] });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.join(' ')).toContain('agents[0].persona');
    });

    it('refuses a persona path that climbs OUT of `.agents/`', () => {
        // The persona is read and becomes an agent's instructions. A path that
        // escapes the folder would let a manifest point that at anything on the
        // machine — an SSH key, a .env — and have Genie hand it to a model.
        for (const persona of [
            '../../../.ssh/id_rsa',
            '/etc/passwd',
            'C:/Windows/win.ini',
            '..\\..\\secrets.md',
            '.agents\\..\\..\\secrets.md',
            'nested/../../out.md',
            './x.md',
            '',
        ]) {
            const result = validateAppManifest({
                ...valid(),
                agents: [{ name: 'Reviewer', persona }],
            });
            expect(result.ok, `"${persona}" must be refused`).toBe(false);
        }
    });

    it('allows a persona in a sub-folder of `.agents/`', () => {
        // "Persona and config for each agent" is often more than one file, so an
        // agent gets to own a directory.
        const result = validateAppManifest({
            ...valid(),
            agents: [{ name: 'Reviewer', persona: 'reviewer/persona.md' }],
        });
        expect(result.ok).toBe(true);
    });

    it('refuses two agents with the same name', () => {
        // The consent screen lists them by name. Two identical rows describe a
        // roster the user cannot tell apart.
        const result = validateAppManifest({
            ...valid(),
            agents: [
                { name: 'Reviewer', persona: 'a.md' },
                { name: 'reviewer ', persona: 'b.md' },
            ],
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.join(' ')).toMatch(/twice|already/i);
    });

    it('refuses a roster too long for anybody to read', () => {
        // Same reasoning as the panel cap: every declared agent is a line on the
        // consent screen, and a roster nobody reads is the failure mode consent
        // exists to prevent.
        const many = Array.from({ length: 40 }, (_, i) => ({
            name: `Agent ${i}`,
            persona: `a${i}.md`,
        }));
        expect(validateAppManifest({ ...valid(), agents: many }).ok).toBe(false);
    });

    it('refuses `agents` that is not an array', () => {
        expect(validateAppManifest({ ...valid(), agents: { name: 'x' } }).ok).toBe(false);
    });
});

/**
 * A GApp that OFFERS TOOLS to agents in other workspaces — the capability
 * provider (finding, 2026-08-24, recorded while building Remotion, the first
 * third-party GApp).
 *
 * `gapp-agents-runtime.md` already says a GApp may be one: "Some GApps don't even
 * have agents but provide tools to agents like Remotion. This is a tool that any
 * workspace or GApp can use as well." Until this block the manifest had no way to
 * say it — and worse than no way. `validateAppManifest` rebuilds a fresh object
 * from an allow-list of known keys, so a provider manifest VALIDATED, installed,
 * reported success, and its tools silently did not exist.
 *
 * That is exactly the failure the GApp agent runtime was built to stop one layer
 * up: "a developer following the SDK README ships a persona, installs, and gets N
 * empty terminals with no error. That reads as a broken product, not an unbuilt
 * feature."
 *
 * The vocabulary is deliberately the one `genie-plugin.json` already uses —
 * `contributes.mcpTools`, namespaced — because the right question was never
 * "should this be a plugin?" but "why can a plugin do what a GApp cannot?". What a
 * renderer needs is on the GApp side already: `services[]` with literal argv in
 * any language and real OS authority, and `requires[]` for the toolchain. The
 * plugin sandbox is deliberately incapable (30s call timeout, no `child_process`,
 * no subprocess) and should stay that way. So the missing piece was never
 * authority — it was the BRIDGE from a GApp's own service into the agent-facing
 * tool list.
 */
describe('a GApp that offers tools to other agents', () => {
    const provider = (over: Record<string, unknown> = {}) => ({
        ...valid(),
        slug: 'remotion',
        services: [{ name: 'renderer', command: ['node', 'tools/server.js'] }],
        contributes: {
            mcpTools: [
                {
                    name: 'renderVideo',
                    description: 'Render a Remotion composition to an mp4.',
                    inputSchema: { type: 'object', properties: { composition: { type: 'string' } } },
                },
            ],
            servedBy: 'renderer',
            transport: { kind: 'stdio' },
        },
        ...over,
    });

    it('declares the tools it offers, and keeps them', () => {
        const result = validateAppManifest(provider());

        expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
        if (!result.ok) return;
        expect(result.value.contributes?.mcpTools.map((t) => t.name)).toEqual(['renderVideo']);
        expect(result.value.contributes?.servedBy).toBe('renderer');
        expect(result.value.contributes?.transport).toEqual({ kind: 'stdio' });
    });

    it('namespaces an offered tool by the app’s OWN slug', () => {
        // One identity, not a second name to keep unique. The slug is already the
        // app's address (`remotion.gen`) and already has to be a unique DNS label,
        // so `remotion.renderVideo` is the tool name a caller can predict from the
        // app they installed.
        expect(appToolName('remotion', 'renderVideo')).toBe('remotion.renderVideo');
    });

    it('refuses tools served by a service that does not exist', () => {
        // The cross-field check catches the real mistake. A `servedBy` naming
        // nothing is a manifest whose tools can never start, and finding that out
        // at install beats finding it out on the first call.
        const result = validateAppManifest(
            provider({
                contributes: {
                    mcpTools: [{ name: 'x', description: 'd', inputSchema: { type: 'object' } }],
                    servedBy: 'nonexistent',
                    transport: { kind: 'stdio' },
                },
            }),
        );

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.join(' ')).toContain('nonexistent');
    });

    it('refuses a tool with no argument schema, or a duplicate name', () => {
        for (const mcpTools of [
            [{ name: 'x', description: 'd' }],
            [{ name: 'x', description: 'd', inputSchema: { type: 'string' } }],
            [
                { name: 'x', description: 'd', inputSchema: { type: 'object' } },
                { name: 'x', description: 'e', inputSchema: { type: 'object' } },
            ],
        ]) {
            const result = validateAppManifest(
                provider({
                    contributes: { mcpTools, servedBy: 'renderer', transport: { kind: 'stdio' } },
                }),
            );
            expect(result.ok, JSON.stringify(mcpTools)).toBe(false);
        }
    });

    it('accepts an HTTP transport with a port, and refuses one without', () => {
        // A stdio MCP server does not fit `services[]`, which assumes a port-based
        // daemon, so the transport has to be said explicitly rather than inferred.
        const tool = { name: 'x', description: 'd', inputSchema: { type: 'object' } };
        expect(
            validateAppManifest(
                provider({
                    contributes: {
                        mcpTools: [tool],
                        servedBy: 'renderer',
                        transport: { kind: 'http', port: 8797 },
                    },
                }),
            ).ok,
        ).toBe(true);

        expect(
            validateAppManifest(
                provider({
                    contributes: {
                        mcpTools: [tool],
                        servedBy: 'renderer',
                        transport: { kind: 'http' },
                    },
                }),
            ).ok,
        ).toBe(false);
    });
});

/**
 * `consumers` — whose agents may SPEND this app's compute.
 *
 * The inverse of `scope`, and it must not be folded into it. `scope` answers
 * "whose workspace may this app touch?" and is a grant the user makes TO the app.
 * `consumers` answers "whose agents may spend this app's compute?" and is a grant
 * made ABOUT it. An app can legitimately be `scope: self` — Remotion touches
 * nothing but its own workspace — while being callable from everywhere. One field
 * cannot carry both without one of them being wrong.
 */
describe('who may call an app’s offered tools', () => {
    const withTools = (consumers?: unknown) => ({
        ...valid(),
        slug: 'remotion',
        services: [{ name: 'renderer', command: ['node', 'server.js'] }],
        contributes: {
            mcpTools: [{ name: 'renderVideo', description: 'd', inputSchema: { type: 'object' } }],
            servedBy: 'renderer',
            transport: { kind: 'stdio' as const },
        },
        permissions: { scope: 'self', capabilities: [], ...(consumers ? { consumers } : {}) },
    });

    it('carries a workstation-wide offer through', () => {
        const result = validateAppManifest(withTools({ scope: 'workstation' }));

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.permissions.consumers).toEqual({ scope: 'workstation' });
        // `scope: self` and `consumers: workstation` together are not a
        // contradiction — they are the whole point. Remotion touches nothing but
        // its own workspace and is callable from everywhere.
        expect(result.value.permissions.scope).toBe('self');
    });

    it('defaults an app that offers tools to its OWN agents only', () => {
        // Fail closed, like every other permission here: absent must never read as
        // "anyone on this machine may spend your CPU".
        const result = validateAppManifest(withTools());

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.permissions.consumers).toEqual({ scope: 'self' });
    });

    it('names the workspaces when the offer is limited to some', () => {
        const result = validateAppManifest(
            withTools({ scope: 'workspaces', workspaces: ['tynn.ai'] }),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.permissions.consumers).toEqual({
            scope: 'workspaces',
            workspaces: ['tynn.ai'],
        });
    });

    it('refuses a limited offer that names no workspace — an empty list is not "all"', () => {
        expect(validateAppManifest(withTools({ scope: 'workspaces', workspaces: [] })).ok).toBe(
            false,
        );
    });

    it('refuses `consumers` on an app that offers no tools', () => {
        // A grant about nothing. Silently keeping it would put a sentence on the
        // consent screen describing an offer the app cannot make.
        const result = validateAppManifest({
            ...valid(),
            permissions: { scope: 'self', capabilities: [], consumers: { scope: 'workstation' } },
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.join(' ')).toMatch(/consumers/);
    });
});

/**
 * The SILENT DROP — the sharp edge the provider finding actually cut itself on.
 *
 * `validateAppManifest` rebuilds a fresh object from an allow-list of known keys,
 * so anything it does not recognise never reaches the runtime AND never raises an
 * error. A developer writes a manifest, installs it, Genie reports success, and
 * the thing they declared simply does not exist. No error, at any point.
 *
 * The file already argues this case one level down, about capabilities: "silently
 * ignoring `root` would let a manifest read as though it asked for something while
 * the runtime quietly granted nothing, and the developer would find out from a
 * mystery denial months later." The same is true of the object as a whole, so the
 * same answer applies to it.
 */
describe('a manifest that declares something Genie does not know', () => {
    it('is REFUSED, rather than quietly accepted with the field dropped', () => {
        // The plugin vocabulary verbatim — the exact manifest that was accepted,
        // installed, and silently had its tools removed.
        const result = validateAppManifest({ ...valid(), mcpTools: [{ name: 'renderVideo' }] });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.join(' ')).toContain('mcpTools');
    });

    it('still allows `$schema`, which editors add and Genie does not read', () => {
        const result = validateAppManifest({
            ...valid(),
            $schema: 'https://genie.tynn.ai/schemas/genie-app.json',
        });
        expect(result.ok).toBe(true);
    });
});

describe('shared schema identity', () => {
    it('preserves the pinned `$schema` in the validated manifest', () => {
        const schema = 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.1.1/schemas/workspace/genie-app.schema.json';
        const result = validateAppManifest({ ...valid(), $schema: schema });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.$schema).toBe(schema);
    });
});
