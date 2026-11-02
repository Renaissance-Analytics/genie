/**
 * THE WINDOW HANDS OVER WHAT THE OS SAYS ABOUT PROXIES (P3.4 cut c). Electron reports no change of proxy settings, so this runs when a
 * window connects to its host and when the machine wakes. A host it could not resolve is left out, not sent as direct, so its last
 * answer stands.
 */
export async function reportProxyAnswers(options: {
    readonly hosts: readonly string[];
    resolve(url: string): Promise<string>;
    send(answers: Record<string, string>): Promise<void>;
    readonly log?: (line: string) => void;
}): Promise<void> {
    const answers: Record<string, string> = {};
    for (const host of options.hosts) {
        try {
            answers[host] = await options.resolve(host);
        } catch (error) {
            options.log?.(`proxy: the OS gave no answer for ${host}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (Object.keys(answers).length === 0) return;
    try {
        await options.send(answers);
    } catch (error) {
        options.log?.(`proxy: the host did not take the OS's answer: ${error instanceof Error ? error.message : String(error)}`);
    }
}
