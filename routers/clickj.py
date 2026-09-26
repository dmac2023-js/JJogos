"""ClickJ — clicker + PvP por turnos (WebSocket /ws/clickj).

O estado de todos os jogadores fica em memória e o servidor é a autoridade:
cliques manuais têm limite por segundo, o autoclicker roda aqui (1 tick/s) e
as lutas são resolvidas aqui. A gravação no Redis é em lote (a cada 30s e
quando alguém sai) pra não estourar a cota de comandos do Upstash.
"""
import asyncio
import json
import random
import secrets
import time
from typing import Dict, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from shared import clickj as regras
from shared.config import PASTA_BASE
from shared.db import redis_get, redis_set, usando_redis
from shared.economia import (
    carregar_economia,
    cosmeticos_equipados,
    obter_carteira,
    registrar_fim_partida,
    salvar_economia,
)
from shared.logging_util import log_tela
from shared.recordes import eh_anonimo

router = APIRouter()

CHAVE_CLICKJ = "jjogos:clickj"
ARQUIVO_CLICKJ = PASTA_BASE / "clickj.json"
INTERVALO_SALVAR = 30
INTERVALO_ONLINE = 3
INTERVALO_COSMETICOS = 120
CLIQUES_POR_SEGUNDO_MAX = 20
CLIQUES_RAJADA_MAX = 40
PRAZO_TURNO = 30
PRAZO_CONVITE = 20
TOLERANCIA_DESCONEXAO = 30

_dados: dict = {"jogadores": {}}
_carregado = False
_sujo = False
_lock_carga = asyncio.Lock()
_lock_ranking = asyncio.Lock()
_ticker: Optional[asyncio.Task] = None
_ultimo_online = ""
_rng = random.Random()

conexoes: Dict[str, dict] = {}
convites: Dict[tuple, float] = {}
lutas: Dict[str, dict] = {}
luta_de: Dict[str, str] = {}


# ---------------------------------------------------------------------------
# Persistência
# ---------------------------------------------------------------------------

def _ler_armazenamento() -> dict:
    # Diferente de shared.db.carregar_json, aqui um erro de rede PROPAGA: se a
    # leitura falhar não podemos seguir com {} e depois gravar por cima.
    if usando_redis():
        bruto = redis_get(CHAVE_CLICKJ)
        return json.loads(bruto) if bruto else {}
    if ARQUIVO_CLICKJ.exists():
        return json.loads(ARQUIVO_CLICKJ.read_text(encoding="utf-8"))
    return {}


def _gravar_armazenamento(texto: str) -> None:
    if usando_redis():
        redis_set(CHAVE_CLICKJ, texto)
    else:
        ARQUIVO_CLICKJ.write_text(texto, encoding="utf-8")


async def _garantir_carregado() -> None:
    global _dados, _carregado
    if _carregado:
        return
    async with _lock_carga:
        if _carregado:
            return
        lido = await asyncio.to_thread(_ler_armazenamento)
        lido.setdefault("jogadores", {})
        for j in lido["jogadores"].values():
            regras.normalizar(j)
        _dados = lido
        _carregado = True


def _marcar_sujo() -> None:
    global _sujo
    _sujo = True


async def _salvar_se_sujo() -> None:
    global _sujo
    if not (_carregado and _sujo):
        return
    _sujo = False
    texto = json.dumps(_dados, ensure_ascii=False)
    try:
        await asyncio.to_thread(_gravar_armazenamento, texto)
    except Exception as erro:
        _sujo = True
        log_tela("clickj: falha ao salvar: " + str(erro))


# ---------------------------------------------------------------------------
# Envio
# ---------------------------------------------------------------------------

def _jogador(nome: str) -> Optional[dict]:
    return _dados["jogadores"].get(nome)


async def _enviar(nome: str, mensagem: dict) -> None:
    c = conexoes.get(nome)
    if not c:
        return
    try:
        await c["ws"].send_json(mensagem)
    except Exception:
        pass


def _estado_publico(nome: str, agora: float) -> dict:
    j = _jogador(nome)
    cpc, jpc = regras.valores_clique(j, agora)
    sk = regras.skills(j, agora)
    nivel = j["nivel"]
    c = conexoes.get(nome) or {}
    return {
        "nome": nome,
        "nick": j.get("nick"),
        "avatar": j.get("avatar"),
        "cosmeticos": c.get("cosmeticos") or {},
        "classe": j["classe"],
        "genero": j["genero"],
        "titulo": regras.titulo(j),
        "jcoins": j["jcoins"],
        "cliques": j["cliques"],
        "nivel": nivel,
        "nivel_max": regras.NIVEL_MAX,
        "cliques_nivel_atual": regras.NIVEIS[nivel - 1][0],
        "cliques_proximo_nivel": regras.NIVEIS[nivel][0] if nivel < regras.NIVEL_MAX else None,
        "cliques_por_clique": cpc,
        "jcoins_por_clique": jpc,
        "rebirths": j["rebirths"],
        "hp_max": regras.hp_max(j),
        "auto_nivel": j["auto_nivel"],
        "auto_cps": regras.AUTO_CPS.get(j["auto_nivel"], 0),
        "auto_preco_mult": regras.mult_preco_autoclicker(j["rebirths"]),
        "equip": j["equip"],
        "pocoes": j["pocoes"],
        "efeitos": {k: {"valor": ef["valor"], "restante": max(0, int(ef["expira"] - agora))}
                    for k, ef in j["efeitos"].items() if ef["expira"] > agora},
        "skills": sk["total"],
        "skills_pocao": sk["pocao"],
        "faltando_rebirth": regras.faltando_rebirth(j),
        "nivel_requerido_rebirth": regras.nivel_requerido_rebirth(j["rebirths"]),
        "maestria_skill": j.get("maestria_skill"),
        "maestria_nivel": j.get("maestria_nivel", 0),
        "titulos": j.get("titulos", []),
        "titulo_equipado": j.get("titulo_equipado"),
        "respec_atual": regras.respec_distribuicao_atual(j),
        "respec_total": regras.total_pontos_respec(j),
        "pvp_vitorias": j["pvp_vitorias"],
        "pvp_derrotas": j["pvp_derrotas"],
        "ack": c.get("ack", 0),
    }


async def _enviar_estado(nome: str, extra: Optional[dict] = None) -> None:
    if not _jogador(nome):
        return
    c = conexoes.get(nome)
    if not c:
        return
    # Autoclicker (tick a cada 1s) e cliques manuais podem mandar "estado" quase
    # ao mesmo tempo por caminhos concorrentes — sem isso, o que chegasse por
    # último no socket "vencia" mesmo sendo o mais antigo, fazendo o timer da
    # poção (calculado a partir daqui) parecer voltar no tempo. O client ignora
    # qualquer "estado" com seq menor que o último aceito.
    c["seq_estado"] = c.get("seq_estado", 0) + 1
    mensagem = {"tipo": "estado", "seq_estado": c["seq_estado"], "jogador": _estado_publico(nome, time.time())}
    if extra:
        mensagem.update(extra)
    await _enviar(nome, mensagem)


def _entrada_online(nome: str) -> Optional[dict]:
    j = _jogador(nome)
    c = conexoes.get(nome)
    if not j or not c:
        return None
    return {
        "nome": nome,
        "nick": j.get("nick") or nome,
        "avatar": j.get("avatar"),
        "cosmeticos": c.get("cosmeticos") or {},
        "classe": j["classe"],
        "genero": j["genero"],
        "titulo": regras.titulo(j),
        "nivel": j["nivel"],
        "jcoins": j["jcoins"],
        "rebirths": j["rebirths"],
        "em_luta": nome in luta_de,
    }


async def _transmitir_online(forcar: bool = False) -> None:
    global _ultimo_online
    lista = [e for e in (_entrada_online(n) for n in list(conexoes)) if e]
    lista.sort(key=lambda e: (-e["rebirths"], -e["nivel"], -e["jcoins"]))
    assinatura = json.dumps(lista, sort_keys=True, ensure_ascii=False)
    if not forcar and assinatura == _ultimo_online:
        return
    _ultimo_online = assinatura
    for nome in list(conexoes):
        await _enviar(nome, {"tipo": "online", "jogadores": lista})


# ---------------------------------------------------------------------------
# Luta
# ---------------------------------------------------------------------------

def _outro(luta: dict, nome: str) -> str:
    a, b = luta["ordem"]
    return b if nome == a else a


def _luta_publica(luta: dict, agora: float) -> dict:
    lutadores = {}
    for nome, l in luta["lutadores"].items():
        lutadores[nome] = {
            "nick": l["nick"], "avatar": l["avatar"], "cosmeticos": l["cosmeticos"],
            "classe": l["classe"], "genero": l["genero"], "titulo": l["titulo"],
            "arma": l["arma"], "stats": l["stats"],
            "hp": l["hp"], "hp_max": l["hp_max"],
            "defendendo": l["defendendo"], "esquivando": l["esquivando"],
            "esquiva_em": max(0, l["esquiva_livre_em"] - l["turnos"]),
            "pode_curar": regras.pode_curar(l),
            "pocoes_usadas": l.get("pocoes_usadas", []),
            "conectado": nome in conexoes,
        }
    return {
        "id": luta["id"],
        "ordem": luta["ordem"],
        "turno_de": luta["turno_de"],
        "restante": max(0, int(luta["prazo"] - agora)),
        "fim": luta["fim"],
        "vencedor": luta["vencedor"],
        "evento": luta["evento"],
        "log": luta["log"][-6:],
        "lutadores": lutadores,
    }


async def _transmitir_luta(luta: dict) -> None:
    publica = _luta_publica(luta, time.time())
    for nome in luta["ordem"]:
        await _enviar(nome, {"tipo": "luta", "luta": publica})


def _remover_convites_de(*nomes: str) -> None:
    for chave in list(convites):
        if chave[0] in nomes or chave[1] in nomes:
            convites.pop(chave, None)


async def _iniciar_luta(desafiante: str, desafiado: str) -> None:
    agora = time.time()
    _remover_convites_de(desafiante, desafiado)
    lutadores = {}
    for nome in (desafiante, desafiado):
        j = _jogador(nome)
        regras.limpar_efeitos(j, agora)
        l = regras.novo_lutador(j, agora)
        l.update({
            "nick": j.get("nick") or nome, "avatar": j.get("avatar"),
            "cosmeticos": (conexoes.get(nome) or {}).get("cosmeticos") or {},
            "classe": j["classe"], "genero": j["genero"], "titulo": regras.titulo(j),
            "arma": j["equip"].get("arma", -1), "desconectado_desde": None,
        })
        lutadores[nome] = l
    a, b = lutadores[desafiante], lutadores[desafiado]
    if a["stats"]["agilidade"] != b["stats"]["agilidade"]:
        primeiro = desafiante if a["stats"]["agilidade"] > b["stats"]["agilidade"] else desafiado
    else:
        primeiro = _rng.choice([desafiante, desafiado])
    luta = {
        "id": secrets.token_hex(4),
        "ordem": [desafiante, desafiado],
        "lutadores": lutadores,
        "turno_de": primeiro,
        "prazo": agora + PRAZO_TURNO,
        "inicio": agora,
        "fim": False,
        "vencedor": None,
        "evento": None,
        "seq": 0,
        "log": ["A luta começou! %s é mais ágil e começa." % lutadores[primeiro]["nick"]],
    }
    lutas[luta["id"]] = luta
    luta_de[desafiante] = luta["id"]
    luta_de[desafiado] = luta["id"]
    await _transmitir_luta(luta)
    await _transmitir_online()


def _registrar_partidas_ranking(registros: list) -> None:
    for nome, nick, segundos, avatar, venceu in registros:
        try:
            registrar_fim_partida(nome, nick, segundos, jogo="clickj_pvp",
                                  avatar=avatar, venceu=venceu)
        except Exception as erro:
            log_tela("clickj: falha ao registrar partida no ranking: " + str(erro))


async def _registrar_ranking_em_fila(registros: list) -> None:
    # Uma gravação por vez: cada uma lê, altera e grava o blob inteiro da
    # economia, então duas lutas terminando juntas se sobrescreveriam.
    async with _lock_ranking:
        await asyncio.to_thread(_registrar_partidas_ranking, registros)


async def _finalizar_luta(luta: dict, vencedor: Optional[str], motivo: str = "") -> None:
    luta["fim"] = True
    luta["vencedor"] = vencedor
    for nome in luta["ordem"]:
        luta_de.pop(nome, None)
    lutas.pop(luta["id"], None)
    if motivo:
        luta["log"].append(motivo)

    recompensas = {}
    if vencedor:
        perdedor = _outro(luta, vencedor)
        for nome, venceu in ((vencedor, True), (perdedor, False)):
            j = _jogador(nome)
            recompensas[nome] = regras.recompensa_pvp(j, venceu)
            j["pvp_vitorias" if venceu else "pvp_derrotas"] += 1
        _marcar_sujo()
        segundos = max(1, int(time.time() - luta["inicio"]))
        registros = [(n, luta["lutadores"][n]["nick"], segundos, luta["lutadores"][n]["avatar"], n == vencedor)
                     for n in luta["ordem"]]
        asyncio.create_task(_registrar_ranking_em_fila(registros))

    await _transmitir_luta(luta)
    for nome in luta["ordem"]:
        await _enviar(nome, {
            "tipo": "luta_fim",
            "venceu": nome == vencedor,
            "empate": vencedor is None,
            "recompensa": recompensas.get(nome),
            "motivo": motivo,
        })
        await _enviar_estado(nome)
    await _transmitir_online()


async def _processar_acao(luta: dict, nome: str, acao: str, automatica: bool = False) -> None:
    ator = luta["lutadores"][nome]
    alvo_nome = _outro(luta, nome)
    alvo = luta["lutadores"][alvo_nome]
    ok, evento = regras.executar_acao(ator, alvo, acao, ator["nick"], alvo["nick"], _rng)
    if not ok:
        await _enviar(nome, {"tipo": "erro", "mensagem": evento["texto"]})
        return
    luta["seq"] += 1
    evento.update({"seq": luta["seq"], "ator": nome, "alvo": alvo_nome, "automatica": automatica})
    if automatica:
        evento["texto"] = "Tempo esgotado — " + evento["texto"]
    luta["evento"] = evento
    luta["log"].append(evento["texto"])
    if alvo["hp"] <= 0:
        await _finalizar_luta(luta, nome, "%s venceu a luta!" % ator["nick"])
        return
    luta["turno_de"] = alvo_nome
    luta["prazo"] = time.time() + PRAZO_TURNO
    await _transmitir_luta(luta)


# ---------------------------------------------------------------------------
# Tick (1/s): autoclicker, poções, convites, prazos de turno, gravação
# ---------------------------------------------------------------------------

async def _tick(ciclo: int) -> None:
    agora = time.time()

    for nome in list(conexoes):
        j = _jogador(nome)
        if not j:
            continue
        mudou = regras.limpar_efeitos(j, agora)
        if j["auto_nivel"] > 0:
            subiu = regras.aplicar_cliques(j, regras.AUTO_CPS[j["auto_nivel"]], agora)
            _marcar_sujo()
            mudou = True
            if subiu:
                await _enviar(nome, {"tipo": "aviso", "mensagem": "Subiu para o nível %d!" % j["nivel"]})
        if mudou:
            await _enviar_estado(nome)

    atualizar = next((n for n, c in conexoes.items()
                      if agora - c.get("cosm_em", 0) > INTERVALO_COSMETICOS), None)
    if atualizar:
        conexoes[atualizar]["cosm_em"] = agora
        try:
            cosm = await asyncio.to_thread(cosmeticos_equipados, atualizar)
            if atualizar in conexoes:
                conexoes[atualizar]["cosmeticos"] = cosm
        except Exception:
            pass

    for (de, para), expira in list(convites.items()):
        if expira <= agora:
            convites.pop((de, para), None)
            j = _jogador(para)
            await _enviar(de, {"tipo": "aviso", "mensagem": "%s não respondeu ao desafio." % ((j or {}).get("nick") or para)})
            await _enviar(para, {"tipo": "desafio_cancelado", "de": de})

    for luta in list(lutas.values()):
        ausentes = [n for n, l in luta["lutadores"].items()
                    if n not in conexoes and l["desconectado_desde"]
                    and agora - l["desconectado_desde"] > TOLERANCIA_DESCONEXAO]
        if len(ausentes) == 2:
            await _finalizar_luta(luta, None, "Os dois saíram — luta cancelada.")
        elif len(ausentes) == 1:
            saiu = ausentes[0]
            await _finalizar_luta(luta, _outro(luta, saiu),
                                  "%s saiu da luta e perdeu." % luta["lutadores"][saiu]["nick"])
        elif agora > luta["prazo"]:
            await _processar_acao(luta, luta["turno_de"], "defender", automatica=True)

    if ciclo % INTERVALO_ONLINE == 0:
        await _transmitir_online()
    if ciclo % INTERVALO_SALVAR == 0:
        await _salvar_se_sujo()


async def _loop_ticker() -> None:
    ciclo = 0
    while True:
        await asyncio.sleep(1)
        ciclo += 1
        try:
            await _tick(ciclo)
        except Exception as erro:
            log_tela("clickj: erro no tick: " + repr(erro))


def _garantir_ticker() -> None:
    global _ticker
    if _ticker is None or _ticker.done():
        _ticker = asyncio.create_task(_loop_ticker())


# ---------------------------------------------------------------------------
# Mensagens do cliente
# ---------------------------------------------------------------------------

async def _tratar(nome: str, dados: dict) -> None:
    tipo = dados.get("tipo")
    agora = time.time()
    j = _jogador(nome)
    c = conexoes.get(nome)
    if not c:
        return

    if tipo == "ping":
        await _enviar(nome, {"tipo": "pong"})
        return

    if tipo == "criar":
        if j:
            await _enviar(nome, {"tipo": "erro", "mensagem": "Você já tem um personagem."})
            return
        classe, genero = dados.get("classe"), dados.get("genero")
        if classe not in regras.CLASSES or genero not in regras.GENEROS:
            await _enviar(nome, {"tipo": "erro", "mensagem": "Escolha uma classe e um gênero."})
            return
        _dados["jogadores"][nome] = regras.novo_jogador(nome, c["nick"], c["avatar"], classe, genero, agora)
        _marcar_sujo()
        await _enviar_estado(nome)
        await _transmitir_online()
        return

    if not j:
        await _enviar(nome, {"tipo": "erro", "mensagem": "Crie seu personagem primeiro."})
        return

    if tipo == "cliques":
        try:
            n = max(0, min(int(dados.get("n", 0)), 1000))
        except (TypeError, ValueError):
            n = 0
        c["tokens"] = min(CLIQUES_RAJADA_MAX, c["tokens"] + (agora - c["refill"]) * CLIQUES_POR_SEGUNDO_MAX)
        c["refill"] = agora
        permitidos = min(n, int(c["tokens"]))
        c["tokens"] -= permitidos
        try:
            c["ack"] = int(dados.get("seq", c["ack"]))
        except (TypeError, ValueError):
            pass
        subiu = regras.aplicar_cliques(j, permitidos, agora)
        if permitidos:
            _marcar_sujo()
        extra = {"aviso": "Subiu para o nível %d!" % j["nivel"]} if subiu else None
        await _enviar_estado(nome, extra)
        return

    if tipo in ("comprar", "usar_pocao", "melhorar_auto", "rebirth", "maestria_escolher", "maestria_melhorar",
                "comprar_titulo", "equipar_titulo", "respec_livros"):
        if tipo == "comprar":
            ok, msg = regras.comprar(j, str(dados.get("item", "")))
        elif tipo == "usar_pocao":
            ok, msg = regras.usar_pocao(j, str(dados.get("item", "")), agora)
        elif tipo == "melhorar_auto":
            ok, msg = regras.melhorar_autoclicker(j)
        elif tipo == "maestria_escolher":
            ok, msg = regras.escolher_maestria(j, str(dados.get("skill", "")))
        elif tipo == "maestria_melhorar":
            ok, msg = regras.melhorar_maestria(j)
        elif tipo == "comprar_titulo":
            ok, msg = regras.comprar_titulo(j, str(dados.get("titulo", "")))
        elif tipo == "equipar_titulo":
            ok, msg = regras.equipar_titulo(j, dados.get("titulo") or None)
        elif tipo == "respec_livros":
            ok, msg = regras.respec_livros(j, dados.get("distribuicao") or {})
        else:
            if nome in luta_de:
                ok, msg = False, "Termine a luta antes do rebirth."
            else:
                ok, msg = regras.fazer_rebirth(j)
        if not ok:
            await _enviar(nome, {"tipo": "erro", "mensagem": msg})
            return
        _marcar_sujo()
        await _enviar_estado(nome, {"aviso": msg})
        if tipo == "rebirth":
            await _salvar_se_sujo()
            await _transmitir_online(forcar=True)
        return

    if tipo == "converter_jcoins":
        try:
            trilhoes = max(1, int(dados.get("trilhoes", 0)))
        except (TypeError, ValueError):
            trilhoes = 0
        if trilhoes < 1:
            await _enviar(nome, {"tipo": "erro", "mensagem": "Quantidade inválida."})
            return
        custo = trilhoes * 1_000_000_000_000
        if j["jcoins"] < custo:
            await _enviar(nome, {"tipo": "erro", "mensagem": "Jcoins insuficientes."})
            return
        j["jcoins"] -= custo
        moedas = trilhoes * 100
        eco = await asyncio.to_thread(carregar_economia)
        carteira = obter_carteira(eco, nome)
        carteira["saldo"] = carteira.get("saldo", 0) + moedas
        await asyncio.to_thread(salvar_economia, eco)
        _marcar_sujo()
        await _enviar_estado(nome, {"aviso": "Converteu %dT em %d moedas!" % (trilhoes, moedas)})
        return

    if tipo == "usar_pocao_luta":
        luta = lutas.get(luta_de.get(nome, ""))
        if not luta or luta["fim"]:
            await _enviar(nome, {"tipo": "erro", "mensagem": "Poções de atributo só valem durante uma luta."})
            return
        ok, msg = regras.usar_pocao_luta(j, luta["lutadores"][nome], str(dados.get("item", "")))
        if not ok:
            await _enviar(nome, {"tipo": "erro", "mensagem": msg})
            return
        _marcar_sujo()
        await _enviar_estado(nome, {"aviso": msg})
        await _transmitir_luta(luta)
        return

    if tipo == "desafiar":
        alvo = str(dados.get("alvo", ""))
        if alvo == nome:
            return
        if alvo not in conexoes or not _jogador(alvo):
            await _enviar(nome, {"tipo": "erro", "mensagem": "Esse jogador não está mais online."})
            return
        if nome in luta_de or alvo in luta_de:
            await _enviar(nome, {"tipo": "erro", "mensagem": "Alguém já está em uma luta."})
            return
        if (nome, alvo) in convites:
            await _enviar(nome, {"tipo": "erro", "mensagem": "Você já desafiou esse jogador. Aguarde a resposta."})
            return
        convites[(nome, alvo)] = agora + PRAZO_CONVITE
        await _enviar(alvo, {"tipo": "desafio", "de": _entrada_online(nome), "expira_em": PRAZO_CONVITE})
        await _enviar(nome, {"tipo": "aviso", "mensagem": "Desafio enviado para %s." % (_jogador(alvo).get("nick") or alvo)})
        return

    if tipo == "responder_desafio":
        de = str(dados.get("de", ""))
        if convites.pop((de, nome), None) is None:
            await _enviar(nome, {"tipo": "erro", "mensagem": "Esse desafio expirou."})
            return
        if not dados.get("aceitar"):
            await _enviar(de, {"tipo": "aviso", "mensagem": "%s recusou o desafio." % (j.get("nick") or nome)})
            return
        if de not in conexoes or nome in luta_de or de in luta_de:
            await _enviar(nome, {"tipo": "erro", "mensagem": "Não deu pra começar a luta agora."})
            return
        await _iniciar_luta(de, nome)
        return

    if tipo == "acao":
        luta = lutas.get(luta_de.get(nome, ""))
        if not luta or luta["fim"]:
            return
        if luta["turno_de"] != nome:
            await _enviar(nome, {"tipo": "erro", "mensagem": "Não é sua vez."})
            return
        await _processar_acao(luta, nome, str(dados.get("acao", "")))
        return

    if tipo == "desistir":
        luta = lutas.get(luta_de.get(nome, ""))
        if luta and not luta["fim"]:
            await _finalizar_luta(luta, _outro(luta, nome), "%s desistiu." % luta["lutadores"][nome]["nick"])
        return


@router.websocket("/ws/clickj")
@router.websocket("/clickj")
async def ws_clickj(websocket: WebSocket):
    await websocket.accept()
    query = websocket.query_params
    nome = (query.get("nome") or "").strip()
    nick = (query.get("nick") or "").strip() or nome
    avatar = query.get("avatar") or None

    if not nome or eh_anonimo(nome) or eh_anonimo(nick):
        await websocket.send_json({"tipo": "erro_fatal", "mensagem": "Entre com Discord para jogar ClickJ."})
        await websocket.close()
        return
    try:
        await _garantir_carregado()
    except Exception as erro:
        log_tela("clickj: falha ao carregar dados: " + str(erro))
        await websocket.send_json({"tipo": "erro_fatal", "mensagem": "Não consegui carregar seus dados agora. Tente de novo em instantes."})
        await websocket.close()
        return
    _garantir_ticker()

    antiga = conexoes.get(nome)
    if antiga:
        try:
            await antiga["ws"].send_json({"tipo": "erro_fatal", "mensagem": "Você abriu o ClickJ em outra janela."})
            await antiga["ws"].close()
        except Exception:
            pass

    try:
        cosmeticos = await asyncio.to_thread(cosmeticos_equipados, nome)
    except Exception:
        cosmeticos = {}
    agora = time.time()
    conexoes[nome] = {
        "ws": websocket, "nick": nick, "avatar": avatar,
        "tokens": CLIQUES_RAJADA_MAX, "refill": agora,
        "cosmeticos": cosmeticos, "cosm_em": agora, "ack": 0,
    }
    j = _jogador(nome)
    if j:
        j["nick"] = nick
        if avatar:
            j["avatar"] = avatar

    await websocket.send_json({"tipo": "bem_vindo", "catalogo": regras.catalogo(), "tem_personagem": bool(j)})
    if j:
        await _enviar_estado(nome)
    luta = lutas.get(luta_de.get(nome, ""))
    if luta:
        luta["lutadores"][nome]["desconectado_desde"] = None
        await _transmitir_luta(luta)
    await _transmitir_online(forcar=True)

    try:
        while True:
            bruto = await websocket.receive_text()
            try:
                dados = json.loads(bruto)
            except Exception:
                continue
            if isinstance(dados, dict):
                await _tratar(nome, dados)
    except WebSocketDisconnect:
        pass
    except Exception as erro:
        log_tela("clickj: erro no ws de " + nome + ": " + repr(erro))
    finally:
        if (conexoes.get(nome) or {}).get("ws") is websocket:
            conexoes.pop(nome, None)
            _remover_convites_de(nome)
            luta = lutas.get(luta_de.get(nome, ""))
            if luta:
                luta["lutadores"][nome]["desconectado_desde"] = time.time()
                await _transmitir_luta(luta)
            await _salvar_se_sujo()
            await _transmitir_online()
