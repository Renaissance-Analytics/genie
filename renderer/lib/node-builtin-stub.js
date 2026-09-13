// The browser stand-in for Node built-ins (`fs`, `path`, `os`) that some Fancy
// dependencies reach for. The renderer has no Node access, so they resolve here —
// see `turbopack.resolveAlias` in renderer/next.config.js.
module.exports = {};
