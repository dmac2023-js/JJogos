"""Moedas, loja de decorações de avatar e cor do nick.

Carteira é indexada por "nome" (o username do Discord, já usado como chave
única em todo o app pra recordes/vitórias) — quem não está logado com
Discord (anônimo) não ganha nem gasta moeda nenhuma.
"""
import json
import time
from pathlib import Path
from typing import Optional

from shared.config import ARQUIVO_ECONOMIA, PASTA_BASE
from shared.db import carregar_json, salvar_json
from shared.recordes import eh_anonimo

CHAVE_ECONOMIA = "jjogos:economia"

BONUS_INTERVALO_SEGUNDOS = 15 * 60
BONUS_QUANTIDADE = 5
MOEDAS_VITORIA_SOLO = 2
MOEDAS_VITORIA_MULTIPLAYER = 5
PRECO_DECORACAO = 70
PRECO_COR_NICK = 30

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
            "imagem": f"https://cdn.discordapp.com/avatar-decoration-presets/{asset}.png",
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


def obter_carteira(dados: dict, nome: str) -> dict:
    carteira = dados["carteiras"].setdefault(nome, {})
    carteira.setdefault("saldo", 0)
    carteira.setdefault("ultimo_bonus", 0)
    carteira.setdefault("decoracoes", [])
    carteira.setdefault("cores_nick", [])
    carteira.setdefault("equipado", {"decoracao": None, "cor_nick": None})
    return carteira


def carteira_publica(carteira: dict) -> dict:
    return {
        "saldo": carteira.get("saldo", 0),
        "decoracoes": carteira.get("decoracoes", []),
        "cores_nick": carteira.get("cores_nick", []),
        "equipado": carteira.get("equipado", {"decoracao": None, "cor_nick": None}),
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


def tentar_reclamar_bonus(nome: str) -> dict:
    """Credita o bônus de atividade (5 moedas a cada 15 min), se já deu
    tempo desde o último. O cliente chama isso periodicamente enquanto a
    aba/Activity está aberta — o servidor decide, não confia no relógio do
    cliente."""
    if eh_anonimo(nome) or not nome:
        return {"creditado": False, "saldo": 0, "proximo_em_segundos": BONUS_INTERVALO_SEGUNDOS}

    dados = carregar_economia()
    carteira = obter_carteira(dados, nome)
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
