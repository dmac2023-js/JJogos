"""Moedas, loja de decorações de avatar e cor do nick."""
import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

from shared.imagem_proxy import ImagemRecusada, buscar as buscar_imagem_externa

from shared.economia import (
    CATALOGO_DECORACOES,
    CORES_NICK,
    FONTES_NICK,
    LOCK_ECONOMIA,
    PRECO_COR_NICK,
    PRECO_DECORACAO,
    PRECO_FONTE_NICK,
    SKINS_SPLANO,
    SKINS_SPLANO_GRUPOS,
    preco_skin_splano,
    ROLETA_APOSTA_MINIMA,
    ROLETA_APOSTA_MULTIPLO,
    ROLETA_FATIAS,
    carregar_economia,
    carteira_publica,
    consulta_admin,
    creditar_moedas,
    decoracao_existe,
    debitar_moedas,
    eh_admin_discord_id,
    girar_roleta,
    limpar_itens_admin,
    zerar_saldo_admin,
    obter_carteira,
    perfil_publico,
    preco_decoracao_item,
    registrar_fim_partida,
    resolver_nome_alvo,
    salvar_economia,
    tentar_reclamar_bonus,
    top_ranking,
)
from shared.recordes import eh_anonimo

router = APIRouter()


class BonusRequest(BaseModel):
    nome: str
    nick: str = "Anônimo"
    avatar: str = ""


class CompraDecoracao(BaseModel):
    nome: str
    nick: str = "Anônimo"
    sku_id: str


class CompraCor(BaseModel):
    nome: str
    nick: str = "Anônimo"
    cor: str


class CompraFonte(BaseModel):
    nome: str
    nick: str = "Anônimo"
    fonte: str


class CompraSkinSplano(BaseModel):
    nome: str
    nick: str = "Anônimo"
    skin: str


class ImagemSkinSplano(BaseModel):
    nome: str
    nick: str = "Anônimo"
    imagem: str


class EquiparRequest(BaseModel):
    nome: str
    nick: str = "Anônimo"
    tipo: str  # "decoracao" | "cor_nick" | "fonte_nick" | "skin_splano"
    valor: Optional[str] = None


class GirarRoleta(BaseModel):
    nome: str
    nick: str = "Anônimo"
    aposta: int


class DoarMoedas(BaseModel):
    admin_id: str
    alvo_id: str
    quantidade: int
    acao: str = "adicionar"  # "adicionar" | "remover"


class AdminAlvo(BaseModel):
    admin_id: str
    alvo_id: str


class TempoJogo(BaseModel):
    nome: str
    nick: str = "Anônimo"
    avatar: str = ""
    segundos: int = 0
    jogo: str = ""
    venceu: bool = False
    resultado: str = ""


def _carteira_vazia() -> dict:
    return {"saldo": 0, "decoracoes": [], "cores_nick": [], "fontes_nick": [], "historico": [],
            "equipado": {"decoracao": None, "cor_nick": None, "fonte_nick": None}}


@router.get("/economia/carteira")
def obter_minha_carteira(nome: str = "", nick: str = "", avatar: str = "", discord_id: str = ""):
    if not nome or eh_anonimo(nick):
        return _carteira_vazia()
    with LOCK_ECONOMIA:
        dados = carregar_economia()
        carteira = obter_carteira(dados, nome, nick=nick, avatar=avatar or None,
                                  discord_id=discord_id or None)
        # Salva nick+avatar sempre que chamado — garante que o ranking
        # exibe o display name atual mesmo que o usuário nunca tenha comprado nada.
        salvar_economia(dados)
        resposta = carteira_publica(carteira)
        resposta["eh_admin"] = eh_admin_discord_id(discord_id)
        return resposta


@router.get("/economia/loja")
def obter_loja():
    return {
        "decoracoes": CATALOGO_DECORACOES,
        "preco_decoracao": PRECO_DECORACAO,
        "cores_nick": [c for c in CORES_NICK if c != "arco-iris"],
        "tem_arco_iris": True,
        "preco_cor_nick": PRECO_COR_NICK,
        "fontes_nick": [{"id": k, "nome": v} for k, v in FONTES_NICK.items()],
        "preco_fonte_nick": PRECO_FONTE_NICK,
        "skins_splano": [dict(s, id=k, preco=preco_skin_splano(k))
                         for k, s in SKINS_SPLANO.items()],
        "skins_splano_grupos": SKINS_SPLANO_GRUPOS,
    }


@router.post("/economia/bonus")
def reclamar_bonus(dados: BonusRequest):
    if eh_anonimo(dados.nick) or not dados.nome:
        raise HTTPException(status_code=400, detail="Entre com Discord pra ganhar moedas.")
    return tentar_reclamar_bonus(dados.nome, nick=dados.nick, avatar=dados.avatar or None)


@router.post("/economia/comprar/decoracao")
def comprar_decoracao(dados: CompraDecoracao):
    if eh_anonimo(dados.nick) or not dados.nome:
        raise HTTPException(status_code=400, detail="Entre com Discord pra comprar.")
    if not decoracao_existe(dados.sku_id):
        raise HTTPException(status_code=404, detail="Decoração não encontrada.")

    with LOCK_ECONOMIA:
        economia = carregar_economia()
        carteira = obter_carteira(economia, dados.nome, nick=dados.nick)
        if dados.sku_id in carteira["decoracoes"]:
            raise HTTPException(status_code=409, detail="Você já tem essa decoração.")
        preco = preco_decoracao_item(dados.sku_id)
        if carteira["saldo"] < preco:
            raise HTTPException(status_code=402, detail="Moedas insuficientes.")

        carteira["saldo"] -= preco
        carteira["decoracoes"].append(dados.sku_id)
        salvar_economia(economia)
        return carteira_publica(carteira)


@router.post("/economia/comprar/cor")
def comprar_cor(dados: CompraCor):
    if eh_anonimo(dados.nick) or not dados.nome:
        raise HTTPException(status_code=400, detail="Entre com Discord pra comprar.")
    if dados.cor not in CORES_NICK:
        raise HTTPException(status_code=400, detail="Cor inválida.")

    with LOCK_ECONOMIA:
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


@router.post("/economia/comprar/fonte")
def comprar_fonte(dados: CompraFonte):
    if eh_anonimo(dados.nick) or not dados.nome:
        raise HTTPException(status_code=400, detail="Entre com Discord pra comprar.")
    if dados.fonte not in FONTES_NICK:
        raise HTTPException(status_code=400, detail="Fonte inválida.")

    with LOCK_ECONOMIA:
        economia = carregar_economia()
        carteira = obter_carteira(economia, dados.nome, nick=dados.nick)
        if dados.fonte in carteira["fontes_nick"]:
            raise HTTPException(status_code=409, detail="Você já tem essa fonte.")
        if carteira["saldo"] < PRECO_FONTE_NICK:
            raise HTTPException(status_code=402, detail="Moedas insuficientes.")

        carteira["saldo"] -= PRECO_FONTE_NICK
        carteira["fontes_nick"].append(dados.fonte)
        salvar_economia(economia)
        return carteira_publica(carteira)


@router.post("/economia/comprar/skin-splano")
def comprar_skin_splano(dados: CompraSkinSplano):
    if eh_anonimo(dados.nick) or not dados.nome:
        raise HTTPException(status_code=400, detail="Entre com Discord pra comprar.")
    if dados.skin not in SKINS_SPLANO:
        raise HTTPException(status_code=400, detail="Skin inválida.")

    economia = carregar_economia()
    carteira = obter_carteira(economia, dados.nome, nick=dados.nick)
    if dados.skin in carteira["skins_splano"]:
        raise HTTPException(status_code=409, detail="Você já tem essa skin.")
    preco = preco_skin_splano(dados.skin)
    if carteira["saldo"] < preco:
        raise HTTPException(status_code=402, detail="Moedas insuficientes.")

    carteira["saldo"] -= preco
    carteira["skins_splano"].append(dados.skin)
    salvar_economia(economia)
    return carteira_publica(carteira)


@router.post("/economia/skin-splano/imagem")
def definir_imagem_skin_splano(dados: ImagemSkinSplano):
    """URL da imagem usada pela skin personalizada (só quem comprou tem)."""
    if eh_anonimo(dados.nick) or not dados.nome:
        raise HTTPException(status_code=400, detail="Entre com Discord.")
    url = (dados.imagem or "").strip()
    if url and not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Use um link http(s) direto da imagem.")
    if len(url) > 500:
        raise HTTPException(status_code=400, detail="Link muito longo.")

    economia = carregar_economia()
    carteira = obter_carteira(economia, dados.nome, nick=dados.nick)
    if "imagem" not in carteira["skins_splano"]:
        raise HTTPException(status_code=403, detail="Compre a skin de imagem personalizada primeiro.")
    carteira["skin_splano_imagem"] = url
    salvar_economia(economia)
    return carteira_publica(carteira)


# Cache curto na memória do processo: a mesma skin é pedida por todo mundo na
# sala a cada partida, e a VM não tem banda sobrando pra rebaixar a imagem toda
# vez. url -> (validade, bytes, content-type).
_CACHE_IMAGENS: dict = {}
_CACHE_SEGUNDOS = 600
_CACHE_MAXIMO = 60


@router.get("/imagem-externa")
def imagem_externa(url: str = Query(..., max_length=500)):
    """Serve uma imagem de outro site pelo nosso domínio.

    Existe por causa da Activity do Discord: lá a página roda em
    <id>.discordsays.com e a sandbox bloqueia host que não seja do Discord, o
    que fazia a skin de imagem personalizada sumir. Pelo nosso domínio a imagem
    é de mesma origem e carrega. A checagem de SSRF mora em shared/imagem_proxy.
    """
    agora = time.time()
    em_cache = _CACHE_IMAGENS.get(url)
    if em_cache and em_cache[0] > agora:
        corpo, tipo = em_cache[1], em_cache[2]
    else:
        try:
            corpo, tipo = buscar_imagem_externa(url)
        except ImagemRecusada as erro:
            raise HTTPException(status_code=400, detail=str(erro))
        if len(_CACHE_IMAGENS) >= _CACHE_MAXIMO:
            _CACHE_IMAGENS.clear()
        _CACHE_IMAGENS[url] = (agora + _CACHE_SEGUNDOS, corpo, tipo)
    return Response(content=corpo, media_type=tipo,
                    headers={"Cache-Control": "public, max-age=600"})


@router.post("/economia/equipar")
def equipar(dados: EquiparRequest):
    if eh_anonimo(dados.nick) or not dados.nome:
        raise HTTPException(status_code=400, detail="Entre com Discord.")
    listas = {"decoracao": "decoracoes", "cor_nick": "cores_nick",
              "fonte_nick": "fontes_nick", "skin_splano": "skins_splano"}
    if dados.tipo not in listas:
        raise HTTPException(status_code=400, detail="Tipo inválido.")

    with LOCK_ECONOMIA:
        economia = carregar_economia()
        carteira = obter_carteira(economia, dados.nome, nick=dados.nick)
        lista = carteira[listas[dados.tipo]]
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
    if eh_anonimo(dados.nick) or not dados.nome or (not dados.jogo and dados.segundos <= 0):
        return {"ok": False}
    registrar_fim_partida(dados.nome, dados.nick, max(0, dados.segundos),
                          jogo=dados.jogo, avatar=dados.avatar or None,
                          venceu=dados.venceu, resultado=dados.resultado)
    return {"ok": True}


@router.get("/economia/ranking")
def obter_ranking(limit: int = 10):
    limit = max(1, min(limit, 50))
    return top_ranking(limit)


@router.get("/economia/jogador")
def obter_perfil_jogador(nome: str = ""):
    """Perfil público (mesmo formato do ranking) — usado ao clicar no avatar/nick
    de alguém em salas, placares e tabelas de vitórias."""
    perfil = perfil_publico(nome) if nome and not eh_anonimo(nome) else None
    if not perfil:
        raise HTTPException(status_code=404, detail="Jogador sem perfil ainda.")
    return perfil


def _alvo_admin(admin_id: str, alvo_id: str) -> str:
    """Checa o ID do admin e resolve o alvo (ID do Discord ou username).
    Nunca confia num "sou admin" mandado pelo cliente — o ID é checado aqui."""
    if not eh_admin_discord_id(admin_id):
        raise HTTPException(status_code=403, detail="Você não tem permissão para isso.")
    nome_alvo = resolver_nome_alvo((alvo_id or "").strip())
    if not nome_alvo:
        raise HTTPException(
            status_code=404,
            detail=("Não achei ninguém com esse ID/username. Se for um ID do Discord, a pessoa "
                    "precisa ter aberto o site logada pelo menos uma vez recentemente (versão "
                    "atual). Tente também o @username dela do Discord direto."),
        )
    return nome_alvo


@router.post("/economia/admin/consultar")
def admin_consultar(dados: AdminAlvo):
    """Saldo e itens da loja de um jogador — o admin digita o ID e vê quanto
    a pessoa tem antes de adicionar/remover moedas."""
    nome_alvo = _alvo_admin(dados.admin_id, dados.alvo_id)
    return consulta_admin(nome_alvo)


@router.post("/economia/admin/doar")
def admin_doar_moedas(dados: DoarMoedas):
    """Só o(s) ID(s) em ADMIN_DISCORD_IDS conseguem creditar/remover moedas
    de qualquer jogador (inclusive pra si mesmo, usando o próprio ID)."""
    if dados.quantidade <= 0 or dados.quantidade > 1_000_000_000:
        raise HTTPException(status_code=400, detail="Quantidade inválida.")
    nome_alvo = _alvo_admin(dados.admin_id, dados.alvo_id)

    if dados.acao == "remover":
        novo_saldo = debitar_moedas(nome_alvo, dados.quantidade)
    else:
        novo_saldo = creditar_moedas(nome_alvo, dados.quantidade)
    if novo_saldo is None:
        raise HTTPException(status_code=400, detail="Não consegui alterar o saldo desse jogador.")
    return {"nome": nome_alvo, "saldo": novo_saldo,
            "itens": consulta_admin(nome_alvo)["itens"]}


@router.post("/economia/admin/zerar-saldo")
def admin_zerar_saldo(dados: AdminAlvo):
    """Remove todo o dinheiro do jogador de uma vez (os itens ficam)."""
    nome_alvo = _alvo_admin(dados.admin_id, dados.alvo_id)
    novo_saldo = zerar_saldo_admin(nome_alvo)
    if novo_saldo is None:
        raise HTTPException(status_code=400, detail="Não consegui alterar o saldo desse jogador.")
    return {"nome": nome_alvo, "saldo": novo_saldo,
            "itens": consulta_admin(nome_alvo)["itens"]}


@router.post("/economia/admin/limpar-itens")
def admin_limpar_itens(dados: AdminAlvo):
    """Apaga todos os itens que o jogador comprou/ganhou na loja (as moedas
    continuam na conta)."""
    nome_alvo = _alvo_admin(dados.admin_id, dados.alvo_id)
    return limpar_itens_admin(nome_alvo)
