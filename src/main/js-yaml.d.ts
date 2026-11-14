/** Narrow declaration for the parser API used here; parsed configuration stays unknown until validated. */
declare module 'js-yaml' {
    const yaml: { load(text: string): unknown };
    export default yaml;
}
