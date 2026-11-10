import { runPublishCli } from '../src/main/publish-plugin.js';

process.exitCode = await runPublishCli(process.argv.slice(2), process.env, { out: line => console.log(line), error: line => console.error(line) });
