# `@genie/plugin-sdk`

Type-safe authoring for `genie-plugin.json`, including MCP tools, declared Fancy
editors, and workspace panels. `definePlugin()` returns the manifest unchanged;
write its result as JSON for Genie to validate and install.

```ts
import { definePlugin } from '@genie/plugin-sdk';

export default definePlugin({
  id: 'com.example.board',
  namespace: 'board',
  name: 'Board',
  version: '1.0.0',
  contributes: {
    panels: [{
      id: 'main',
      title: 'Board',
      fancyComponent: {
        package: '@example/fancy-board',
        version: '^1.0.0',
        export: 'Board'
      }
    }]
  },
  capabilities: { genieApi: ['ui.panel'] }
});
```

Genie only mounts exports present in its vetted adapter registry. A declaration
does not execute arbitrary renderer code.
