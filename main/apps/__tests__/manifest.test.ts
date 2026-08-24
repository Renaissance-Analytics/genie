import { describe, expect, it } from 'vitest';
import { validateAppManifest, RESERVED_APP_NAMES } from '../manifest';

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
