#!/usr/bin/env bash
set -uo pipefail

if (( $# < 4 )) || [[ ! $2 =~ ^[1-9][0-9]*$ ]] || [[ ! $3 =~ ^(-|[1-9][0-9]{0,4}(,[1-9][0-9]{0,4})*)$ ]]; then
	printf 'Usage: %s NEW_EVIDENCE_DIR TIMEOUT_SECONDS SERVER_PORTS_OR_DASH COMMAND [ARGS...]\n' "$0" >&2
	exit 2
fi

run_dir=$1
timeout_seconds=$2
server_ports=$3
cleanup_grace_seconds=10
shift 3
if [[ $server_ports != - ]]; then
	IFS=, read -r -a ports <<< "$server_ports"
	for port in "${ports[@]}"; do
		if (( port > 65535 )); then
			printf 'Invalid server port %s; require 1 through 65535.\n' "$port" >&2
			exit 2
		fi
	done
fi
mkdir "$run_dir" || exit 2
pwd > "$run_dir/cwd"
printf '%q ' "$@" > "$run_dir/command"
printf '\n' >> "$run_dir/command"
printf '%s\n' "$$" > "$run_dir/supervisor-pid"
printf '%s\n' "$server_ports" > "$run_dir/server-ports"

capture_listeners() {
	ss -ltnp > "$run_dir/listeners-$1" || return 1
	awk -v ports="$server_ports" 'BEGIN { split(ports, p, ","); for (i in p) wanted[p[i]] = 1 } { n = split($4, address, ":"); if (wanted[address[n]]) print }' \
		"$run_dir/listeners-$1" > "$run_dir/server-listeners-$1"
}

if ! capture_listeners before || [[ -s "$run_dir/server-listeners-before" ]]; then
	printf 'BLOCKED: server-port preflight failed; command was not started.\n' > "$run_dir/cleanup"
	printf '2\n' > "$run_dir/exit"
	exit 2
fi

child_environment=(env -u LC_ALL)
if [[ ${LC_ALL+x} ]]; then
	child_environment=(env "LC_ALL=$LC_ALL")
fi
LC_ALL=C setsid --wait timeout --verbose --signal=TERM --kill-after="${cleanup_grace_seconds}s" "${timeout_seconds}s" "${child_environment[@]}" "$@" > "$run_dir/stdout.log" 2> "$run_dir/stderr.log" &
run_group=$!
printf '%s\n' "$run_group" > "$run_dir/process-group"

capture_group() {
	ps -eo pid,ppid,pgid,stat,comm | awk -v group="$run_group" '$3 == group && $4 !~ /^Z/' > "$run_dir/processes-$1"
}

finish() {
	result=$?
	trap - EXIT HUP INT TERM
	cleanup_failed=0
	forced_kill=no
	capture_group before-cleanup || cleanup_failed=1
	if kill -0 -- "-$run_group" 2>/dev/null; then
		kill -TERM -- "-$run_group" 2>/dev/null || true
		for (( attempt=0; attempt<cleanup_grace_seconds*10; attempt++ )); do
			capture_group during-cleanup || { cleanup_failed=1; break; }
			[[ -s "$run_dir/processes-during-cleanup" ]] || break
			sleep 0.1
		done
		if [[ -s "$run_dir/processes-during-cleanup" ]]; then
			forced_kill=yes
			kill -KILL -- "-$run_group" 2>/dev/null || true
		fi
	fi
	if (( result == 137 )) || awk '/^timeout: sending signal KILL / { found = 1 } END { exit !found }' "$run_dir/stderr.log"; then
		forced_kill=yes
	fi
	case $result in
		124|129|130|137|143) cleanup_failed=1 ;;
	esac
	printf '%s\n' "$forced_kill" > "$run_dir/forced-kill"
	capture_group after-cleanup || cleanup_failed=1
	capture_listeners after-cleanup || cleanup_failed=1
	if (( cleanup_failed )) || [[ $forced_kill == yes || -s "$run_dir/processes-after-cleanup" || -s "$run_dir/server-listeners-after-cleanup" ]]; then
		printf 'BLOCKED: timeout/interruption, forced termination, failed inspection, or remaining processes/server listeners.\n' > "$run_dir/cleanup"
		(( result != 0 )) || result=1
	else
		printf 'PASS: group and selected server-port checks passed. Detached processes require separate verification.\n' > "$run_dir/cleanup"
	fi
	printf '%s\n' "$result" > "$run_dir/exit"
	exit "$result"
}

trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
wait "$run_group"
exit "$?"
