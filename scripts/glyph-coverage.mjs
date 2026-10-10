/**
 * WHICH CHARACTERS ACTUALLY DRAW, in a lean Linux container.
 *
 * `react-fancy`'s author asked a question they could not answer from where they are: of the
 * non-ASCII characters the kit can render, which come out as tofu on a machine with ordinary
 * font coverage? That is a measurement, and this takes it.
 *
 * ## How tofu is detected — and the first method that did not work
 *
 * A missing glyph renders as the font's `.notdef` box, and every missing glyph renders as the
 * SAME box. The obvious test is to compare each character's advance WIDTH against a
 * known-absent codepoint from a Private Use Area.
 *
 * **That cannot work in a monospace font**, where every glyph has the same advance width by
 * definition — tofu included. The method's own control caught it: an ASCII `A` measured
 * identical to tofu in the mono stack, which would have reported every mono character as
 * missing. A control that refuses to report is worth more than a result.
 *
 * So the characters are RASTERISED to a canvas and compared pixel by pixel. Tofu is a specific
 * bitmap; a real glyph is a different one. That works in both proportional and monospace faces
 * because it looks at what is drawn rather than at how much room it took.
 *
 * The control still runs first: an ASCII `A` must NOT match the tofu bitmap, or the method is
 * broken here and every answer below would be a false positive.
 */

const PORT = Number(process.env.CDP_PORT ?? 9222);

const SUBJECTS = [
    ['U+21C4', '⇄', 'ActivityLight direction="both"'],
    ['U+2190', '←', 'ActivityLight direction="in"'],
    ['U+2192', '→', 'ActivityLight / "Open workspace"'],
    ['U+2713', '✓', 'Checkbox tick'],
    ['U+2715', '✕', 'Checkbox cross'],
    ['U+25B2', '▲', 'Table sort ascending'],
    ['U+25BC', '▼', 'Table sort descending'],
    ['U+2726', '✦', 'MagicWand'],
    ['U+2212', '−', 'ImageViewer / diff minus'],
    ['U+2318', '⌘', 'Apple modifier key'],
    ['U+00B7', '·', 'separator, used throughout'],
    ['U+0394', 'Δ', 'think-token delta'],
    ['U+2193', '↓', 'the unseen pill'],

    /*
     * THE WGL4 THEORY, with its own control.
     *
     * react-fancy's author read the Liberation-only column and proposed that the band which
     * failed is WGL4 — the repertoire Liberation targets. If that holds, `direction="both"`
     * can be fixed with a DIFFERENT CHARACTER inside the covered set rather than an SVG icon,
     * which costs one character instead of five.
     *
     * They explicitly asked for the falsifier alongside the candidate, which is why both are
     * here: U+2194 is the proposal, U+21C6 is the near neighbour that should fail if the
     * theory is right. The rest probe the boundary, because confirming one candidate is not
     * testing a theory.
     */
    ['U+2194 cand', '↔', 'CANDIDATE for direction=both (WGL4: yes)'],
    ['U+21C6 ctrl', '⇆', 'CONTROL — should be tofu if WGL4 holds'],
    ['U+2195', '↕', 'WGL4 boundary: expected present'],
    ['U+21A8', '↨', 'WGL4 boundary: expected present'],
    ['U+25CA', '◊', 'WGL4 boundary: expected present'],
    ['U+2660', '♠', 'WGL4 boundary: expected present'],
    ['U+2756', '❖', 'Dingbats: expected tofu'],
];

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
    const frame = JSON.parse(e.data);
    pending.get(frame.id)?.(frame);
    pending.delete(frame.id);
});
const evaluate = (expression) =>
    new Promise((resolve) => {
        const n = ++id;
        pending.set(n, (f) => resolve(f.result?.result?.value));
        ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });

/*
 * Built as a plain string rather than a template literal: the page script contains backticks
 * and `${}` of its own, and nesting them inside a template is how a probe ends up measuring a
 * syntax error. Learned the hard way, one container run ago.
 */
const script = [
    '(() => {',
    '  const inkOf = (text, family) => {',
    '    const canvas = document.createElement("canvas");',
    '    canvas.width = 80; canvas.height = 80;',
    '    const ctx = canvas.getContext("2d");',
    '    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 80, 80);',
    '    ctx.fillStyle = "#000";',
    '    ctx.font = "48px " + family;',
    '    ctx.textBaseline = "middle";',
    '    ctx.fillText(text, 8, 40);',
    '    const data = ctx.getImageData(0, 0, 80, 80).data;',
    '    let signature = "";',
    '    for (let y = 0; y < 80; y += 4) {',
    '      for (let x = 0; x < 80; x += 4) {',
    '        let inked = 0;',
    '        for (let dy = 0; dy < 4; dy += 1) {',
    '          for (let dx = 0; dx < 4; dx += 1) {',
    '            if (data[((y + dy) * 80 + (x + dx)) * 4] < 128) inked += 1;',
    '          }',
    '        }',
    '        signature += inked > 1 ? "#" : ".";',
    '      }',
    '    }',
    '    return signature;',
    '  };',
    '  const sans = getComputedStyle(document.body).fontFamily;',
    '  const monoEl = document.querySelector("[data-route]");',
    '  const mono = monoEl ? getComputedStyle(monoEl).fontFamily : "monospace";',
    // A Private Use Area codepoint no font covers. Every missing glyph falls back to the same
    // .notdef box, so this IS the tofu bitmap.
    '  const TOFU = "\\uE123";',
    `  const chars = ${JSON.stringify(SUBJECTS.map(([, char]) => char))};`,
    '  const measure = (family) => ({',
    '    tofu: inkOf(TOFU, family),',
    '    control: inkOf("A", family),',
    '    subjects: chars.map((c) => inkOf(c, family)),',
    '  });',
    '  return JSON.stringify({',
    '    sans: measure(sans), mono: measure(mono), sansFamily: sans, monoFamily: mono,',
    '  });',
    '})()',
].join('\n');

const data = JSON.parse(await evaluate(script));

/** Two rasterisations are the same glyph when their ink signatures match exactly. */
const same = (a, b) => a === b;

console.log('\nGLYPH COVERAGE — measured in this container\n');
console.log(`  sans: ${data.sansFamily}`);
console.log(`  mono: ${data.monoFamily}\n`);

let methodOk = true;
for (const [label, m] of [['sans', data.sans], ['mono', data.mono]]) {
    if (same(m.control, m.tofu)) {
        console.log(`  !! ${label}: the ASCII control rasterises identically to tofu — the METHOD is`);
        console.log('     broken here, so every result below would be a false positive.');
        methodOk = false;
    }
}

if (methodOk) {
    console.log('  char       sans   mono   used by');
    const missing = [];

    SUBJECTS.forEach(([label, , usedBy], i) => {
        const sansTofu = same(data.sans.subjects[i], data.sans.tofu);
        const monoTofu = same(data.mono.subjects[i], data.mono.tofu);
        if (sansTofu || monoTofu) missing.push(`${label} (${usedBy})`);
        console.log(
            `  ${label.padEnd(10)} ${(sansTofu ? 'TOFU' : 'ok').padEnd(6)} ${(monoTofu ? 'TOFU' : 'ok').padEnd(6)} ${usedBy}`,
        );
    });

    console.log('');
    console.log(
        missing.length === 0
            ? '  Every character drew. Nothing to report upstream.'
            : `  MISSING: ${missing.join(', ')}`,
    );
}

ws.close();
