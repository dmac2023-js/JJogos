"""Campo Minado — solo e 1x1 online."""
import asyncio
import json
import re
import secrets
import time
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from shared.game_store import jogos
from shared.lobby_state import conexoes_lobby
from shared.logging_util import log_tela
from shared.recordes import (
    _registrar_vitoria,
    carregar_recordes,
    eh_anonimo,
    ranking_top,
    ranking_vitorias,
    salvar_recordes,
)

router = APIRouter()


class NovaSalaCampo(BaseModel):
    codigo: Optional[str] = None
    publica: bool = True
    dificuldade: str = "facil"
    nome: str = "Anônimo"
    nick: str = "Anônimo"
    avatar: Optional[str] = None


class NovoRecordCampo(BaseModel):
    dificuldade: str
    nome: str
    nick: str
    tempo_segundos: int
    avatar: Optional[str] = None



# Campo Minado online: código -> sala (1x1 corrida, mesmo tabuleiro).
salas_campo: Dict[str, dict] = {}
MAX_CAMPO = 2
CAMPO_SALA_SEM_WS_SEGUNDOS = 60
# dificuldade -> (linhas, colunas, bombas)
CAMPO_DIM = {
    "facil": (10, 10, 12),
    "medio": (18, 18, 45),
    "dificil": (24, 24, 90),
}

def registrar_vitoria_campo(nick: str, nome: str, avatar: Optional[str],
                            tempo: Optional[int] = None,
                            dificuldade: str = "facil") -> None:
    """Vitória Campo Minado por dificuldade + melhor tempo."""
    if eh_anonimo(nick):
        return
    recordes = carregar_recordes()
    lista = recordes.setdefault("campo_minado_vitorias", [])
    recordes["campo_minado_vitorias"] = _registrar_vitoria(
        lista, nick, nome, avatar, dificuldade, tempo)
    salvar_recordes(recordes)



def campo_gerar_minas(linhas: int, colunas: int, bombas: int,
                      seguro: Optional[int] = None) -> List[int]:
    """Sorteia índices de bombas. Se seguro for índice, evita essa célula."""
    total = linhas * colunas
    bombas = max(1, min(bombas, total - 1))
    proibido = set()
    if seguro is not None and 0 <= seguro < total:
        proibido.add(seguro)
        # também evita vizinhos do 1º clique (abertura maior, padrão clássico)
        r, c = divmod(seguro, colunas)
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                rr, cc = r + dr, c + dc
                if 0 <= rr < linhas and 0 <= cc < colunas:
                    proibido.add(rr * colunas + cc)
    candidatos = [i for i in range(total) if i not in proibido]
    if len(candidatos) < bombas:
        candidatos = [i for i in range(total) if i != seguro]
    return sorted(secrets.SystemRandom().sample(candidatos, bombas))


def campo_numeros(linhas: int, colunas: int, minas: List[int]) -> List[int]:
    """Número de bombas vizinhas por célula (0 = vazio)."""
    conjunto = set(minas)
    nums = [0] * (linhas * colunas)
    for i in range(linhas * colunas):
        if i in conjunto:
            nums[i] = -1
            continue
        r, c = divmod(i, colunas)
        n = 0
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue
                rr, cc = r + dr, c + dc
                if 0 <= rr < linhas and 0 <= cc < colunas and (rr * colunas + cc) in conjunto:
                    n += 1
        nums[i] = n
    return nums


def campo_celulas_abertas(linhas: int, colunas: int, nums: List[int],
                          inicio: int) -> List[int]:
    """Flood-fill a partir de índice: retorna células seguras a revelar."""
    conjunto_minas = {i for i, v in enumerate(nums) if v < 0}
    visitado = set()
    fila = [inicio]
    saida: List[int] = []
    while fila:
        i = fila.pop()
        if i in visitado:
            continue
        visitado.add(i)
        if i in conjunto_minas:
            continue
        saida.append(i)
        if nums[i] != 0:
            continue
        r, c = divmod(i, colunas)
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue
                rr, cc = r + dr, c + dc
                if 0 <= rr < linhas and 0 <= cc < colunas:
                    j = rr * colunas + cc
                    if j not in visitado:
                        fila.append(j)
    return saida


def purgar_salas_campo_obsoletas() -> None:
    agora = time.time()
    for codigo, s in list(salas_campo.items()):
        conectados = sum(1 for p in s.get("slots", {}).values() if p and p.get("ws"))
        if conectados == 0 and agora - s.get("criado_em", agora) > CAMPO_SALA_SEM_WS_SEGUNDOS:
            salas_campo.pop(codigo, None)
            jid = s.get("jogo_id")
            if jid:
                jogos.pop(jid, None)
            log_tela("campo sala obsoleta removida codigo=" + codigo)


def _codigo_campo_valido(codigo: str) -> bool:
    return bool(re.fullmatch(r"[a-z0-9_-]{3,16}", codigo or ""))


def info_jogador_campo(s: dict, slot: str) -> dict:
    p = s.get("slots", {}).get(slot) or {}
    return {
        "slot": slot,
        "nick": p.get("nick", "—"),
        "nome": p.get("nome", ""),
        "avatar": p.get("avatar"),
        "conectado": bool(p.get("ws")),
        "reveladas": len(p.get("reveladas", [])),
        "perdeu": bool(p.get("perdeu", False)),
        "tempo_fim": p.get("tempo_fim"),
    }


def estado_campo_para(s: dict, slot: Optional[str] = None) -> dict:
    return {
        "tipo": "estado_campo",
        "sala": s["codigo"],
        "publica": s.get("publica", False),
        "dificuldade": s.get("dificuldade", "facil"),
        "fase": s.get("fase", "esperando"),
        "meu_slot": slot,
        "lider": s.get("lider"),
        "placar": s.get("placar", {"p1": 0, "p2": 0}),
        "jogadores": [info_jogador_campo(s, "p1"), info_jogador_campo(s, "p2")],
        "vencedor_rodada": s.get("vencedor_rodada"),
        "revanche_de": s.get("revanche_de"),
        "linhas": s.get("linhas"),
        "colunas": s.get("colunas"),
        "bombas": s.get("bombas"),
        "jogo_id": s.get("jogo_id") if s.get("fase") in ("jogando", "fim", "parcial") else None,
    }


async def broadcast_campo(sala: str, msg: dict):
    s = salas_campo.get(sala)
    if not s:
        return
    for p in s.get("slots", {}).values():
        if p and p.get("ws"):
            try:
                await p["ws"].send_json(msg)
            except Exception:
                pass


async def encerrar_sala_campo(sala: str, motivo: str):
    s = salas_campo.pop(sala, None)
    if not s:
        return
    jid = s.get("jogo_id")
    if jid:
        jogos.pop(jid, None)
    for p in list(s.get("slots", {}).values()):
        if p and p.get("ws"):
            try:
                await p["ws"].send_json({"tipo": "sala_campo_encerrada", "motivo": motivo})
                await p["ws"].close()
            except Exception:
                pass
    if s.get("countdown_task"):
        try:
            s["countdown_task"].cancel()
        except Exception:
            pass
    log_tela("campo sala encerrada codigo=%s motivo=%s" % (sala, motivo))
    await _notificar_salas_campo_lobby()


async def _notificar_salas_campo_lobby():
    purgar_salas_campo_obsoletas()
    lista = []
    for codigo, s in salas_campo.items():
        if not s.get("publica"):
            continue
        lista.append({
            "sala": codigo,
            "dificuldade": s.get("dificuldade", "facil"),
            "lider": (s.get("slots", {}).get(s.get("lider")) or {}).get("nick", "—"),
            "jogadores": sum(1 for p in s.get("slots", {}).values() if p and p.get("ws")),
            "fase": s.get("fase", "esperando"),
        })
    msg = {"tipo": "salas_campo", "salas": lista}
    for ws in list(conexoes_lobby):
        try:
            await ws.send_json(msg)
        except Exception:
            pass


async def _iniciar_contagem_campo(sala: str):
    s = salas_campo.get(sala)
    if not s or s.get("fase") not in ("esperando", "contagem", "fim"):
        return
    s["fase"] = "contagem"
    s["countdown_task"] = asyncio.current_task()
    try:
        for n in (3, 2, 1, 0):
            s = salas_campo.get(sala)
            if not s or s.get("fase") != "contagem":
                return
            await broadcast_campo(sala, {"tipo": "contagem", "n": n})
            if n > 0:
                await asyncio.sleep(1)
        s = salas_campo.get(sala)
        if not s or s.get("fase") != "contagem":
            return
        s["fase"] = "jogando"
        s["vencedor_rodada"] = None
        s["minas"] = None
        s["nums"] = None
        s["inicio_ms"] = int(time.time() * 1000)
        for sl in ("p1", "p2"):
            if s["slots"].get(sl):
                s["slots"][sl]["reveladas"] = []
                s["slots"][sl]["bandeiras"] = []
                s["slots"][sl]["perdeu"] = False
                s["slots"][sl]["tempo_fim"] = None
        linhas, colunas, bombas = CAMPO_DIM[s.get("dificuldade", "facil")]
        s["linhas"] = linhas
        s["colunas"] = colunas
        s["bombas"] = bombas
        # minas sorteadas no 1º revelar (primeira célula fica segura)
        for sl in ("p1", "p2"):
            p = s["slots"].get(sl)
            if p and p.get("ws"):
                try:
                    await p["ws"].send_json({
                        "tipo": "inicio_campo",
                        "jogo_id": s.get("jogo_id"),
                        "dificuldade": s.get("dificuldade"),
                        "linhas": linhas,
                        "colunas": colunas,
                        "bombas": bombas,
                        "meu_slot": sl,
                    })
                except Exception:
                    pass
    finally:
        s2 = salas_campo.get(sala)
        if s2:
            s2["countdown_task"] = None


def campo_garantir_minas(s: dict, primeiro: int) -> None:
    """Gera minas uma vez; 1º clique (de quem revelar primeiro) nunca em bomba."""
    if s.get("minas") is not None:
        return
    linhas = s["linhas"]
    colunas = s["colunas"]
    bombas = s["bombas"]
    minas = campo_gerar_minas(linhas, colunas, bombas, seguro=primeiro)
    s["minas"] = minas
    s["nums"] = campo_numeros(linhas, colunas, minas)



# Endpoints — Campo Minado
# ---------------------------------------------------------------------------

@router.get("/campo/salas")
async def listar_salas_campo():
    purgar_salas_campo_obsoletas()
    lista = []
    for codigo, s in salas_campo.items():
        if not s.get("publica"):
            continue
        lista.append({
            "sala": codigo,
            "dificuldade": s.get("dificuldade", "facil"),
            "lider": (s.get("slots", {}).get(s.get("lider")) or {}).get("nick", "—"),
            "jogadores": sum(1 for p in s.get("slots", {}).values() if p and p.get("ws")),
            "fase": s.get("fase", "esperando"),
        })
    return {"salas": lista}


@router.post("/campo/sala/novo")
async def criar_sala_campo(dados: NovaSalaCampo):
    codigo = (dados.codigo or "").strip().lower()
    if codigo and not _codigo_campo_valido(codigo):
        raise HTTPException(status_code=400,
                            detail="Código: 3 a 16 caracteres (letras, números, - ou _).")
    if codigo and codigo in salas_campo:
        raise HTTPException(status_code=409, detail="Já existe uma sala com esse código.")
    dificuldade = dados.dificuldade.lower()
    if dificuldade not in CAMPO_DIM:
        raise HTTPException(status_code=400, detail="Dificuldade inválida.")

    purgar_salas_campo_obsoletas()
    if not codigo:
        while True:
            codigo = secrets.token_urlsafe(6).lower().replace("-", "").replace("_", "")[:10]
            if not _codigo_campo_valido(codigo) or codigo not in salas_campo:
                break

    linhas, colunas, bombas = CAMPO_DIM[dificuldade]
    jogo_id = secrets.token_urlsafe(12)
    jogos[jogo_id] = {"tipo": "campo", "dificuldade": dificuldade}

    salas_campo[codigo] = {
        "codigo": codigo,
        "publica": bool(dados.publica),
        "dificuldade": dificuldade,
        "jogo_id": jogo_id,
        "linhas": linhas,
        "colunas": colunas,
        "bombas": bombas,
        "minas": None,
        "nums": None,
        "inicio_ms": None,
        "lider": "p1",
        "fase": "esperando",
        "slots": {
            "p1": {
                "ws": None, "nome": dados.nome, "nick": dados.nick,
                "avatar": dados.avatar, "reveladas": [], "bandeiras": [],
                "perdeu": False, "tempo_fim": None,
            },
            "p2": None,
        },
        "placar": {"p1": 0, "p2": 0},
        "vencedor_rodada": None,
        "revanche_de": None,
        "countdown_task": None,
        "criado_em": time.time(),
    }
    log_tela("campo sala criada codigo=%s publica=%s dif=%s" % (
        codigo, bool(dados.publica), dificuldade))
    await _notificar_salas_campo_lobby()
    return {"sala": codigo, "publica": bool(dados.publica), "dificuldade": dificuldade}


@router.get("/campo/novo")
def novo_campo(dificuldade: str = "facil"):
    """Tabuleiro solo: devolve minas e números (1º clique protegido no client via seed)."""
    dificuldade = dificuldade.lower()
    if dificuldade not in CAMPO_DIM:
        raise HTTPException(status_code=400, detail="Dificuldade inválida.")
    linhas, colunas, bombas = CAMPO_DIM[dificuldade]
    minas = campo_gerar_minas(linhas, colunas, bombas, seguro=None)
    nums = campo_numeros(linhas, colunas, minas)
    return {
        "dificuldade": dificuldade,
        "linhas": linhas,
        "colunas": colunas,
        "bombas": bombas,
        "minas": minas,
        "numeros": nums,
    }


@router.get("/campo/recordes/{dificuldade}")
def obter_recordes_campo(dificuldade: str):
    if dificuldade not in CAMPO_DIM:
        raise HTTPException(status_code=400, detail="Dificuldade inválida.")
    recordes = carregar_recordes()
    top3 = ranking_top(recordes["campo_minado"].get(dificuldade, []),
                       "tempo_segundos", reverse=False)
    return {"dificuldade": dificuldade, "recordes": top3}


@router.post("/campo/recordes")
def salvar_record_campo(dados: NovoRecordCampo):
    if dados.dificuldade not in CAMPO_DIM:
        raise HTTPException(status_code=400, detail="Dificuldade inválida.")
    if dados.tempo_segundos <= 0:
        raise HTTPException(status_code=400, detail="Tempo inválido.")

    recordes = carregar_recordes()
    if not eh_anonimo(dados.nick):
        registro = {"nome": dados.nome, "nick": dados.nick,
                    "tempo_segundos": dados.tempo_segundos}
        if dados.avatar:
            registro["avatar"] = dados.avatar
        recordes["campo_minado"].setdefault(dados.dificuldade, []).append(registro)
        recordes["campo_minado"][dados.dificuldade].sort(
            key=lambda r: r["tempo_segundos"])
        recordes["campo_minado"][dados.dificuldade] = \
            recordes["campo_minado"][dados.dificuldade][:50]
        salvar_recordes(recordes)
        registrar_vitoria_campo(dados.nick, dados.nome, dados.avatar,
                                dados.tempo_segundos, dados.dificuldade)

    recordes = carregar_recordes()
    top3 = ranking_top(recordes["campo_minado"].get(dados.dificuldade, []),
                       "tempo_segundos", reverse=False)
    ranking = ranking_vitorias(recordes.get("campo_minado_vitorias", []),
                               dificuldade=dados.dificuldade, limite=10)
    return {"dificuldade": dados.dificuldade, "recordes": top3, "ranking": ranking}


@router.get("/campo/ranking")
def ranking_campo(dificuldade: Optional[str] = None):
    recordes = carregar_recordes()
    ranking = ranking_vitorias(recordes.get("campo_minado_vitorias", []),
                               dificuldade=dificuldade, limite=10)
    return {"ranking": ranking, "dificuldade": dificuldade}


# ---------------------------------------------------------------------------

# WebSocket — Campo Minado online (1x1 corrida)
# ---------------------------------------------------------------------------

@router.websocket("/ws/campo/{sala}")
@router.websocket("/campo/{sala}")
async def ws_campo(websocket: WebSocket, sala: str):
    await websocket.accept()
    query = websocket.query_params
    nome = query.get("nome", "Anônimo")
    nick = query.get("nick", "Anônimo")
    avatar = query.get("avatar") or None

    s = salas_campo.get(sala)
    if not s:
        await websocket.send_json({"tipo": "erro", "mensagem": "Sala não encontrada."})
        await websocket.close()
        return

    slot = None
    for cand in ("p1", "p2"):
        p = s["slots"].get(cand)
        if p and not p.get("ws") and p.get("nick") == nick:
            slot = cand
            break

    if slot is None:
        p1 = s["slots"].get("p1")
        p2 = s["slots"].get("p2")
        p1_live = bool(p1 and p1.get("ws"))
        p2_live = bool(p2 and p2.get("ws"))
        if p1_live and p2_live:
            await websocket.send_json({"tipo": "erro", "mensagem": "Sala cheia."})
            await websocket.close()
            return
        if not p1_live:
            slot = "p1"
            if p1 is None:
                s["slots"]["p1"] = {
                    "ws": None, "nome": nome, "nick": nick, "avatar": avatar,
                    "reveladas": [], "bandeiras": [], "perdeu": False, "tempo_fim": None,
                }
        else:
            slot = "p2"
            if p2 is None:
                s["slots"]["p2"] = {
                    "ws": None, "nome": nome, "nick": nick, "avatar": avatar,
                    "reveladas": [], "bandeiras": [], "perdeu": False, "tempo_fim": None,
                }

    if s["slots"][slot]:
        s["slots"][slot].update({
            "nome": nome, "nick": nick, "avatar": avatar,
        })

    s["slots"][slot]["ws"] = websocket

    await websocket.send_json(estado_campo_para(s, slot))
    await _notificar_salas_campo_lobby()

    iniciou_contagem = False
    if (s.get("fase") == "esperando"
            and s["slots"]["p1"] and s["slots"]["p1"].get("ws")
            and s["slots"]["p2"] and s["slots"]["p2"].get("ws")):
        # p1 (que já estava esperando) precisa ver o p2 entrar
        for sl in ("p1", "p2"):
            p = s["slots"].get(sl)
            if p and p.get("ws") and sl != slot:
                try:
                    await p["ws"].send_json(estado_campo_para(s, sl))
                except Exception:
                    pass
        s["countdown_task"] = asyncio.create_task(_iniciar_contagem_campo(sala))
        iniciou_contagem = True

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                dados = json.loads(raw)
            except Exception:
                continue
            tipo = dados.get("tipo")
            s = salas_campo.get(sala)
            if not s:
                break
            if s.get("slots", {}).get(slot, {}) is None:
                break

            if tipo == "ping":
                try:
                    await websocket.send_json({"tipo": "pong"})
                except Exception:
                    pass
                continue

            if tipo == "revelar":
                if s.get("fase") != "jogando":
                    continue
                p = s["slots"].get(slot)
                if not p or p.get("perdeu") or s.get("vencedor_rodada"):
                    continue
                idx = dados.get("idx")
                linhas = s["linhas"]
                colunas = s["colunas"]
                total = linhas * colunas
                if not isinstance(idx, int) or not (0 <= idx < total):
                    continue
                campo_garantir_minas(s, idx)
                minas_set = set(s["minas"])
                nums = s["nums"]
                reveladas = set(p.get("reveladas", []))
                bandeiras = set(p.get("bandeiras", []))
                if idx in reveladas:
                    continue
                if idx in bandeiras:
                    continue
                if idx in minas_set:
                    p["perdeu"] = True
                    try:
                        await websocket.send_json({
                            "tipo": "voce_perdeu",
                            "idx": idx,
                            "minas": s["minas"],
                        })
                    except Exception:
                        pass
                    outro = "p2" if slot == "p1" else "p1"
                    p_outro = s["slots"].get(outro)
                    s["vencedor_rodada"] = outro if (p_outro and not p_outro.get("perdeu")) else slot
                    if p_outro and not p_outro.get("perdeu"):
                        s["placar"][outro] = s["placar"].get(outro, 0) + 1
                        s["fase"] = "parcial"
                        tempo_outro = 0
                        if s.get("inicio_ms"):
                            tempo_outro = max(1, int((time.time() * 1000 - s["inicio_ms"]) / 1000))
                        p_outro["tempo_fim"] = tempo_outro
                        registrar_vitoria_campo(
                            p_outro.get("nick", "—"), p_outro.get("nome", ""),
                            p_outro.get("avatar"), tempo_outro,
                            s.get("dificuldade", "facil"))
                        await broadcast_campo(sala, {
                            "tipo": "vencedor_rodada",
                            "slot": outro,
                            "nick": p_outro.get("nick", "—"),
                            "tempo": tempo_outro,
                            "motivo": "oponente_errou",
                            "placar": s["placar"],
                            "jogadores": [info_jogador_campo(s, "p1"),
                                          info_jogador_campo(s, "p2")],
                            "minas": s["minas"],
                        })
                    else:
                        s["fase"] = "parcial"
                        await broadcast_campo(sala, {
                            "tipo": "ambos_perderam",
                            "placar": s["placar"],
                            "jogadores": [info_jogador_campo(s, "p1"),
                                          info_jogador_campo(s, "p2")],
                            "minas": s["minas"],
                        })
                    continue
                abertas = campo_celulas_abertas(linhas, colunas, nums, idx)
                ja_abertas = set(reveladas)
                novas = [i for i in abertas if i not in ja_abertas]
                reveladas.update(abertas)
                p["reveladas"] = sorted(reveladas)
                seguras = total - len(minas_set)
                if len(reveladas) >= seguras:
                    p["perdeu"] = False
                    tempo_ms = 0
                    if s.get("inicio_ms"):
                        tempo_ms = int(time.time() * 1000 - s["inicio_ms"])
                    tempo_s = max(1, int(tempo_ms / 1000))
                    p["tempo_fim"] = tempo_s
                    if not s.get("vencedor_rodada"):
                        s["vencedor_rodada"] = slot
                        s["placar"][slot] = s["placar"].get(slot, 0) + 1
                        s["fase"] = "parcial"
                        registrar_vitoria_campo(
                            p.get("nick", "—"), p.get("nome", ""),
                            p.get("avatar"), tempo_s,
                            s.get("dificuldade", "facil"))
                        await broadcast_campo(sala, {
                            "tipo": "vencedor_rodada",
                            "slot": slot,
                            "nick": p.get("nick", "—"),
                            "tempo": tempo_s,
                            "motivo": "limpou",
                            "placar": s["placar"],
                            "jogadores": [info_jogador_campo(s, "p1"),
                                          info_jogador_campo(s, "p2")],
                            "minas": s["minas"],
                        })
                else:
                    await websocket.send_json({
                        "tipo": "revelado",
                        "slot": slot,
                        "idx": idx,
                        "celulas": novas,
                        "nums": {str(i): nums[i] for i in novas},
                        "reveladas_total": len(reveladas),
                        "seguras": seguras,
                    })
                    await broadcast_campo(sala, {
                        "tipo": "progresso_campo",
                        "jogadores": [info_jogador_campo(s, "p1"),
                                      info_jogador_campo(s, "p2")],
                        "fase": s.get("fase"),
                    })
                continue

            if tipo == "marcar":
                if s.get("fase") != "jogando":
                    continue
                p = s["slots"].get(slot)
                if not p or p.get("perdeu") or s.get("vencedor_rodada"):
                    continue
                idx = dados.get("idx")
                total = s["linhas"] * s["colunas"]
                if not isinstance(idx, int) or not (0 <= idx < total):
                    continue
                bandeiras = set(p.get("bandeiras", []))
                reveladas = set(p.get("reveladas", []))
                if idx in reveladas:
                    continue
                if idx in bandeiras:
                    bandeiras.discard(idx)
                else:
                    bandeiras.add(idx)
                p["bandeiras"] = sorted(bandeiras)
                await websocket.send_json({
                    "tipo": "marcado",
                    "slot": slot,
                    "bandeiras": p["bandeiras"],
                    "bandeiras_qtd": len(p["bandeiras"]),
                })
                continue

            if tipo == "pedir_revanche":
                s["revanche_de"] = slot
                outro = "p2" if slot == "p1" else "p1"
                p_outro = s["slots"].get(outro) or {}
                await broadcast_campo(sala, {
                    "tipo": "revanche_pedida",
                    "por": s["slots"][slot]["nick"],
                    "por_slot": slot,
                    "para": p_outro.get("nick"),
                    "placar": s["placar"],
                    "jogadores": [info_jogador_campo(s, "p1"), info_jogador_campo(s, "p2")],
                })
                continue

            if tipo == "responder_revanche":
                aceitar = bool(dados.get("aceitar"))
                if aceitar and s.get("revanche_de"):
                    s["fase"] = "esperando"
                    s["revanche_de"] = None
                    s["vencedor_rodada"] = None
                    s["minas"] = None
                    s["nums"] = None
                    for p in s.get("slots", {}).values():
                        if p:
                            p["reveladas"] = []
                            p["bandeiras"] = []
                            p["perdeu"] = False
                            p["tempo_fim"] = None
                    await broadcast_campo(sala, {"tipo": "revanche_aceita"})
                    s["countdown_task"] = asyncio.create_task(_iniciar_contagem_campo(sala))
                else:
                    await broadcast_campo(sala, {"tipo": "revanche_recusada"})
                    await encerrar_sala_campo(sala, "revanche_recusada")
                    break
                continue

            if tipo == "parar":
                await encerrar_sala_campo(sala, "parou")
                break

            if tipo == "sair":
                outro = "p2" if slot == "p1" else "p1"
                p_outro = (s.get("slots", {}) or {}).get(outro)
                if s.get("fase") in ("jogando", "contagem") and p_outro and p_outro.get("ws"):
                    s["slots"][slot]["ws"] = None
                    s["vencedor_rodada"] = outro
                    s["placar"][outro] = s["placar"].get(outro, 0) + 1
                    s["fase"] = "parcial"
                    try:
                        await p_outro["ws"].send_json({
                            "tipo": "vencedor_rodada",
                            "slot": outro,
                            "nick": p_outro.get("nick", "—"),
                            "tempo": 0,
                            "desistencia": True,
                            "placar": s["placar"],
                            "jogadores": [info_jogador_campo(s, "p1"),
                                          info_jogador_campo(s, "p2")],
                            "mensagem": "Oponente saiu. Você venceu!",
                        })
                    except Exception:
                        pass
                    await asyncio.sleep(2)
                    await encerrar_sala_campo(sala, "oponente_desistiu")
                    break
                if s.get("lider") == slot:
                    await encerrar_sala_campo(sala, "lider_saiu")
                    break
                s["slots"][slot] = None
                await broadcast_campo(sala, estado_campo_para(s, slot))
                if s.get("fase") not in ("jogando", "contagem"):
                    await encerrar_sala_campo(sala, "saiu_antes_de_jogar")
                    break
                continue

    except (WebSocketDisconnect, Exception):
        pass
    finally:
        s = salas_campo.get(sala)
        if s and s.get("slots", {}).get(slot, {}) is not None and \
                s["slots"][slot] and s["slots"][slot].get("ws") is websocket:
            s["slots"][slot]["ws"] = None
            outro = "p2" if slot == "p1" else "p1"
            p_outro = s.get("slots", {}).get(outro)
            if s.get("fase") in ("jogando", "contagem") and p_outro and p_outro.get("ws") is not None:
                s["vencedor_rodada"] = outro
                s["placar"][outro] = s["placar"].get(outro, 0) + 1
                s["fase"] = "parcial"
                try:
                    await p_outro["ws"].send_json({
                        "tipo": "vencedor_rodada",
                        "slot": outro,
                        "nick": p_outro.get("nick", "—"),
                        "tempo": 0,
                        "desistencia": True,
                        "placar": s["placar"],
                        "jogadores": [info_jogador_campo(s, "p1"),
                                      info_jogador_campo(s, "p2")],
                        "mensagem": "Oponente saiu. Você venceu!",
                    })
                except Exception:
                    pass
                await asyncio.sleep(2)
                await encerrar_sala_campo(sala, "oponente_desistiu")
            elif s.get("lider") == slot:
                if s.get("fase") == "jogando" and p_outro and p_outro.get("ws"):
                    s["vencedor_rodada"] = outro
                    s["placar"][outro] = s["placar"].get(outro, 0) + 1
                    s["fase"] = "parcial"
                    try:
                        await p_outro["ws"].send_json({
                            "tipo": "vencedor_rodada",
                            "slot": outro,
                            "nick": p_outro.get("nick", "—"),
                            "tempo": 0,
                            "desistencia": True,
                            "placar": s["placar"],
                            "jogadores": [info_jogador_campo(s, "p1"),
                                          info_jogador_campo(s, "p2")],
                            "mensagem": "O líder saiu. Você venceu!",
                        })
                    except Exception:
                        pass
                    await asyncio.sleep(2)
                    await encerrar_sala_campo(sala, "lider_desconectou")
                else:
                    await encerrar_sala_campo(sala, "lider_desconectou")
            else:
                await broadcast_campo(sala, estado_campo_para(s, slot))
                if s.get("fase") == "jogando":
                    await encerrar_sala_campo(sala, "oponente_desconectou")
                elif s.get("fase") == "esperando":
                    pass
                await _notificar_salas_campo_lobby()


# ---------------------------------------------------------------------------
