"""Ludo — online (até 4 jogadores)."""
import asyncio
import json
import re
import secrets
import time
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from shared.economia import MOEDAS_VITORIA_MULTIPLAYER, creditar_moedas
from shared.lobby_state import conexoes_lobby
from shared.logging_util import log_tela
from shared.recordes import carregar_recordes, eh_anonimo, ranking_top, salvar_recordes

router = APIRouter()

class NovaSalaLudo(BaseModel):
    codigo: Optional[str] = None
    publica: bool = True
    dificuldade: str = "facil"
    nome: str = "Anônimo"
    nick: str = "Anônimo"
    avatar: Optional[str] = None


# Ludo online: código -> sala (até 4 jogadores + espectadores).
salas_ludo: Dict[str, dict] = {}
MAX_LUDO = 4
LUDO_SALA_SEM_WS_SEGUNDOS = 60
LUDO_CORES = ["vermelho", "verde", "amarelo", "azul"]
LUDO_OFFSETS = {"vermelho": 0, "verde": 13, "amarelo": 26, "azul": 39}
LUDO_SEGURAS = {0, 8, 13, 21, 26, 34, 39, 47}
# Trilha externa 52 células (row, col) — ordem canônica de Ludo 15x15.
LUDO_TRACK = [
    (6, 1), (6, 2), (6, 3), (6, 4), (6, 5),
    (5, 6), (4, 6), (3, 6), (2, 6), (1, 6), (0, 6),
    (0, 7),
    (0, 8),
    (1, 8), (2, 8), (3, 8), (4, 8), (5, 8),
    (6, 9), (6, 10), (6, 11), (6, 12), (6, 13), (6, 14),
    (7, 14),
    (8, 14),
    (8, 13), (8, 12), (8, 11), (8, 10), (8, 9),
    (9, 8), (10, 8), (11, 8), (12, 8), (13, 8), (14, 8),
    (14, 7),
    (14, 6),
    (13, 6), (12, 6), (11, 6), (10, 6), (9, 6),
    (8, 5), (8, 4), (8, 3), (8, 2), (8, 1), (8, 0),
    (7, 0),
    (6, 0),
]
# Colunas de casa (5 células) + centro final.
LUDO_HOME = {
    "vermelho": [(7, 1), (7, 2), (7, 3), (7, 4), (7, 5)],
    "verde": [(1, 7), (2, 7), (3, 7), (4, 7), (5, 7)],
    "amarelo": [(7, 13), (7, 12), (7, 11), (7, 10), (7, 9)],
    "azul": [(13, 7), (12, 7), (11, 7), (10, 7), (9, 7)],
}
LUDO_CENTRO = (7, 7)
# Bases: 4 slots de peça por cor (área 6x6 do canto).
LUDO_BASES = {
    "vermelho": [(1, 1), (1, 3), (3, 1), (3, 3)],
    "verde": [(1, 11), (1, 13), (3, 11), (3, 13)],
    "amarelo": [(11, 11), (11, 13), (13, 11), (13, 13)],
    "azul": [(11, 1), (11, 3), (13, 1), (13, 3)],
}


def registrar_vitoria_ludo(nick: str, nome: str, avatar: Optional[str]) -> None:
    """Vitória global no Ludo (permanente; anônimo não conta). Ludo só existe
    online (não tem modo solo), então toda vitória vale moeda de multiplayer."""
    if eh_anonimo(nick):
        return
    creditar_moedas(nome, MOEDAS_VITORIA_MULTIPLAYER)
    recordes = carregar_recordes()
    vitorias = recordes.setdefault("ludo_vitorias", [])
    for v in vitorias:
        if v.get("nick") == nick and v.get("nome") == nome:
            v["vitorias"] = v.get("vitorias", 0) + 1
            if avatar:
                v["avatar"] = avatar
            recordes["ludo_vitorias"] = sorted(
                vitorias, key=lambda r: r.get("vitorias", 0), reverse=True)[:50]
            salvar_recordes(recordes)
            return
    novo = {"nick": nick, "nome": nome, "vitorias": 1}
    if avatar:
        novo["avatar"] = avatar
    vitorias.append(novo)
    recordes["ludo_vitorias"] = sorted(
        vitorias, key=lambda r: r.get("vitorias", 0), reverse=True)[:50]
    salvar_recordes(recordes)



# Ludo online — salas, estado, lógica autoritativa
# ---------------------------------------------------------------------------

def purgar_salas_ludo_obsoletas() -> None:
    agora = time.time()
    for codigo, s in list(salas_ludo.items()):
        conectados = sum(1 for p in s.get("slots", {}).values() if p and p.get("ws"))
        if conectados == 0 and agora - s.get("criado_em", agora) > LUDO_SALA_SEM_WS_SEGUNDOS:
            salas_ludo.pop(codigo, None)
            log_tela("ludo sala obsoleta removida codigo=" + codigo)


def _codigo_ludo_valido(codigo: str) -> bool:
    return bool(re.fullmatch(r"[a-z0-9_-]{3,16}", codigo or ""))


def info_jogador_ludo(s: dict, slot: str) -> dict:
    p = s.get("slots", {}).get(slot) or {}
    cor = s.get("cores", {}).get(slot)
    pecas = (s.get("pecas", {}) or {}).get(slot) or [-1, -1, -1, -1]
    return {
        "slot": slot,
        "cor": cor,
        "nick": p.get("nick", "—"),
        "nome": p.get("nome", ""),
        "avatar": p.get("avatar"),
        "conectado": bool(p.get("ws")),
        "pecas": pecas,
        "venceu": bool(p.get("venceu")),
    }


def estado_ludo_para(s: dict, slot: Optional[str] = None) -> dict:
    jogadores = [info_jogador_ludo(s, sl) for sl in ("p1", "p2", "p3", "p4")
                 if s.get("slots", {}).get(sl)]
    conectados = sum(1 for p in s.get("slots", {}).values() if p and p.get("ws"))
    fase = s.get("fase", "esperando")
    pode_iniciar = (
        slot is not None
        and slot == s.get("lider")
        and fase in ("esperando", "fim")
        and conectados >= 2
        and not s.get("countdown_task")
    )
    return {
        "tipo": "estado_ludo",
        "sala": s["codigo"],
        "publica": s.get("publica", False),
        "fase": fase,
        "meu_slot": slot,
        "lider": s.get("lider"),
        "vez": s.get("vez"),
        "dado": s.get("dado"),
        "dado_ja_rolado": bool(s.get("dado_ja_rolado")),
        "opcoes": s.get("opcoes") or [],
        "seis_seguidos": s.get("seis_seguidos", 0),
        "jogadores": jogadores,
        "vencedor": s.get("vencedor"),
        "ultimo_evento": s.get("ultimo_evento"),
        "conectados": conectados,
        "pode_iniciar": pode_iniciar,
        "placar": s.get("placar", {"p1": 0, "p2": 0, "p3": 0, "p4": 0}),
    }


async def broadcast_ludo(sala: str, msg: dict):
    s = salas_ludo.get(sala)
    if not s:
        return
    for p in s.get("slots", {}).values():
        if p and p.get("ws"):
            try:
                await p["ws"].send_json(msg)
            except Exception:
                pass
    for ws in list(s.get("espectadores", []) or []):
        try:
            await ws.send_json(msg)
        except Exception:
            pass


async def broadcast_estado_ludo(sala: str):
    """Envia estado personalizado (meu_slot/pode_iniciar corretos) para todos."""
    s = salas_ludo.get(sala)
    if not s:
        return
    for sl, p in list(s.get("slots", {}).items()):
        if p and p.get("ws"):
            try:
                await p["ws"].send_json(estado_ludo_para(s, sl))
            except Exception:
                pass
    for ws in list(s.get("espectadores", []) or []):
        try:
            await ws.send_json(estado_ludo_para(s, None))
        except Exception:
            pass


async def _notificar_salas_ludo_lobby():
    purgar_salas_ludo_obsoletas()
    lista = []
    for codigo, s in salas_ludo.items():
        if not s.get("publica"):
            continue
        vivos = sum(1 for p in s.get("slots", {}).values() if p and p.get("ws"))
        lista.append({
            "sala": codigo,
            "lider": (s.get("slots", {}).get(s.get("lider")) or {}).get("nick", "—"),
            "jogadores": vivos,
            "fase": s.get("fase", "esperando"),
        })
    msg = {"tipo": "salas_ludo", "salas": lista}
    for ws in list(conexoes_lobby):
        try:
            await ws.send_json(msg)
        except Exception:
            pass


async def encerrar_sala_ludo(sala: str, motivo: str):
    s = salas_ludo.pop(sala, None)
    if not s:
        return
    if s.get("countdown_task"):
        try:
            s["countdown_task"].cancel()
        except Exception:
            pass
    fechar = [{"tipo": "sala_ludo_encerrada", "motivo": motivo}]
    for p in list(s.get("slots", {}).values()):
        if p and p.get("ws"):
            try:
                await p["ws"].send_json(fechar[0])
                await p["ws"].close()
            except Exception:
                pass
    for ws in list(s.get("espectadores", []) or []):
        try:
            await ws.send_json(fechar[0])
            await ws.close()
        except Exception:
            pass
    log_tela("ludo sala encerrada codigo=%s motivo=%s" % (sala, motivo))
    await _notificar_salas_ludo_lobby()


def _ludo_abs(cor: str, pos_rel: int) -> Optional[int]:
    """Posição relativa 0..51 -> índice absoluto 0..51 na trilha; senão None."""
    if pos_rel is None or pos_rel < 0 or pos_rel > 51:
        return None
    return (LUDO_OFFSETS[cor] + pos_rel) % 52


def _ludo_tem_opcao(s: dict, slot: str, dado: int) -> list:
    cor = s["cores"][slot]
    pecas = s["pecas"][slot]
    opcoes = []
    for i, pos in enumerate(pecas):
        if pos == 57:
            continue
        if pos == -1:
            if dado == 6:
                opcoes.append(i)
            continue
        novo = pos + dado
        if novo <= 57:
            opcoes.append(i)
    return opcoes


def _ludo_aplicar_capturas(s: dict, slot: str, idx: int, nova_pos: int) -> list:
    cor = s["cores"][slot]
    if nova_pos < 0 or nova_pos > 51:
        return []
    abs_alvo = _ludo_abs(cor, nova_pos)
    if abs_alvo is None or abs_alvo in LUDO_SEGURAS:
        return []
    capturados = []
    for outro in ("p1", "p2", "p3", "p4"):
        if outro == slot or not s["slots"].get(outro):
            continue
        cor_outro = s["cores"][outro]
        for j, p in enumerate(s["pecas"][outro]):
            if p < 0 or p > 51:
                continue
            if _ludo_abs(cor_outro, p) == abs_alvo:
                s["pecas"][outro][j] = -1
                capturados.append({"slot": outro, "peao": j,
                                   "nick": (s["slots"][outro] or {}).get("nick")})
    return capturados


def _ludo_passar_vez(s: dict) -> None:
    vivos = [sl for sl in ("p1", "p2", "p3", "p4")
             if s["slots"].get(sl) and not (s["slots"][sl] or {}).get("venceu")]
    if not vivos:
        return
    atual = s.get("vez")
    if atual not in vivos:
        s["vez"] = vivos[0]
        return
    i = vivos.index(atual)
    s["vez"] = vivos[(i + 1) % len(vivos)]


def _ludo_avancar_vez(s: dict) -> None:
    """Pula desconectados sem vencer."""
    for _ in range(8):
        _ludo_passar_vez(s)
        p = s.get("slots", {}).get(s.get("vez"))
        if p and p.get("ws"):
            return
    # todos os vivos desconectados — mantém o líder


def _ludo_check_vitoria(s: dict) -> Optional[str]:
    for sl in ("p1", "p2", "p3", "p4"):
        p = s["slots"].get(sl)
        if not p:
            continue
        if all(x == 57 for x in s["pecas"][sl]):
            p["venceu"] = True
            s["fase"] = "fim"
            s["vencedor"] = sl
            s.setdefault("placar", {"p1": 0, "p2": 0, "p3": 0, "p4": 0})
            s["placar"][sl] = s["placar"].get(sl, 0) + 1
            registrar_vitoria_ludo(p.get("nick", "Anônimo"),
                                   p.get("nome", ""), p.get("avatar"))
            return sl
    return None


@router.get("/ludo/ranking")
def ranking_ludo_vitorias():
    recordes = carregar_recordes()
    ranking = ranking_top(recordes.get("ludo_vitorias", []),
                          "vitorias", reverse=True, limite=10)
    return {"ranking": ranking}


@router.get("/ludo/salas")
async def listar_salas_ludo():
    purgar_salas_ludo_obsoletas()
    lista = []
    for codigo, s in salas_ludo.items():
        if not s.get("publica"):
            continue
        lista.append({
            "sala": codigo,
            "lider": (s.get("slots", {}).get(s.get("lider")) or {}).get("nick", "—"),
            "jogadores": sum(1 for p in s.get("slots", {}).values() if p and p.get("ws")),
            "fase": s.get("fase", "esperando"),
        })
    return {"salas": lista}


@router.post("/ludo/sala/novo")
async def criar_sala_ludo(dados: NovaSalaLudo):
    codigo = (dados.codigo or "").strip().lower()
    if codigo and not _codigo_ludo_valido(codigo):
        raise HTTPException(status_code=400,
                            detail="Código: 3 a 16 caracteres (letras, números, - ou _).")
    if codigo and codigo in salas_ludo:
        raise HTTPException(status_code=409, detail="Já existe uma sala com esse código.")

    purgar_salas_ludo_obsoletas()
    if not codigo:
        while True:
            codigo = secrets.token_urlsafe(6).lower().replace("-", "").replace("_", "")[:10]
            if _codigo_ludo_valido(codigo) and codigo not in salas_ludo:
                break

    cores_slot = {}
    for i, sl in enumerate(("p1", "p2", "p3", "p4")):
        cores_slot[sl] = LUDO_CORES[i]

    salas_ludo[codigo] = {
        "codigo": codigo,
        "publica": bool(dados.publica),
        "fase": "esperando",
        "lider": "p1",
        "vez": None,
        "dado": None,
        "dado_ja_rolado": False,
        "opcoes": [],
        "seis_seguidos": 0,
        "vencedor": None,
        "ultimo_evento": None,
        "cores": cores_slot,
        "slots": {
            "p1": {
                "ws": None, "nome": dados.nome, "nick": dados.nick,
                "avatar": dados.avatar, "venceu": False,
            },
            "p2": None, "p3": None, "p4": None,
        },
        "pecas": {"p1": [-1, -1, -1, -1], "p2": [-1, -1, -1, -1],
                  "p3": [-1, -1, -1, -1], "p4": [-1, -1, -1, -1]},
        "placar": {"p1": 0, "p2": 0, "p3": 0, "p4": 0},
        "espectadores": [],
        "countdown_task": None,
        "criado_em": time.time(),
    }
    log_tela("ludo sala criada codigo=%s publica=%s" % (codigo, bool(dados.publica)))
    await _notificar_salas_ludo_lobby()
    return {"sala": codigo, "publica": bool(dados.publica)}


# ---------------------------------------------------------------------------

# WebSocket — Ludo online
# ---------------------------------------------------------------------------

async def _iniciar_contagem_ludo(sala: str):
    s = salas_ludo.get(sala)
    if not s or s.get("fase") not in ("esperando", "contagem", "fim"):
        return
    s["fase"] = "contagem"
    s["countdown_task"] = asyncio.current_task()
    try:
        for n in (3, 2, 1, 0):
            s = salas_ludo.get(sala)
            if not s or s.get("fase") != "contagem":
                return
            await broadcast_ludo(sala, {"tipo": "contagem", "n": n})
            if n > 0:
                await asyncio.sleep(1)
        s = salas_ludo.get(sala)
        if not s or s.get("fase") != "contagem":
            return
        s["fase"] = "jogando"
        s["dado"] = None
        s["dado_ja_rolado"] = False
        s["opcoes"] = []
        s["seis_seguidos"] = 0
        s["vencedor"] = None
        for sl in ("p1", "p2", "p3", "p4"):
            if s["slots"].get(sl):
                s["pecas"][sl] = [-1, -1, -1, -1]
                s["slots"][sl]["venceu"] = False
        primeiro = next((sl for sl in ("p1", "p2", "p3", "p4")
                         if s["slots"].get(sl) and s["slots"][sl].get("ws")), "p1")
        s["vez"] = primeiro
        s["ultimo_evento"] = {"texto": "Jogo iniciado! Vez de " +
                              ((s["slots"].get(primeiro) or {}).get("nick") or "—")}
        await broadcast_estado_ludo(sala)
    finally:
        s2 = salas_ludo.get(sala)
        if s2:
            s2["countdown_task"] = None


# Activity do Discord às vezes corta o prefixo /ws — alias igual à velha/sudoku.
@router.websocket("/ws/ludo/{sala}")
@router.websocket("/ludo/{sala}")
async def ws_ludo(websocket: WebSocket, sala: str):
    await websocket.accept()
    query = websocket.query_params
    nome = query.get("nome", "Anônimo")
    nick = query.get("nick", "Anônimo")
    avatar = query.get("avatar") or None

    s = salas_ludo.get(sala)
    if not s:
        await websocket.send_json({"tipo": "erro", "mensagem": "Sala não encontrada."})
        await websocket.close()
        return

    slot = None
    # Reconexão: mesmo nick em slot sem WS vivo.
    for cand in ("p1", "p2", "p3", "p4"):
        p = s["slots"].get(cand)
        if p and not p.get("ws") and p.get("nick") == nick:
            slot = cand
            break

    if slot is None:
        for cand in ("p1", "p2", "p3", "p4"):
            if s["slots"].get(cand) is None:
                slot = cand
                s["slots"][cand] = {
                    "ws": None, "nome": nome, "nick": nick,
                    "avatar": avatar, "venceu": False,
                }
                break

    if slot is not None and s["slots"].get(slot):
        s["slots"][slot].update({
            "nome": nome, "nick": nick, "avatar": avatar,
        })
        s["slots"][slot]["ws"] = websocket
        espectadores = [w for w in (s.get("espectadores") or []) if w is not websocket]
        s["espectadores"] = espectadores
    else:
        # Sala cheia → espectador.
        esp = list(s.get("espectadores") or [])
        if websocket not in esp:
            esp.append(websocket)
        s["espectadores"] = esp

    # Envia para o jogador novo + atualiza quem já estava na sala.
    await broadcast_estado_ludo(sala)
    await _notificar_salas_ludo_lobby()

    # Auto-inicia só com 4 jogadores; 2–3 esperam botão do líder.
    if (slot is not None and s.get("fase") == "esperando"
            and sum(1 for p in s["slots"].values() if p and p.get("ws")) >= 4
            and not s.get("countdown_task")):
        s["countdown_task"] = asyncio.create_task(_iniciar_contagem_ludo(sala))

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                dados = json.loads(raw)
            except Exception:
                continue
            tipo = dados.get("tipo")
            s = salas_ludo.get(sala)
            if not s:
                break

            if tipo == "ping":
                try:
                    await websocket.send_json({"tipo": "pong"})
                except Exception:
                    pass
                continue

            if slot is None:
                continue
            if not s["slots"].get(slot):
                break
            if s.get("fase") not in ("jogando", "contagem", "esperando", "fim"):
                continue

            if tipo == "iniciar":
                if s.get("fase") not in ("esperando", "fim"):
                    continue
                if slot != s.get("lider"):
                    await websocket.send_json({
                        "tipo": "erro_jogada",
                        "mensagem": "Só o líder da sala pode iniciar.",
                    })
                    continue
                conectados = sum(
                    1 for p in s["slots"].values() if p and p.get("ws"))
                if conectados < 2:
                    await websocket.send_json({
                        "tipo": "erro_jogada",
                        "mensagem": "Mínimo de 2 jogadores para começar.",
                    })
                    continue
                if s.get("countdown_task"):
                    continue
                s["countdown_task"] = asyncio.create_task(
                    _iniciar_contagem_ludo(sala))
                continue

            if tipo == "rolar":
                if s.get("fase") != "jogando":
                    continue
                if s.get("vez") != slot:
                    await websocket.send_json({"tipo": "erro_jogada",
                                               "mensagem": "Não é a sua vez."})
                    continue
                if s.get("dado_ja_rolado"):
                    await websocket.send_json({"tipo": "erro_jogada",
                                               "mensagem": "Dado já rolado. Mova uma peça."})
                    continue
                dado = secrets.randbelow(6) + 1
                s["dado"] = dado
                s["dado_ja_rolado"] = True
                s["seis_seguidos"] = (s.get("seis_seguidos") or 0) + 1 if dado == 6 else 0

                if dado == 6 and s.get("seis_seguidos", 0) >= 3:
                    s["ultimo_evento"] = {"texto": "Três seis seguidos! Turno passou."}
                    s["dado"] = None
                    s["dado_ja_rolado"] = False
                    s["seis_seguidos"] = 0
                    s["opcoes"] = []
                    _ludo_avancar_vez(s)
                    await broadcast_estado_ludo(sala)
                    continue

                opcoes = _ludo_tem_opcao(s, slot, dado)
                s["opcoes"] = opcoes
                nick_vez = (s["slots"].get(slot) or {}).get("nick", "—")
                s["ultimo_evento"] = {"texto": nick_vez + " tirou " + str(dado) + "."}
                if not opcoes:
                    s["ultimo_evento"] = {"texto": nick_vez + " tirou " + str(dado) +
                                         " e não tem movimento."}
                    s["dado"] = None
                    s["dado_ja_rolado"] = False
                    s["seis_seguidos"] = 0
                    s["opcoes"] = []
                    _ludo_avancar_vez(s)
                await broadcast_estado_ludo(sala)
                continue

            if tipo == "mover":
                if s.get("fase") != "jogando" or s.get("vez") != slot:
                    continue
                if not s.get("dado_ja_rolado") or s.get("dado") is None:
                    await websocket.send_json({"tipo": "erro_jogada",
                                               "mensagem": "Rode o dado primeiro."})
                    continue
                try:
                    idx = int(dados.get("peao"))
                except Exception:
                    continue
                opcoes = s.get("opcoes") or []
                if idx not in opcoes:
                    await websocket.send_json({"tipo": "erro_jogada",
                                               "mensagem": "Movimento inválido."})
                    continue

                dado = s["dado"]
                pos = s["pecas"][slot][idx]
                nova = 0 if pos == -1 else pos + dado
                if nova > 57:
                    continue
                s["pecas"][slot][idx] = nova

                capturas = _ludo_aplicar_capturas(s, slot, idx, nova)
                entrou_casa = nova >= 52
                chegou_centro = nova == 57
                extra = (dado == 6) or bool(capturas) or chegou_centro

                cor = s["cores"][slot]
                if chegou_centro:
                    txt = (s["slots"][slot] or {}).get("nick", "—") + " levou um peão ao centro!"
                elif capturas:
                    txt = (s["slots"][slot] or {}).get("nick", "—") + " capturou " + \
                        (capturas[0].get("nick") or "um peão") + "!"
                elif entrou_casa:
                    txt = (s["slots"][slot] or {}).get("nick", "—") + " entrou na coluna de casa."
                else:
                    txt = (s["slots"][slot] or {}).get("nick", "—") + " moveu o peão " + str(idx + 1) + "."
                s["ultimo_evento"] = {"texto": txt, "capturas": capturas}

                venceu = _ludo_check_vitoria(s)
                if venceu:
                    s["dado"] = None
                    s["dado_ja_rolado"] = False
                    s["opcoes"] = []
                    await broadcast_estado_ludo(sala)
                    continue

                if extra:
                    # Mantém a vez; limpa o dado para novo roll (exceto se for 6, precisa novo roll).
                    s["dado"] = None
                    s["dado_ja_rolado"] = False
                    s["opcoes"] = []
                    s["ultimo_evento"]["texto"] += " Joga de novo!"
                else:
                    s["dado"] = None
                    s["dado_ja_rolado"] = False
                    s["opcoes"] = []
                    s["seis_seguidos"] = 0
                    _ludo_avancar_vez(s)
                await broadcast_estado_ludo(sala)
                continue

            if tipo == "sair":
                if s["slots"].get(slot) and s["slots"][slot].get("ws") is websocket:
                    s["slots"][slot]["ws"] = None
                    if s.get("lider") == slot and s.get("fase") == "esperando":
                        await encerrar_sala_ludo(sala, "lider_saiu")
                        break
                    if s.get("fase") in ("jogando", "contagem"):
                        restantes = [
                            sl for sl in ("p1", "p2", "p3", "p4")
                            if s["slots"].get(sl) and s["slots"][sl].get("ws")
                            and sl != slot and not s["slots"][sl].get("venceu")
                        ]
                        if len(restantes) >= 1 and s.get("vez") == slot:
                            _ludo_avancar_vez(s)
                    await broadcast_estado_ludo(sala)
                    await _notificar_salas_ludo_lobby()
                break

    except WebSocketDisconnect:
        pass
    finally:
        s = salas_ludo.get(sala)
        if s:
            if slot and s["slots"].get(slot) and s["slots"][slot].get("ws") is websocket:
                s["slots"][slot]["ws"] = None
                if s.get("fase") == "esperando" and s.get("lider") == slot:
                    # Dá um instante para reconectar antes de fechar.
                    await asyncio.sleep(0)
                    s2 = salas_ludo.get(sala)
                    if s2 and s2.get("fase") == "esperando" and s2.get("lider") == slot \
                            and not (s2["slots"].get(slot) or {}).get("ws"):
                        # Se mais alguém esperando e líder sumiu → encerra.
                        outros = sum(1 for p in s2["slots"].values()
                                     if p and p.get("ws") and p is not s2["slots"].get(slot))
                        if outros == 0:
                            await encerrar_sala_ludo(sala, "lider_desconectou")
                            return
                if s.get("fase") in ("jogando", "contagem"):
                    if s.get("vez") == slot:
                        _ludo_avancar_vez(s)
                    vivos_ws = sum(
                        1 for sl in ("p1", "p2", "p3", "p4")
                        if s["slots"].get(sl) and s["slots"][sl].get("ws")
                        and not s["slots"][sl].get("venceu")
                    )
                    if vivos_ws <= 1 and s.get("fase") == "jogando":
                        # W.O.: quem ficou vence se era 2+.
                        ficou = next(
                            (sl for sl in ("p1", "p2", "p3", "p4")
                             if s["slots"].get(sl) and s["slots"][sl].get("ws")
                             and not s["slots"][sl].get("venceu")), None)
                        if ficou and sum(1 for p in s["slots"].values() if p) >= 2:
                            s["fase"] = "fim"
                            s["vencedor"] = ficou
                            s["slots"][ficou]["venceu"] = True
                            s.setdefault("placar",
                                         {"p1": 0, "p2": 0, "p3": 0, "p4": 0})
                            s["placar"][ficou] = s["placar"].get(ficou, 0) + 1
                            p_ficou = s["slots"][ficou] or {}
                            registrar_vitoria_ludo(
                                p_ficou.get("nick", "Anônimo"),
                                p_ficou.get("nome", ""),
                                p_ficou.get("avatar"))
                            s["ultimo_evento"] = {
                                "texto": "Desistências. " +
                                ((s["slots"][ficou] or {}).get("nick") or "—") + " venceu!",
                            }
                if not salas_ludo.get(sala):
                    return
                await broadcast_estado_ludo(sala)
                await _notificar_salas_ludo_lobby()
            elif websocket in (s.get("espectadores") or []):
                s["espectadores"] = [w for w in s["espectadores"] if w is not websocket]


# ---------------------------------------------------------------------------
