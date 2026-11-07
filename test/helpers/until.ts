/**
 * WAIT BY THE CLOCK, AND SAY SO. These tests counted ticks of 5 ms and then carried on silently. On Windows a timer can run at 15 ms, and an agent's first preparation runs a native ACL
 * call that took 4.7 s on the test VM, so the count ran out with the driver not made yet, and the next line read as "the agent got no key" (`expected null to be 'Bearer rpk_…'`).
 * The test had a fake keychain and a working mint: it had only stopped waiting. Its cleanup then deleted the folder under the running ACL call, which printed a failed ACL into the
 * next test.
 */
export async function until(done: () => boolean, ms = 60_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!done()) {
        if (Date.now() > deadline) throw new Error(`not within ${ms} ms: ${String(done)}`);
        await new Promise((r) => setTimeout(r, 5));
    }
}
