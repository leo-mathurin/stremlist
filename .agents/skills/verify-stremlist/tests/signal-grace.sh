#!/usr/bin/env bash
set -u
case_dir=$1
fixture=$2
token=$3
port=$4
trap 'trap "" TERM; sleep 3; printf "graceful teardown complete\n" > "$case_dir/graceful-marker"; exit 0' TERM
printf '%s\n' "$$" > "$case_dir/bash-pid"
python3 "$fixture" listen "$case_dir" "$token" "$port" &
listener_pid=$!
while [[ ! -f "$case_dir/listener.json" ]]; do
	sleep 0.01
done
printf 'ready\n' > "$case_dir/bash-ready"
wait "$listener_pid"
