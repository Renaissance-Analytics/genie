#!/usr/bin/env python3
"""
ARE KEYS TYPED BEFORE THE SHELL'S PROMPT LOST? A probe with no Genie in it (Tynn issue #692).

    python3 scripts/ci/early-keys-probe.py [rounds]

omarchy-test, 2026-11-11: the smoke typed into a terminal pane 1200 ms after it mounted, the shell's prompt drew at
1248 ms, and the typed command never showed (smoke 37 and 38); the next run, with the prompt a little earlier, passed.
So early keys can be lost on an Omarchy machine. This says WHERE, by leaving Genie out: a plain kernel pty, this
machine's bash, and a command written to it at once, before bash has read a byte.

  early / user's rc    the case in question: the machine's own bash start-up (prompt, mise, and whatever else it runs)
  early / --norc       CONTROL: bash with no start-up files; the kernel holds typed bytes until bash reads them
  late  / user's rc    CONTROL: the same command typed 4 s in, after the prompt; shows the probe can see a command run

Read it as: early/rc below the two controls = the shell's own start-up discards what was typed before its prompt, in
any terminal, and Genie's pane only shows it. early/rc as good as the controls = a plain pty keeps early keys here, so
keys lost in Genie's pane are lost by Genie. It also prints the questions the start-up asked the terminal (a start-up
that asks one and reads the answer can swallow typed bytes with it); the probe answers the two usual ones as a
terminal would.

It starts shells and nothing else. It always exits 0: it is a measurement, not a row.
"""
import os
import pty
import select
import sys
import time

ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 8
QUERIES = {b'\x1b[6n': b'\x1b[1;1R', b'\x1b[c': b'\x1b[?62;22c', b'\x1b[0c': b'\x1b[?62;22c'}


def one(norc: bool, delay: float, n: int):
    """One shell: type `echo EK_$((6*7))_n` after `delay` seconds; True when its OUTPUT (EK_42_n) comes back."""
    want = ('EK_42_%d' % n).encode()
    pid, fd = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        os.execvp('bash', ['bash'] + (['--norc', '--noprofile'] if norc else []) + ['-i'])
    typed = ('echo EK_$((6*7))_%d\n' % n).encode()
    started = time.monotonic()
    sent = False
    seen = b''
    asked = set()
    first_output = None
    ran = False
    try:
        while time.monotonic() - started < delay + 10:
            if not sent and time.monotonic() - started >= delay:
                os.write(fd, typed)
                sent = True
            readable, _, _ = select.select([fd], [], [], 0.05)
            if not readable:
                continue
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            if first_output is None:
                first_output = time.monotonic() - started
            seen += chunk
            for question, answer in QUERIES.items():
                if question in chunk:
                    asked.add(question)
                    os.write(fd, answer)
            if want in seen:
                ran = True
                break
    finally:
        try:
            os.write(fd, b'\nexit\n')
        except OSError:
            pass
        time.sleep(0.2)
        try:
            os.kill(pid, 9)
        except OSError:
            pass
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass
        os.close(fd)
    return ran, first_output, asked


def row(name: str, norc: bool, delay: float):
    ran = 0
    firsts = []
    asked = set()
    for n in range(ROUNDS):
        ok, first, questions = one(norc, delay, n)
        ran += 1 if ok else 0
        if first is not None:
            firsts.append(first)
        asked |= questions
    first_ms = '%d-%d' % (min(firsts) * 1000, max(firsts) * 1000) if firsts else 'none'
    print('EARLY_KEYS %-18s the command ran in %d of %d shells; first output after %s ms; terminal questions asked: %s'
          % (name, ran, ROUNDS, first_ms, sorted(repr(q) for q in asked) or 'none'), flush=True)


print('EARLY_KEYS bash: %s' % os.popen('bash --version | head -1').read().strip(), flush=True)
row('late/rc (control)', False, 4.0)
row('early/norc (control)', True, 0.0)
row('early/rc', False, 0.0)
