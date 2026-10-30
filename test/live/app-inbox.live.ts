/**
 * APPS AND SCRIPTS REPORT TO AGENTS, END TO END (genie#1345) — for real, in a test VM.
 *
 * The unit suite proves each rule with fakes. This proves the chain the owner asked for against REAL processes:
 *
 *   1. a Genie-hosted SITE (a real dev-server process Genie starts through the real pty engine) posts with the token
 *      Genie put in ITS env — and its message lands in the clerk's inbox marked `site:…@fancy`;
 *   2. a kept BACKGROUND PROCESS posts to a named agent (the manual scribe) the same way, marked `proc:…@fancy`;
 *   3. a SCRIPT outside Genie, holding a key the person made, posts as `script:nightly@fancy`;
 *   4. the agent's own `agentinbox receive` returns each one marked as an app's and fenced as data;
 *   5. delivery follows the mode: the automated clerk is WOKEN, the manual scribe is NOT (and is told on its next turn);
 *   6. another workspace's agent cannot be reached — the process tries, and is told 404; nothing lands there;
 *   7. the token is in the site process's own environment and NOT in the workspace's service env (positive control
 *      beside the absence, read from /proc on Linux).
 *
 * The agents' SESSIONS are a stand-in (a host the harness drives, as test/inbox-push.test.ts does): what is real is
 * every process, the pty engine, the HTTP door, the key book, the inbox store and Genie's own delivery code
 * (`wireInboxPush` with main's app policy). Run in the VM only:
 *   scripts/vm-fifo.sh omarchy ../_wt/<tree> 'npm ci && npx tsx test/live/app-inbox.live.ts'
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appDelivery, isAppSender } from '../../src/core/app-inbox.js';
import { agentRecord, mintAgentId, type AgentId } from '../../src/core/identity.js';
import { AppInboxKeys } from '../../src/main/app-inbox-keys.js';
import { AppInboxService, appInboxEnvFor, startAppInboxServer } from '../../src/main/app-inbox-service.js';
import { AttentionStore } from '../../src/main/attention-store.js';
import { composeServices } from '../../src/main/compose.js';
import { realFancyTermPort } from '../../src/main/fancy-term-port.js';
import { handleFeatureAction, type FeatureState } from '../../src/main/feature-ipc.js';
import { wireInboxPush, type InboxPushPorts } from '../../src/main/inbox-push.js';
import { genieTools, type GenieToolsDeps } from '../../src/main/mcp-tools.js';
import { ProcessBook } from '../../src/main/process-book.js';

const failures: string[] = [];
function check(ok: boolean, label: string, detail = ''): void {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
}
async function until(predicate: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 200));
    }
    return predicate();
}

const POSTER = `
const [, , subject, to, outFile] = process.argv;
const res = await fetch(process.env.GENIE_INBOX_URL + '/v1/inbox', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + process.env.GENIE_INBOX_TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ subject, body: 'from ' + subject, ...(to && to !== '-' ? { to } : {}) }),
});
const text = await res.text();
if (outFile) (await import('node:fs')).appendFileSync(outFile, JSON.stringify({ subject, to, status: res.status, text }) + '\\n');
`;

async function main(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'genie2-app-inbox-live-'));
    const userData = join(root, 'home');
    const fancy = join(root, 'fancy');
    const tynn = join(root, 'tynn');
    for (const [dir, name] of [[fancy, 'fancy'], [tynn, 'tynn']] as const) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'project.json'), `${JSON.stringify({ name, repos: [] }, null, 2)}\n`);
    }
    const out = join(root, 'posts.jsonl');
    writeFileSync(join(fancy, 'poster.mjs'), POSTER);
    // The site's dev server: it serves, and on start reports to the clerk (poster.mjs as a child, so argv is its own).
    writeFileSync(join(fancy, 'site.mjs'), `
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
createServer((q, s) => s.end('ok')).listen(Number(process.argv[2]), '127.0.0.1');
execFileSync(process.execPath, [new URL('./poster.mjs', import.meta.url).pathname, 'site up: 3 petitions queued', 'clerk', ${JSON.stringify(out)}], { stdio: 'inherit' });
setInterval(() => {}, 1 << 30);
`);
    writeFileSync(join(fancy, 'proc.mjs'), `
import { execFileSync } from 'node:child_process';
const poster = new URL('./poster.mjs', import.meta.url).pathname;
execFileSync(process.execPath, [poster, 'lab run 412 finished', 'scribe', ${JSON.stringify(out)}], { stdio: 'inherit' });
execFileSync(process.execPath, [poster, 'cross-workspace attempt', 'keeper@tynn', ${JSON.stringify(out)}], { stdio: 'inherit' });
setInterval(() => {}, 1 << 30);
`);

    const clerk = agentRecord({ id: mintAgentId(), workspaceId: 'fancy', provider: 'claude', name: 'clerk', mode: 'automated' });
    const scribe = agentRecord({ id: mintAgentId(), workspaceId: 'fancy', provider: 'claude', name: 'scribe', mode: 'manual' });
    const keeper = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'keeper', mode: 'automated', accessScope: 'all' });
    const roster = [clerk, scribe, keeper];
    const slugs = new Map([['fancy', 'fancy'], ['tynn', 'tynn']]);

    const MARK = Buffer.from('GT1');
    const encryptor = {
        isAvailable: () => true,
        encrypt: (b: Buffer) => Buffer.concat([MARK, Buffer.from(b.map((x) => x ^ 0x5a))]),
        decrypt: (b: Buffer) => Buffer.from(b.subarray(MARK.length).map((x) => x ^ 0x5a)),
    };

    const keys = await AppInboxKeys.open(userData);
    let services: Awaited<ReturnType<typeof composeServices>> | null = null;
    const service = new AppInboxService({
        keys,
        inbox: { send: (i) => services!.inbox.send(i), unread: (p) => services?.inbox.unread(p) ?? [], all: () => services?.inbox.all() ?? [] },
        roster: () => roster, slugs: () => slugs, defaultAgentOf: (ws) => (ws === 'fancy' ? clerk.id : keeper.id),
        enabled: (ws) => services?.settings.snapshotFor(ws).app_inbox !== false,
        siteHosts: (ws) => services?.sites.list().filter((s) => s.workspaceId === ws).map((s) => s.host) ?? [],
    });
    const server = await startAppInboxServer({ service, port: 0 });
    console.log(`\ngenie2 live APP INBOX check — door ${server.url}, root ${root}\n`);
    check(server.address === '127.0.0.1', '0. the door listens on 127.0.0.1 only', server.address);

    services = await composeServices({
        userData, pty: realFancyTermPort(userData, encryptor), v1Settings: () => null, caddyBin: null, frontDoorPort: 0,
        docker: async () => ({ stdout: '', exitCode: 0 }), portFree: async () => true,
        roster: () => roster, workspaceSlugs: () => slugs,
        workspaces: () => [{ id: 'fancy', path: fancy }, { id: 'tynn', path: tynn }],
        appInboxEnv: (s) => appInboxEnvFor({ url: server.url, token: keys.tokenFor(s) }),
    });
    const composed = services;

    // Genie's own delivery, with main's app policy, over a host the harness drives (the agents' sessions are the stand-in).
    const running = new Map<string, number>();
    const idle = new Set<string>();
    const ended = new Map<string, number>();
    const prompts: Array<[string, string]> = [];
    const woken: string[] = [];
    const listeners = new Set<(id: AgentId) => void>();
    const hostPort: InboxPushPorts['host'] = {
        subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
        promptable: (id) => (idle.has(id) ? running.get(id) ?? null : null),
        runOf: (id) => running.get(id) ?? null,
        turnsEndedThisRun: (id) => ended.get(id) ?? 0,
        probe: () => null,
        prompt: (id, text) => { prompts.push([id, text]); idle.delete(id); return true; },
    };
    const start = (id: string) => { running.set(id, (running.get(id) ?? 0) + 1); idle.add(id); for (const l of listeners) l(id as AgentId); };
    const appWakes = new Map<string, number>();
    wireInboxPush({
        inbox: composed.inbox, host: hostPort,
        reminders: (input) => composed.inboxReminders(input), settled: (id, ok) => composed.inboxNoticeSettled(id, ok),
        wake: (id) => { woken.push(id); start(id); return true; },
        appMail: (to, message) => (isAppSender(message.from) ? appDelivery(roster.find((r) => r.id === to)?.mode ?? 'manual', appWakes.get(to) ?? null, Date.now()) : null),
        appWoke: (id) => { appWakes.set(id, Date.now()); },
    });

    const book = await ProcessBook.open(userData, { supervisor: composed.supervisor, envFor: (ws) => composed.engines.envFor(ws), asleep: () => false, appEnv: (p) => composed.appEnv(p) });
    try {
        // 1. A Genie-hosted site.
        const state: FeatureState = { toolStatuses: null, knowledgeQuery: '' };
        await handleFeatureAction(composed, { kind: 'hosting.createSite', workspaceId: 'fancy', repoPath: fancy, form: { name: 'flabs', mode: 'proxy', devServer: { stack: 'node', command: `node site.mjs {port}` }, hostPort: null, root: null, spa: false } }, state);
        const siteMail = () => composed.inbox.all().find((m) => m.from === 'app:site:site_flabs');
        check(await until(() => siteMail() !== undefined, 30_000), '1. the hosted site posted, and its message landed', JSON.stringify(siteMail()?.app ?? readFileSync(out, 'utf8').slice(-300)));
        check(siteMail()?.to === clerk.id && siteMail()?.app?.label === 'site:flabs@fancy', '1b. …to the clerk, marked site:flabs@fancy', `${siteMail()?.to === clerk.id ? 'clerk' : siteMail()?.to} · ${siteMail()?.app?.label}`);

        // 2 + 6. A kept background process: to the manual scribe, then a try at another workspace.
        const p = await book.create({ workspaceId: 'fancy', workspacePath: fancy, name: 'queue', command: 'node proc.mjs', restart: 'never' });
        const procMail = () => composed.inbox.all().find((m) => m.from === `app:process:${p.id}`);
        const posts = () => (existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { subject: string; status: number }) : []);
        check(await until(() => procMail() !== undefined && posts().some((x) => x.subject === 'cross-workspace attempt'), 30_000), '2. the background process posted, and its message landed', JSON.stringify(procMail()?.app ?? null));
        check(procMail()?.to === scribe.id && procMail()?.app?.label === 'proc:queue@fancy', '2b. …to the named scribe, marked proc:queue@fancy', String(procMail()?.app?.label));
        const cross = posts().find((x) => x.subject === 'cross-workspace attempt');
        check(cross?.status === 404, '6. its post to keeper@tynn was refused 404', JSON.stringify(cross));
        check(composed.inbox.unread(keeper.id).length === 0, '6b. …and nothing landed in the other workspace', `keeper unread ${composed.inbox.unread(keeper.id).length}`);

        // 3. A script outside Genie, with a key the person made.
        const made = await keys.createScriptKey('fancy', 'nightly');
        execFileSync(process.execPath, [join(fancy, 'poster.mjs'), 'nightly check red', '-', out], { env: { ...process.env, GENIE_INBOX_URL: server.url, GENIE_INBOX_TOKEN: made.token } });
        const scriptMail = composed.inbox.all().find((m) => m.from === `app:script:${made.id}`);
        check(scriptMail?.to === clerk.id && scriptMail?.app?.label === 'script:nightly@fancy', '3. the script posted with its key, to the default agent, marked script:nightly@fancy', String(scriptMail?.app?.label));
        // The same script with a made-up key: 404, nothing stored.
        const before = composed.inbox.all().length;
        execFileSync(process.execPath, [join(fancy, 'poster.mjs'), 'forged', '-', out], { env: { ...process.env, GENIE_INBOX_URL: server.url, GENIE_INBOX_TOKEN: 'gik_forged' } });
        check(posts().find((x) => x.subject === 'forged')?.status === 404 && composed.inbox.all().length === before, '3b. a made-up key: 404, nothing stored');

        // 5. Delivery by mode.
        check(woken.includes(clerk.id), '5. the automated clerk was WOKEN by the app', `woken: ${woken.map((id) => roster.find((r) => r.id === id)?.name).join(', ')}`);
        check(!woken.includes(scribe.id), '5b. the manual scribe was NOT woken');
        check(prompts.some(([id, t]) => id === clerk.id && /from an app|from apps/.test(t)), '5c. the clerk’s notice counts the app messages and says they are data', prompts.find(([id]) => id === clerk.id)?.[1] ?? 'none');
        check(!prompts.some(([id]) => id === scribe.id), '5d. the scribe got no turn of its own');
        start(scribe.id); // its next session event (the person starts it / its next turn)
        check(prompts.some(([id]) => id === scribe.id), '5e. …and is told when it next runs', prompts.find(([id]) => id === scribe.id)?.[1] ?? 'none');

        // 4. What the agent's own tool returns.
        const attention = await AttentionStore.open(userData, composed.inbox);
        const tool = genieTools({
            inbox: composed.inbox, attention, roster: () => roster,
            resolveCaller: (k) => { const r = roster.find((a) => a.name === k); return r ? { agentId: r.id, agentName: r.name, workspaceId: r.workspaceId, workspacePath: fancy } : null; },
            workspaceSetting: () => ({ scope: 'self' }), userActive: () => true, glow: () => true, thumbsUp: () => {},
        } as GenieToolsDeps).find((t) => t.definition.name === 'agentinbox')!;
        const r = JSON.parse((await tool.handler({ terminalId: 'clerk', action: 'receive' } as never, { server: 'genie', tool: 'agentinbox', headers: {} })).text) as { messages: Array<Record<string, unknown>> };
        const fromSite = r.messages.find((m) => m.from === 'app:site:site_flabs');
        check(fromSite?.fromKind === 'app' && typeof fromSite?.note === 'string' && /not a person or an agent/.test(String(fromSite.note)), '4. receive marks it as an app’s and fences it as data', String(fromSite?.note ?? 'missing'));
        const reply = JSON.parse((await tool.handler({ terminalId: 'clerk', action: 'send', to: 'app:site:site_flabs', text: 'thanks' } as never, { server: 'genie', tool: 'agentinbox', headers: {} })).text) as { ok: boolean; error?: string };
        check(reply.ok === false && /cannot be replied to/.test(reply.error ?? ''), '4b. and the agent cannot reply to it', reply.error ?? '');

        // 7. Where the token is, and is not.
        const siteProc = composed.supervisor.list('fancy').find((s) => /dev server/.test(s.name));
        if (process.platform === 'linux' && siteProc?.pid) {
            let environ = '';
            try { environ = readFileSync(`/proc/${siteProc.pid}/environ`, 'utf8'); } catch { environ = ''; }
            // The pty's pid may be the shell; its node child is what serves. Read the tree's environs.
            let tree = environ;
            try { tree += execFileSync('sh', ['-c', `for p in $(pgrep -P ${siteProc.pid}); do cat /proc/$p/environ; done`], { encoding: 'utf8' }); } catch { /* none */ }
            check(tree.includes('GENIE_INBOX_TOKEN=gik_'), '7. CONTROL: the site process’s own environment holds its token', `pid ${siteProc.pid}`);
        } else {
            check(false, '7. CONTROL: the site process’s own environment holds its token', `not measured (${process.platform}, pid ${siteProc?.pid ?? 'none'})`);
        }
        check(!Object.keys(composed.engines.envFor('fancy')).includes('GENIE_INBOX_TOKEN'), '7b. the workspace’s service env (agents, terminals, .env) does not');
    } finally {
        for (const s of composed.supervisor.list()) composed.supervisor.stop(s.id);
        await composed.shutdown();
        await server.close();
        try { rmSync(root, { recursive: true, force: true }); } catch { /* the pty engine may still hold a file for a moment */ }
    }

    console.log(failures.length === 0 ? '\nALL PASS\n' : `\n${failures.length} FAILED: ${failures.join('; ')}\n`);
    process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => { console.error(error); process.exit(1); });
