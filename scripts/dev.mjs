/**
 * `npm run dev` — what nextron used to orchestrate, as code we own (Tynn #449).
 *
 * Three processes: Vite for the renderer, `tsc --watch` for the main process, and Electron
 * once both have produced something to load. nextron did this; replacing it with a
 * dependency would be trading one opaque orchestrator for another, and this is forty lines.
 *
 * Everything is reaped on exit. A dev runner that leaks its children is how this machine
 * ended up with a `vite` burning 18.4 CPU-hours over nine days and a test runner holding
 * 12.5 GB for six days, because nothing reaped what was spawned.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_ENTRY = path.join(ROOT, 'app', 'background.js');
const children = [];

function run(label, command, args) {
    // `shell: true` on Windows: npm/vite/tsc resolve to `.cmd` shims there, which cannot be
    // executed directly — the "no pid" class of failure this repo has already paid for.
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', (code) => {
        if (code !== 0 && code !== null) console.error(`[dev] ${label} exited ${code}`);
    });
    children.push(child);
    return child;
}

function shutdown() {
    for (const child of children) {
        if (!child.killed) child.kill();
    }
}
for (const signal of ['SIGINT', 'SIGTERM', 'exit']) process.on(signal, shutdown);

run('vite', 'npx', ['vite', '--config', 'renderer/vite.config.mts']);
run('tsc', 'npx', ['tsc', '-p', 'main/tsconfig.json', '--watch', '--preserveWatchOutput']);

/**
 * Wait for the compiled main entry before launching Electron.
 *
 * Launching earlier fails with a bare "cannot find module" that reads as a broken install
 * rather than as a race, which is the kind of first-run confusion that costs an hour.
 */
let waited = 0;
const poll = setInterval(() => {
    if (fs.existsSync(MAIN_ENTRY)) {
        clearInterval(poll);
        console.log('[dev] main compiled — starting Electron');
        run('electron', 'npx', ['electron', '.']);
        return;
    }
    waited += 500;
    if (waited >= 60_000) {
        clearInterval(poll);
        console.error(`[dev] gave up waiting for ${MAIN_ENTRY} — is tsc failing above?`);
    }
}, 500);
