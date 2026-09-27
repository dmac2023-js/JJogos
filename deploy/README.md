# Deploy — Oracle Cloud Always Free

VM Ubuntu ARM (Ampere A1), nginx na frente, uvicorn em systemd.
Escolhido pelo **egress de 10 TB/mês**: o relay de tela manda de 2,5 a
12 Mbps por espectador, o que estoura os 100 GB do Render em poucas horas.

## Primeira instalação

Na VM, como `ubuntu`:

```bash
curl -fsSL https://raw.githubusercontent.com/dmac2023-js/JJogos/master/deploy/setup.sh \
  | bash -s -- jogos7.duckdns.org seu@email.com
```

Depois preencha os segredos e reinicie:

```bash
nano /opt/jjogos/.env
sudo systemctl restart jjogos
```

## Atualizar depois de um push

```bash
bash /opt/jjogos/deploy/atualizar.sh
```

## Arquivos

| Arquivo | Vai para |
|---|---|
| `setup.sh` | roda na VM, não é copiado |
| `atualizar.sh` | roda na VM a cada deploy |
| `jjogos.service` | `/etc/systemd/system/` |
| `nginx.conf` | `/etc/nginx/sites-available/jjogos` |
| `jjogos-proxy.conf` | `/etc/nginx/snippets/` |
| `upgrade.conf` | `/etc/nginx/conf.d/` |

## Pegadinhas

- **iptables**: a imagem Ubuntu do Oracle tem um `REJECT` que descarta tudo
  fora do SSH. Abrir 80/443 na Security List do painel **não basta** — o
  `setup.sh` insere as regras antes do REJECT e salva com
  `netfilter-persistent`.
- **Shape**: a Ampere A1.Flex (4 OCPU/24 GB) é a preferível, mas a
  E2.1.Micro (1 OCPU/1 GB) resolve: o gargalo é egress, e os 10 TB/mês são
  cota da conta, não da máquina. Na Micro o `setup.sh` cria 2 GB de swap
  pra um pico de espectadores não disparar o OOM killer.
- **Capacidade ARM**: `sa-saopaulo-1` costuma responder "out of capacity" nas
  shapes Ampere. Insistir em horários diferentes ou trocar de região resolve.
- **Não** adicionar `X-Frame-Options` no nginx: foi o `DENY` do proxy da
  Discloud que impediu o iframe da Activity. O app manda
  `Content-Security-Policy: frame-ancestors` com os domínios do Discord.
- **Estado em memória**: as salas de tela/jogos vivem no processo. `restart`
  derruba transmissões abertas, e não dá pra rodar mais de um worker.
