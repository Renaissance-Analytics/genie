import { spawn } from 'node-pty';

const shell = process.env.COMSPEC || 'cmd.exe';
const p = spawn(shell, ['/c', 'echo hello-from-pty && exit'], {
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    name: 'xterm-color',
});

let out = '';
p.onData((d) => {
    out += d;
});
p.onExit(({ exitCode }) => {
    console.log('exit:', exitCode);
    console.log('captured (' + out.length + ' bytes):', JSON.stringify(out.slice(0, 200)));
    if (out.includes('hello-from-pty')) {
        console.log('PASS: pty worked');
        process.exit(0);
    } else {
        console.log('FAIL: pty did not return expected output');
        process.exit(1);
    }
});
