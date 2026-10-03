#!/bin/sh
set -eu
cgroup=$1
shift
# Join before exec: Node startup and every ordinary descendant are contained.
printf '%s\n' "$$" > "$cgroup/cgroup.procs"
exec "$@"
