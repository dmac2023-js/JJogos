# Acessando a VM de produção

Runbook do servidor onde o JJogos roda. Para **instalar do zero** numa máquina
nova, veja [README.md](README.md) — este arquivo é sobre o dia a dia da VM que
já está no ar.

## Resumo

| | |
|---|---|
| Site | https://jogos7.duckdns.org |
| IP | `152.67.52.90` |
| Host | Oracle Cloud Always Free, `sa-saopaulo-1` |
| Shape | VM.Standard.E2.1.Micro — 1 OCPU, 954 MB RAM, 45 GB disco |
| SO | Ubuntu 24.04 |
| Usuário | `ubuntu` (sudo sem senha) |
| DNS | DuckDNS (`jogos7`) → aponta para o IP acima |

---

## 1. Entrar por SSH

```bash
ssh -i "C:\Users\leona\Downloads\ssh-key-2026-09-27.key" ubuntu@152.67.52.90
```

Se der **"UNPROTECTED PRIVATE KEY FILE"**, o Windows está com a chave aberta
demais. No PowerShell:

```powershell
icacls "C:\Users\leona\Downloads\ssh-key-2026-09-27.key" /inheritance:r /grant:r "$env:USERNAME:R"
```

> ⚠️ Essa chave é a **única** forma de entrar na máquina. A Oracle não tem
> como reemitir: perdeu, perdeu a VM. Guarde uma cópia fora do Downloads.

---

## 2. Onde está cada coisa

| Caminho | O que é |
|---|---|
| `/opt/jjogos` | o repositório (clone do master) |
| `/opt/jjogos/.venv` | virtualenv com as dependências |
| `/opt/jjogos/.env` | **os segredos** — modo 600, fora do git |
| `/etc/systemd/system/jjogos.service` | o serviço |
| `/etc/nginx/sites-enabled/jjogos` | proxy reverso + TLS |
| `/etc/nginx/snippets/jjogos-proxy.conf` | headers e timeouts do proxy |
| `/etc/nginx/conf.d/upgrade.conf` | o `map` que faz o WebSocket funcionar |
| `/etc/letsencrypt/live/jogos7.duckdns.org/` | certificado |
| `/swapfile` | 2 GB de swap (essencial com 954 MB de RAM) |

---

## 3. O serviço

```bash
systemctl status jjogos          # está rodando?
sudo systemctl restart jjogos    # reiniciar
sudo systemctl stop jjogos       # parar
journalctl -u jjogos -f          # logs ao vivo (Ctrl+C sai)
journalctl -u jjogos -n 100      # últimas 100 linhas
journalctl -u jjogos -p err      # só os erros
```

O uvicorn escuta em `127.0.0.1:8000` — **só** o nginx fala com ele. A internet
entra pela 443 e é repassada.

> ⚠️ `restart` **derruba todas as transmissões e partidas abertas**. O estado
> das salas vive na memória do processo, não em banco. Evite reiniciar com
> gente usando.

---

## 4. Publicar uma mudança

Depois de dar push no master, na VM:

```bash
bash /opt/jjogos/deploy/atualizar.sh
```

Ele faz `git reset --hard origin/master`, reinstala dependências se mudaram,
reinicia o serviço e confirma que subiu. Se falhar, ele mostra o log.

> Como é `reset --hard`, **qualquer edição feita direto na VM é descartada.**
> Mude sempre pelo repositório local e dê push.

Ao mexer em `.js` ou `.css`, lembre de subir o `?v=AAAAMMDD-NN` no
`static/index.html` — sem isso o navegador serve a versão velha do cache
(os estáticos têm `Cache-Control: immutable`).

---

## 5. Os segredos (`.env`)

```bash
nano /opt/jjogos/.env
sudo systemctl restart jjogos    # só vale depois do restart
```

O que mora lá: `SITE_URL`, `OAUTH_REDIRECT_URI`, `DISCORD_APPLICATION_ID`,
`DISCORD_CLIENT_SECRET`, `DISCORD_PUBLIC_KEY`, `UPSTASH_REDIS_REST_URL`,
`UPSTASH_REDIS_REST_TOKEN`.

O systemd lê esse arquivo como `EnvironmentFile`, então **toda alteração exige
restart**. Mantenha o modo 600 (`chmod 600 /opt/jjogos/.env`).

Nunca commite esse arquivo. O `.env` do repositório local é de
desenvolvimento e não tem as chaves do Upstash.

---

## 6. Os dados

Esta é a parte que mais confunde: **os dados do jogo não estão na VM.**

Recordes, economia e progresso ficam no **Upstash Redis**, um serviço externo
acessado por REST. A VM é descartável — recriá-la não perde nada.

O mecanismo está em [`shared/db.py`](../shared/db.py): `carregar_json(chave,
arquivo_local)` e `salvar_json(...)` gravam um blob JSON por chave. Quando
`UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN` estão definidos, vai
para o Redis; **sem eles, cai silenciosamente para arquivos JSON locais** —
que somem no próximo `atualizar.sh`, porque o `reset --hard` os apaga.

Por isso: se os recordes começarem a sumir sozinhos, o primeiro suspeito é o
`.env` ter perdido as variáveis do Upstash.

Para ver quais chaves o código usa:

```bash
grep -rn "carregar_json\|salvar_json" /opt/jjogos/routers /opt/jjogos/shared
```

Para inspecionar os dados, use o **console do Upstash** no navegador — é mais
seguro que montar `curl` com o token na linha de comando, onde ele fica no
histórico do shell.

---

## 7. nginx e certificado

```bash
sudo nginx -t                    # valida a config ANTES de aplicar
sudo systemctl reload nginx      # aplica sem derrubar conexões
sudo certbot certificates        # quando expira?
sudo certbot renew --dry-run     # testa a renovação
```

A renovação é automática (timer do systemd). O certificado atual expira em
**26/12/2026**.

> ⚠️ O certbot **reescreve** `/etc/nginx/sites-enabled/jjogos` ao renovar.
> Se ele perder o `include .../jjogos-proxy.conf`, as transmissões passam a
> cair após 60s — o timeout padrão do nginx substitui o de 1h que
> configuramos. Depois de qualquer mexida no certificado, confirme:
>
> ```bash
> grep -c jjogos-proxy.conf /etc/nginx/sites-enabled/jjogos   # tem que ser >= 1
> ```

---

## 8. Firewall: são duas camadas

Erro clássico — abrir uma e achar que basta. **As duas precisam estar abertas.**

**Camada 1 — iptables, dentro da VM:**

```bash
sudo iptables -L INPUT -n --line-numbers
```

As regras de 80 e 443 têm que aparecer **antes** da linha `REJECT`. Se ficarem
depois, não valem nada — e o sintoma é idêntico ao de firewall da nuvem
fechado. Para corrigir, rode o `setup.sh` de novo (é idempotente).

**Camada 2 — Security List, no painel da Oracle:**

Networking → Virtual cloud networks → `vcn-jogos7` → aba **Security** → a lista
que contém a regra da porta **22**. Se a lista que você abriu não tem a regra
de SSH, é a lista errada — existe mais de uma.

---

## 9. Saúde da máquina

```bash
free -h                  # RAM e swap
df -h /                  # disco
uptime                   # carga
sudo ss -lntp            # quem está escutando em quais portas
```

Referência do estado normal, com tudo no ar: ~440 MB de RAM usados, swap
praticamente zerado, 5% de disco.

Se o swap estiver sendo usado de verdade (dezenas de MB), a máquina está sob
pressão — provavelmente muitas transmissões simultâneas pelo relay.

---

## 10. Quando der problema

| Sintoma | Verifique |
|---|---|
| Site fora do ar | `systemctl status jjogos` e `systemctl status nginx` |
| **502 Bad Gateway** | nginx de pé, app caído → `journalctl -u jjogos -n 50` |
| Timeout, sem resposta | firewall — confira as **duas** camadas (seção 8) |
| Erro de certificado | `sudo certbot certificates`; se o IP mudou, conserte o DuckDNS primeiro |
| Site sumiu do nada | o IP público mudou? Compare `curl ifconfig.me` na VM com o do DuckDNS |
| Transmissão cai após ~1 min | o `include` do snippet sumiu do nginx (seção 7) |
| Recordes resetando | `.env` sem as variáveis do Upstash (seção 6) |
| Activity não abre (tela branca) | veja se alguma resposta ganhou `X-Frame-Options`: `curl -I https://jogos7.duckdns.org` |

### Verificação rápida, de fora da VM

```bash
curl -I https://jogos7.duckdns.org
```

O que tem que aparecer: **200**, `content-security-policy: frame-ancestors`
com os domínios do Discord, `permissions-policy` com `display-capture`, e
**nenhum** `x-frame-options` (foi esse header que inviabilizou a Discloud).

---

## 11. O IP público

Se a VM for parada e religada e o IP for **efêmero**, ele muda — e aí DNS e
certificado quebram juntos.

Para tornar permanente: *Instance → Primary VNIC → três pontinhos no IP →
Edit → **Reserved***.

Se o IP mudar, o conserto é: atualizar em [duckdns.org](https://duckdns.org),
esperar o DNS propagar e rodar
`sudo certbot renew --force-renewal`.
