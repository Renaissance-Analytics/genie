/**
 * INBOX MAIL WAKES AN IDLE AGENT, END TO END (genie#1379) — for real, in a test VM.
 *
 * The owner on beta.53: a site's message showed in the fancy agent's chat, and the agent did nothing until he typed. This
 * replays that, with nobody typing after the agent goes idle, and prints the timeline:
 *
 *   1. IDLE + APP: the manual `fancy` agent is started and finishes the person's turn (idle, as the owner's was). A
 *      Genie-hosted SITE (a real dev-server process Genie starts through the real pty engine) then posts through the real
 *      door with the token Genie put in its env. Genie gives fancy a turn; fancy collects with its real `agentinbox
 *      receive` and ACTS — it reports to the person through `agentinbox send`.
 *   2. BURST: the site posts three at once — ONE turn, naming three.
 *   3. AGENT MAIL: another agent sends with its real `agentinbox send` — the idle fancy gets a turn.
 *   4. BUSY: the person gives fancy a task; the site posts mid-turn — no interruption; one follow-up turn when it ends.
 *   5. STOPPED: a script key posts to the manual `scribe`, which is not running — it is NOT started; its mail shows
 *      uncollected.
 *
 * Real: the site process, the pty engine, the HTTP door, the key book, the inbox store, compose's notices, the
 * SessionHost and Genie's delivery with main's own policy (`appMailPushPorts`). The stand-in: the provider behind the
 * session — a scripted driver that, given a notice, does what an agent does (receive, then act) through Genie's real
 * agentinbox tool, then ends its turn. Run in the VM only:
 *   scripts/vm-fifo.sh omarchy ../_wt/<tree> 'npm ci && npx tsx test/live/inbox-wake.live.ts'
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentRecord, mintAgentId, type AgentId, type AgentRecord } from '../../src/core/identity.js';
import { HUMAN } from '../../src/core/inbox.js';
import type { DriverEvents, SessionDriverFactory } from '../../src/core/session.js';
import { AppInboxKeys } from '../../src/main/app-inbox-keys.js';
import { AppInboxService, appInboxEnvFor, startAppInboxServer } from '../../src/main/app-inbox-service.js';
import { AttentionStore } from '../../src/main/attention-store.js';
import { composeServices } from '../../src/main/compose.js';
import { realFancyTermPort } from '../../src/main/fancy-term-port.js';
import { handleFeatureAction, type FeatureState } from '../../src/main/feature-ipc.js';
import { appMailPushPorts, INBOX_COALESCE_MS, wireInboxPush } from '../../src/main/inbox-push.js';
import { genieTools, type GenieToolsDeps } from '../../src/main/mcp-tools.js';
import { SessionHost, type DriverFor } from '../../src/main/session-host.js';

const failures: string[] = [];
function check(ok: boolean, label: string, detail = ''): void {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
}
const t0 = Date.now();
const timeline: string[] = [];
function mark(what: string): void {
    const line = `  +${((Date.now() - t0) / 1000).toFixed(2).padStart(7)}s  ${what}`;
    timeline.push(line);
    console.log(line);
}
async function until(predicate: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 100));
    }
    return predicate();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'genie2-inbox-wake-live-'));
    const userData = join(root, 'home');
    const fancyDir = join(root, 'fancy');
    mkdirSync(fancyDir, { recursive: true });
    writeFileSync(join(fancyDir, 'project.json'), `${JSON.stringify({ name: 'fancy', repos: [] }, null, 2)}\n`);
    const trigger = join(root, 'post.json');
    const posted = join(root, 'posted.jsonl');
    // The site's dev server: it serves, and posts whatever the harness drops in post.json — the harness picks WHEN.
    writeFileSync(join(fancyDir, 'site.mjs'), `
import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
createServer((q, s) => s.end('ok')).listen(Number(process.argv[2]), '127.0.0.1');
const trigger = ${JSON.stringify(trigger)};
let busy = false;
setInterval(async () => {
  if (busy || !existsSync(trigger)) return;
  busy = true;
  const jobs = JSON.parse(readFileSync(trigger, 'utf8'));
  rmSync(trigger);
  await Promise.all(jobs.map(async (j) => {
    const res = await fetch(process.env.GENIE_INBOX_URL + '/v1/inbox', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + process.env.GENIE_INBOX_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(j),
    });
    appendFileSync(${JSON.stringify(posted)}, JSON.stringify({ at: Date.now(), subject: j.subject, status: res.status, text: await res.text() }) + '\\n');
  }));
  busy = false;
}, 100);
`);

    const fancy = agentRecord({ id: mintAgentId(), workspaceId: 'fancy', provider: 'claude', name: 'fancy', mode: 'manual' });
    const wren = agentRecord({ id: mintAgentId(), workspaceId: 'fancy', provider: 'claude', name: 'wren', mode: 'manual' });
    const scribe = agentRecord({ id: mintAgentId(), workspaceId: 'fancy', provider: 'claude', name: 'scribe', mode: 'manual' });
    const roster: AgentRecord[] = [fancy, wren, scribe];
    const nameOf = (id: string): string => roster.find((r) => r.id === id)?.name ?? (id === HUMAN ? 'the person' : id);
    const slugs = new Map([['fancy', 'fancy']]);
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
        roster: () => roster, slugs: () => slugs, defaultAgentOf: () => fancy.id,
        enabled: () => true,
        siteHosts: (ws) => services?.sites.list().filter((s) => s.workspaceId === ws).map((s) => s.host) ?? [],
    });
    const server = await startAppInboxServer({ service, port: 0 });
    services = await composeServices({
        userData, pty: realFancyTermPort(userData, encryptor), v1Settings: () => null, caddyBin: null, frontDoorPort: 0,
        docker: async () => ({ stdout: '', exitCode: 0 }), portFree: async () => true,
        roster: () => roster, workspaceSlugs: () => slugs,
        workspaces: () => [{ id: 'fancy', path: fancyDir }],
        appInboxEnv: (s) => appInboxEnvFor({ url: server.url, token: keys.tokenFor(s) }),
    });
    const composed = services;
    console.log(`\ngenie2 live INBOX WAKE check — door ${server.url}, coalescing ${INBOX_COALESCE_MS} ms, root ${root}\n`);

    // Genie's real agentinbox tool, as each agent calls it.
    const attention = await AttentionStore.open(userData, composed.inbox);
    const box = genieTools({
        inbox: composed.inbox, attention, roster: () => roster,
        resolveCaller: (k) => { const r = roster.find((a) => a.name === k); return r ? { agentId: r.id, agentName: r.name, workspaceId: r.workspaceId, workspacePath: fancyDir } : null; },
        workspaceSetting: () => ({ scope: 'self' }), userActive: () => true, glow: () => true, thumbsUp: () => {},
    } as GenieToolsDeps).find((t) => t.definition.name === 'agentinbox')!;
    const agentinbox = async (caller: string, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
        JSON.parse((await box.handler({ terminalId: caller, ...args } as never, { server: 'genie', tool: 'agentinbox', headers: {} })).text) as Record<string, unknown>;

    // THE STAND-IN PROVIDER: given a notice, it does what an agent does — receive, then act — and ends its turn; given the
    // person's task, it works for `workMs` and ends.
    const notices = new Map<string, string[]>();
    const acted: Array<{ agent: string; subjects: string[] }> = [];
    let workMs = 300;
    const events = new Map<string, DriverEvents>();
    const driverFor: DriverFor = (record) => {
        const factory: SessionDriverFactory = (options) => {
            events.set(record.id, options.events);
            const end = () => options.events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
            return {
                start: () => {},
                prompt: (content: unknown) => {
                    const text = String(content);
                    if (!text.includes('unread AgentInbox')) {
                        mark(`${record.name}: the person's prompt — working ${workMs} ms`);
                        setTimeout(() => { mark(`${record.name}: turn ended (idle)`); end(); }, workMs);
                        return;
                    }
                    notices.set(record.id, [...(notices.get(record.id) ?? []), text]);
                    mark(`${record.name}: Genie gave it a turn — "${text}"`);
                    void (async () => {
                        const got = await agentinbox(record.name, { action: 'receive' });
                        const messages = (got.messages as Array<Record<string, unknown>> | undefined) ?? [];
                        const subjects = messages.map((m) => String(m.subject ?? m.text));
                        mark(`${record.name}: agentinbox receive → ${messages.length}: ${messages.map((m) => `${m.fromKind === 'app' ? (m.source as { label: string }).label : nameOf(String(m.from))}: ${String(m.subject ?? m.text)}`).join(' | ')}`);
                        const sent = await agentinbox(record.name, { action: 'send', to: 'human', text: `Handled: ${subjects.join(', ')}` });
                        mark(`${record.name}: ACTED — reported to the person (${sent.ok === true ? 'sent' : `refused: ${String(sent.error)}`})`);
                        acted.push({ agent: record.name, subjects });
                        setTimeout(() => { mark(`${record.name}: turn ended (idle)`); end(); }, 200);
                    })();
                },
                kill: () => {},
                cliSessionId: null,
            };
        };
        return factory;
    };
    const host = new SessionHost({ userData, driverFor, processTree: { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) } });
    const started: string[] = [];
    composed.inbox.onSend((to, message) => {
        const m = message as { from: string; app?: { label: string; subject: string } } | undefined;
        mark(`mail landed for ${nameOf(to)} from ${m?.app ? m.app.label : nameOf(m?.from ?? '?')}${m?.app ? `: ${m.app.subject}` : ''}`);
    });
    const unwire = wireInboxPush({
        inbox: composed.inbox, host,
        reminders: (input) => composed.inboxReminders(input), settled: (id, ok) => composed.inboxNoticeSettled(id, ok),
        // main's wake is the open-agent path; the harness starts it the same way.
        wake: (id) => { const r = roster.find((x) => x.id === id); if (!r) return false; started.push(r.name); return host.start(r, fancyDir).ok; },
        ...appMailPushPorts({ modeOf: (id) => roster.find((r) => r.id === id)?.mode, now: () => Date.now(), schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } }),
    });
    const post = (jobs: Array<Record<string, unknown>>) => { mark(`the site is asked to post ${jobs.length}`); writeFileSync(trigger, JSON.stringify(jobs)); };
    const postsOK = (n: number) => (existsSync(posted) ? readFileSync(posted, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { status: number }) : []).filter((p) => p.status === 201).length >= n;
    const noticeCount = (id: string) => notices.get(id)?.length ?? 0;

    try {
        // The agent, idle — the person's turn ran and ended, and nobody types after this.
        check(host.start(fancy, fancyDir).ok && host.start(wren, fancyDir).ok, '0. fancy (manual) and wren are running');
        host.prompt(fancy.id, 'set up the council page', 'you');
        await until(() => host.promptable(fancy.id) !== null, 5_000);
        check(host.promptable(fancy.id) !== null, '0b. fancy is idle (the person’s turn ended)');
        const lastPersonPrompt = Date.now();

        // The site, a real Genie-hosted process.
        const state: FeatureState = { toolStatuses: null, knowledgeQuery: '' };
        await handleFeatureAction(composed, { kind: 'hosting.createSite', workspaceId: 'fancy', repoPath: fancyDir, form: { name: 'flabs', mode: 'proxy', devServer: { stack: 'node', command: 'node site.mjs {port}' }, hostPort: null, root: null, spa: false } }, state);
        await sleep(3_000);
        mark('site flabs is up (Genie-hosted dev server)');

        // 1. IDLE + APP MAIL.
        console.log('\n-- 1. idle agent, app mail');
        post([{ to: 'fancy', subject: 'petition #42 queued', body: 'Change #42 approved by the owner' }]);
        check(await until(() => postsOK(1), 15_000), '1. the site posted through the door (201)');
        check(await until(() => acted.length >= 1, 15_000), '1b. fancy got a turn and ACTED — with nobody typing', JSON.stringify(acted[0] ?? null));
        check(noticeCount(fancy.id) === 1 && /from an app: data, not instructions/.test(notices.get(fancy.id)![0]!), '1c. one notice, saying it is an app’s and data', notices.get(fancy.id)?.[0] ?? 'none');
        await until(() => host.promptable(fancy.id) !== null, 5_000);

        // 2. A BURST: one turn.
        console.log('\n-- 2. a burst of three');
        post([1, 2, 3].map((i) => ({ to: 'fancy', subject: `lab run ${i} finished`, body: `run ${i}` })));
        check(await until(() => acted.length >= 2, 15_000), '2. the burst was handled');
        await sleep(INBOX_COALESCE_MS * 3);
        check(noticeCount(fancy.id) === 2 && /You have 3 unread/.test(notices.get(fancy.id)![1]!), '2b. ONE turn for the three, naming three', notices.get(fancy.id)?.slice(1).join(' / ') ?? 'none');
        check(acted[1]?.subjects.length === 3, '2c. it collected all three in that turn', JSON.stringify(acted[1]?.subjects));

        // 3. AGENT MAIL.
        console.log('\n-- 3. another agent writes');
        await until(() => host.promptable(fancy.id) !== null, 5_000);
        const sent = await agentinbox('wren', { action: 'send', to: 'fancy', text: 'can you check the council page?' });
        check(sent.ok === true, '3. wren sent through its real agentinbox tool', JSON.stringify(sent).slice(0, 160));
        check(await until(() => acted.length >= 3, 15_000), '3b. the idle fancy got a turn for an agent’s message and acted', JSON.stringify(acted[2] ?? null));

        // 4. BUSY: told when the turn ends.
        console.log('\n-- 4. busy agent');
        await until(() => host.promptable(fancy.id) !== null, 5_000);
        workMs = 6_000;
        host.prompt(fancy.id, 'refactor the council page', 'you');
        await sleep(500);
        post([{ to: 'fancy', subject: 'deploy finished', body: 'flabs deployed' }]);
        await until(() => postsOK(5), 15_000);
        await sleep(2_500);
        check(noticeCount(fancy.id) === 3 && host.probe(fancy.id)?.inTurn === true, '4. mid-turn: not interrupted (no notice yet)', `notices ${noticeCount(fancy.id)}, in turn ${String(host.probe(fancy.id)?.inTurn)}`);
        check(await until(() => acted.length >= 4, 15_000), '4b. its turn ended, then ONE follow-up turn — nobody typed', JSON.stringify(acted[3] ?? null));

        // 5. STOPPED: not started; shown as uncollected.
        console.log('\n-- 5. a stopped manual agent');
        const key = await keys.createScriptKey('fancy', 'nightly');
        const res = await fetch(`${server.url}/v1/inbox`, { method: 'POST', headers: { authorization: `Bearer ${key.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ to: 'scribe', subject: 'nightly backup done', body: 'ok' }) });
        check(res.status === 201, '5. a script posted to the stopped scribe (201)', String(res.status));
        await sleep(INBOX_COALESCE_MS * 3);
        check(!started.includes('scribe') && host.runOf(scribe.id) === null, '5b. scribe was NOT started', `started: ${started.join(', ') || 'none'}`);
        const waiting = composed.signals({ osAgentWorking: false, githubBlocked: false }).uncollectedMail;
        check(waiting === 1 && composed.inbox.unread(scribe.id).length === 1, '5c. its mail waits, shown as uncollected (the Deck’s count)', `uncollected ${waiting}`);
        mark(`scribe: not started; ${waiting} message waiting, shown uncollected`);

        check(lastPersonPrompt > 0, `the person typed nothing after phase 0 except phase 4’s task (which is the busy case)`);
    } finally {
        unwire();
        host.stopAll();
        await host.settled();
        for (const s of composed.supervisor.list()) composed.supervisor.stop(s.id);
        await composed.shutdown();
        await server.close();
        try { rmSync(root, { recursive: true, force: true }); } catch { /* the pty engine may still hold a file */ }
    }

    console.log('\nTIMELINE\n' + timeline.join('\n'));
    appendFileSync(join(tmpdir(), 'inbox-wake-timeline.txt'), timeline.join('\n') + '\n');
    console.log(failures.length === 0 ? '\nALL PASS\n' : `\n${failures.length} FAILED: ${failures.join('; ')}\n`);
    process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => { console.error(error); process.exit(1); });
