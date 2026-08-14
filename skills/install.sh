#!/bin/sh
# Install the Gridwillow skills for OMP (Oh My Pi) or Claude Code.
#
# Both discover skills as <dir>/<skill-name>/SKILL.md, so the same folder serves
# either one. Symlinks rather than copies, so `git pull` updates them in place.
#
#   ./skills/install.sh          # OMP   -> ~/.omp/agent/skills/
#   ./skills/install.sh claude   # Claude -> ~/.claude/skills/

set -e
SRC=$(cd "$(dirname "$0")" && pwd)

case "${1:-omp}" in
  omp)     DEST="$HOME/.omp/agent/skills" ;;
  claude)  DEST="$HOME/.claude/skills" ;;
  *)       echo "usage: $0 [omp|claude]" >&2; exit 2 ;;
esac

mkdir -p "$DEST"
for skill in "$SRC"/*/; do
  [ -f "$skill/SKILL.md" ] || continue
  name=$(basename "$skill")
  ln -sfn "${skill%/}" "$DEST/$name"
  echo "linked $name -> $DEST/$name"
done

echo
echo "Restart your agent so discovery runs again."
