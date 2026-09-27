#!/usr/bin/env bash
# Deploy de uma mudança já no master. Rodar na VM: bash /opt/jjogos/deploy/atualizar.sh
set -euo pipefail
ALVO="/opt/jjogos"

git -C "$ALVO" fetch --quiet origin master
git -C "$ALVO" reset --hard --quiet origin/master
"$ALVO/.venv/bin/pip" install --quiet -r "$ALVO/requirements.txt"
sudo systemctl restart jjogos
sleep 2
systemctl is-active --quiet jjogos && echo "ok — jjogos rodando" || {
    echo "FALHOU:"; journalctl -u jjogos -n 30 --no-pager; exit 1
}
