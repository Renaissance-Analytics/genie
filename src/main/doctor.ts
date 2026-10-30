import { app, BrowserWindow, ClipboardItem, clipboard, ipcMain } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentRecord, mintAgentId } from '../core/identity.js';
import { osaHomeFiles, writeOsaHome, type OsaFacts } from '../core/osa-home.js';
import { omarchyFacts } from './omarchy-skills.js';
import type { StreamEvent } from '../core/stream-event.js';
import { doctorDataTools } from './doctor-data.js';
import { DoctorRun } from './doctor-run.js';
import { doctorPrompt } from './doctor-prompt.js';
import { genieRunningNow } from './genie-running-file.js';
import { askAndWait, doctorTools, type DoctorOsa } from './doctor-mcp.js';
import { genieMcpServer } from './mcp-server.js';
import { genieHome, installDir } from './paths.js';
import { genieWindowIcon } from './app-identity.js';
import { SessionHost } from './session-host.js';
import { forwardRendererConsole } from '../core/render-error.js';
import { electronClipboardPort, registerClipboardIpc } from './clipboard-ipc.js';

/**
 * DOCTOR MODE (`genie --doctor`, the owner 2026-10-12): Genie with ONLY the Genie OSA, to diagnose the system and repair
 * the install. It does not even attempt to open Genie's configuration or database — no store, registry, settings, v1
 * import or reap, config sync, remote listener, pty host or knowledge graph (a test keeps those imports out of this
 * file) at boot; genie loads one workspace and one agent on demand, read only (doctor-data.ts). It must run beside a
 * Genie that is running or broken, so it takes its own per-user folder and lock and an MCP
 * port the OS picks, never the remembered one.
 *
 *  - The OSA runs in `<doctor>/osa`, a folder written from Genie's baked-in doctor instructions and the diagnostics
 *    skill (core/osa-home.ts), with every tool: the person is here, and repairs need the shell.
 *  - The doctor channel (main/doctor-mcp.ts) is how Claude Code talks to genie. Its URL and token are printed and
 *    written to `<doctor>/doctor-mcp.json`, never into Genie's data. The OSA is told of it only when it is first used.
 */
const OS_WORKSPACE = '__genie__';

function textOf(e: StreamEvent): string {
    const any = e as { text?: unknown; title?: unknown; path?: unknown };
    return typeof any.text === 'string' ? any.text : typeof any.title === 'string' ? any.title : typeof any.path === 'string' ? any.path : '';
}

export async function runDoctor(): Promise<void> {
    // Genie's own per-user folder, read BEFORE doctor mode takes a folder of its own (it is a fact for the OSA, not opened).
    const genieUserData = app.getPath('userData');
    const doctorDir = join(app.getPath('appData'), 'genie2-doctor');
    app.setPath('userData', doctorDir);
    // One doctor at a time; it never contends with Genie's lock, which lives in Genie's folder.
    if (!app.requestSingleInstanceLock()) {
        console.error('[doctor] Genie doctor mode is already running.');
        app.quit();
        return;
    }
    await app.whenReady();

    const facts: OsaFacts = { version: app.getVersion(), platform: process.platform, installDir: installDir(process.execPath), genieHome: genieHome(), userData: genieUserData, omarchy: await omarchyFacts() };
    const osaDir = join(doctorDir, 'osa');
    await writeOsaHome({
        dir: osaDir,
        files: osaHomeFiles('doctor', facts),
        fs: {
            read: async (p) => { try { return await readFile(p, 'utf8'); } catch { return null; } },
            write: async (p, text) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p, text, 'utf8'); },
        },
    });

    // GENIE'S OWN TOOLS IN DOCTOR MODE (the owner, 2026-10-13): Genie's data on demand — one workspace and one agent at a
    // time, read only (doctor-data.ts). Nothing under ~/.genie is opened until genie calls one of them.
    // …and ONE of them started, on its real thread with Genie's real tools — never while normal Genie runs (doctor-run.ts).
    const run = new DoctorRun({
        genieHome: genieHome(),
        // Doctor's own copies of Genie's stores when it runs beside a running Genie — in doctor's own folder, never Genie's.
        besideHome: join(doctorDir, 'beside'),
        genieRunning: () => genieRunningNow(genieHome()),
        // genie's NORMAL home (~/.genie/osa), exactly as normal Genie's boot writes it — it runs here as itself.
        prepareOsaHome: () => writeOsaHome({
            dir: join(genieHome(), 'osa'),
            files: osaHomeFiles('normal', facts),
            fs: {
                read: async (p) => { try { return await readFile(p, 'utf8'); } catch { return null; } },
                write: async (p, text) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p, text, 'utf8'); },
            },
        }).then(() => undefined),
    });
    const dataServer = genieMcpServer({ registrations: [...doctorDataTools({ genieHome: genieHome() }), ...run.tools()], port: 0 });
    const data = await dataServer.start();
    const host = new SessionHost({
        userData: doctorDir,
        mcpServersFor: () => [{ type: 'http', name: 'genie', url: data.url, headers: [{ name: 'Authorization', value: `Bearer ${data.token}` }] }],
    });
    const record = agentRecord({ id: mintAgentId(), workspaceId: OS_WORKSPACE, provider: 'claude', name: 'genie' });
    const started = host.start(record, osaDir);
    if (!started.ok) console.error(`[doctor] genie did not start: ${started.reason}`);

    const osa: DoctorOsa = {
        tell: async (text) => (host.prompt(record.id, text, 'doctor') ? { ok: true } : { ok: false, reason: 'genie is not running' }),
        ask: (text, timeoutMs) => askAndWait(host, record.id, text, timeoutMs),
        transcript: (limit) => host.rowsFor(record.id).slice(-limit).map((r) => ({ at: r.at, kind: r.event.kind, text: textOf(r.event) })),
        status: () => ({ ...(host.probe(record.id) ?? { running: false }) }),
    };
    const server = genieMcpServer({ registrations: doctorTools(osa, facts), port: 0 });
    const endpoint = await server.start();
    const connect = `claude mcp add --transport http genie-doctor ${endpoint.url} --header "Authorization: Bearer ${endpoint.token}"`;
    await writeFile(join(doctorDir, 'doctor-mcp.json'), `${JSON.stringify({ url: endpoint.url, token: endpoint.token, connect }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    console.log(`[doctor] Genie doctor mode — genie ${started.ok ? 'is running' : 'did not start'} in ${osaDir}`);
    console.log(`[doctor] Connect Claude Code: ${connect}`);

    // THE WINDOW: its own page and preload (`genieDoctor`), never Genie's renderer bridge.
    const here = dirname(fileURLToPath(import.meta.url));
    // The doctor's chat draws copy buttons: they write through main, as in Genie's own windows (main/clipboard-ipc.ts).
    registerClipboardIpc(ipcMain, electronClipboardPort(clipboard, ClipboardItem));
    ipcMain.handle('doctor:facts', () => facts);
    ipcMain.handle('doctor:connect', () => connect);
    ipcMain.handle('doctor:detail', () => ({
        agent: { id: record.id, name: record.name, provider: record.provider, fidelity: 'declared', cwd: osaDir },
        session: host.probe(record.id),
        rows: host.rowsFor(record.id),
        turns: host.turnsFor(record.id),
        cost: null,
    }));
    // Your message WITH its files (picked, dropped, pasted images): the same content-block path as Genie's composer.
    ipcMain.handle('doctor:prompt', (_e, text: unknown, files: unknown) => doctorPrompt(host, record.id, text, files));
    ipcMain.handle('doctor:start', () => host.start(record, osaDir));
    ipcMain.handle('doctor:answer-approval', (_e, optionId: unknown, note: unknown) => (typeof optionId === 'string' ? host.answerApproval(record.id, optionId, typeof note === 'string' ? note : '').ok : false));
    const win = new BrowserWindow({
        width: 1280,
        height: 840,
        title: 'Genie — doctor mode',
        // Genie's own icon (main/app-identity.ts): the doctor is Genie too, on the same taskbar button.
        ...genieWindowIcon(here),
        backgroundColor: '#09090b',
        show: false,
        webPreferences: { preload: join(here, 'doctor-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.once('ready-to-show', () => win.show());
    // The renderer's composer-focus log (genie#1235) and render errors (parity audit #7): written to main's log, as Genie's window does.
    win.webContents.on('console-message', (details) => forwardRendererConsole(details.message, { out: (l) => console.log(l), err: (l) => console.error(l), log: () => {} }));
    void win.loadFile(join(here, '../renderer/doctor.html'));
    // Pushed, never polled: every change to genie's session tells the window to read again.
    host.subscribe(() => { if (!win.isDestroyed()) win.webContents.send('doctor:changed'); });
    app.on('window-all-closed', () => app.quit());

    app.on('before-quit', () => {
        host.stop(record.id);
        void server.stop();
        void dataServer.stop();
        void run.stop();
    });
}
