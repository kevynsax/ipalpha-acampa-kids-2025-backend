#!/usr/bin/env bash
# Collect OPENROUTER_API_KEY and patch Secret acampa-2025-secrets (never recreates it).
# Usage:
#   ./backend/scripts/collect-openrouter-secret.sh
#   ./backend/scripts/collect-openrouter-secret.sh --from-env   # reuse backend/.env
#   ./backend/scripts/collect-openrouter-secret.sh --dry-run
set -euo pipefail

NS=ipalpha-kids
SECRET=acampa-2025-secrets
KEY=openrouter-api-key
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FROM_ENV=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --from-env) FROM_ENV=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

value=""
if [[ "$FROM_ENV" == 1 ]]; then
  env_file="$ROOT/.env"
  [[ -f "$env_file" ]] || { echo "missing $env_file" >&2; exit 1; }
  value="$(python3 - "$env_file" <<'PY'
import sys
from pathlib import Path
for line in Path(sys.argv[1]).read_text().splitlines():
    s = line.strip()
    if s.startswith("OPENROUTER_API_KEY="):
        print(s.split("=", 1)[1].strip().strip('"').strip("'"))
        break
PY
)"
  [[ -n "$value" ]] || { echo "OPENROUTER_API_KEY empty in $env_file" >&2; exit 1; }
  echo "Using OPENROUTER_API_KEY from backend/.env (${#value} chars)."
else
  if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    value="$OPENROUTER_API_KEY"
    echo "Using OPENROUTER_API_KEY from the environment (${#value} chars)."
  else
    prompt="OPENROUTER_API_KEY (sk-or-…): "
    if [[ -n "${ZSH_VERSION:-}" ]]; then
      # zsh: read -rs "?prompt"
      read -rs "?$prompt" value; echo
    else
      read -rs -p "$prompt" value; echo
    fi
  fi
fi
[[ -n "$value" ]] || { echo "empty key, aborting" >&2; exit 1; }

if [[ "$DRY" == 1 ]]; then
  echo "dry-run: would patch secret/$SECRET in $NS with key $KEY (${#value} chars)"
  echo "then: kubectl -n $NS rollout restart deploy/acampa-2025-backend deploy/acampa-2025-import-worker"
  unset value
  exit 0
fi

command -v kubectl >/dev/null || { echo "kubectl not on PATH" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq not on PATH" >&2; exit 1; }

kubectl -n "$NS" get secret "$SECRET" >/dev/null
jq -n --arg v "$value" '{stringData:{"openrouter-api-key":$v}}' \
  | kubectl -n "$NS" patch secret "$SECRET" --type merge --patch-file /dev/stdin
unset value

echo "Patched $SECRET.$KEY. Restarting backend + import worker…"
kubectl -n "$NS" rollout restart deploy/acampa-2025-backend deploy/acampa-2025-import-worker
kubectl -n "$NS" rollout status deploy/acampa-2025-backend
kubectl -n "$NS" rollout status deploy/acampa-2025-import-worker
echo "Done. Confirm the key exists with: kubectl -n $NS get secret $SECRET -o jsonpath='{.data.openrouter-api-key}' | wc -c"
