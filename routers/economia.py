"""Moedas, loja de decorações de avatar e cor do nick."""
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from shared.economia import (
    CATALOGO_DECORACOES,
    CORES_NICK,
    PRECO_COR_NICK,
    PRECO_DECORACAO,
    carregar_economia,
    carteira_publica,
    decoracao_existe,
    obter_carteira,
    salvar_economia,
    tentar_reclamar_bonus,
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


def _carteira_vazia() -> dict:
    return {"saldo": 0, "decoracoes": [], "cores_nick": [], "equipado": {"decoracao": None, "cor_nick": None}}


@router.get("/economia/carteira")
def obter_minha_carteira(nome: str = "", nick: str = ""):
    if not nome or eh_anonimo(nick):
        return _carteira_vazia()
    dados = carregar_economia()
    return carteira_publica(obter_carteira(dados, nome))


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
    carteira = obter_carteira(economia, dados.nome)
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
    carteira = obter_carteira(economia, dados.nome)
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
    carteira = obter_carteira(economia, dados.nome)
    lista = carteira["decoracoes"] if dados.tipo == "decoracao" else carteira["cores_nick"]
    if dados.valor is not None and dados.valor not in lista:
        raise HTTPException(status_code=403, detail="Você não tem esse item.")

    carteira["equipado"][dados.tipo] = dados.valor
    salvar_economia(economia)
    return carteira_publica(carteira)
