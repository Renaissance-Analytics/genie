import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MOVE_STEPS, WINDOW_CAPABILITIES, WINDOW_ENGINE_INVENTORY, WINDOW_PROTOCOL_DOORS } from '../src/core/ipc-inventory.js';

/**
 * CLIENT/HOST SPLIT STEP 2e, THE GUARD (Tynn #898, story #899). A client is a dumb terminal (the owner's ruling): it serves
 * no remote connection, and it reaches host features over the one protocol only. test/ipc-inventory.test.ts holds the
 * window's IPC side; this file holds the rest:
 *  1. SERVES NOTHING: no module main.ts loads is a remote-serving one, and the window's composition roots start no server
 *     but the window's own pages.
 *  2. ITS ENGINE LINK: every use main.ts makes of its engine client is named, as the link's own, a window capability, or
 *     the step that moves it onto the one protocol; that last list is frozen and only shrinks (the coordinator, 2026-11-19).
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
/**
 * Comment LINES go (the repo's source-guard convention): a line that starts with //, /* or * is not code. Never a block
 * regex: a "/*" inside a comment or a string (main.ts has one) opens a block that swallows real code, and the guard
 * would read less than is there. Stripping by line can only read more.
 */
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

/** The files a module loads by VALUE (type-only imports load nothing at run time), followed from `entry`. */
export function valueReach(entry: string, readText: (path: string) => string | null = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)): Set<string> {
    const seen = new Set<string>();
    const stack = [resolve(root, entry)];
    while (stack.length) {
        const file = stack.pop()!;
        if (seen.has(file)) continue;
        const text = readText(file);
        if (text === null) continue;
        seen.add(file);
        const specs: string[] = [];
        for (const m of code(text).matchAll(/^\s*(?:import|export)\s+(?!type\b)([^;]*?)\s+from\s+'(\.[^']+)'/gm)) {
            const names = m[1]!.trim();
            const typeOnly = /^\{[^}]*\}$/.test(names) && names.slice(1, -1).split(',').map((p) => p.trim()).filter(Boolean).every((p) => p.startsWith('type '));
            if (!typeOnly) specs.push(m[2]!);
        }
        for (const m of code(text).matchAll(/^\s*import\s+'(\.[^']+)'/gm)) specs.push(m[1]!);
        for (const spec of specs) {
            const ts = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
            stack.push(readText(ts) !== null ? ts : ts.replace(/\.ts$/, '.tsx'));
        }
    }
    return new Set([...seen].map((f) => relative(root, f).split('\\').join('/')));
}

/** Modules whose job is to serve remote connections: genie-host's, never the window's. */
const REMOTE_SERVING = [
    'src/main/genie-host.ts', 'src/main/remote-host.ts', 'src/main/remote-access-host.ts', 'src/main/protocol-tunnels.ts',
    'src/main/remote-listen.ts', 'src/main/ws-server-transport.ts', 'src/main/host-alone-api.ts', 'src/main/gapp-server.ts',
    'src/main/mcp-server.ts', 'src/main/host-mcp.ts',
];

/** What starts a server. The window's composition roots call none: genie-host does (app-inbox, hosting, the router, …). */
const STARTERS = [
    /\bcreateServer\(/, /\.listen\(/, /new RemoteHost\(/, /\btransportHub\(/, /\bbuildHostApi\(/, /\bhostAloneApi\(/,
    /\bhostRemoteApi\(/, /\bstartAppInboxServer\(/, /new GenRouterServer\(/, /\bcomposeHosting\(/, /\bsiteDoor\(/,
    /\bgenieMcpServer\(/, /new GAppServer\(/, /\bremoteListener\(/, /new WebSocketServer\(/, /new ProtocolTunnels\(/,
];
const startersIn = (text: string) => STARTERS.filter((p) => p.test(code(text))).map(String);

describe('the window serves nothing (step 2e)', () => {
    const reach = valueReach('src/main/main.ts');

    it('POSITIVE CONTROL: the walk follows main.ts into what the window really loads', () => {
        for (const file of ['src/main/window-pages.ts', 'src/main/local-protocol-door.ts', 'src/main/window-tunnel.ts', 'src/main/session-engine-client.ts', 'src/main/compose.ts']) expect(reach, file).toContain(file);
    });

    it('no remote-serving module is loaded by the window', () => {
        expect(REMOTE_SERVING.filter((file) => reach.has(file))).toEqual([]);
    });

    it('CONTROL: a value import of one is followed, a type-only import is not', () => {
        const files: Record<string, string> = {
            [resolve(root, 'x/main.ts')]: "import { app } from 'electron';\nimport type { A } from './typed.js';\nimport { type B } from './typed2.js';\nimport { C } from './real.js';\n",
            [resolve(root, 'x/real.ts')]: "export { D } from './remote-host.js';\n",
            [resolve(root, 'x/remote-host.ts')]: '',
            [resolve(root, 'x/typed.ts')]: '', [resolve(root, 'x/typed2.ts')]: '',
        };
        const walked = valueReach('x/main.ts', (p) => files[p] ?? null);
        expect([...walked].sort()).toEqual(['x/main.ts', 'x/real.ts', 'x/remote-host.ts']);
    });

    it('main.ts and compose.ts start no server; the window\'s own pages are what main serves itself', () => {
        expect(startersIn(read('src/main/main.ts'))).toEqual([]);
        expect(startersIn(read('src/main/compose.ts'))).toEqual([]);
        expect(code(read('src/main/main.ts'))).toMatch(/\bconfigureWindowPages\(/);
    });

    // The doors main tunnels to genie-host (Tynn #896, 2b-2b): each is named, and each rides the engine link; none listens.
    const tunneled = (text: string) => [...code(text).matchAll(/\btunnelDoor\(\s*([\w.]+)\s*,\s*([^)]*\))/g)].map((m) => [m[1]!, m[2]!.replace(/\s+/g, '')] as const);
    it('every door main tunnels is a protocol door in WINDOW_PROTOCOL_DOORS, carried over its engine link', () => {
        const doors = tunneled(read('src/main/main.ts'));
        expect(doors.map(([d]) => d).sort()).toEqual(WINDOW_PROTOCOL_DOORS.map(([d]) => d).sort());
        for (const [door, link] of doors) expect(link, door).toBe('tunnelLinkOf(agentEngineLink.client)');
        for (const [, kind] of WINDOW_PROTOCOL_DOORS) expect(kind).toBe('protocol-door');
        expect(reach).toContain('src/main/own-protocol-client.ts');
        expect(startersIn(read('src/main/own-protocol-client.ts'))).toEqual([]);
    });

    it('CONTROL: the door scan reads code, not comments, and names a newcomer', () => {
        expect(tunneled("// tunnelDoor(old, tunnelLinkOf(x))\nconst t = tunnelDoor(newDoor, tunnelLinkOf(agentEngineLink.client), {});"))
            .toEqual([['newDoor', 'tunnelLinkOf(agentEngineLink.client)']]);
    });

    it('CONTROL: each starter is seen in code and not in a comment', () => {
        expect(startersIn('const s = createServer(handler);\nhub = transportHub(t);')).toEqual([String(STARTERS[0]), String(STARTERS[3])]);
        expect(startersIn('// createServer(handler)\n/* new RemoteHost( */')).toEqual([]);
    });
});

/**
 * Every use main.ts makes of its engine client: the member, or `call:<method>` for a raw call. An ALIAS of the client
 * (`const engineLink = agentEngineLink.client`) is followed, and a client handed whole to a function is `whole:<alias>`,
 * which no list may hold (Tynn #1007, 2g-4e: main.ts read the registry as `engineLink.stores()`, unseen).
 */
export function engineUses(text: string): string[] {
    const uses = new Set<string>();
    const source = code(text);
    const add = (member: string, method: string | undefined) => uses.add(member === 'call' ? `call:${method ?? '?'}` : member);
    for (const m of source.matchAll(/(?<![\w$-])client\??\.(\w+)(\s*\(\s*'([^']*)')?/g)) add(m[1]!, m[3]);
    const aliases = [...source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*[\w$.?]*\bclient\b(?!\s*\??\.)/g)].map((m) => m[1]!);
    for (const alias of new Set(aliases)) {
        for (const m of source.matchAll(new RegExp(`(?<![\\w$./-])${alias}\\??\\.(\\w+)(\\s*\\(\\s*'([^']*)')?`, 'g'))) add(m[1]!, m[3]);
        // Handed whole: an argument of a call, never an `if (alias)` test.
        if (new RegExp(`(?<!\\b(?:if|while|switch)\\s*)\\(\\s*${alias}\\s*[,)]|,\\s*${alias}\\s*[,)]`).test(source)) uses.add(`whole:${alias}`);
    }
    return [...uses].sort();
}

describe('the window\'s engine link carries only the link, window capabilities, and what is still to move (step 2e)', () => {
    const used = engineUses(read('src/main/main.ts'));
    const listed = WINDOW_ENGINE_INVENTORY.map(([use]) => use);

    it('every use main.ts makes of its engine client is listed, with no stale row', () => {
        expect(used.length).toBeGreaterThan(0);
        expect({ unlisted: used.filter((u) => !listed.includes(u)), stale: listed.filter((u) => !used.includes(u)).sort() }).toEqual({ unlisted: [], stale: [] });
        expect(new Set(listed).size).toBe(listed.length);
    });

    const KNOWN = new RegExp(`^(link|window:(${WINDOW_CAPABILITIES.join('|')})|move:(${MOVE_STEPS.join('|')}))$`);
    it('each is the link\'s own, a window capability, or the step that moves it', () => {
        for (const [use, destination] of WINDOW_ENGINE_INVENTORY) expect(destination, use).toMatch(KNOWN);
    });

    /** Frozen (the coordinator, 2026-11-19): each leaves in the PR that moves it, and nothing joins. */
    const STILL_TO_MOVE: Readonly<Record<string, string>> = {
        // terminals and processBook left in 2g-2 (#953): the tray, its Restart/Shut-down list and the quit read genie-host's
        // summary (summary.watch), and main's tool server keeps no host-native deps.
        // 2f is done: the question window's answers moved in 2f-1 (#912); the device link's frames and main's Deck liveness
        // (takeOvers: the question window and the tray read genie-host's Deck) in 2f-2 (#941).
        // 2g (#913): the services the window still composes over genie-host's replicas. appInbox, tynnPage and workstation
        // left in 2g-1 (#952): main held them and nothing read them.
        // github, keyring, relayHost and tynn left in 2g-3b (#959): the accounts, the keyring card and the registration are
        // genie-host's; main unseals an older Genie's secrets once and hands them over (keychain.adoptLegacy).
        // catalog and plugins left in 2g-3c (#961): compose read nothing from them in the window.
        flows: '2g', hosting: '2g',
        // Seen in 2g-4e (#1007) once the scanner followed main's `engineLink` alias; each is a task on 2g-4d (#955).
        // pushWindowView and v1Import left in 2g-4d B (#1044).
        onSpawnFrame: '2g', runHostTool: '2g', spawnLink: '2g',
        // The Files watch (#955 task #1472); IssueWatch and the Tynn panels' watches (G-1, #934 task #1474).
        onFilesEvent: '2g', filesWatch: '2g', filesUnwatch: '2g',
        issueWatch: '2g', tynnBoardWatch: '2g', tynnBoardUnwatch: '2g', onTynnBoardEvent: '2g', tynnIssuesWatch: '2g', tynnIssuesUnwatch: '2g',
        onTynnIssuesEvent: '2g', tynnFeaturesWatch: '2g', tynnFeaturesUnwatch: '2g', onTynnFeaturesEvent: '2g',
        // recordsChanged left in 2g-3 (#954): genie-host reads its own registry.
        // remoteAccess left in 2g-4a (#997): main's notifications read genie-host's remote.watch.
        stores: '2g', supervisor: '2g',
    };
    const ratchet = (rows: readonly (readonly [string, string])[], usedNow: readonly string[]) => ({
        joined: rows.filter(([u, d]) => d.startsWith('move:') && STILL_TO_MOVE[u] !== d.slice('move:'.length)).map(([u]) => u).sort(),
        relabelled: Object.keys(STILL_TO_MOVE).filter((u) => usedNow.includes(u) && !rows.some(([r, d]) => r === u && d.startsWith('move:'))).sort(),
    });

    it('THE RATCHET: every still-to-move use is on the frozen list under its step, and none was re-labelled while still used', () => {
        expect(ratchet(WINDOW_ENGINE_INVENTORY, used)).toEqual({ joined: [], relabelled: [] });
    });

    it('CONTROL: the scanner reads members and raw calls, not comments or import paths, and the ratchet notices a newcomer', () => {
        // A "/*" in a line comment opens nothing: the uses after it are still read (main.ts:2469 hid two that way).
        expect(engineUses("// Genie 1 (#1/*): its sign-in\nconst a = agentEngineLink.client.github();\n/* a real block */\nlink.client.workstation();")).toEqual(['github', 'workstation']);
        expect(engineUses("import { X } from './session-engine-client.js';\n// client.flows()\nagentEngineLink.client.hosting();\nvoid client.call('engine.thing', []);\nlink?.client?.heartbeat(b);"))
            .toEqual(['call:engine.thing', 'heartbeat', 'hosting']);
        expect(ratchet([['newThing', 'move:2g']], []).joined).toEqual(['newThing']);
        expect(ratchet([['hosting', 'window:chrome']], ['hosting']).relabelled).toEqual(['hosting']);
    });

    it('CONTROL: the scanner follows an alias of the engine client, and names a client handed over whole (Tynn #1007, 2g-4e)', () => {
        // main.ts:1471 read the registry as `engineLink.stores()` through `const engineLink = agentEngineLink.client`: unseen.
        expect(engineUses("const engineLink = agentEngineLink.client;\nengineLink.stores();\nconst e = agentEngineLink?.client ?? null;\nif (e) e.onLink(a, b);\n// e.flows()\nvoid e?.mcpStatus();"))
            .toEqual(['mcpStatus', 'onLink', 'stores']);
        // A client handed to another module is every member at once: it is named, so no list can leave it unseen.
        expect(engineUses("const e = agentEngineLink.client;\nconst r = e ? withHostTools(all, e, resolve) : all;\nif (e) {}\nf({ run: (c) => e.runHostTool(c) });"))
            .toEqual(['runHostTool', 'whole:e']);
        // CONTROL: `.client` read for something else is no alias.
        expect(engineUses("const c = this.client.other;\nc.thing();")).toEqual(['other']);
        // CONTROL: an import path that ends in the alias's name is no use of it.
        expect(engineUses("import { x } from './window-tunnel-link.js';\nconst link = agentEngineLink.client;\nlink.filesWatch(v);")).toEqual(['filesWatch']);
    });
});
