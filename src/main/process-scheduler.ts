// RED-PHASE STUB (genie#1204): the shape the tests call, with no behaviour yet.
export class ProcessScheduler {
    constructor(_deps: unknown) {}
    plan(): void {}
    async runNow(_id: string): Promise<string> { return 'skipped'; }
    async settled(): Promise<void> {}
}
