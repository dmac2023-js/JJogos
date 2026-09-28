"""Moedas, loja de decorações de avatar e cor do nick.

Carteira é indexada por "nome" (o username do Discord, já usado como chave
única em todo o app pra recordes/vitórias) — quem não está logado com
Discord (anônimo) não ganha nem gasta moeda nenhuma.
"""
import hashlib
import json
import secrets
import threading
import time
from pathlib import Path
from typing import Optional

from shared.config import ARQUIVO_ECONOMIA, PASTA_BASE
from shared.db import carregar_json, salvar_json
from shared.recordes import eh_anonimo

CHAVE_ECONOMIA = "jjogos:economia"

# Todo mundo começa com esse saldo — quem entra pela primeira vez já tem com
# que mexer na loja e na roleta sem precisar farmar do zero.
SALDO_INICIAL = 100

# Toda leitura+alteração+gravação da carteira (o blob inteiro de TODOS os
# jogadores) precisa passar por aqui. carregar_economia()/salvar_economia()
# leem e reescrevem o dicionário inteiro sem merge — duas gravações
# concorrentes (ex: comprar na loja enquanto converte Jcoins no ClickJ, ou
# duas pessoas comprando ao mesmo tempo) faziam uma sobrescrever a outra e
# "sumir" moedas/itens. Um único lock global serializa todo write.
LOCK_ECONOMIA = threading.Lock()

BONUS_INTERVALO_SEGUNDOS = 10 * 60
BONUS_QUANTIDADE = 50
# Prêmio da roleta quando o jogador já tem TUDO da loja (vira moedas no lugar
# do item). O preço real das decorações varia por item — este é o do meio da
# faixa, só usado nesse fallback.
PRECO_DECORACAO = 10000
PRECOS_DECORACAO_NIVEIS = [10000, 11000, 12000, 13000, 14000, 15000]
PRECO_COR_NICK = 8000
PRECO_FONTE_NICK = 9000


def _preco_decoracao(sku_id: str) -> int:
    # Preço fixo por item (determinístico a partir do sku_id), variando entre
    # os níveis de PRECOS_DECORACAO_NIVEIS — não muda a cada carregamento.
    indice = int(hashlib.md5(str(sku_id).encode("utf-8")).hexdigest(), 16) % len(PRECOS_DECORACAO_NIVEIS)
    return PRECOS_DECORACAO_NIVEIS[indice]


HISTORICO_MAXIMO = 10

# id -> nome exibido na loja (o visual de cada uma fica em .nick-fonte-<id> no css).
FONTES_NICK = {
    "negrito": "Negrito",
    "italico": "Itálico",
    "mono": "Monoespaçada",
    "serifa": "Serifada",
    "cursiva": "Cursiva",
    "impacto": "Impacto",
    "versalete": "Versalete",
    "espacada": "Espaçada",
    "caixa-alta": "Caixa alta",
    "compacta": "Compacta",
    "sublinhado": "Sublinhado",
    "riscado": "Riscado",
    "manual": "Manual",
    "pixel": "Pixel",
}

# Moedas por vitória — cada jogo tem sua própria tabela (por dificuldade,
# quando aplicável). Online paga o mesmo que o solo na mesma dificuldade —
# exceto a Velha online, que não tem dificuldade e paga um valor fixo.
MOEDAS_SUDOKU_SOLO = {"facil": 100, "medio": 300, "dificil": 400}
MOEDAS_SUDOKU_ONLINE = {"facil": 100, "medio": 300, "dificil": 400}

MOEDAS_VELHA_SOLO = {"facil": 50, "medio": 100, "dificil": 200}
MOEDAS_VELHA_ONLINE = 300

MOEDAS_TERMO_SOLO = {"facil": 150, "medio": 300, "dificil": 450}
MOEDAS_TERMO_ONLINE = {"facil": 150, "medio": 300, "dificil": 450}

MOEDAS_CAMPO_SOLO = {"facil": 100, "medio": 250, "dificil": 350}
MOEDAS_CAMPO_ONLINE = {"facil": 100, "medio": 250, "dificil": 350}

# Ludo: vencedor recebe participação + vitória (total 2000); demais recebem só participação (500).
MOEDAS_LUDO_VITORIA = 1500
MOEDAS_LUDO_PARTICIPACAO = 500

# Splano.io: kill e vitória.
MOEDAS_SPLANO_KILL = 50
MOEDAS_SPLANO_VITORIA = 200

# label em português -> valor CSS (usado pelo front pra colorir o nick).
CORES_NICK = {
    "azul": "#5b9dff",
    "verde": "#7ddea3",
    "vermelho": "#ff8a8a",
    "amarelo": "#ffd36a",
    "roxo": "#c9a6ff",
    "rosa": "#ff9ecf",
    "laranja": "#ffab66",
    "ciano": "#7ef0e0",
    "magenta": "#f72585",
    "lima": "#b7f34d",
    "turquesa": "#4cc9f0",
    "violeta": "#8b5cf6",
    "dourado": "#f59f00",
    "branco": "#f4f6ff",
    "arco-iris": None,  # animação (ver .nick-arco-ris no css), não é cor fixa
}

# --- Skins do Splano.io -----------------------------------------------------
# padrao: como o círculo é pintado no canvas.
#   solido    -> uma cor só
#   listras   -> faixas horizontais alternando as cores
#   vertical  -> faixas verticais alternando as cores
#   faixa     -> cor de fundo com uma faixa diagonal da segunda cor
#   rainbow   -> matiz girando (animada)
#   imagem    -> o próprio jogador escolhe a imagem (url na carteira)
PRECO_SKIN_SPLANO = 8000
PRECO_SKIN_SPLANO_IMAGEM = 12000
PRECO_SKIN_SPLANO_RAINBOW = 10000

def _skin(nome, grupo, cores, padrao="solido"):
    return {"nome": nome, "grupo": grupo, "cores": cores, "padrao": padrao}


SKINS_SPLANO = {
    # Cores simples
    "azul": _skin("Azul", "cores", ["#3b82f6"]),
    "verde": _skin("Verde", "cores", ["#22c55e"]),
    "vermelho": _skin("Vermelho", "cores", ["#ef4444"]),
    "amarelo": _skin("Amarelo", "cores", ["#facc15"]),
    "roxo": _skin("Roxo", "cores", ["#a855f7"]),
    "rosa": _skin("Rosa", "cores", ["#ec4899"]),
    "laranja": _skin("Laranja", "cores", ["#fb923c"]),
    "ciano": _skin("Ciano", "cores", ["#22d3ee"]),
    "branco": _skin("Branco", "cores", ["#e8edf7"]),
    "preto": _skin("Preto", "cores", ["#2b2f3a"]),
    "dourado": _skin("Dourado", "cores", ["#e0a526"]),
    "lima": _skin("Lima", "cores", ["#a3e635"]),
    # Times brasileiros
    "flamengo": _skin("Flamengo", "times_br", ["#d50000", "#141414"], "listras"),
    "corinthians": _skin("Corinthians", "times_br", ["#141414", "#f2f2f2"], "vertical"),
    "palmeiras": _skin("Palmeiras", "times_br", ["#046a38"], "solido"),
    "sao-paulo": _skin("São Paulo", "times_br", ["#f2f2f2", "#d50000"], "faixa"),
    "vasco": _skin("Vasco", "times_br", ["#141414", "#f2f2f2"], "faixa"),
    "gremio": _skin("Grêmio", "times_br", ["#0d80bf", "#141414"], "vertical"),
    "internacional": _skin("Internacional", "times_br", ["#c8102e"], "solido"),
    "cruzeiro": _skin("Cruzeiro", "times_br", ["#1b3f94"], "solido"),
    "atletico-mg": _skin("Atlético-MG", "times_br", ["#141414", "#f2f2f2"], "vertical"),
    "santos": _skin("Santos", "times_br", ["#f2f2f2", "#141414"], "listras"),
    "botafogo": _skin("Botafogo", "times_br", ["#141414", "#f2f2f2"], "vertical"),
    "fluminense": _skin("Fluminense", "times_br", ["#7a1e38", "#046a38"], "vertical"),
    "bahia": _skin("Bahia", "times_br", ["#0d80bf", "#d50000"], "listras"),
    "vitoria": _skin("Vitória", "times_br", ["#d50000", "#141414"], "vertical"),
    # Times internacionais
    "real-madrid": _skin("Real Madrid", "times_int", ["#f4f6ff", "#d4af37"], "faixa"),
    "barcelona": _skin("Barcelona", "times_int", ["#1c3a94", "#a50044"], "vertical"),
    "man-united": _skin("Man. United", "times_int", ["#da291c"], "solido"),
    "man-city": _skin("Man. City", "times_int", ["#6cabdd"], "solido"),
    "liverpool": _skin("Liverpool", "times_int", ["#c8102e"], "solido"),
    "chelsea": _skin("Chelsea", "times_int", ["#034694"], "solido"),
    "arsenal": _skin("Arsenal", "times_int", ["#ef0107", "#f2f2f2"], "faixa"),
    "bayern": _skin("Bayern", "times_int", ["#dc052d"], "solido"),
    "juventus": _skin("Juventus", "times_int", ["#f2f2f2", "#141414"], "vertical"),
    "milan": _skin("Milan", "times_int", ["#fb090b", "#141414"], "vertical"),
    "inter-milao": _skin("Inter de Milão", "times_int", ["#0068a8", "#141414"], "vertical"),
    "psg": _skin("PSG", "times_int", ["#0b1c3d", "#d50000"], "faixa"),
    "boca": _skin("Boca Juniors", "times_int", ["#1c3a94", "#facc15"], "listras"),
    "river": _skin("River Plate", "times_int", ["#f2f2f2", "#d50000"], "faixa"),
    # Seleções
    "brasil": _skin("Brasil", "selecoes", ["#ffdf00", "#009c3b"], "faixa"),
    "argentina": _skin("Argentina", "selecoes", ["#75aadb", "#f2f2f2"], "vertical"),
    "alemanha": _skin("Alemanha", "selecoes", ["#f2f2f2", "#141414"], "faixa"),
    "franca": _skin("França", "selecoes", ["#1c3a94", "#d50000"], "faixa"),
    "italia": _skin("Itália", "selecoes", ["#0f5ba7"], "solido"),
    "espanha": _skin("Espanha", "selecoes", ["#c60b1e", "#facc15"], "listras"),
    "portugal": _skin("Portugal", "selecoes", ["#d50000", "#046a38"], "vertical"),
    "inglaterra": _skin("Inglaterra", "selecoes", ["#f2f2f2", "#d50000"], "faixa"),
    "uruguai": _skin("Uruguai", "selecoes", ["#75aadb"], "solido"),
    "holanda": _skin("Holanda", "selecoes", ["#fb923c"], "solido"),
    "japao": _skin("Japão", "selecoes", ["#0b1c3d", "#d50000"], "faixa"),
    "mexico": _skin("México", "selecoes", ["#046a38", "#d50000"], "vertical"),
    # Especiais (preço próprio)
    "rainbow": _skin("Rainbow RGB", "especiais", ["#ff0000"], "rainbow"),
    "imagem": _skin("Imagem personalizada", "especiais", ["#2b2f3a"], "imagem"),
}
SKINS_SPLANO_GRUPOS = {
    "cores": "Cores",
    "times_br": "Times do Brasil",
    "times_int": "Times do mundo",
    "selecoes": "Seleções",
    "especiais": "Especiais",
}


def preco_skin_splano(skin_id: str) -> int:
    if skin_id == "rainbow":
        return PRECO_SKIN_SPLANO_RAINBOW
    if skin_id == "imagem":
        return PRECO_SKIN_SPLANO_IMAGEM
    return PRECO_SKIN_SPLANO


ARQUIVO_LOJA_DECORACOES = PASTA_BASE / "loja_decoracoes.json"

PARTIDAS_JOGOS = [
    "sudoku_solo", "sudoku_online",
    "velha_maquina", "velha_online",
    "campo_solo", "campo_online",
    "termo_solo", "termo_online",
    "ludo",
    "clickj_pvp",
    "splano_io",
]

INSIGNIAS_DOACAO = [
    (10_000, "Patrono", "patrono"), (100_000, "Campeão", "campeao"),
    (500_000, "Iluminado", "iluminado"), (1_000_000, "Herói", "heroi"),
    (5_000_000, "Lendário", "lendario"), (10_000_000, "Divindade", "divindade"),
]
TAXA_DOACAO = 0.10
DONO_DOACAO = "jovem7l"
# Toda transferência válida conta para a progressão, inclusive para o mesmo
# destinatário. O controle contra abuso passa a ser o teto diário total.
INTERVALO_INSIGNIA_MESMO_DESTINATARIO = 0
LIMITE_TRANSFERENCIA_DIARIA = 200_000
INTERVALO_MISSOES = 4 * 60 * 60
MISSOES_MODELOS = [
    {"tipo": "tempo", "alvo": 3600, "recompensa": 1500, "texto": "Jogue por 1 hora"},
    {"tipo": "partidas", "alvo": 3, "recompensa": 1000, "texto": "Jogue 3 partidas online"},
    {"tipo": "vitorias", "alvo": 2, "recompensa": 2000, "texto": "Consiga 2 vitórias"},
    {"tipo": "kills", "alvo": 5, "recompensa": 1500, "texto": "Consiga 5 kills no Splano.io"},
    {"tipo": "rebirths", "alvo": 1, "recompensa": 2000, "texto": "Faça 1 rebirth no ClickJ"},
]


def _modelos_missao(agora: int) -> list:
    ciclo = (agora // INTERVALO_MISSOES) % (len(MISSOES_MODELOS) - 1)
    return [MISSOES_MODELOS[0], MISSOES_MODELOS[1 + ciclo], MISSOES_MODELOS[1 + ((ciclo + 1) % (len(MISSOES_MODELOS) - 1))]]


def progresso_doacao(total: int) -> dict:
    total = max(0, int(total or 0))
    ganhas = [{"valor": v, "nome": n, "icone": i} for v, n, i in INSIGNIAS_DOACAO if total >= v]
    proxima = next(({"valor": v, "nome": n, "icone": i} for v, n, i in INSIGNIAS_DOACAO if total < v), None)
    atual = ganhas[-1] if ganhas else None
    anterior = ganhas[-1]["valor"] if ganhas else 0
    if proxima:
        faixa = max(1, proxima["valor"] - anterior)
        progresso = min(100, round((total - anterior) / faixa * 100, 1))
        falta = proxima["valor"] - total
    else:
        progresso, falta = 100, 0
    return {"total": total, "insignias": ganhas, "atual": atual, "proxima": proxima,
            "anterior": anterior, "falta": falta, "progresso": progresso}


def _historico_doacoes_publico(lista: list, destino: str) -> list:
    carteiras = carregar_economia().get("carteiras", {})
    carteira_clown = carteiras.get("clown") or carteiras.get("Clown") or {}
    equipado_clown = carteira_clown.get("equipado") or {}
    saida = []
    agrupado = {}
    # O username antigo e o nome global apontam para a mesma pessoa. A
    # normalização também impede que um snapshot antigo fique sem foto.
    for original in lista[:3]:
        item = dict(original)
        chave = item.get(destino)
        eh_clown = str(chave or "").lower() in ("agoratobem", "clown")
        if eh_clown:
            item["nick"] = carteira_clown.get("nick") or "Clown"
            item["avatar"] = item.get("avatar") or carteira_clown.get("avatar")
            item["cor_nick"] = item.get("cor_nick") or equipado_clown.get("cor_nick")
            item["fonte_nick"] = item.get("fonte_nick") or equipado_clown.get("fonte_nick")
            item["decoracao_imagem"] = item.get("decoracao_imagem") or _imagem_decoracao(equipado_clown.get("decoracao"), animada=True)
            chave = "clown"
        agrupamento = chave or item.get("nick") or "desconhecido"
        if agrupamento in agrupado:
            agrupado[agrupamento]["quantidade"] = int(agrupado[agrupamento].get("quantidade", 0)) + int(item.get("quantidade", 0))
        else:
            agrupado[agrupamento] = item
            saida.append(item)
    return saida


def _conta_para_insignia(carteira: dict, destinatario: str, agora: int) -> bool:
    return True


def prever_transferencia(remetente: str, destinatario: str, quantidade: int) -> dict:
    dados = carregar_economia()
    carteira = dados.get("carteiras", {}).get(remetente) or {}
    alvo = dados.get("carteiras", {}).get(destinatario) or {}
    agora = int(time.time())
    taxa = quantidade // 10
    return {"saldo_remetente": carteira.get("saldo", 0),
            "saldo_destinatario": alvo.get("saldo", 0),
            "recebido": quantidade - taxa, "taxa": taxa,
            "conta_insignia": _conta_para_insignia(carteira, destinatario, agora),
            "doacao": progresso_doacao(carteira.get("total_doado", 0))}


def _missoes(carteira: dict, agora: int = None) -> dict:
    agora = int(agora or time.time())
    estado = carteira.get("missoes")
    if not estado or agora - int(estado.get("inicio", 0)) >= INTERVALO_MISSOES:
        estado = {"inicio": agora, "itens": [dict(m, progresso=0, concluida=False, recompensa_resgatada=False) for m in _modelos_missao(agora)], "bonus_pago": False}
        carteira["missoes"] = estado
    for item in estado.get("itens", []):
        # Missões antigas já pagas antes da separação concluir/resgatar.
        if item.get("concluida") and "recompensa_resgatada" not in item:
            item["recompensa_resgatada"] = True
        else:
            item.setdefault("recompensa_resgatada", False)
    return estado


def _atualizar_missoes(carteira: dict, segundos: int, jogo: str, venceu: bool, agora: int, kills: int = 0, rebirths: int = 0) -> None:
    estado = _missoes(carteira, agora)
    for m in estado["itens"]:
        if m["tipo"] == "tempo": m["progresso"] += max(0, segundos)
        elif m["tipo"] == "partidas" and jogo in ("sudoku_online", "velha_online", "campo_online", "termo_online", "ludo", "clickj_pvp", "splano_io"): m["progresso"] += 1
        elif m["tipo"] == "vitorias" and venceu: m["progresso"] += 1
        elif m["tipo"] == "kills" and jogo == "splano_io": m["progresso"] += max(0, kills)
        elif m["tipo"] == "rebirths": m["progresso"] += max(0, rebirths)
        if m["progresso"] >= m["alvo"] and not m.get("concluida"):
            m["progresso"], m["concluida"] = m["alvo"], True


def resgatar_missao(carteira: dict, indice: int) -> dict:
    estado = _missoes(carteira)
    if indice < 0 or indice >= len(estado["itens"]):
        raise ValueError("Missão inválida.")
    missao = estado["itens"][indice]
    if not missao.get("concluida"):
        raise ValueError("Essa missão ainda não foi concluída.")
    if missao.get("recompensa_resgatada"):
        raise ValueError("Essa recompensa já foi resgatada.")
    carteira["saldo"] = carteira.get("saldo", 0) + missao["recompensa"]
    missao["recompensa_resgatada"] = True
    bonus = False
    if all(m.get("recompensa_resgatada") for m in estado["itens"]) and not estado.get("bonus_pago"):
        carteira["saldo"] += 1000
        estado["bonus_pago"] = True
        bonus = True
    return {"missao": missao, "bonus": bonus, "saldo": carteira["saldo"], "missoes": estado}

# Roleta da sorte: setores maiores têm mais chance real, não só visual.
# A aposta só anda de 1000 em 1000 e começa em 1000 — o front oferece botões
# de ±1k, ±10k, ±100k e ±1M em cima disso.
ROLETA_APOSTA_MINIMA = 1000
ROLETA_APOSTA_MULTIPLO = 1000
_ROLETA_ORDEM = [
    "1.25x", "0.5x", "0.25x", "1.5x", "presente", "?", "0.5x", "1.25x",
    "0.75x", "0.25x", "0.75x", "1.5x",
]
_ROLETA_MODELOS = {
    "0.25x": {"tipo": "multiplicador", "valor": 0.25, "label": "0.25x"},
    "1.25x": {"tipo": "multiplicador", "valor": 1.25, "label": "1.25x"},
    "1.5x": {"tipo": "multiplicador", "valor": 1.5, "label": "1.5x"},
    "0.75x": {"tipo": "multiplicador", "valor": 0.75, "label": "0.75x"},
    "0.5x": {"tipo": "multiplicador", "valor": 0.5, "label": "0.5x"},
    "presente": {"tipo": "presente", "label": "Presente"},
    "?": {"tipo": "interrogacao", "label": "?"},
}
# Exatos 60% de perda/redução e 40% de ganho. Dentro dos ganhos: presente
# = 5%, ? = 2%, 1.25x + 1.5x = 33%. O peso dos dois 0.5x cai 25%,
# e a diferença é transferida para os dois 1.5x.
_ROLETA_PESOS = {"1.25x": 14, "0.5x": 12.825, "0.25x": 10, "0.75x": 2.9, "1.5x": 6.775, "presente": 5, "?": 2}
ROLETA_FATIAS = []
for _i, _chave in enumerate(_ROLETA_ORDEM):
    _fatia = dict(_ROLETA_MODELOS[_chave])
    _fatia["peso"] = _ROLETA_PESOS[_chave]
    ROLETA_FATIAS.append(_fatia)


def _carregar_catalogo_decoracoes() -> list:
    try:
        brutos = json.loads(ARQUIVO_LOJA_DECORACOES.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return []
    catalogo = []
    for item in brutos:
        sku_id = item.get("sku_id")
        asset = item.get("asset")
        if not sku_id or not asset:
            continue
        catalogo.append({
            "sku_id": sku_id,
            "nome": item.get("name") or sku_id,
            "preco": _preco_decoracao(sku_id),
            # .webp = quadro parado (usado em repouso); .png = APNG animado
            # (o CDN da Discord só anima nesse formato) — trocado no hover.
            "imagem": f"https://cdn.discordapp.com/avatar-decoration-presets/{asset}.webp?size=96",
            "imagem_animada": f"https://cdn.discordapp.com/avatar-decoration-presets/{asset}.png?size=96",
        })
    return catalogo


CATALOGO_DECORACOES = _carregar_catalogo_decoracoes()
_DECORACOES_POR_SKU = {item["sku_id"]: item for item in CATALOGO_DECORACOES}


def decoracao_existe(sku_id: str) -> bool:
    return sku_id in _DECORACOES_POR_SKU


def preco_decoracao_item(sku_id: str) -> int:
    item = _DECORACOES_POR_SKU.get(sku_id)
    return item["preco"] if item else PRECO_DECORACAO


# ---------------------------------------------------------------------------
# Molduras de perfil
# ---------------------------------------------------------------------------
#
# Moldura (type 3 do Discord) não tem um "asset" único como a decoração: são
# 1 a 6 camadas PNG servidas por /media/v1/collectibles-shop/{sku}/{id}/static
# e posicionadas em volta do perfil pelo client (anchor top/bottom, order
# front/back, dentro de um perfil de inner_width px com overflow pra fora).
ARQUIVO_LOJA_MOLDURAS = PASTA_BASE / "loja_molduras.json"
CDN_MOLDURA = "https://cdn.discordapp.com/media/v1/collectibles-shop/{sku}/{camada}/static"
PRECO_MOLDURA_NIVEIS = [15000, 16000, 17000, 18000, 19000, 20000]


def _preco_moldura(sku_id: str) -> int:
    # Preço fixo por moldura, derivado do id (igual a decoração): entre 15000
    # e 20000, sem mudar a cada carregamento nem dar vantagem pra quem sorteia.
    indice = int(hashlib.md5(str(sku_id).encode("utf-8")).hexdigest(), 16) % len(PRECO_MOLDURA_NIVEIS)
    return PRECO_MOLDURA_NIVEIS[indice]


def _carregar_catalogo_molduras() -> list:
    try:
        brutos = json.loads(ARQUIVO_LOJA_MOLDURAS.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return []
    catalogo = []
    for item in brutos:
        sku_id = item.get("sku_id")
        camadas = item.get("layers") or []
        if not sku_id or not camadas:
            continue
        urls = [CDN_MOLDURA.format(sku=sku_id, camada=c.get("id")) for c in camadas if c.get("id")]
        if not urls:
            continue
        catalogo.append({
            "sku_id": sku_id,
            "nome": item.get("name") or sku_id,
            "preco": _preco_moldura(sku_id),
            # primeira camada = preview do card na loja (a mais característica
            # em geral é a de cima); o perfil usa TODAS as camadas.
            "imagem": urls[0],
            "camadas": [{
                "url": CDN_MOLDURA.format(sku=sku_id, camada=c["id"]),
                "order": c.get("order") or "front",
                "anchor": c.get("anchor") or "top",
                # staple = topo/base vaza pro fora; border/rail = arte dentro
                # do card, recortada (é o tipo que manda no desenho).
                "type": c.get("type") or "staple",
                "responsive": bool(c.get("responsive")),
            } for c in camadas if c.get("id")],
            "inner_width": item.get("inner_width") or 1200,
            "overflow_top": item.get("overflow_top") or 0,
            "overflow_bottom": item.get("overflow_bottom") or 0,
            "overflow_horizontal": item.get("overflow_horizontal") or 0,
        })
    return catalogo


CATALOGO_MOLDURAS = _carregar_catalogo_molduras()
_MOLDURAS_POR_SKU = {item["sku_id"]: item for item in CATALOGO_MOLDURAS}


def moldura_existe(sku_id: str) -> bool:
    return sku_id in _MOLDURAS_POR_SKU


def preco_moldura_item(sku_id: str) -> int:
    item = _MOLDURAS_POR_SKU.get(sku_id)
    return item["preco"] if item else min(PRECO_MOLDURA_NIVEIS)


def moldura_publica(sku_id: Optional[str]) -> Optional[dict]:
    """Moldura equipada pronta pro front desenhar (geometria + camadas)."""
    if not sku_id:
        return None
    return _MOLDURAS_POR_SKU.get(sku_id)


_cache_carteiras = {"em": 0.0, "carteiras": None}
CACHE_CARTEIRAS_SEGUNDOS = 5


def carregar_economia() -> dict:
    dados = carregar_json(CHAVE_ECONOMIA, ARQUIVO_ECONOMIA)
    dados.setdefault("carteiras", {})
    return dados


def salvar_economia(dados: dict) -> None:
    salvar_json(CHAVE_ECONOMIA, dados, ARQUIVO_ECONOMIA)
    _cache_carteiras.update(em=time.time(), carteiras=dados.get("carteiras", {}))


def _carteiras_recentes() -> dict:
    """Carteiras de até 5s atrás — os placares pedem os cosméticos de cada
    jogador a cada atualização, e sem isso cada pedido era uma ida ao Redis."""
    agora = time.time()
    if _cache_carteiras["carteiras"] is None or agora - _cache_carteiras["em"] > CACHE_CARTEIRAS_SEGUNDOS:
        _cache_carteiras.update(em=agora, carteiras=carregar_economia().get("carteiras", {}))
    return _cache_carteiras["carteiras"]


def obter_carteira(dados: dict, nome: str, nick: str = None, avatar: str = None,
                   discord_id: str = None) -> dict:
    carteira = dados["carteiras"].setdefault(nome, {})
    carteira.setdefault("saldo", SALDO_INICIAL)
    carteira.setdefault("ultimo_bonus", 0)
    carteira.setdefault("decoracoes", [])
    carteira.setdefault("cores_nick", [])
    carteira.setdefault("fontes_nick", [])
    carteira.setdefault("skins_splano", [])
    carteira.setdefault("skin_splano_imagem", "")
    carteira.setdefault("molduras", [])
    equipado = carteira.setdefault("equipado", {})
    for chave in ("decoracao", "cor_nick", "fonte_nick", "skin_splano", "moldura"):
        equipado.setdefault(chave, None)
    carteira.setdefault("segundos_jogados", 0)
    carteira.setdefault("partidas", {})
    carteira.setdefault("vitorias", {})
    carteira.setdefault("historico", [])
    carteira.setdefault("discord_id", None)
    if nick:
        carteira["nick"] = nick
    if avatar:
        carteira["avatar"] = avatar
    if discord_id:
        carteira["discord_id"] = discord_id
    return carteira


# ID(s) do Discord com acesso ao botão "Doar/Gerar moedas" da loja. Nunca
# confiar num "sou admin" mandado pelo cliente — só esse ID é aceito.
ADMIN_DISCORD_IDS = {"1527038915628761110"}


def eh_admin_discord_id(discord_id: str) -> bool:
    return bool(discord_id) and discord_id in ADMIN_DISCORD_IDS


def resolver_nome_por_discord_id(discord_id: str) -> Optional[str]:
    """Acha o 'nome' (chave da carteira) de quem tem esse ID do Discord.
    Só funciona pra quem já abriu o site logado ao menos uma vez (é quando
    o discord_id é gravado na carteira)."""
    if not discord_id:
        return None
    carteiras = carregar_economia().get("carteiras", {})
    for nome, carteira in carteiras.items():
        if carteira.get("discord_id") == discord_id:
            return nome
    return None


def resolver_nome_alvo(identificador: str) -> Optional[str]:
    """Aceita ID do Discord OU o 'nome' (username) direto — o ID só resolve
    pra quem já teve o discord_id gravado na carteira (após abrir o site com
    a versão atual); o username sempre funciona, pois é a própria chave."""
    if not identificador:
        return None
    carteiras = carregar_economia().get("carteiras", {})
    if identificador in carteiras:
        return identificador
    return resolver_nome_por_discord_id(identificador)


def _imagem_decoracao(sku: Optional[str], animada: bool) -> Optional[str]:
    if not sku:
        return None
    return _DECORACOES_POR_SKU.get(sku, {}).get("imagem_animada" if animada else "imagem")


def carteira_publica(carteira: dict) -> dict:
    equipado = carteira.get("equipado") or {}
    return {
        "saldo": carteira.get("saldo", 0),
        "decoracoes": carteira.get("decoracoes", []),
        "cores_nick": carteira.get("cores_nick", []),
        "fontes_nick": carteira.get("fontes_nick", []),
        "skins_splano": carteira.get("skins_splano", []),
        "skin_splano_imagem": carteira.get("skin_splano_imagem", ""),
        "molduras": carteira.get("molduras", []),
        "equipado": {
            "decoracao": equipado.get("decoracao"),
            "cor_nick": equipado.get("cor_nick"),
            "fonte_nick": equipado.get("fonte_nick"),
            "skin_splano": equipado.get("skin_splano"),
            "moldura": equipado.get("moldura"),
        },
        # URL pronta da decoração equipada, pro front não precisar carregar o
        # catálogo inteiro só pra desenhar o avatar do cabeçalho/perfil.
        "decoracao_imagem": _imagem_decoracao(equipado.get("decoracao"), animada=True),
        # Moldura equipada com geometria e camadas (o equipado["moldura"] só
        # guarda o sku) — o perfil desenha em cima disso.
        "moldura_perfil": moldura_publica(equipado.get("moldura")),
        "historico": carteira.get("historico", []),
    }


def _cosmeticos_da_carteira(carteira: Optional[dict]) -> dict:
    equipado = (carteira or {}).get("equipado") or {}
    return {
        "decoracao": _imagem_decoracao(equipado.get("decoracao"), animada=False),
        "cor_nick": equipado.get("cor_nick"),
        "fonte_nick": equipado.get("fonte_nick"),
    }


def cosmeticos_equipados(nome: str) -> dict:
    """Usado pelos jogos pra mostrar a decoração/cor/fonte equipada de
    QUALQUER jogador (não só o usuário atual) — ex: no placar de uma partida."""
    if eh_anonimo(nome) or not nome:
        return _cosmeticos_da_carteira(None)
    return _cosmeticos_da_carteira(_carteiras_recentes().get(nome))


def cosmeticos_de_varios(nomes) -> dict:
    carteiras = _carteiras_recentes()
    return {n: _cosmeticos_da_carteira(carteiras.get(n)) for n in nomes if n}


def skin_splano(nome: str) -> dict:
    """Skin equipada no Splano.io, já pronta pro canvas desenhar. Sem skin
    (ou anônimo), a cor sai do próprio nome — cada um fica com a sua."""
    carteira = None
    if nome and not eh_anonimo(nome):
        carteira = _carteiras_recentes().get(nome)
    skin_id = ((carteira or {}).get("equipado") or {}).get("skin_splano")
    skin = SKINS_SPLANO.get(skin_id)
    if not skin:
        cores = list(CORES_NICK.values())
        cor = [c for c in cores if c][sum(map(ord, nome or "?")) % len([c for c in cores if c])]
        return {"id": None, "padrao": "solido", "cores": [cor], "imagem": ""}
    return {
        "id": skin_id,
        "padrao": skin["padrao"],
        "cores": skin["cores"],
        "imagem": (carteira or {}).get("skin_splano_imagem", "") if skin["padrao"] == "imagem" else "",
    }


def registrar_fim_partida(nome: str, nick: str, segundos: int,
                          jogo: str = "", avatar: str = None,
                          venceu: bool = False, resultado: str = "", kills: int = 0) -> None:
    """Registra fim de partida: acumula segundos, incrementa partidas e
    vitórias por jogo e guarda no histórico das últimas partidas."""
    if eh_anonimo(nome) or not nome:
        return
    with LOCK_ECONOMIA:
        dados = carregar_economia()
        carteira = obter_carteira(dados, nome, nick=nick, avatar=avatar)
        if segundos > 0:
            carteira["segundos_jogados"] = carteira.get("segundos_jogados", 0) + segundos
        if jogo in PARTIDAS_JOGOS:
            partidas = carteira.setdefault("partidas", {})
            partidas[jogo] = partidas.get(jogo, 0) + 1
            if venceu:
                vitorias = carteira.setdefault("vitorias", {})
                vitorias[jogo] = vitorias.get(jogo, 0) + 1
            if resultado not in ("vitoria", "derrota", "empate"):
                resultado = "vitoria" if venceu else "derrota"
            historico = carteira.setdefault("historico", [])
            historico.insert(0, {"jogo": jogo, "resultado": resultado, "em": int(time.time())})
            del historico[HISTORICO_MAXIMO:]
        _atualizar_missoes(carteira, segundos, jogo, venceu, int(time.time()), kills=kills)
        salvar_economia(dados)


def registrar_evento_missao(nome: str, nick: str, tipo: str, quantidade: int, avatar: str = None) -> None:
    if eh_anonimo(nome) or not nome or quantidade <= 0:
        return
    with LOCK_ECONOMIA:
        dados = carregar_economia()
        carteira = obter_carteira(dados, nome, nick=nick, avatar=avatar)
        _atualizar_missoes(carteira, 0, "", False, int(time.time()), rebirths=quantidade if tipo == "rebirths" else 0)
        salvar_economia(dados)


def _entrada_publica(nome: str, carteira: dict) -> dict:
    equipado = carteira.get("equipado") or {}
    partidas = carteira.get("partidas", {})
    total_doado = carteira.get("total_doado", 0)
    return {
        "nome": nome,
        "nick": carteira.get("nick") or nome,
        "cor_nick": equipado.get("cor_nick"),
        "fonte_nick": equipado.get("fonte_nick"),
        "avatar": carteira.get("avatar"),
        "decoracao_imagem": _imagem_decoracao(equipado.get("decoracao"), animada=True),
        "moldura_perfil": moldura_publica(equipado.get("moldura")),
        "saldo": carteira.get("saldo", 0),
        "segundos": carteira.get("segundos_jogados", 0),
        "partidas": partidas,
        "vitorias": carteira.get("vitorias", {}),
        "total_partidas": sum(partidas.values()),
        "total_doado": total_doado,
        "doacao": progresso_doacao(total_doado),
        "missoes": _missoes(carteira),
        "historico_doacoes": _historico_doacoes_publico(carteira.get("historico_envios", []), "para"),
        "historico_recebidos": _historico_doacoes_publico(carteira.get("historico_recebidos", []), "de"),
    }


def perfil_publico(nome: str) -> Optional[dict]:
    carteira = carregar_economia().get("carteiras", {}).get(nome)
    return _entrada_publica(nome, carteira) if carteira else None


def top_ranking(limit: int = 10) -> dict:
    """Retorna os top jogadores por moedas, por partidas jogadas e por doações."""
    entradas = [_entrada_publica(nome, c) for nome, c in carregar_economia().get("carteiras", {}).items()]
    top_moedas = sorted(entradas, key=lambda x: x["saldo"], reverse=True)
    top_partidas = sorted(entradas, key=lambda x: x["total_partidas"], reverse=True)
    return {
        "top_moedas": top_moedas[:limit],
        "top_horas": top_partidas[:limit],
        "top_doadores": top_doadores(limit),
    }


def creditar_moedas(nome: str, quantidade: int) -> Optional[int]:
    """Credita moedas pro jogador (ignora anônimo/nome vazio). Retorna o
    novo saldo, ou None se não creditou nada."""
    if eh_anonimo(nome) or not nome or quantidade <= 0:
        return None
    with LOCK_ECONOMIA:
        dados = carregar_economia()
        carteira = obter_carteira(dados, nome)
        carteira["saldo"] = carteira.get("saldo", 0) + quantidade
        salvar_economia(dados)
        return carteira["saldo"]


def transferir_moedas(remetente: str, destinatario: str, quantidade: int) -> dict:
    """Transfere moedas de remetente para destinatário. Retorna dict com
    novo_saldo_remetente, novo_saldo_destinatario. Levanta ValueError em erro."""
    if eh_anonimo(remetente) or not remetente:
        raise ValueError("Você precisa estar logado para enviar moedas.")
    if eh_anonimo(destinatario) or not destinatario:
        raise ValueError("Destinatário inválido.")
    if remetente == destinatario:
        raise ValueError("Não é possível enviar moedas para si mesmo.")
    if quantidade <= 0:
        raise ValueError("Quantidade deve ser maior que zero.")

    with LOCK_ECONOMIA:
        dados = carregar_economia()
        carteira_rem = obter_carteira(dados, remetente)
        if carteira_rem.get("saldo", 0) < quantidade:
            raise ValueError("Moedas insuficientes.")
        agora = int(time.time())
        transferencias = carteira_rem.setdefault("transferencias_24h", [])
        transferencias[:] = [
            item for item in transferencias
            if agora - int(item.get("em", 0)) < 24 * 60 * 60
        ]
        usado_hoje = sum(int(item.get("quantidade", 0)) for item in transferencias)
        if usado_hoje + quantidade > LIMITE_TRANSFERENCIA_DIARIA:
            restante = max(0, LIMITE_TRANSFERENCIA_DIARIA - usado_hoje)
            raise ValueError("Limite diário de transferências atingido. Você ainda pode enviar %s moedas hoje." % restante)
        carteiras = dados.get("carteiras", {})
        if destinatario not in carteiras:
            raise ValueError("Usuário destinatário não encontrado.")
        carteira_dest = obter_carteira(dados, destinatario)
        eq_rem = carteira_rem.get("equipado") or {}
        eq_dest = carteira_dest.get("equipado") or {}
        visual_rem = {"nick": carteira_rem.get("nick") or remetente, "avatar": carteira_rem.get("avatar"),
                      "cor_nick": eq_rem.get("cor_nick"), "fonte_nick": eq_rem.get("fonte_nick"),
                      "decoracao_imagem": _imagem_decoracao(eq_rem.get("decoracao"), animada=True)}
        visual_dest = {"nick": carteira_dest.get("nick") or destinatario, "avatar": carteira_dest.get("avatar"),
                       "cor_nick": eq_dest.get("cor_nick"), "fonte_nick": eq_dest.get("fonte_nick"),
                       "decoracao_imagem": _imagem_decoracao(eq_dest.get("decoracao"), animada=True)}
        taxa = quantidade // 10
        taxa_dono = quantidade // 100
        recebido = quantidade - taxa
        carteira_rem["saldo"] = carteira_rem.get("saldo", 0) - quantidade
        carteira_dest["saldo"] = carteira_dest.get("saldo", 0) + recebido
        dono = obter_carteira(dados, DONO_DOACAO)
        dono["saldo"] = dono.get("saldo", 0) + taxa_dono
        # Registra histórico de doações
        historico_rem = carteira_rem.setdefault("historico_envios", [])
        historico_rem.insert(0, {"para": destinatario, "quantidade": quantidade, "em": agora, **visual_dest})
        del historico_rem[50:]
        transferencias.append({"quantidade": quantidade, "em": agora})
        del transferencias[:-100]
        ultimos = carteira_rem.setdefault("doacoes_por_destinatario", {})
        conta_insignia = _conta_para_insignia(carteira_rem, destinatario, agora)
        if conta_insignia:
            ultimos[destinatario] = agora
        total_doado = carteira_rem.get("total_doado", 0) + (quantidade if conta_insignia else 0)
        carteira_rem["total_doado"] = total_doado
        historico_dest = carteira_dest.setdefault("historico_recebidos", [])
        historico_dest.insert(0, {"de": remetente, "quantidade": recebido, "em": agora, "taxa": taxa, **visual_rem})
        del historico_dest[50:]
        salvar_economia(dados)
        return {
            "novo_saldo_remetente": carteira_rem["saldo"],
            "novo_saldo_destinatario": carteira_dest["saldo"],
            "doacao": progresso_doacao(total_doado),
            "insignia_nova": (progresso_doacao(total_doado)["atual"] if conta_insignia and progresso_doacao(total_doado)["atual"] and progresso_doacao(total_doado)["atual"] != progresso_doacao(carteira_rem.get("total_doado", 0) - quantidade)["atual"] else None),
            "recebido": recebido,
            "taxa": taxa,
            "taxa_dono": taxa_dono,
            "contou_insignia": conta_insignia,
        }


def top_doadores(limit: int = 10) -> list:
    """Retorna os top doadores ordenados por total_doado."""
    carteiras = carregar_economia().get("carteiras", {})
    entradas = []
    for nome, c in carteiras.items():
        total = c.get("total_doado", 0)
        if total <= 0:
            continue
        equipado = c.get("equipado") or {}
        entradas.append({
            "nome": nome,
            "nick": c.get("nick") or nome,
            "cor_nick": equipado.get("cor_nick"),
            "fonte_nick": equipado.get("fonte_nick"),
            "avatar": c.get("avatar"),
            "decoracao_imagem": _imagem_decoracao(equipado.get("decoracao"), animada=True),
            "moldura_perfil": moldura_publica(equipado.get("moldura")),
            "total_doado": total,
            "doacao": progresso_doacao(total),
        })
    return sorted(entradas, key=lambda x: x["total_doado"], reverse=True)[:limit]


def debitar_moedas(nome: str, quantidade: int) -> Optional[int]:
    """Remove moedas da conta (o saldo nunca fica negativo). Retorna o novo
    saldo, ou None se não removeu nada."""
    if eh_anonimo(nome) or not nome or quantidade <= 0:
        return None
    with LOCK_ECONOMIA:
        dados = carregar_economia()
        carteira = obter_carteira(dados, nome)
        carteira["saldo"] = max(0, carteira.get("saldo", 0) - quantidade)
        salvar_economia(dados)
        return carteira["saldo"]


def _contagem_itens(carteira: dict) -> dict:
    contagem = {
        "decoracoes": len(carteira.get("decoracoes") or []),
        "cores_nick": len(carteira.get("cores_nick") or []),
        "fontes_nick": len(carteira.get("fontes_nick") or []),
        "skins_splano": len(carteira.get("skins_splano") or []),
        "molduras": len(carteira.get("molduras") or []),
    }
    contagem["total"] = sum(v for k, v in contagem.items() if k != "total")
    return contagem


def zerar_saldo_admin(nome: str) -> Optional[int]:
    """Tira TODO o dinheiro do jogador de uma vez (o botão "remover todo o
    dinheiro" do painel). Retorna o novo saldo — sempre 0."""
    if eh_anonimo(nome) or not nome:
        return None
    with LOCK_ECONOMIA:
        dados = carregar_economia()
        carteira = obter_carteira(dados, nome)
        carteira["saldo"] = 0
        salvar_economia(dados)
        return 0


def consulta_admin(nome: str) -> dict:
    """Saldo + quantos itens da loja o jogador tem — pro painel de admin."""
    if not nome:
        return {"nome": "", "nick": None, "saldo": 0, "itens": _contagem_itens({})}
    with LOCK_ECONOMIA:
        dados = carregar_economia()
        carteira = obter_carteira(dados, nome)
        return {"nome": nome, "nick": carteira.get("nick"), "saldo": carteira.get("saldo", 0),
                "itens": _contagem_itens(carteira)}


def limpar_itens_admin(nome: str) -> dict:
    """Apaga tudo que o jogador comprou/ganhou na loja (decorações, cores,
    fontes, skins do Splano e molduras). As moedas ficam na conta."""
    if not nome:
        return {"nome": "", "removidos": 0, "saldo": 0, "itens": _contagem_itens({})}
    with LOCK_ECONOMIA:
        dados = carregar_economia()
        carteira = obter_carteira(dados, nome)
        removidos = 0
        for chave in ("decoracoes", "cores_nick", "fontes_nick", "skins_splano", "molduras"):
            removidos += len(carteira.get(chave) or [])
            carteira[chave] = []
        carteira["skin_splano_imagem"] = ""
        equipado = carteira.setdefault("equipado", {})
        for chave in ("decoracao", "cor_nick", "fonte_nick", "skin_splano", "moldura"):
            equipado[chave] = None
        salvar_economia(dados)
        return {"nome": nome, "removidos": removidos, "saldo": carteira.get("saldo", 0),
                "itens": _contagem_itens(carteira)}


def tentar_reclamar_bonus(nome: str, nick: str = None, avatar: str = None) -> dict:
    """Credita o bônus de atividade (50 moedas a cada 10 min), se já deu
    tempo desde o último. O cliente chama isso periodicamente enquanto a
    aba/Activity está aberta — o servidor decide, não confia no relógio do
    cliente."""
    if eh_anonimo(nome) or not nome:
        return {"creditado": False, "saldo": 0, "proximo_em_segundos": BONUS_INTERVALO_SEGUNDOS}

    with LOCK_ECONOMIA:
        dados = carregar_economia()
        carteira = obter_carteira(dados, nome, nick=nick, avatar=avatar)
        agora = time.time()
        passado = agora - carteira.get("ultimo_bonus", 0)

        if passado >= BONUS_INTERVALO_SEGUNDOS:
            carteira["saldo"] = carteira.get("saldo", 0) + BONUS_QUANTIDADE
            carteira["ultimo_bonus"] = agora
            salvar_economia(dados)
            return {"creditado": True, "saldo": carteira["saldo"], "proximo_em_segundos": BONUS_INTERVALO_SEGUNDOS}

        return {
            "creditado": False,
            "saldo": carteira["saldo"],
            "proximo_em_segundos": int(BONUS_INTERVALO_SEGUNDOS - passado),
        }


def sortear_fatia_roleta(aposta: int = 0) -> dict:
    """Sorteia ponderando pelo tamanho. Abaixo de 10 mil reduz o presente."""
    pesos = [f["peso"] for f in ROLETA_FATIAS]
    if aposta < 10_000:
        pesos = [p * (0.2 if f["tipo"] == "presente" else 1) for p, f in zip(pesos, ROLETA_FATIAS)]
    alvo = secrets.SystemRandom().random() * sum(pesos)
    indice = 0
    for i, peso in enumerate(pesos):
        alvo -= peso
        if alvo <= 0:
            indice = i
            break
    fatia = dict(ROLETA_FATIAS[indice])
    fatia["indice"] = indice
    return fatia


def sortear_presente(carteira: dict) -> Optional[dict]:
    """Presente da roleta: sorteia primeiro a categoria (decoração, moldura,
    cor do nick, fonte do nick ou skin do Splano.io) entre as que ainda têm
    item não possuído, depois o item."""
    aleatorio = secrets.SystemRandom()
    decoracoes = [d for d in CATALOGO_DECORACOES if d["sku_id"] not in carteira.get("decoracoes", [])]
    molduras = [m for m in CATALOGO_MOLDURAS if m["sku_id"] not in carteira.get("molduras", [])]
    cores = [c for c in CORES_NICK if c not in carteira.get("cores_nick", [])]
    fontes = [f for f in FONTES_NICK if f not in carteira.get("fontes_nick", [])]
    skins = [s for s in SKINS_SPLANO if s not in carteira.get("skins_splano", [])]
    categorias = [nome for nome, itens in (
        ("decoracao", decoracoes), ("moldura", molduras), ("cor_nick", cores),
        ("fonte_nick", fontes), ("skin_splano", skins),
    ) if itens]
    if not categorias:
        return None
    categoria = aleatorio.choice(categorias)
    if categoria == "decoracao":
        item = aleatorio.choice(decoracoes)
        carteira["decoracoes"].append(item["sku_id"])
        return {"tipo": "decoracao", "id": item["sku_id"], "nome": item["nome"], "imagem": item["imagem"]}
    if categoria == "moldura":
        item = aleatorio.choice(molduras)
        carteira.setdefault("molduras", []).append(item["sku_id"])
        return {"tipo": "moldura", "id": item["sku_id"], "nome": item["nome"], "imagem": item.get("imagem", "")}
    if categoria == "cor_nick":
        cor = aleatorio.choice(cores)
        carteira["cores_nick"].append(cor)
        return {"tipo": "cor_nick", "id": cor, "nome": "Arco-íris" if cor == "arco-iris" else cor.capitalize()}
    if categoria == "fonte_nick":
        fonte = aleatorio.choice(fontes)
        carteira["fontes_nick"].append(fonte)
        return {"tipo": "fonte_nick", "id": fonte, "nome": FONTES_NICK[fonte]}
    skin = aleatorio.choice(skins)
    carteira["skins_splano"].append(skin)
    return {"tipo": "skin_splano", "id": skin, "nome": SKINS_SPLANO[skin]["nome"],
            "cores": SKINS_SPLANO[skin].get("cores", []),
            "padrao": SKINS_SPLANO[skin].get("padrao", "solido")}


def girar_roleta(nome: str, aposta: int) -> dict:
    """Aposta na roleta: debita a aposta, sorteia a fatia e aplica o prêmio
    (moedas ou decoração). Levanta ValueError se a aposta for inválida ou o
    saldo for insuficiente — o router traduz isso pra HTTPException."""
    if aposta < ROLETA_APOSTA_MINIMA or aposta % ROLETA_APOSTA_MULTIPLO != 0:
        raise ValueError(
            f"Aposta mínima é {ROLETA_APOSTA_MINIMA} moedas, sempre em múltiplos de {ROLETA_APOSTA_MULTIPLO}."
        )

    with LOCK_ECONOMIA:
        dados = carregar_economia()
        carteira = obter_carteira(dados, nome)
        if carteira["saldo"] < aposta:
            raise ValueError("Moedas insuficientes.")

        carteira["saldo"] -= aposta
        fatia = sortear_fatia_roleta(aposta)
        premio_moedas = 0
        presente = None

        if fatia["tipo"] == "interrogacao":
            chance_item = 0.03 if aposta < 10_000 else 0.12
            if secrets.SystemRandom().random() < chance_item:
                presente = sortear_presente(carteira)
            else:
                presente = None
            if presente:
                fatia["tipo"], fatia["label"] = "presente", "Presente surpresa"
            else:
                fatia["tipo"] = "multiplicador"
                fatia["valor"] = round(secrets.SystemRandom().uniform(1, 3), 2)
                fatia["label"] = str(fatia["valor"]) + "x"
        if fatia["tipo"] == "multiplicador":
            premio_moedas = int(aposta * fatia["valor"])
            carteira["saldo"] += premio_moedas
        elif fatia["tipo"] == "presente":
            presente = sortear_presente(carteira)
            if not presente:
                # já tem tudo da loja — credita o preço de uma decoração em moedas.
                premio_moedas = PRECO_DECORACAO
                carteira["saldo"] += premio_moedas

        salvar_economia(dados)
        return {
            "fatia_indice": fatia["indice"],
            "resultado": fatia,
            "premio_moedas": premio_moedas,
            "presente": presente,
            "carteira": carteira_publica(carteira),
        }
