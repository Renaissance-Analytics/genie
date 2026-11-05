/** Wait for React to create the app's bridge; preload may already answer before that happens. */
export async function waitForPageProbe(cdp) {
    let state = null;
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
        state = await cdp.evaluate('({ enabled: window.genieTestMode === true, bridge: typeof window.genieTest === "object", document: document.readyState })');
        if (state?.bridge) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`The app page bridge did not become available. Launch main with GENIE_PAGE_PROBE=1. Last state: ${JSON.stringify(state)}`);
}
