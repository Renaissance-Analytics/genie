/** Why did the approval not appear? Ask the app, rather than guess. */
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
    const f = JSON.parse(e.data);
    pending.get(f.id)?.(f);
    pending.delete(f.id);
});
const evaluate = (expression) =>
    new Promise((resolve) => {
        const n = ++id;
        pending.set(n, (f) => resolve(f.result?.result?.value ?? JSON.stringify(f.result?.result ?? f.error)));
        ws.send(JSON.stringify({
            id: n,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, awaitPromise: true },
        }));
    });

const codexId = await evaluate(`
    (async () => {
        const s = await window.genie.snapshot();
        const row = s.agents.find((a) => a.provider === 'codex');
        return row ? row.id : null;
    })()
`);
console.log('codex agent id:', codexId);

if (codexId) {
    console.log('\n--- before opening ---');
    console.log(await evaluate(`
        (async () => {
            const d = await window.genie.agentDetail(${JSON.stringify(codexId)});
            return JSON.stringify({ session: d?.session, refusal: d?.refusal, rows: d?.rows.length });
        })()
    `));

    console.log('\n--- opening the agent (starts or reattaches a session) ---');
    await evaluate(`window.genie.openAgent(${JSON.stringify(codexId)}); true`);
    await new Promise((r) => setTimeout(r, 3000));

    console.log(await evaluate(`
        (async () => {
            const d = await window.genie.agentDetail(${JSON.stringify(codexId)});
            return JSON.stringify({
                running: d?.session?.running ?? null,
                turnState: d?.session?.turnState ?? null,
                refusal: d?.refusal ?? null,
                rows: d?.rows.length ?? null,
            });
        })()
    `));

    console.log('\n--- prompting ---');
    await evaluate(`window.genie.prompt(${JSON.stringify(codexId)}, 'run the migration'); true`);
    await new Promise((r) => setTimeout(r, 4000));

    console.log(await evaluate(`
        (async () => {
            const d = await window.genie.agentDetail(${JSON.stringify(codexId)});
            return JSON.stringify({
                running: d?.session?.running ?? null,
                turnState: d?.session?.turnState ?? null,
                pendingApproval: d?.session?.pendingApproval ?? null,
                failure: d?.session?.failure ?? null,
                rows: d?.rows.length ?? null,
                kinds: (d?.rows ?? []).map((r) => r.event.kind + (r.event.sessionUpdate ? ':' + r.event.sessionUpdate : '')),
                mains: (d?.rows ?? []).map((r) => JSON.stringify(r.event).slice(0, 160)),
            }, null, 1);
        })()
    `));
}

ws.close();
