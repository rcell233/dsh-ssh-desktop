#!/bin/sh
set -eu
unset ELECTRON_RUN_AS_NODE
task_project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$task_project_dir"
exec pnpm --filter dsh-ssh-desktop start "$@"
