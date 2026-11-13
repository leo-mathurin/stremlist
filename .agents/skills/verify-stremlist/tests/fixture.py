#!/usr/bin/env python3
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time


mode, directory, token, port = sys.argv[1:]
directory = Path(directory)
port = int(port)


def record(name, **fields):
    fields.update(pid=os.getpid(), pgid=os.getpgrp(), sid=os.getsid(0), token=token)
    stat = Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()
    fields['start_ticks'] = stat[19]
    destination = directory / name
    temporary = destination.with_suffix('.writing')
    temporary.write_text(json.dumps(fields) + '\n')
    temporary.rename(destination)


if mode in {'orphan', 'orphan-ignore', 'detached'}:
    record('command.json', mode=mode)
    child_mode = 'ignore' if mode == 'orphan-ignore' else 'listen'
    command = [sys.executable, __file__, child_mode, str(directory), token, str(port)]
    if mode == 'detached':
        command.insert(0, 'setsid')
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 5
    while not (directory / 'listener.json').exists():
        if child.poll() is not None or time.monotonic() > deadline:
            raise RuntimeError('Listener did not start')
        time.sleep(0.01)
    print(f'{mode} listener ready at 127.0.0.1:{port}', flush=True)
    raise SystemExit(0)

if mode == 'ignore':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)

if mode == 'reserve':
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen()
    port = listener.getsockname()[1]
    record('reservation.json', port=port, mode=mode)
    sys.stdin.readline()
    listener.close()
    raise SystemExit(0)

listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(('127.0.0.1', port))
listener.listen()
record('listener.json', port=listener.getsockname()[1], mode=mode)
print(f'{mode} listener ready at 127.0.0.1:{listener.getsockname()[1]}', flush=True)
while True:
    signal.pause()
