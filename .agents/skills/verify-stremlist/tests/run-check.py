#!/usr/bin/env python3
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import time
import traceback
import uuid


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
EVIDENCE = ROOT / 'test-results' / 'verify-stremlist-helper' / ('run-' + time.strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8])
HELPER = HERE.parent / 'scripts/run-check.sh'
FIXTURE = HERE / 'fixture.py'
SIGNAL_FIXTURE = HERE / 'signal-grace.sh'
RUN = EVIDENCE / 'cases'
RUN.mkdir(parents=True)
TOKEN = EVIDENCE.name
SELECTED = set(sys.argv[1:])
results = []
owned = {}
ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0)


def process(pid):
    try:
        raw = Path(f'/proc/{pid}/stat').read_text()
        fields = raw.rsplit(')', 1)[1].split()
        return {'pid': pid, 'state': fields[0], 'ppid': int(fields[1]),
                'pgid': int(fields[2]), 'sid': int(fields[3]),
                'start_ticks': fields[19],
                'cmdline': Path(f'/proc/{pid}/cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')}
    except (FileNotFoundError, ProcessLookupError):
        return None


def remember(pid, label, expected_start=None):
    state = process(pid)
    if state is not None:
        if expected_start is not None and state['start_ticks'] != expected_start:
            raise RuntimeError(f'PID reuse at {pid}')
        owned[pid] = {'label': label, 'start_ticks': state['start_ticks']}
    return state


def live(pid):
    state = process(pid)
    identity = owned.get(pid)
    return bool(state and identity and state['start_ticks'] == identity['start_ticks'] and state['state'] != 'Z')


def register_markers(case_dir):
    for name in ['reservation.json', 'command.json', 'listener.json']:
        path = case_dir / name
        if path.exists():
            entry = json.loads(path.read_text())
            if entry['token'] != TOKEN:
                raise RuntimeError('Unexpected fixture identity')
            remember(entry['pid'], str(path.relative_to(EVIDENCE)), entry['start_ticks'])
    if (case_dir / 'bash-pid').exists():
        remember(int((case_dir / 'bash-pid').read_text()), str(case_dir / 'bash-pid'))


def snapshot(case_dir, label, port=None):
    register_markers(case_dir)
    raw = {}
    for name, command in [('processes', ['ps', '-eo', 'pid,ppid,pgid,sid,stat,comm']),
                          ('listeners', ['ss', '-ltnp'])]:
        completed = subprocess.run(command, text=True, capture_output=True)
        (case_dir / f'{name}-{label}.raw').write_text(completed.stdout + completed.stderr)
        raw[name] = {'exit': completed.returncode, 'stdout': completed.stdout, 'stderr': completed.stderr}
    observed = [state for entry in Path('/proc').iterdir() if entry.name.isdigit() and (state := process(int(entry.name))) is not None]
    descendants = {os.getpid()}
    while True:
        added = {state['pid'] for state in observed if state['ppid'] in descendants} - descendants
        if not added:
            break
        descendants.update(added)
    for state in observed:
        if state['pid'] in descendants and state['pid'] != os.getpid():
            remember(state['pid'], 'observed exact descendant', state['start_ticks'])
    group_file = case_dir / 'helper' / 'process-group'
    if group_file.exists():
        group = int(group_file.read_text())
        raw['run_group'] = {'pgid': group, 'live_members': [state for state in observed if state['pgid'] == group and state['state'] != 'Z']}
        (case_dir / f'group-{label}.json').write_text(json.dumps(raw['run_group'], indent=2) + '\n')
    states = {str(pid): process(pid) for pid in owned}
    (case_dir / f'owned-{label}.json').write_text(json.dumps(states, indent=2) + '\n')
    if port is not None:
        selected = subprocess.run(['ss', '-H', '-ltnp', f'( sport = :{port} )'], text=True, capture_output=True)
        (case_dir / f'port-{label}.raw').write_text(selected.stdout + selected.stderr)
        raw['selected_port'] = {'exit': selected.returncode, 'stdout': selected.stdout, 'stderr': selected.stderr}
    return raw


def wait_for(path, task=None, timeout=6):
    deadline = time.monotonic() + timeout
    while not path.exists():
        if task is not None and task.poll() is not None:
            raise RuntimeError(f'Process exited {task.returncode} before {path}')
        if time.monotonic() > deadline:
            raise RuntimeError(f'Timed out awaiting {path}')
        time.sleep(0.02)


def kill_exact(pid, sig):
    state = process(pid)
    if state and state['state'] != 'Z':
        identity = owned.get(pid)
        if not identity or identity['start_ticks'] != state['start_ticks']:
            raise RuntimeError(f'Refusing to signal unowned or reused PID {pid}')
        os.kill(pid, sig)


def reap():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if pid == 0:
                break
        except ChildProcessError:
            break


def cleanup(case_dir):
    register_markers(case_dir)
    actions = []
    for pid in list(owned):
        if live(pid):
            kill_exact(pid, signal.SIGTERM)
            actions.append({'pid': pid, 'signal': 'TERM', 'label': owned[pid]['label']})
    deadline = time.monotonic() + 1
    while any(live(pid) for pid in owned) and time.monotonic() < deadline:
        time.sleep(0.03)
    for pid in list(owned):
        if live(pid):
            kill_exact(pid, signal.SIGKILL)
            actions.append({'pid': pid, 'signal': 'KILL', 'label': owned[pid]['label']})
    time.sleep(0.05)
    reap()
    (case_dir / 'harness-cleanup.json').write_text(json.dumps(actions, indent=2) + '\n')


def reserve(case_dir):
    command = [sys.executable, str(FIXTURE), 'reserve', str(case_dir), TOKEN, '0']
    stdout = (case_dir / 'reservation.stdout').open('w')
    stderr = (case_dir / 'reservation.stderr').open('w')
    task = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr)
    remember(task.pid, 'owned dynamic-port reservation helper')
    wait_for(case_dir / 'reservation.json', task)
    entry = json.loads((case_dir / 'reservation.json').read_text())
    return task, entry['port']


def release(reservation):
    reservation.communicate(input=b'release\n', timeout=5)
    if reservation.returncode != 0:
        raise RuntimeError('Reservation helper failed')


def run_case(name, *, mode=None, expected_exit=0, timeout=15, interrupt=False,
             expected_cleanup='PASS', expected_forced='no', remains=False, preexisting=False,
             interrupt_signal=signal.SIGTERM, locale_state=None, locale_probe=True):
    if SELECTED and name not in SELECTED:
        return
    case_dir = RUN / name
    case_dir.mkdir()
    row = {'case': name, 'status': 'could not run', 'assertions': [], 'evidence': str(case_dir.relative_to(EVIDENCE))}
    results.append(row)
    task = None
    reservation = None
    port = None
    try:
        if mode is not None or preexisting:
            reservation, port = reserve(case_dir)
            snapshot(case_dir, 'reserved', port)
        if preexisting:
            command = [sys.executable, '-c', 'from pathlib import Path; import sys; Path(sys.argv[1]).write_text("ran")', str(case_dir / 'must-not-run')]
        elif mode == 'signal':
            command = ['bash', str(SIGNAL_FIXTURE), str(case_dir), str(FIXTURE), TOKEN, str(port)]
        elif mode:
            command = [sys.executable, str(FIXTURE), mode, str(case_dir), TOKEN, str(port)]
        elif expected_exit == 7:
            command = ['bash', '-c', 'printf "child failure\\n" >&2; exit 7']
        elif locale_state is not None and locale_probe:
            command = [sys.executable, '-c', 'import json, os; print(json.dumps({"present": "LC_ALL" in os.environ, "value": os.environ.get("LC_ALL")}))']
        elif expected_exit in {129, 130}:
            command = ['bash', '-c', f'exit {expected_exit}']
        elif expected_exit == 124:
            command = ['sleep', '20']
        else:
            command = ['bash', '-c', 'printf "success\\n"; exit 0']
        full = [str(HELPER), str(case_dir / 'helper'), str(timeout), str(port) if port is not None else '-', *command]
        row['command'] = full
        (case_dir / 'invocation.sh').write_text(shlex.join(full) + '\n')
        if reservation is not None and not preexisting:
            release(reservation)
        before = snapshot(case_dir, 'before-launch', port)
        child_environment = None
        if locale_state is not None:
            child_environment = os.environ.copy()
            child_environment.pop('LC_ALL', None)
            if locale_state['present']:
                child_environment['LC_ALL'] = locale_state['value']
            row['supervisor_lc_all'] = locale_state
            (case_dir / 'lc-all-input.json').write_text(json.dumps(locale_state) + '\n')
        started = time.monotonic()
        task = subprocess.Popen(full, env=child_environment, stdout=(case_dir / 'supervisor.stdout').open('w'), stderr=(case_dir / 'supervisor.stderr').open('w'))
        remember(task.pid, 'run-check supervisor')
        if mode is not None:
            ready = case_dir / ('bash-ready' if mode == 'signal' else 'listener.json')
            wait_for(ready, task=task, timeout=6)
            row['child_ready_before_signal'] = ready.exists()
            register_markers(case_dir)
            snapshot(case_dir, 'running', port)
        if interrupt:
            row['signal_at_seconds'] = round(time.monotonic() - started, 6)
            row['supervisor_signal'] = signal.Signals(interrupt_signal).name
            (case_dir / 'delivered-signal.json').write_text(json.dumps({'signal': row['supervisor_signal'], 'pid': task.pid, 'start_ticks': owned[task.pid]['start_ticks'], 'child_ready': row.get('child_ready_before_signal')}) + '\n')
            kill_exact(task.pid, interrupt_signal)
        task.wait(timeout=35)
        row['exit'] = task.returncode
        row['elapsed_seconds'] = round(time.monotonic() - started, 6)
        after = snapshot(case_dir, 'after-helper', port)
        run_dir = case_dir / 'helper'
        for field, filename in [('recorded_exit', 'exit'), ('cleanup', 'cleanup'), ('forced_kill', 'forced-kill')]:
            row[field] = (run_dir / filename).read_text().strip() if (run_dir / filename).exists() else None
        row['assertions'].append({'name': f'process exit equals {expected_exit}', 'pass': task.returncode == expected_exit})
        row['assertions'].append({'name': 'recorded exit equals actual exit', 'pass': row['recorded_exit'] == str(task.returncode)})
        row['assertions'].append({'name': f'cleanup reports {expected_cleanup}', 'pass': bool(row['cleanup'] and row['cleanup'].startswith(expected_cleanup + ':'))})
        if expected_forced is not None:
            row['assertions'].append({'name': f'forced-kill equals {expected_forced}', 'pass': row['forced_kill'] == expected_forced})
        if expected_cleanup == 'PASS':
            row['assertions'].append({'name': 'PASS explicitly scopes group and selected ports and detached limitation', 'pass': all(text in row['cleanup'] for text in ['group', 'selected server-port', 'Detached processes require separate verification'])})
            row['assertions'].append({'name': 'helper records no live group members', 'pass': not (run_dir / 'processes-after-cleanup').read_text().strip()})
        if not preexisting:
            row['group_after_helper'] = after['run_group']
            row['assertions'].append({'name': 'independent OS inspection finds no live recorded-group members', 'pass': not after['run_group']['live_members']})
            row['assertions'].append({'name': 'helper cleanup records no live group members for this outcome', 'pass': not (run_dir / 'processes-after-cleanup').read_text().strip()})
        if interrupt:
            row['assertions'].append({'name': 'child readiness was observed before supervisor signal', 'pass': row.get('child_ready_before_signal') is True})
        if locale_state is not None and locale_probe:
            row['child_lc_all'] = json.loads((run_dir / 'stdout.log').read_text())
            row['assertions'].append({'name': 'child LC_ALL presence and value exactly match supervisor input', 'pass': row['child_lc_all'] == locale_state})
        if name in {'timeout-124', 'timeout-required-force'}:
            diagnostic = (run_dir / 'stderr.log').read_text()
            row['assertions'].append({'name': 'timeout TERM diagnostic uses C locale wording', 'pass': 'timeout: sending signal TERM to command ' in diagnostic})
            if expected_forced == 'yes':
                row['assertions'].append({'name': 'timeout KILL diagnostic uses C locale wording', 'pass': 'timeout: sending signal KILL to command ' in diagnostic})
        if port is not None:
            observed_listener = bool(after['selected_port']['stdout'].strip())
            row['assertions'].append({'name': 'selected listener remains until exact-PID cleanup' if remains else 'selected listener gone after helper', 'pass': observed_listener == remains})
            if not preexisting:
                entry = json.loads((case_dir / 'listener.json').read_text())
                group = int((run_dir / 'process-group').read_text())
                row['listener'] = entry
                row['run_group'] = group
                row['assertions'].append({'name': 'listener leaves recorded group' if mode == 'detached' else 'listener belongs to recorded group', 'pass': (entry['pgid'] != group) if mode == 'detached' else (entry['pgid'] == group)})
                row['assertions'].append({'name': 'listener PID live after helper' if remains else 'listener PID stopped after helper', 'pass': live(entry['pid']) == remains})
            else:
                row['assertions'].append({'name': 'occupied port is observed before launch', 'pass': bool(before['selected_port']['stdout'].strip())})
                row['assertions'].append({'name': 'pre-existing owner still live', 'pass': live(reservation.pid)})
                row['assertions'].append({'name': 'command never started', 'pass': not (case_dir / 'must-not-run').exists() and not (run_dir / 'process-group').exists()})
        if mode == 'signal':
            marker = case_dir / 'graceful-marker'
            row['assertions'].append({'name': 'Bash TERM trap writes marker after three-second teardown', 'pass': marker.exists() and marker.read_text().strip() == 'graceful teardown complete'})
            elapsed_after_signal = row['elapsed_seconds'] - row['signal_at_seconds']
            row['teardown_elapsed_seconds'] = elapsed_after_signal
            row['assertions'].append({'name': 'three-second trap was given time to complete', 'pass': 2.8 <= elapsed_after_signal < 9.8})
        if expected_forced == 'yes':
            elapsed = row['elapsed_seconds'] - row.get('signal_at_seconds', 0)
            row['assertions'].append({'name': 'forced group cleanup waits full ten-second grace', 'pass': 9.8 <= elapsed < 20})
        row['status'] = 'pass' if all(item['pass'] for item in row['assertions']) else 'fail'
    except Exception:
        row['error'] = traceback.format_exc()
        (case_dir / 'error.txt').write_text(row['error'])
    finally:
        if task is not None and task.poll() is None:
            kill_exact(task.pid, signal.SIGTERM)
            try:
                task.wait(timeout=15)
            except subprocess.TimeoutExpired:
                kill_exact(task.pid, signal.SIGKILL)
                task.wait(timeout=3)
        if reservation is not None and reservation.poll() is None and preexisting:
            release(reservation)
        cleanup(case_dir)
        final = snapshot(case_dir, 'after-owned-cleanup', port)
        if port is not None:
            row['assertions'].append({'name': 'exact-owned cleanup leaves selected port empty', 'pass': not final['selected_port']['stdout'].strip()})
        row['assertions'].append({'name': 'all registered owned PIDs stopped', 'pass': not any(live(pid) for pid in owned)})
        if row['status'] == 'pass' and not all(item['pass'] for item in row['assertions']):
            row['status'] = 'fail'
        (case_dir / 'result.json').write_text(json.dumps(row, indent=2) + '\n')
        print(json.dumps({'case': name, 'status': row['status'], 'exit': row.get('exit'), 'cleanup': row.get('cleanup'), 'elapsed': row.get('elapsed_seconds')}), flush=True)


def validation(name, command):
    if SELECTED and name not in SELECTED:
        return
    folder = RUN / name
    folder.mkdir()
    completed = subprocess.run(command, capture_output=True, text=True)
    (folder / 'command').write_text(shlex.join(command) + '\n')
    (folder / 'stdout').write_text(completed.stdout)
    (folder / 'stderr').write_text(completed.stderr)
    (folder / 'exit').write_text(str(completed.returncode) + '\n')
    row = {'case': name, 'status': 'pass' if completed.returncode == 0 else 'fail', 'exit': completed.returncode, 'command': command, 'evidence': str(folder.relative_to(EVIDENCE))}
    results.append(row)
    print(json.dumps(row), flush=True)


def invalid(name, arguments, existing=False):
    if SELECTED and name not in SELECTED:
        return
    folder = RUN / name
    folder.mkdir()
    target = folder / 'helper'
    if existing:
        target.mkdir()
        (target / 'sentinel').write_text('preserve\n')
    command = [str(HELPER), *[str(target) if arg == '@DIR' else arg for arg in arguments]]
    if command[-1:] == ['true']:
        command[-1:] = [sys.executable, '-c', 'from pathlib import Path; import sys; Path(sys.argv[1]).write_text("ran")', str(folder / 'must-not-run')]
    completed = subprocess.run(command, capture_output=True, text=True, timeout=5)
    (folder / 'command').write_text(shlex.join(command) + '\n')
    (folder / 'stdout').write_text(completed.stdout)
    (folder / 'stderr').write_text(completed.stderr)
    (folder / 'exit').write_text(str(completed.returncode) + '\n')
    assertions = [{'name': 'invalid invocation exits 2', 'pass': completed.returncode == 2},
                  {'name': 'command never started', 'pass': not (folder / 'must-not-run').exists()}]
    if existing:
        assertions.append({'name': 'existing evidence is preserved', 'pass': (target / 'sentinel').read_text() == 'preserve\n' and list(target.iterdir()) == [target / 'sentinel']})
    else:
        assertions.append({'name': 'invalid arguments create no helper evidence directory', 'pass': not target.exists()})
    row = {'case': name, 'status': 'pass' if all(a['pass'] for a in assertions) else 'fail', 'exit': completed.returncode, 'command': command, 'assertions': assertions, 'evidence': str(folder.relative_to(EVIDENCE))}
    results.append(row)
    (folder / 'result.json').write_text(json.dumps(row, indent=2) + '\n')
    print(json.dumps({'case': name, 'status': row['status'], 'exit': row['exit']}), flush=True)


initial = HELPER.read_bytes()
(RUN / 'run-check-tested.sh').write_bytes(initial)
(RUN / 'helper-sha256-before').write_text(hashlib.sha256(initial).hexdigest() + '\n')
(RUN / 'ownership-policy.txt').write_text('Signals target only child PIDs recorded with /proc start_ticks. Dynamic ports are reserved by owned Python loopback helpers. No group or name-based cleanup is performed by this test driver. Test-runner subreaper collects its own orphaned children.\n')
try:
    validation('bash-syntax', ['bash', '-n', str(HELPER)])
    validation('skill-local-links', [sys.executable, '-c', r"""
from pathlib import Path
import re
import sys
missing = []
for path in Path(sys.argv[1]).rglob('*.md'):
    for reference in re.findall(r'\]\(([^)]+)\)', path.read_text()):
        if '://' in reference or reference.startswith('#'):
            continue
        target = (path.parent / reference.split('#')[0]).resolve()
        if not target.exists():
            missing.append((str(path), reference))
assert not missing, missing
""", str(HERE.parent)])
    validation('executable-bit', ['test', '-x', str(HELPER)])
    run_case('success-0')
    run_case('child-failure-7', expected_exit=7)
    run_case('command-exit-129-policy', expected_exit=129, expected_cleanup='BLOCKED')
    run_case('command-exit-130-policy', expected_exit=130, expected_cleanup='BLOCKED')
    run_case('supervisor-sighup-after-child-ready', mode='listen', interrupt=True, interrupt_signal=signal.SIGHUP, expected_exit=129, expected_cleanup='BLOCKED')
    for name, state in [('locale-unset', {'present': False, 'value': None}),
                        ('locale-empty', {'present': True, 'value': ''}),
                        ('locale-C.UTF-8', {'present': True, 'value': 'C.UTF-8'})]:
        run_case(name, locale_state=state)
    run_case('timeout-124', expected_exit=124, timeout=1, expected_cleanup='BLOCKED')
    run_case('orphan-same-group-dynamic-listener', mode='orphan')
    run_case('supervisor-sigterm-three-second-trap', mode='signal', interrupt=True, expected_exit=143, expected_cleanup='BLOCKED')
    run_case('supervisor-sigterm-required-force', mode='ignore', interrupt=True, expected_exit=143, expected_cleanup='BLOCKED', expected_forced='yes')
    run_case('orphan-required-force', mode='orphan-ignore', expected_exit=1, expected_cleanup='BLOCKED', expected_forced='yes')
    run_case('detached-setsid-listener', mode='detached', expected_exit=1, expected_cleanup='BLOCKED', remains=True)
    run_case('preexisting-port-refuses-command', preexisting=True, expected_exit=2, expected_cleanup='BLOCKED', expected_forced=None, remains=True)
    run_case('timeout-required-force', mode='ignore', expected_exit=137, timeout=1, expected_cleanup='BLOCKED', expected_forced='yes', locale_state={'present': True, 'value': 'C.UTF-8'}, locale_probe=False)
    for name, args in [
        ('missing-all-args', []),
        ('missing-command', ['@DIR', '1', '-']),
        ('invalid-timeout-zero', ['@DIR', '0', '-', 'true']),
        ('invalid-timeout-text', ['@DIR', 'bad', '-', 'true']),
        ('invalid-ports-empty', ['@DIR', '1', '', 'true']),
        ('invalid-ports-zero', ['@DIR', '1', '0', 'true']),
        ('invalid-ports-leading-zero', ['@DIR', '1', '080', 'true']),
        ('invalid-ports-overflow', ['@DIR', '1', '65536', 'true']),
        ('invalid-ports-double-comma', ['@DIR', '1', '1234,,5678', 'true']),
        ('invalid-ports-trailing-comma', ['@DIR', '1', '1234,', 'true']),
        ('invalid-ports-mixed-dash', ['@DIR', '1', '-,1234', 'true']),
        ('invalid-ports-text', ['@DIR', '1', 'http', 'true']),
        ('invalid-ports-negative', ['@DIR', '1', '-1', 'true']),
        ('invalid-ports-whitespace', ['@DIR', '1', '1234 5678', 'true']),
    ]:
        invalid(name, args)
    invalid('existing-evidence-refused', ['@DIR', '1', '-', 'true'], existing=True)
finally:
    current = HELPER.read_bytes()
    (RUN / 'helper-sha256-after').write_text(hashlib.sha256(current).hexdigest() + '\n')
    results.append({'case': 'helper-unchanged-during-test', 'status': 'pass' if current == initial else 'fail'})
    reap()
    audit = [{'pid': pid, **identity, 'observed': process(pid), 'same_identity_live': live(pid)} for pid, identity in owned.items()]
    direct_children = Path(f'/proc/{os.getpid()}/task/{os.getpid()}/children').read_text().split()
    (RUN / 'final-owned-processes.json').write_text(json.dumps({'owned': audit, 'direct_children': direct_children}, indent=2) + '\n')
    results.append({'case': 'final-owned-process-audit', 'status': 'pass' if not any(item['same_identity_live'] for item in audit) and not direct_children else 'fail', 'evidence': str((RUN / 'final-owned-processes.json').relative_to(EVIDENCE))})
    (RUN / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    summary = {status: sum(r['status'] == status for r in results) for status in ['pass', 'fail', 'could not run']}
    payload = {'run': str(RUN), 'helper': str(HELPER), 'helper_sha256': hashlib.sha256(initial).hexdigest(), 'counts': summary, 'cases': results}
    (EVIDENCE / 'results.json').write_text(json.dumps(payload, indent=2) + '\n')
    lines = ['# Helper verification', '', f"Counts. {summary['pass']} pass, {summary['fail']} fail, {summary['could not run']} could not run.", '', f'Tested `{HELPER}`.', '', f'SHA-256 `{hashlib.sha256(initial).hexdigest()}`.', '', 'Raw evidence for each case is linked from results.json.', '', 'Expected BLOCKED outcomes verify the helper verdict, not application teardown.', '', '## Results', '']
    for row in results:
        lines.append(f"- {row['status']}. `{row['case']}`. Exit `{row.get('exit', 'n/a')}`.")
        for check in row.get('assertions', []):
            if not check['pass']:
                lines.append(f"  Failed assertion. {check['name']}.")
        if row.get('error'):
            lines.append('  Raw error is saved in the case evidence directory.')
    lines += ['', 'The harness signals only its own recorded PIDs after checking their start times. Detached and pre-existing listeners are verified alive until their owner explicitly cleans them. No application services or containers are started.', '']
    (EVIDENCE / 'REPORT.md').write_text('\n'.join(lines))
    print(json.dumps({'counts': summary, 'run': str(RUN)}), flush=True)
sys.exit(1 if summary['fail'] or summary['could not run'] else 0)
