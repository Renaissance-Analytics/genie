/**
 * The browser-side probe the Testing Browser tunnel fixture runs (genie#80).
 *
 * Kept as a standalone source string, separate from `tunnel.ts`, for two
 * reasons: `tunnel.ts` cannot be imported without Electron, and this script is
 * the part with real behaviour worth testing — see
 * `main/e2e/__tests__/tunnel-probe.test.ts`, which evaluates it against stubbed
 * browser globals and drives the same convergence loop the main process does.
 *
 * CONTRACT (the other half lives in `tunnel-legs.ts`):
 *   - `window.__tunnelProbe` holds the observed state. `running` is true while a
 *     pass is in flight, so a torn sample is never mistaken for a result.
 *   - `window.__tunnelRun(legs)` runs the named legs (all of them when omitted),
 *     recording per-leg failures in `errors` — which holds the MOST RECENT
 *     pass only, so a recovered leg clears its own error.
 *   - Legs re-run after the first pass are appended to `recovered`, so a
 *     genuinely intermittent tunnel is reported rather than swallowed.
 *   - The first pass is kicked off automatically on load.
 */
export const TUNNEL_PROBE_SCRIPT = `
  window.__tunnelProbe = {
    // True while a pass is in flight — the flags are partial and the error list
    // is half-written, so main must not conclude anything from them yet.
    running: true,
    origin: location.origin,
    absoluteScript: false,
    absoluteStyle: false,
    bearer: { ok: false, authorization: null },
    cookie: false,
    redirect: { ok: false, url: '' },
    stream: false,
    websocket: false,
    vite: { manifest: false, module: false, sourceMap: false, hmr: false, debugger: false },
    next: { module: false, sourceMap: false, fastRefresh: false },
    reverb: false,
    errors: [],
    recovered: [],
  };
  (function () {
    const p = window.__tunnelProbe;
    let pass = 0;
    // On a RETRY, re-request under a fresh URL: the browser caches a failed
    // fetch and records a failed module in its module map, so replaying the
    // same URL replays the stored failure instead of re-exercising the tunnel.
    // Both fixtures route on pathname, so the query is inert upstream.
    const bust = (url) =>
      pass < 2 ? url : url + (url.indexOf('?') === -1 ? '?' : '&') + 'pass=' + pass;
    const styled = () =>
      getComputedStyle(document.getElementById('style-probe')).color === 'rgb(1, 2, 3)';
    const inject = (el) => new Promise((resolve, reject) => {
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('subresource failed'));
      document.head.appendChild(el);
    });
    const socket = (url, protocols, read) => new Promise((resolve, reject) => {
      const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
      const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 3000);
      ws.onmessage = (event) => {
        clearTimeout(timeout);
        read(event);
        ws.close();
        resolve();
      };
      ws.onerror = () => { clearTimeout(timeout); ws.close(); reject(new Error('failed')); };
    });

    // ONE capability per leg, each re-runnable on its own. A leg reads its own
    // current state first, so a re-run only pays for what has not yet worked.
    const legs = {
      absoluteScript: async () => {
        if (window.__absoluteScriptLoaded !== true) {
          const el = document.createElement('script');
          el.src = bust('https://app.test/absolute.js');
          await inject(el);
        }
        p.absoluteScript = window.__absoluteScriptLoaded === true;
      },
      absoluteStyle: async () => {
        if (!styled()) {
          const el = document.createElement('link');
          el.rel = 'stylesheet';
          el.href = bust('https://app.test/absolute.css');
          await inject(el);
        }
        p.absoluteStyle = styled();
      },
      bearer: async () => {
        const response = await fetch('/api/bearer', {
          headers: { Authorization: 'Bearer fixture-application-token' },
        });
        p.bearer = await response.json();
      },
      cookie: async () => {
        await fetch('/api/cookie', { credentials: 'include' });
        p.cookie = (await (await fetch('/api/cookie-check', { credentials: 'include' })).json()).ok;
      },
      redirect: async () => {
        const response = await fetch('/redirect');
        const body = await response.json();
        p.redirect = { ok: body.ok === true, url: response.url };
      },
      stream: () => new Promise((resolve, reject) => {
        const events = new EventSource('/api/stream');
        const timeout = setTimeout(() => { events.close(); reject(new Error('timeout')); }, 3000);
        events.addEventListener('fixture', (event) => {
          clearTimeout(timeout);
          events.close();
          p.stream = event.data === 'stream-ok';
          resolve();
        });
        events.onerror = () => { clearTimeout(timeout); events.close(); reject(new Error('failed')); };
      }),
      websocket: () => socket('wss://' + location.host + '/ws', null, (event) => {
        p.websocket = event.data === 'ws-ok';
      }),
      'vite-manifest': async () => {
        const response = await fetch(bust('https://assets.dev.app.test/build/manifest.json'));
        const manifest = await response.json();
        p.vite.manifest = manifest['resources/js/app.ts'].isEntry === true;
      },
      'vite-module': async () => {
        await loadModule(bust('https://assets.dev.app.test/@vite/client'));
        p.vite.module = window.__viteClientLoaded === true;
        const response = await fetch(bust('https://assets.dev.app.test/@vite/client.map'));
        const sourceMap = await response.json();
        p.vite.sourceMap = sourceMap.sources.includes('/@vite/client');
      },
      'vite-hmr': () => socket('wss://assets.dev.app.test/hmr', 'vite-hmr', (event) => {
        p.vite.hmr = JSON.parse(String(event.data)).type === 'connected';
      }),
      'next-module': async () => {
        await loadModule(bust('https://next.dev.app.test/_next/static/chunks/app.js'));
        p.next.module = window.__nextDevChunkLoaded === true;
        const response = await fetch(bust('https://next.dev.app.test/_next/static/chunks/app.js.map'));
        const sourceMap = await response.json();
        p.next.sourceMap = sourceMap.sources.includes('webpack://app/page.tsx');
      },
      'next-fast-refresh': () => socket('wss://next.dev.app.test/_next/webpack-hmr', null, (event) => {
        p.next.fastRefresh = JSON.parse(String(event.data)).action === 'sync';
      }),
      reverb: () => socket('wss://ws.app.test/app/e2e-key?protocol=7&client=js', null, (event) => {
        p.reverb = JSON.parse(String(event.data)).event === 'pusher:connection_established';
      }),
    };

    // Main drives convergence: it re-runs ONLY the legs it has not yet observed
    // working. A leg that lost the warm-up race gets another honest attempt
    // instead of staying false for the rest of the run.
    window.__tunnelRun = async (names) => {
      p.running = true;
      pass += 1;
      const run = (names && names.length ? names : Object.keys(legs)).filter((n) => legs[n]);
      // Anything still being run after the first pass had already failed —
      // recorded so the spec can surface it rather than swallow it.
      if (pass > 1) {
        for (const name of run) {
          if (p.recovered.indexOf(name) === -1) p.recovered.push(name);
        }
      }
      const errors = [];
      await Promise.all(run.map(async (name) => {
        try { await legs[name](); } catch (error) { errors.push(name + ': ' + String(error)); }
      }));
      p.errors = errors;
      p.running = false;
    };
    window.__tunnelRun(Object.keys(legs));
  })();
`;

/**
 * The probe source ready to embed in a page.
 *
 * ESM dynamic `import()` is written as `loadModule(...)` in the source above so
 * the script can also be evaluated OUTSIDE a browser (the unit test hands it a
 * stub loader). In the page, `loadModule` is bound to the real dynamic import
 * here — the two dev-server companion legs still exercise a genuine module load
 * over the tunnel, exactly as before.
 */
export function tunnelProbeScript(): string {
    return `  const loadModule = (url) => import(url);\n${TUNNEL_PROBE_SCRIPT}`;
}
