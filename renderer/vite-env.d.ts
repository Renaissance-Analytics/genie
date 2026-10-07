/// <reference types="vite/client" />

/**
 * Ambient types for the renderer, replacing what Next used to supply (Tynn #449).
 *
 * `vite/client` is what declares side-effect imports of `*.css` — without it every
 * `import './x.css'` is a type error, because Next's own ambient declarations went away with
 * it. It also types `import.meta.env`.
 */
