/** Inspector evaluation can interrupt a native SQLite query's rowFactory.
 * Schedule fixture work on the ordinary event loop, after that stack unwinds. */
export function deferEvaluation<T>(work: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        setImmediate(() => {
            try { resolve(work()); } catch (error) { reject(error); }
        });
    });
}
