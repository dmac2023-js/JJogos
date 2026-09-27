"""Zera TODO o progresso do JJogos: recordes, pontuações, itens da loja e o
ClickJ inteiro. Cada carteira fica com SALDO_INICIAL moedas e só a identidade
(nick, avatar, ID do Discord) é preservada.

Isto é IRREVERSÍVEL. O script grava um backup em JSON antes de escrever
qualquer coisa, e só age depois que você digita ZERAR.

Rodar na VM, com o serviço PARADO (senão o processo no ar regrava por cima do
que acabamos de limpar):

    sudo systemctl stop jjogos
    cd /opt/jjogos && .venv/bin/python deploy/zerar_tudo.py
    sudo systemctl start jjogos

Sem as variáveis do Upstash no ambiente ele mexe nos arquivos JSON locais —
que é o comportamento certo em dev, mas em produção significa que você
esqueceu de carregar o .env.
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shared.config import ARQUIVO_ECONOMIA, ARQUIVO_RECORDES, PASTA_BASE  # noqa: E402
from shared.db import carregar_json, salvar_json, usando_redis  # noqa: E402
from shared.economia import CHAVE_ECONOMIA, SALDO_INICIAL  # noqa: E402

CHAVE_RECORDES = "jjogos:recordes"
CHAVE_CLICKJ = "jjogos:clickj"
ARQUIVO_CLICKJ = PASTA_BASE / "clickj.json"

# O que sobrevive numa carteira: quem a pessoa é. Todo o resto vira zero.
CAMPOS_DE_IDENTIDADE = ("nick", "avatar", "discord_id")


def carteira_zerada(antiga: dict) -> dict:
    nova = {campo: antiga.get(campo) for campo in CAMPOS_DE_IDENTIDADE}
    nova.update({
        "saldo": SALDO_INICIAL,
        "ultimo_bonus": 0,
        "decoracoes": [], "cores_nick": [], "fontes_nick": [], "skins_splano": [],
        "skin_splano_imagem": "",
        "equipado": {"decoracao": None, "cor_nick": None,
                     "fonte_nick": None, "skin_splano": None},
        "segundos_jogados": 0, "partidas": {}, "vitorias": {}, "historico": [],
    })
    return nova


def main() -> int:
    onde = "Upstash Redis (PRODUÇÃO)" if usando_redis() else "arquivos JSON locais (dev)"
    economia = carregar_json(CHAVE_ECONOMIA, ARQUIVO_ECONOMIA)
    recordes = carregar_json(CHAVE_RECORDES, ARQUIVO_RECORDES)
    clickj = carregar_json(CHAVE_CLICKJ, ARQUIVO_CLICKJ)
    carteiras = economia.get("carteiras") or {}

    print("Destino .......: " + onde)
    print("Carteiras .....: %d (todas voltam para %d moedas)" % (len(carteiras), SALDO_INICIAL))
    print("Personagens ClickJ: %d" % len(clickj.get("jogadores") or {}))
    print("Blocos de recorde.: %d" % len(recordes))
    print()

    backup = PASTA_BASE / ("backup-antes-de-zerar-%s.json" % time.strftime("%Y%m%d-%H%M%S"))
    backup.write_text(json.dumps(
        {"economia": economia, "recordes": recordes, "clickj": clickj},
        ensure_ascii=False, indent=2), encoding="utf-8")
    print("Backup gravado em: %s" % backup)
    print()
    print("Isto apaga recordes, vitórias, itens comprados e o ClickJ inteiro.")
    if input('Digite ZERAR para confirmar: ').strip() != "ZERAR":
        print("Cancelado — nada foi alterado.")
        return 1

    economia["carteiras"] = {nome: carteira_zerada(c) for nome, c in carteiras.items()}
    salvar_json(CHAVE_ECONOMIA, economia, ARQUIVO_ECONOMIA)
    salvar_json(CHAVE_RECORDES, {}, ARQUIVO_RECORDES)
    salvar_json(CHAVE_CLICKJ, {"jogadores": {}, "ascensoes": {}}, ARQUIVO_CLICKJ)

    print("Pronto. %d carteiras com %d moedas, recordes e ClickJ zerados."
          % (len(carteiras), SALDO_INICIAL))
    print("Reinicie o serviço: sudo systemctl restart jjogos")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
