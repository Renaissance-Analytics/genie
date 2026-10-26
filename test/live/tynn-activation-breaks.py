"""VM-only causal controls. Mutate one owned VM copy, require an assertion failure, restore exact bytes."""
import hashlib
import os
from pathlib import Path
import subprocess

if os.environ.get('GENIE_TEST_VM') != '1':
    raise SystemExit('Run in a test VM through the shared FIFO.')

controls = [
    ('main connection', 'src/main/main.ts',
     'const privateServers = await services.prepareAgentMcp(record, signal);', 'const privateServers = [];',
     'test/tynn-activation.test.ts', 'production main wires', 'main must prepare each session'),
    ('legacy cleanup', 'src/main/compose.ts',
     'await reconcileLegacyTynnConfig({ workspacePath, fs: nodeTynnConfigFs(workspacePath) });', 'void workspacePath;',
     'test/tynn-activation.test.ts', 'config sync removes the legacy shared credential', '.mcp.json must not contain'),
    ('agent identity isolation', 'src/main/compose.ts',
     'workspacePath: workspace.path, agent, signal, tynn:', "workspacePath: workspace.path, agent: { ...agent, id: 'agent_shared' }, signal, tynn:",
     'test/tynn-activation.test.ts', 'uses distinct keys', 'expected true to be false'),
    ('inherited denial', 'src/main/session-host.ts',
     "const inheritedPolicy = extras?.mcpServers?.some((server) => server.name === 'tynn') ? {} : { disabledMcpServers: ['tynn'] };", 'const inheritedPolicy = {};',
     'test/tynn-inherited-policy.test.ts', 'disables inherited Tynn', 'disabledMcpServers'),
    ('cancelled lookup', 'src/main/tynn-agent-identities.ts',
     "if (input.signal?.aborted) throw new ProvisionFailure('refused', 'Tynn agent credential preparation was cancelled.');",
     "if (false) throw new ProvisionFailure('refused', 'Tynn agent credential preparation was cancelled.');",
     'test/tynn-activation.test.ts', 'does not register or mint after Stop', 'cancelled lookup must not register an identity'),
    ('safe failure mapping', 'src/main/mcp-preparation-error.ts', 'MESSAGES[error.code]', 'error.message',
     'test/mcp-preparation-error.test.ts', 'fixed words', 'expected false to be true'),
]
Path('.patch').mkdir(exist_ok=True)
for index, (label, filename, before, after, testfile, pattern, expected) in enumerate(controls, 1):
    path = Path(filename)
    original = path.read_bytes()
    source = original.decode('utf-8')
    if source.count(before) != 1:
        raise SystemExit(f'Control source is not unique: {label}')
    try:
        path.write_text(source.replace(before, after), encoding='utf-8', newline='\n')
        result = subprocess.run(['npx', 'vitest', 'run', testfile, '--testNamePattern=' + pattern], text=True, capture_output=True, timeout=120)
        output = result.stdout + result.stderr
        Path(f'.patch/activation-control-{index}.log').write_text(output, encoding='utf-8')
        if result.returncode == 0 or 'AssertionError' not in output or expected not in output:
            for line in output.splitlines():
                if 'AssertionError:' in line or line.lstrip().startswith('FAIL '):
                    print(line, flush=True)
            raise SystemExit(f'Control did not fail for its intended reason: {label}; inspect .patch/activation-control-{index}.log')
    finally:
        path.write_bytes(original)
    if hashlib.sha256(path.read_bytes()).digest() != hashlib.sha256(original).digest():
        raise SystemExit(f'Control source was not restored: {label}')
    print(f'RED confirmed and exact source restored: {label}', flush=True)
print('PASS six causal activation controls, all sources restored.', flush=True)
