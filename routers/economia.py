"""Moedas, loja de decorações de avatar e cor do nick."""
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from shared.economia import (
    CATALOGO_DECORACOES,
    CORES_NICK,
    PRECO_COR_NICK,
    PRECO_DECORACAO,
    ROLETA_APOSTA_MINIMA,
    ROLETA_APOSTA_MULTIPLO,
    ROLETA_FATIAS,
    carregar_economia,
    carteira_publica,
    decoracao_existe,
    girar_roleta,
    obter_carteira,
    registrar_tempo_jogo,
    salvar_economia,
    tentar_reclamar_bonus,
    top_ranking,
)
from shared.recordes import eh_anonimo

router = APIRouter()


class BonusRequest(BaseModel):
    nome: str
    nick: str = "Anônimo"


class CompraDecoracao(BaseModel):
    nome: str
    nick: str = "Anônimo"
    sku_id: str


class CompraCor(BaseModel):
    nome: str
    nick: str = "Anônimo"
    cor: str


class EquiparRequest(BaseModel):
    nome: str
    nick: str = "Anônimo"
    tipo: str  # "decoracao" | "cor_nick"
    valor: Optional[str] = None


class GirarRoleta(BaseModel):
    nome: str
    nick: str = "Anônimo"
    aposta: int


class TempoJogo(BaseModel):
    nome: str
    nick: str = "Anônimo"
    segundos: int


def _carteira_vazia() -> dict:
    return {"saldo": 0, "decoracoes": [], "cores_nick": [], "equipado": {"decoracao": None, "cor_nick": None}}


@router.get("/economia/carteira")
def obter_minha_carteira(nome: str = "", nick: str = ""):
    if not nome or eh_anonimo(nick):
        return _carteira_vazia()
    dados = carregar_economia()
    return carteira_publica(obter_carteira(dados, nome, nick=nick))


@router.get("/economia/loja")
def obter_loja():
    return {
        "decoracoes": CATALOGO_DECORACOES,
        "preco_decoracao": PRECO_DECORACAO,
        "cores_nick": [c for c in CORES_NICK if c != "arco-iris"],
        "tem_arco_iris": True,
        "preco_cor_nick": PRECO_COR_NICK,
    }


@router.post("/economia/bonus")
def reclamar_bonus(dados: BonusRequest):
    if eh_anonimo(dados.nick) or not dados.nome:
        raise HTTPException(status_code=400, detail="Entre com Discord pra ganhar moedas.")
    return tentar_reclamar_bonus(dados.nome)


@router.post("/economia/comprar/decoracao")
def comprar_decoracao(dados: CompraDecoracao):
    if eh_anonimo(dados.nick) or not dados.nome:
        raise HTTPException(status_code=400, detail="Entre com Discord pra comprar.")
    if not decoracao_existe(dados.sku_id):
        raise HTTPException(status_code=404, detail="Decoração não encontrada.")

    economia = carregar_economia()
    carteira = obter_carteira(economia, dados.nome, nick=dados.nick)
    if dados.sku_id in carteira["decoracoes"]:
        raise HTTPException(status_code=409, detail="Você já tem essa decoração.")
    if carteira["saldo"] < PRECO_DECORACAO:
        raise HTTPException(status_code=402, detail="Moedas insuficientes.")

    carteira["saldo"] -= PRECO_DECORACAO
    carteira["decoracoes"].append(dados.sku_id)
    salvar_economia(economia)
    return carteira_publica(carteira)


@router.post("/economia/comprar/cor")
def comprar_cor(dados: CompraCor):
    if eh_anonimo(dados.nick) or not dados.nome:
        raise HTTPException(status_code=400, detail="Entre com Discord pra comprar.")
    if dados.cor not in CORES_NICK:
        raise HTTPException(status_code=400, detail="Cor inválida.")

    economia = carregar_economia()
    carteira = obter_carteira(economia, dados.nome, nick=dados.nick)
    if dados.cor in carteira["cores_nick"]:
        raise HTTPException(status_code=409, detail="Você já tem essa cor.")
    if carteira["saldo"] < PRECO_COR_NICK:
        raise HTTPException(status_code=402, detail="Moedas insuficientes.")

    carteira["saldo"] -= PRECO_COR_NICK
    carteira["cores_nick"].append(dados.cor)
    salvar_economia(economia)
    return carteira_publica(carteira)


@router.post("/economia/equipar")
def equipar(dados: EquiparRequest):
    if eh_anonimo(dados.nick) or not dados.nome:
        raise HTTPException(status_code=400, detail="Entre com Discord.")
    if dados.tipo not in ("decoracao", "cor_nick"):
        raise HTTPException(status_code=400, detail="Tipo inválido.")

    economia = carregar_economia()
    carteira = obter_carteira(economia, dados.nome, nick=dados.nick)
    lista = carteira["decoracoes"] if dados.tipo == "decoracao" else carteira["cores_nick"]
    if dados.valor is not None and dados.valor not in lista:
        raise HTTPException(status_code=403, detail="Você não tem esse item.")

    carteira["equipado"][dados.tipo] = dados.valor
    salvar_economia(economia)
    return carteira_publica(carteira)


@router.get("/economia/roleta")
def obter_roleta():
    return {
        "fatias": ROLETA_FATIAS,
        "aposta_minima": ROLETA_APOSTA_MINIMA,
        "aposta_multiplo": ROLETA_APOSTA_MULTIPLO,
    }


@router.post("/economia/roleta/girar")
def girar(dados: GirarRoleta):
    if eh_anonimo(dados.nick) or not dados.nome:
        raise HTTPException(status_code=400, detail="Entre com Discord pra jogar na roleta.")
    try:
        return girar_roleta(dados.nome, dados.aposta)
    except ValueError as erro:
        detalhe = str(erro)
        status = 402 if "insuficientes" in detalhe else 400
        raise HTTPException(status_code=status, detail=detalhe)


@router.post("/economia/tempo")
def registrar_tempo(dados: TempoJogo):
    if eh_anonimo(dados.nick) or not dados.nome or dados.segundos <= 0:
        return {"ok": False}
    registrar_tempo_jogo(dados.nome, dados.nick, dados.segundos)
    return {"ok": True}


@router.get("/economia/ranking")
def obter_ranking(limit: int = 10):
    limit = max(1, min(limit, 50))
    return top_ranking(limit)
