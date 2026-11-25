#!/bin/sh
# The gate is shared by mem-watch and storage-watch as byte-identical twins, since a plugin may not
# import a file outside its own folder. This fails when a pair has drifted apart.
# Run it from anywhere: scripts/check-twins.sh
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
status=0
for file in hooks/gate.ts hooks/gate.test.ts; do
  if ! cmp -s "$root/mem-watch/$file" "$root/storage-watch/$file"; then
    echo "drift: mem-watch/$file and storage-watch/$file differ; copy one over the other" >&2
    status=1
  fi
done
[ "$status" -eq 0 ] && echo "twins identical: hooks/gate.ts, hooks/gate.test.ts"
exit "$status"
