#!/usr/bin/env node
/**
 * THE RENDER PROBE (genie#1340), applied to the BUILD INPUT on a test VM only, never shipped: a counter at each place a
 * push can cost the window something — a pushed estate snapshot or agent detail, a render of the Shell, Sidebar, Agent
 * view, Stream, StreamRow and chat, each Agent-view effect that asks main for something, and react-fancy VirtualList's
 * row measuring — kept in `globalThis.__r`. measure.mjs reads it at the end of a run. Counts per second against pushes
 * per second say which work a push causes that its data did not change.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const C = (k) => `((globalThis.__r ??= {})[${JSON.stringify(k)}] = (globalThis.__r[${JSON.stringify(k)}] ?? 0) + 1);`;
const MARK = '/*probe-renders*/';

function insert(file, edits) {
    let src = readFileSync(file, 'utf8');
    if (src.includes(MARK)) return console.log(`already probed: ${file}`);
    for (const [anchor, key, where = 'after'] of edits) {
        const at = src.indexOf(anchor);
        if (at < 0) throw new Error(`anchor not found in ${file}: ${anchor}`);
        const pos = where === 'after' ? at + anchor.length : at;
        src = src.slice(0, pos) + ` ${MARK}${C(key)} ` + src.slice(pos);
    }
    writeFileSync(file, src);
    console.log(`probed ${file}: ${edits.map((e) => e[1]).join(', ')}`);
}

insert('src/renderer/App.tsx', [
    ['const off = bridge.subscribe((s) => {', 'push:snapshot'],
    ['off = bridge.subscribeAgent(id, (next) => {', 'push:detail'],
]);
insert('src/renderer/Shell.tsx', [['}: ShellProps) {', 'render:Shell']]);
insert('src/renderer/components/Sidebar.tsx', [['rateLimitAlert = null }: SidebarProps) {', 'render:Sidebar']]);
insert('src/renderer/components/ChatFlyout.tsx', [['}: ChatFlyoutProps) {', 'render:ChatFlyout']]);
insert('src/renderer/components/AgentView.tsx', [
    ['}: AgentViewProps) {', 'render:AgentView'],
    ['void readCommits(workspace.id, windowStart)', 'ipc:readCommits', 'before'],
    ['void files.state(workspace.id)', 'ipc:files.state', 'before'],
    ['void files.open(workspace.id, persona)', 'ipc:files.open(persona)', 'before'],
]);
insert('src/renderer/components/Stream.tsx', [['markup }: StreamProps) {', 'render:Stream']]);
insert('src/renderer/components/StreamRow.tsx', [['onSelect, markup }: StreamRowProps) {', 'render:StreamRow']]);

// react-fancy's VirtualList: each run of its measuring layout effect, and each row it measures.
const require = createRequire(join(process.cwd(), 'package.json'));
const fancyDir = dirname(require.resolve('@particle-academy/react-fancy'));
const { readdirSync } = await import('node:fs');
const chunk = readdirSync(fancyDir).map((f) => join(fancyDir, f)).find((f) => f.endsWith('.js') && readFileSync(f, 'utf8').includes('function VirtualList('));
if (!chunk) throw new Error('VirtualList not found');
insert(chunk, [
    ['    const win = windowRef.current;\n    if (!win) return;\n    let changed = false;', 'vl:measure-pass'],
    ['      const h = el.getBoundingClientRect().height;', 'vl:row-measured', 'before'],
]);
