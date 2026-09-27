#!/usr/bin/env bash
# Bootstrap da VM (Ubuntu 22.04/24.04 ARM, Oracle Always Free).
# Rodar UMA vez, como ubuntu, na própria VM:
#
#   curl -fsSL https://raw.githubusercontent.com/dmac2023-js/JJogos/master/deploy/setup.sh \
#     | bash -s -- jogos7.duckdns.org seu@email.com
#
# É idempotente: rodar de novo não quebra nada.
set -euo pipefail

DOMINIO="${1:?uso: setup.sh <dominio> <email>}"
EMAIL="${2:?uso: setup.sh <dominio> <email>}"
REPO="https://github.com/dmac2023-js/JJogos.git"
ALVO="/opt/jjogos"

echo "==> Pacotes"
sudo apt-get update -qq
sudo apt-get install -y -qq python3 python3-venv python3-pip git nginx \
    certbot python3-certbot-nginx iptables-persistent

# ---------------------------------------------------------------------------
# Firewall — o passo que faz todo mundo achar que a VM está quebrada.
# ---------------------------------------------------------------------------
# A imagem Ubuntu do Oracle vem com uma regra REJECT no iptables que descarta
# tudo que não é SSH, ANTES de qualquer coisa que você libere. Abrir as portas
# só na Security List do painel não basta: o pacote chega na VM e morre aqui.
echo "==> Liberando 80/443 no iptables"
for PORTA in 80 443; do
    if ! sudo iptables -C INPUT -p tcp --dport "$PORTA" -j ACCEPT 2>/dev/null; then
        # -I INPUT 6 insere ANTES da regra REJECT do final da cadeia.
        sudo iptables -I INPUT 6 -p tcp --dport "$PORTA" -m state --state NEW -j ACCEPT
    fi
done
sudo netfilter-persistent save

echo "==> Código em $ALVO"
if [ -d "$ALVO/.git" ]; then
    sudo git -C "$ALVO" fetch --quiet origin master
    sudo git -C "$ALVO" reset --hard --quiet origin/master
else
    sudo git clone --quiet "$REPO" "$ALVO"
fi
sudo chown -R ubuntu:ubuntu "$ALVO"

echo "==> Virtualenv"
[ -d "$ALVO/.venv" ] || python3 -m venv "$ALVO/.venv"
"$ALVO/.venv/bin/pip" install --quiet --upgrade pip
"$ALVO/.venv/bin/pip" install --quiet -r "$ALVO/requirements.txt"

# O .env não está no git (e não deve estar). Criamos o esqueleto e o dono
# preenche à mão — systemd lê este arquivo via EnvironmentFile.
if [ ! -f "$ALVO/.env" ]; then
    echo "==> Criando .env esqueleto (PREENCHA DEPOIS)"
    cat > "$ALVO/.env" <<ENV
SITE_URL=https://$DOMINIO
OAUTH_REDIRECT_URI=https://$DOMINIO/auth/callback
DISCORD_APPLICATION_ID=
DISCORD_CLIENT_SECRET=
DISCORD_PUBLIC_KEY=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
ENV
    chmod 600 "$ALVO/.env"
fi

echo "==> nginx"
sudo cp "$ALVO/deploy/upgrade.conf" /etc/nginx/conf.d/upgrade.conf
sudo mkdir -p /etc/nginx/snippets
sudo cp "$ALVO/deploy/jjogos-proxy.conf" /etc/nginx/snippets/jjogos-proxy.conf
sudo sed "s/DOMINIO_AQUI/$DOMINIO/g" "$ALVO/deploy/nginx.conf" \
    | sudo tee /etc/nginx/sites-available/jjogos > /dev/null
sudo ln -sf /etc/nginx/sites-available/jjogos /etc/nginx/sites-enabled/jjogos
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

echo "==> systemd"
sudo cp "$ALVO/deploy/jjogos.service" /etc/systemd/system/jjogos.service
sudo systemctl daemon-reload
sudo systemctl enable --now jjogos

echo "==> Certificado TLS"
# Precisa que o DNS de $DOMINIO já aponte pro IP desta VM, senão o desafio
# HTTP-01 falha. Se falhar, conserta o DNS e roda só esta linha de novo.
sudo certbot --nginx -d "$DOMINIO" --non-interactive --agree-tos \
    -m "$EMAIL" --redirect || {
    echo "!! certbot falhou — confira se $DOMINIO resolve pro IP desta VM"
    echo "!! depois rode: sudo certbot --nginx -d $DOMINIO --redirect"
}

echo
echo "Pronto. Agora:"
echo "  1) preencha $ALVO/.env  (nano $ALVO/.env)"
echo "  2) sudo systemctl restart jjogos"
echo "  3) curl -I https://$DOMINIO"
