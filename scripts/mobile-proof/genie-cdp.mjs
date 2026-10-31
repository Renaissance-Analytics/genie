/**
 * A minimal CDP client into Genie's main window (the mobile proofs, run INSIDE the test VM): evaluate an expression, send
 * any CDP command (a screenshot, a mouse move), and press Allow / Deny on "Pair this device?" as the owner would.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function genieWindow() {
    for (let i = 0; i < 120; i++) {
        try {
            const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
            const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url) && !/[?&](remote|view)=/.test(t.url));
            if (page) {
                const ws = new WebSocket(page.webSocketDebuggerUrl);
                await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
                let id = 0;
                const waiting = new Map();
                // Only an answer to a call THIS client made: a numeric id it is waiting on, whose waiter is a function.
                ws.onmessage = (e) => {
                    const m = JSON.parse(String(e.data));
                    if (typeof m.id !== 'number' || !waiting.has(m.id)) return;
                    const settle = waiting.get(m.id);
                    waiting.delete(m.id);
                    if (typeof settle === 'function') settle(m);
                };
                const send = (method, params = {}) => new Promise((resolve, reject) => {
                    const n = ++id;
                    waiting.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
                    ws.send(JSON.stringify({ id: n, method, params }));
                });
                const evaluate = async (expression) => {
                    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
                    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
                    return r.result?.value;
                };
                /**
                 * Run one of THIS script's own functions in the page with values passed as CDP arguments — never a
                 * selector, an id or an action spliced into code (CodeQL js/bad-code-sanitization).
                 */
                const call = async (fn, ...args) => {
                    const self = await send('Runtime.evaluate', { expression: 'globalThis' });
                    const r = await send('Runtime.callFunctionOn', { objectId: self.result.objectId, functionDeclaration: fn.toString(), arguments: args.map((value) => ({ value })), awaitPromise: true, returnByValue: true });
                    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'call failed');
                    return r.result?.value;
                };
                // Wait until the preload bridge is there.
                for (let j = 0; j < 60; j++) { if (await evaluate('typeof window.genie?.features?.act === "function"')) return { evaluate, call, send, close: () => ws.close() }; await sleep(500); }
            }
        } catch { /* not up yet */ }
        await sleep(1000);
    }
    throw new Error('Genie’s window never answered on CDP 9222');
}

/** Wait for a selector in Genie's window; resolves its text, or throws after `ms`. */
export async function waitInGenie(g, selector, ms = 30_000) {
    for (let waited = 0; waited < ms; waited += 250) {
        const text = await g.call((sel) => document.querySelector(sel)?.textContent ?? null, selector);
        if (text !== null) return text;
        await sleep(250);
    }
    throw new Error(`Genie’s window never showed ${selector}`);
}

/** The owner presses Allow (or Deny) on "Pair this device?" in Genie's window. Returns the prompt's words. */
export async function answerPairOnDesktop(g, allow) {
    const words = await waitInGenie(g, '[data-pair-prompt]');
    await g.call((action) => document.querySelector(`[data-action="${action}"]`).click(), allow ? 'allow-pair' : 'deny-pair');
    return words;
}
