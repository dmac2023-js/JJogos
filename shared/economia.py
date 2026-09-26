"""Moedas, loja de decorações de avatar e cor do nick.

Carteira é indexada por "nome" (o username do Discord, já usado como chave
única em todo o app pra recordes/vitórias) — quem não está logado com
Discord (anônimo) não ganha nem gasta moeda nenhuma.
"""
import json
import secrets
import time
from pathlib import Path
from typing import Optional

from shared.config import ARQUIVO_ECONOMIA, PASTA_BASE
from shared.db import carregar_json, salvar_json
from shared.recordes import eh_anonimo

CHAVE_ECONOMIA = "jjogos:economia"

BONUS_INTERVALO_SEGUNDOS = 15 * 60
BONUS_QUANTIDADE = 5
PRECO_DECORACAO = 70
PRECO_COR_NICK = 30

# Moedas por vitória — cada jogo tem sua própria tabela (por dificuldade,
# quando aplicável). Online sempre paga mais que o modo solo/vs-máquina.
MOEDAS_SUDOKU_SOLO = {"facil": 5, "medio": 10, "dificil": 15}
MOEDAS_SUDOKU_ONLINE = {"facil": 10, "medio": 20, "dificil": 30}

MOEDAS_VELHA_SOLO = 1
MOEDAS_VELHA_ONLINE = 5

MOEDAS_TERMO_SOLO = {"facil": 2, "medio": 5, "dificil": 10}
MOEDAS_TERMO_ONLINE = {"facil": 5, "medio": 10, "dificil": 15}

MOEDAS_CAMPO_SOLO = {"facil": 2, "medio": 5, "dificil": 10}
MOEDAS_CAMPO_ONLINE = {"facil": 5, "medio": 10, "dificil": 15}

# Ludo não tem modo solo nem dificuldade — todo mundo que participa até o
# fim da partida ganha a moeda de participação; quem vence some MAIS a
# moeda de vitória por cima.
MOEDAS_LUDO_VITORIA = 20
MOEDAS_LUDO_PARTICIPACAO = 5

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
    "arco-iris": None,  # animação (ver .nick-arco-iris no css), não é cor fixa
}

ARQUIVO_LOJA_DECORACOES = PASTA_BASE / "loja_decoracoes.json"

PARTIDAS_JOGOS = [
    "sudoku_solo", "sudoku_online",
    "velha_maquina", "velha_online",
    "campo_solo", "campo_online",
    "termo_solo", "termo_online",
    "ludo",
]

# Roleta da sorte — 7 fatias intercaladas (mesma categoria nunca é vizinha),
# peso = tamanho da fatia em % (soma sempre 100). "indice" é preenchido em
# sortear_fatia_roleta() e usado pelo front pra girar até a fatia certa.
ROLETA_APOSTA_MINIMA = 10
ROLETA_APOSTA_MULTIPLO = 10
ROLETA_FATIAS = [
    {"tipo": "multiplicador", "valor": 2.0, "peso": 15, "label": "2x"},
    {"tipo": "multiplicador", "valor": 1.5, "peso": 10, "label": "1.5x"},
    {"tipo": "multiplicador", "valor": 0.5, "peso": 20, "label": "0.5x"},
    {"tipo": "decoracao", "peso": 10, "label": "Decoração grátis"},
    {"tipo": "multiplicador", "valor": 0.5, "peso": 20, "label": "0.5x"},
    {"tipo": "multiplicador", "valor": 1.5, "peso": 10, "label": "1.5x"},
    {"tipo": "multiplicador", "valor": 2.0, "peso": 15, "label": "2x"},
]


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


def carregar_economia() -> dict:
    dados = carregar_json(CHAVE_ECONOMIA, ARQUIVO_ECONOMIA)
    dados.setdefault("carteiras", {})
    return dados


def salvar_economia(dados: dict) -> None:
    salvar_json(CHAVE_ECONOMIA, dados, ARQUIVO_ECONOMIA)


def obter_carteira(dados: dict, nome: str, nick: str = None, avatar: str = None) -> dict:
    carteira = dados["carteiras"].setdefault(nome, {})
    carteira.setdefault("saldo", 0)
    carteira.setdefault("ultimo_bonus", 0)
    carteira.setdefault("decoracoes", [])
    carteira.setdefault("cores_nick", [])
    carteira.setdefault("equipado", {"decoracao": None, "cor_nick": None})
    carteira.setdefault("segundos_jogados", 0)
    carteira.setdefault("partidas", {})
    carteira.setdefault("vitorias", {})
    if nick:
        carteira["nick"] = nick
    if avatar:
        carteira["avatar"] = avatar
    return carteira


def carteira_publica(carteira: dict) -> dict:
    equipado = carteira.get("equipado", {"decoracao": None, "cor_nick": None})
    decoracao_sku = equipado.get("decoracao")
    return {
        "saldo": carteira.get("saldo", 0),
        "decoracoes": carteira.get("decoracoes", []),
        "cores_nick": carteira.get("cores_nick", []),
        "equipado": equipado,
        # URL pronta da decoração equipada, pro front não precisar carregar o
        # catálogo inteiro só pra desenhar o avatar do cabeçalho/perfil.
        "decoracao_imagem": _DECORACOES_POR_SKU.get(decoracao_sku, {}).get("imagem_animada") if decoracao_sku else None,
    }


def cosmeticos_equipados(nome: str) -> dict:
    """Usado pelos jogos pra mostrar a decoração/cor equipada de QUALQUER
    jogador (não só o usuário atual) — ex: no placar de uma partida."""
    if eh_anonimo(nome) or not nome:
        return {"decoracao": None, "cor_nick": None}
    dados = carregar_economia()
    carteira = dados.get("carteiras", {}).get(nome)
    if not carteira:
        return {"decoracao": None, "cor_nick": None}
    equipado = carteira.get("equipado") or {}
    decoracao_sku = equipado.get("decoracao")
    imagem = _DECORACOES_POR_SKU.get(decoracao_sku, {}).get("imagem") if decoracao_sku else None
    return {"decoracao": imagem, "cor_nick": equipado.get("cor_nick")}


def registrar_fim_partida(nome: str, nick: str, segundos: int,
                          jogo: str = "", avatar: str = None,
                          venceu: bool = False) -> None:
    """Registra fim de partida: acumula segundos, incrementa partidas e vitórias por jogo."""
    if eh_anonimo(nome) or not nome:
        return
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
    salvar_economia(dados)


def top_ranking(limit: int = 10) -> dict:
    """Retorna os top jogadores por moedas e por horas jogadas."""
    dados = carregar_economia()
    carteiras = dados.get("carteiras", {})

    top_moedas = []
    top_horas = []

    for nome, carteira in carteiras.items():
        nick = carteira.get("nick") or nome
        equipado = carteira.get("equipado") or {}
        cor_nick = equipado.get("cor_nick")
        decoracao_sku = equipado.get("decoracao")
        decoracao_imagem = (
            _DECORACOES_POR_SKU.get(decoracao_sku, {}).get("imagem_animada")
            if decoracao_sku else None
        )
        saldo = carteira.get("saldo", 0)
        segundos = carteira.get("segundos_jogados", 0)
        partidas_dict = carteira.get("partidas", {})
        total_partidas = sum(partidas_dict.values())
        vitorias_dict = carteira.get("vitorias", {})
        entrada = {
            "nome": nome,
            "nick": nick,
            "cor_nick": cor_nick,
            "avatar": carteira.get("avatar"),
            "decoracao_imagem": decoracao_imagem,
            "segundos": segundos,
            "partidas": partidas_dict,
            "vitorias": vitorias_dict,
            "total_partidas": total_partidas,
        }
        top_moedas.append({**entrada, "saldo": saldo})
        top_horas.append({**entrada, "saldo": saldo})

    top_moedas.sort(key=lambda x: x["saldo"], reverse=True)
    top_horas.sort(key=lambda x: x["total_partidas"], reverse=True)

    return {
        "top_moedas": top_moedas[:limit],
        "top_horas": top_horas[:limit],
    }


def creditar_moedas(nome: str, quantidade: int) -> Optional[int]:
    """Credita moedas pro jogador (ignora anônimo/nome vazio). Retorna o
    novo saldo, ou None se não creditou nada."""
    if eh_anonimo(nome) or not nome or quantidade <= 0:
        return None
    dados = carregar_economia()
    carteira = obter_carteira(dados, nome)
    carteira["saldo"] = carteira.get("saldo", 0) + quantidade
    salvar_economia(dados)
    return carteira["saldo"]


def tentar_reclamar_bonus(nome: str, nick: str = None, avatar: str = None) -> dict:
    """Credita o bônus de atividade (5 moedas a cada 15 min), se já deu
    tempo desde o último. O cliente chama isso periodicamente enquanto a
    aba/Activity está aberta — o servidor decide, não confia no relógio do
    cliente."""
    if eh_anonimo(nome) or not nome:
        return {"creditado": False, "saldo": 0, "proximo_em_segundos": BONUS_INTERVALO_SEGUNDOS}

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


def sortear_fatia_roleta() -> dict:
    """Sorteia uma fatia respeitando os pesos (%) de cada uma."""
    pesos = [fatia["peso"] for fatia in ROLETA_FATIAS]
    indice = secrets.SystemRandom().choices(range(len(ROLETA_FATIAS)), weights=pesos, k=1)[0]
    fatia = dict(ROLETA_FATIAS[indice])
    fatia["indice"] = indice
    return fatia


def sortear_decoracao_nao_possuida(carteira: dict) -> Optional[dict]:
    possuidas = set(carteira.get("decoracoes", []))
    candidatas = [item for item in CATALOGO_DECORACOES if item["sku_id"] not in possuidas]
    if not candidatas:
        return None
    return secrets.SystemRandom().choice(candidatas)


def girar_roleta(nome: str, aposta: int) -> dict:
    """Aposta na roleta: debita a aposta, sorteia a fatia e aplica o prêmio
    (moedas ou decoração). Levanta ValueError se a aposta for inválida ou o
    saldo for insuficiente — o router traduz isso pra HTTPException."""
    if aposta < ROLETA_APOSTA_MINIMA or aposta % ROLETA_APOSTA_MULTIPLO != 0:
        raise ValueError(
            f"Aposta mínima é {ROLETA_APOSTA_MINIMA} moedas, sempre em múltiplos de {ROLETA_APOSTA_MULTIPLO}."
        )

    dados = carregar_economia()
    carteira = obter_carteira(dados, nome)
    if carteira["saldo"] < aposta:
        raise ValueError("Moedas insuficientes.")

    carteira["saldo"] -= aposta
    fatia = sortear_fatia_roleta()
    premio_moedas = 0
    decoracao_ganha = None

    if fatia["tipo"] == "multiplicador":
        premio_moedas = int(aposta * fatia["valor"])
        carteira["saldo"] += premio_moedas
    elif fatia["tipo"] == "decoracao":
        decoracao_ganha = sortear_decoracao_nao_possuida(carteira)
        if decoracao_ganha:
            carteira["decoracoes"].append(decoracao_ganha["sku_id"])
        else:
            # já tem todas as decorações — credita o preço de uma em moedas.
            premio_moedas = PRECO_DECORACAO
            carteira["saldo"] += premio_moedas

    salvar_economia(dados)
    return {
        "fatia_indice": fatia["indice"],
        "resultado": fatia,
        "premio_moedas": premio_moedas,
        "decoracao": decoracao_ganha,
        "carteira": carteira_publica(carteira),
    }
