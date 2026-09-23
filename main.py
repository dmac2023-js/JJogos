import asyncio
import json
import os
import re
import secrets
import time
from pathlib import Path
from typing import Dict, List, Optional

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    from cryptography.exceptions import InvalidSignature
    HAS_CRYPTOGRAPHY = True
except ImportError:
    HAS_CRYPTOGRAPHY = False


load_dotenv()

PASTA_BASE = Path(__file__).parent
PASTA_STATIC = PASTA_BASE / "static"
ARQUIVO_RECORDES = PASTA_BASE / "recordes.json"
DISCORD_APPLICATION_ID = os.getenv("DISCORD_APPLICATION_ID", "")
DISCORD_CLIENT_SECRET = os.getenv("DISCORD_CLIENT_SECRET", "")
DISCORD_PUBLIC_KEY = os.getenv("DISCORD_PUBLIC_KEY", "")
OAUTH_REDIRECT_PADRAO = "https://jogos7.onrender.com/auth/callback"

app = FastAPI(title="Jogos no Discord")


@app.middleware("http")
async def liberar_embed_discord(request: Request, call_next):
    if request.scope["type"] != "http":
        return await call_next(request)
    if request.method == "OPTIONS":
        from starlette.responses import Response
        response = Response(status_code=204)
    else:
        response = await call_next(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "*"
    response.headers["Permissions-Policy"] = (
        "camera=(self), microphone=(self), display-capture=(self), "
        "geolocation=(), payment=()"
    )
    return response



# ---------------------------------------------------------------------------
# Modelos
# ---------------------------------------------------------------------------

class NovoSudoku(BaseModel):
    dificuldade: str = "facil"


class RespostaSudoku(BaseModel):
    jogo_id: str
    grade: List[List[int]]


class CodigoAutorizacao(BaseModel):
    code: str
    redirect_uri: Optional[str] = None
    # true = fluxo da Activity (SDK authorize): NÃO enviar redirect_uri
    # (o authorize do Embedded SDK não usa um — fallback quebraria a troca).
    activity: bool = False


class NovoRecord(BaseModel):
    dificuldade: str
    nome: str
    nick: str
    tempo_segundos: int
    avatar: Optional[str] = None


class NovoJogoVelha(BaseModel):
    modo: str
    dificuldade: str = "facil"
    nome: str = "Anônimo"
    nick: str = "Anônimo"
    avatar: Optional[str] = None


class MoverJogoVelha(BaseModel):
    jogo_id: str
    posicao: int


class NovoRecordVelha(BaseModel):
    dificuldade: str
    nome: str
    nick: str
    avatar: Optional[str] = None


class NovaSalaSudoku(BaseModel):
    codigo: Optional[str] = None
    publica: bool = True
    dificuldade: str = "facil"
    nome: str = "Anônimo"
    nick: str = "Anônimo"
    avatar: Optional[str] = None


class NovaSalaLudo(BaseModel):
    codigo: Optional[str] = None
    publica: bool = True
    dificuldade: str = "facil"
    nome: str = "Anônimo"
    nick: str = "Anônimo"
    avatar: Optional[str] = None


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


class NovaTransmissao(BaseModel):
    instancia: Optional[str] = None
    nick: str = "Anônimo"
    avatar: Optional[str] = None
    resolucao: str = "720p"
    fps: int = 30
    codigo: Optional[str] = None
    publica: bool = False
    multi: Optional[str] = None


class NovaSalaMulti(BaseModel):
    codigo: Optional[str] = None
    publica: bool = True
    nick: str = "Anônimo"
    avatar: Optional[str] = None


class RefreshTokenRequest(BaseModel):
    refresh_token: str


# ---------------------------------------------------------------------------
# Estado global
# ---------------------------------------------------------------------------

jogos: Dict[str, dict] = {}
salas_velha: Dict[str, str] = {}
# sala -> {"host_ws", "host_nick", "host_avatar", "publica", "instancia",
#          "resolucao", "fps", "viewers": {id: WebSocket},
#          "viewers_info": {id: {"nick", "avatar", "logado"}}}
salas_tela: Dict[str, dict] = {}
conexoes_ws: Dict[str, List[WebSocket]] = {}
conexoes_lobby: List[WebSocket] = []
_reconnect_timers: Dict[str, asyncio.Task] = {}
RECONNECT_GRACE_SECONDS = 15

# Sudoku online: código -> estado da sala (2 jogadores, mesmo puzzle)
salas_sudoku: Dict[str, dict] = {}
SUDOKU_SALA_SEM_WS_SEGUNDOS = 60

# Sala multi-tela: código -> membros + lives (até 8) 720p30 fixo.
# Vive enquanto houver pelo menos 1 membro com WS.
salas_multi: Dict[str, dict] = {}
MAX_LIVES_MULTI = 8
SALA_MULTI_SEM_MEMBRO_SEGUNDOS = 90

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


# ---------------------------------------------------------------------------
# Recordes — persistência
# ---------------------------------------------------------------------------

def carregar_recordes() -> dict:
    if ARQUIVO_RECORDES.exists():
        with open(ARQUIVO_RECORDES, "r", encoding="utf-8") as f:
            dados = json.load(f)
    else:
        dados = {}
    dados.setdefault("sudoku", {"facil": [], "medio": [], "dificil": []})
    dados.setdefault("velha", {"facil": [], "medio": [], "dificil": []})
    dados.setdefault("velha_vitorias", [])
    dados.setdefault("ludo_vitorias", [])
    dados.setdefault("campo_minado", {"facil": [], "medio": [], "dificil": []})
    dados.setdefault("campo_minado_vitorias", [])
    return dados


def salvar_recordes(recordes: dict) -> None:
    with open(ARQUIVO_RECORDES, "w", encoding="utf-8") as f:
        json.dump(recordes, f, ensure_ascii=False, indent=2)


def eh_anonimo(nick: str) -> bool:
    """Anônimo não entra em rankings nem conta vitórias."""
    return (nick or "").strip().lower() in {"anônimo", "anonimo"}


def ranking_top(registros: list, chave: str, reverse: bool, limite: int = 3) -> list:
    filtrados = [r for r in registros if not eh_anonimo(str(r.get("nick", "")))]
    return sorted(filtrados, key=lambda r: r.get(chave, 0), reverse=reverse)[:limite]


def ranking_vitorias(lista: list, dificuldade: Optional[str] = None,
                     limite: int = 10) -> list:
    """Top vitórias; se dificuldade informada, filtra por ela."""
    filtrados = []
    for r in lista:
        if eh_anonimo(str(r.get("nick", ""))):
            continue
        if dificuldade and r.get("dificuldade") not in (None, dificuldade):
            continue
        filtrados.append(r)
    return sorted(filtrados, key=lambda r: r.get("vitorias", 0),
                  reverse=True)[:limite]


def _registrar_vitoria(lista: list, nick: str, nome: str,
                       avatar: Optional[str], dificuldade: str,
                       tempo: Optional[int] = None) -> list:
    """Incrementa vitória do jogador na dificuldade (mesma lista plana)."""
    for v in lista:
        if (v.get("nick") == nick and v.get("nome") == nome
                and v.get("dificuldade") == dificuldade):
            v["vitorias"] = v.get("vitorias", 0) + 1
            if avatar:
                v["avatar"] = avatar
            if tempo and tempo > 0:
                anterior = v.get("melhor_tempo")
                if not anterior or tempo < anterior:
                    v["melhor_tempo"] = tempo
            return sorted(lista, key=lambda r: r.get("vitorias", 0),
                          reverse=True)[:50]
    novo = {"nick": nick, "nome": nome, "vitorias": 1,
            "dificuldade": dificuldade}
    if avatar:
        novo["avatar"] = avatar
    if tempo and tempo > 0:
        novo["melhor_tempo"] = tempo
    lista.append(novo)
    return sorted(lista, key=lambda r: r.get("vitorias", 0), reverse=True)[:50]


def registrar_vitoria_ludo(nick: str, nome: str, avatar: Optional[str]) -> None:
    """Vitória global no Ludo (permanente; anônimo não conta)."""
    if eh_anonimo(nick):
        return
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
    return sorted(secrets.sample(candidatos, bombas))


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


def purgar_salas_sudoku_obsoletas() -> None:
    """Remove salas de sudoku criadas mas sem WS conectado há muito tempo."""
    agora = time.time()
    for codigo, s in list(salas_sudoku.items()):
        conectados = sum(1 for p in s.get("slots", {}).values() if p and p.get("ws"))
        if conectados == 0 and agora - s.get("criado_em", agora) > SUDOKU_SALA_SEM_WS_SEGUNDOS:
            salas_sudoku.pop(codigo, None)
            jid = s.get("jogo_id")
            if jid:
                jogos.pop(jid, None)
            log_tela("sudoku sala obsoleta removida codigo=" + codigo)


def info_jogador_sudoku(s: dict, slot: str) -> dict:
    p = s.get("slots", {}).get(slot) or {}
    return {
        "slot": slot,
        "nick": p.get("nick", "—"),
        "nome": p.get("nome", ""),
        "avatar": p.get("avatar"),
        "conectado": bool(p.get("ws")),
        "tempo_fim": p.get("tempo_fim"),
        "completou": p.get("completou", False),
    }


def estado_sudoku_para(s: dict, slot: Optional[str] = None) -> dict:
    slots = s.get("slots", {})
    return {
        "tipo": "estado_sudoku",
        "sala": s["codigo"],
        "publica": s.get("publica", False),
        "dificuldade": s.get("dificuldade", "facil"),
        "fase": s.get("fase", "esperando"),
        "meu_slot": slot,
        "lider": s.get("lider"),
        "placar": s.get("placar", {"p1": 0, "p2": 0}),
        "jogadores": [info_jogador_sudoku(s, "p1"), info_jogador_sudoku(s, "p2")],
        "vencedor_rodada": s.get("vencedor_rodada"),
        "tempos_rodada": s.get("tempos_rodada", {}),
        "revanche_de": s.get("revanche_de"),
        "jogo_id": s.get("jogo_id") if s.get("fase") in ("jogando", "fim", "parcial") else None,
    }


async def broadcast_sudoku(sala: str, msg: dict):
    s = salas_sudoku.get(sala)
    if not s:
        return
    for p in s.get("slots", {}).values():
        if p and p.get("ws"):
            try:
                await p["ws"].send_json(msg)
            except Exception:
                pass


async def encerrar_sala_sudoku(sala: str, motivo: str):
    s = salas_sudoku.pop(sala, None)
    if not s:
        return
    jid = s.get("jogo_id")
    if jid:
        jogos.pop(jid, None)
    for p in list(s.get("slots", {}).values()):
        if p and p.get("ws"):
            try:
                await p["ws"].send_json({"tipo": "sala_sudoku_encerrada", "motivo": motivo})
                await p["ws"].close()
            except Exception:
                pass
    if s.get("countdown_task"):
        try:
            s["countdown_task"].cancel()
        except Exception:
            pass
    log_tela("sudoku sala encerrada codigo=%s motivo=%s" % (sala, motivo))
    await _notificar_salas_sudoku_lobby()


async def _notificar_salas_sudoku_lobby():
    purgar_salas_sudoku_obsoletas()
    lista = []
    for codigo, s in salas_sudoku.items():
        if not s.get("publica"):
            continue
        lista.append({
            "sala": codigo,
            "dificuldade": s.get("dificuldade", "facil"),
            "lider": (s.get("slots", {}).get(s.get("lider")) or {}).get("nick", "—"),
            "jogadores": sum(1 for p in s.get("slots", {}).values() if p and p.get("ws")),
            "fase": s.get("fase", "esperando"),
        })
    msg = {"tipo": "salas_sudoku", "salas": lista}
    for ws in list(conexoes_lobby):
        try:
            await ws.send_json(msg)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Sudoku — IA / puzzle
# ---------------------------------------------------------------------------

def embaralhar_grupos(grupos: List[List[int]]) -> List[int]:
    resultado = []
    grupos = [grupo[:] for grupo in grupos]
    secrets.SystemRandom().shuffle(grupos)
    for grupo in grupos:
        secrets.SystemRandom().shuffle(grupo)
        resultado.extend(grupo)
    return resultado


def criar_solucao() -> List[List[int]]:
    linhas = embaralhar_grupos([[0, 1, 2], [3, 4, 5], [6, 7, 8]])
    colunas = embaralhar_grupos([[0, 1, 2], [3, 4, 5], [6, 7, 8]])
    numeros = list(range(1, 10))
    secrets.SystemRandom().shuffle(numeros)

    def valor(linha: int, coluna: int) -> int:
        indice = (linha * 3 + linha // 3 + coluna) % 9
        return numeros[indice]

    return [[valor(linha, coluna) for coluna in colunas] for linha in linhas]


def candidatos(grade: List[List[int]], linha: int, coluna: int) -> set:
    usados = set(grade[linha])
    usados.update(grade[indice][coluna] for indice in range(9))
    bloco_linha = linha // 3 * 3
    bloco_coluna = coluna // 3 * 3
    usados.update(
        grade[indice_linha][indice_coluna]
        for indice_linha in range(bloco_linha, bloco_linha + 3)
        for indice_coluna in range(bloco_coluna, bloco_coluna + 3)
    )
    return set(range(1, 10)) - usados


def contar_solucoes(grade: List[List[int]], limite: int = 2) -> int:
    melhor = None
    opcoes = None

    for linha in range(9):
        for coluna in range(9):
            if grade[linha][coluna] == 0:
                atuais = candidatos(grade, linha, coluna)
                if not atuais:
                    return 0
                if opcoes is None or len(atuais) < len(opcoes):
                    melhor = (linha, coluna)
                    opcoes = atuais

    if melhor is None:
        return 1

    linha, coluna = melhor
    total = 0
    for numero in opcoes:
        grade[linha][coluna] = numero
        total += contar_solucoes(grade, limite)
        grade[linha][coluna] = 0
        if total >= limite:
            return total
    return total


def criar_puzzle(solucao: List[List[int]], dificuldade: str) -> List[List[int]]:
    quantidade_minima = {"facil": 40, "medio": 32, "dificil": 27}.get(dificuldade, 40)
    puzzle = [linha[:] for linha in solucao]
    posicoes = [(linha, coluna) for linha in range(9) for coluna in range(9)]
    secrets.SystemRandom().shuffle(posicoes)
    preenchidas = 81

    for linha, coluna in posicoes:
        if preenchidas <= quantidade_minima:
            break
        valor_original = puzzle[linha][coluna]
        puzzle[linha][coluna] = 0
        teste = [linha_teste[:] for linha_teste in puzzle]
        if contar_solucoes(teste) == 1:
            preenchidas -= 1
        else:
            puzzle[linha][coluna] = valor_original

    return puzzle


def grade_tem_duplicatas(grade: List[List[int]]) -> bool:
    for linha in grade:
        numeros = [numero for numero in linha if numero != 0]
        if len(numeros) != len(set(numeros)):
            return True

    for coluna in range(9):
        numeros = [grade[linha][coluna] for linha in range(9) if grade[linha][coluna] != 0]
        if len(numeros) != len(set(numeros)):
            return True

    for inicio_linha in range(0, 9, 3):
        for inicio_coluna in range(0, 9, 3):
            numeros = [
                grade[linha][coluna]
                for linha in range(inicio_linha, inicio_linha + 3)
                for coluna in range(inicio_coluna, inicio_coluna + 3)
                if grade[linha][coluna] != 0
            ]
            if len(numeros) != len(set(numeros)):
                return True

    return False


# ---------------------------------------------------------------------------
# Jogo da Velha — IA
# ---------------------------------------------------------------------------

LINHAS_VITORIA = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
]


def verificar_vencedor(tabuleiro: List[str]) -> Optional[str]:
    for a, b, c in LINHAS_VITORIA:
        if tabuleiro[a] and tabuleiro[a] == tabuleiro[b] == tabuleiro[c]:
            return tabuleiro[a]
    return None


def espacos_vazios(tabuleiro: List[str]) -> List[int]:
    return [i for i, v in enumerate(tabuleiro) if v == ""]


def minimax(tabuleiro: List[str], maximizando: bool) -> int:
    vencedor = verificar_vencedor(tabuleiro)
    if vencedor == "O":
        return 1
    if vencedor == "X":
        return -1
    if not espacos_vazios(tabuleiro):
        return 0

    if maximizando:
        melhor = -2
        for i in espacos_vazios(tabuleiro):
            tabuleiro[i] = "O"
            pontuacao = minimax(tabuleiro, False)
            tabuleiro[i] = ""
            melhor = max(melhor, pontuacao)
        return melhor
    else:
        melhor = 2
        for i in espacos_vazios(tabuleiro):
            tabuleiro[i] = "X"
            pontuacao = minimax(tabuleiro, True)
            tabuleiro[i] = ""
            melhor = min(melhor, pontuacao)
        return melhor


def jogada_ia(tabuleiro: List[str], dificuldade: str) -> int:
    vazios = espacos_vazios(tabuleiro)
    if not vazios:
        return -1
    if dificuldade == "facil":
        return secrets.choice(vazios)
    if dificuldade == "medio" and secrets.randbelow(2) == 0:
        return secrets.choice(vazios)
    melhor_pontuacao = -2
    melhor_jogada = vazios[0]
    for i in vazios:
        tabuleiro[i] = "O"
        pontuacao = minimax(tabuleiro, False)
        tabuleiro[i] = ""
        if pontuacao > melhor_pontuacao:
            melhor_pontuacao = pontuacao
            melhor_jogada = i
    return melhor_jogada


# ---------------------------------------------------------------------------
# Jogo da Velha — helpers
# ---------------------------------------------------------------------------

def criar_novo_jogo_velha(modo: str, dificuldade: str, nome_x: str, nick_x: str,
                          avatar_x: Optional[str] = None) -> dict:
    jogo_id = secrets.token_urlsafe(12)
    sala = secrets.token_urlsafe(6) if modo == "multiplayer" else None
    # O criador da sala ocupa a vaga "X" e é o dono (responsável pela sala).
    jogador_x = None
    if modo == "multiplayer":
        jogador_x = {"nome": nome_x, "nick": nick_x}
        if avatar_x:
            jogador_x["avatar"] = avatar_x
    jogo = {
        "jogo_id": jogo_id,
        "modo": modo,
        "tabuleiro": ["", "", "", "", "", "", "", "", ""],
        "jogador_atual": "X",
        "jogador_x": jogador_x,
        "jogador_o": None,
        "jogo_ativo": True,
        "resultado": None,
        "sala": sala,
        "dificuldade": dificuldade if modo == "maquina" else None,
        "dono": "X" if modo == "multiplayer" else None,
        "placar": {"X": 0, "O": 0},
    }
    jogos[jogo_id] = jogo
    if sala:
        salas_velha[sala] = jogo_id
    return jogo


def reiniciar_jogo(jogo: dict):
    jogo["tabuleiro"] = ["", "", "", "", "", "", "", "", ""]
    jogo["jogo_ativo"] = True
    jogo["resultado"] = None
    primeiro = secrets.choice(["X", "O"])
    jogo["jogador_atual"] = primeiro
    return primeiro


def estado_para_cliente(jogo: dict, jogador: str = "X") -> dict:
    return {
        "tipo": "estado",
        "jogo_id": jogo["jogo_id"],
        "tabuleiro": jogo["tabuleiro"],
        "jogador_atual": jogo["jogador_atual"],
        "jogador_x": jogo["jogador_x"]["nick"] if jogo["jogador_x"] else None,
        "jogador_o": jogo["jogador_o"]["nick"] if jogo["jogador_o"] else None,
        "avatar_x": (jogo["jogador_x"] or {}).get("avatar"),
        "avatar_o": (jogo["jogador_o"] or {}).get("avatar"),
        "placar": jogo.get("placar", {"X": 0, "O": 0}),
        "jogo_ativo": jogo["jogo_ativo"],
        "resultado": jogo["resultado"],
        "sua_vez": jogo["jogador_atual"] == jogador and jogo["jogo_ativo"],
        "minha_peca": jogador,
    }


async def transmitir_sala(sala: str, mensagem: dict, excluidos: Optional[set] = None):
    excluidos = excluidos or set()
    for ws in list(conexoes_ws.get(sala, [])):
        if id(ws) not in excluidos:
            try:
                await ws.send_json(mensagem)
            except Exception:
                pass


async def transmitir_salas_lobby():
    salas_ativas = []
    for sala, jogo_id in list(salas_velha.items()):
        jogo = jogos.get(jogo_id)
        if not jogo or jogo["modo"] != "multiplayer":
            continue
        jogadores = (1 if jogo["jogador_x"] else 0) + (1 if jogo["jogador_o"] else 0)
        conns = len(conexoes_ws.get(sala, []))
        salas_ativas.append({
            "sala": sala,
            "jogador_x": jogo["jogador_x"]["nick"] if jogo["jogador_x"] else None,
            "jogador_o": jogo["jogador_o"]["nick"] if jogo["jogador_o"] else None,
            "jogadores": jogadores,
            "espectadores": max(0, conns - jogadores),
            "em_andamento": jogo["jogo_ativo"] and jogo["jogador_o"] is not None,
        })
    msg = {"tipo": "salas_atualizadas", "salas": salas_ativas}
    for ws in list(conexoes_lobby):
        try:
            await ws.send_json(msg)
        except Exception:
            pass


def limpar_sala(sala: str):
    jogo_id = salas_velha.pop(sala, None)
    if jogo_id and jogo_id in jogos:
        del jogos[jogo_id]
    conexoes_ws.pop(sala, None)
    # Isso é sala da velha — não mexe em salas_sudoku (dict separado).


async def _fechar_sala_por_dono(sala: str, jogo: dict, excluido: Optional[WebSocket] = None):
    """O dono da sala saiu: avisa os demais, fecha a sala e limpa o estado."""
    mensagem = {
        "tipo": "oponente_desconectou",
        "mensagem": "O dono da sala saiu. A sala foi encerrada.",
        "dono_saiu": True,
    }
    for ws in list(conexoes_ws.get(sala, [])):
        if id(ws) == id(excluido):
            continue
        try:
            await ws.send_json(mensagem)
            await ws.close()
        except Exception:
            pass
    limpar_sala(sala)
    await transmitir_salas_lobby()


# ---------------------------------------------------------------------------
# Endpoints — saúde / config / auth
# ---------------------------------------------------------------------------

@app.get("/saude")
def saude():
    return {"online": True}


@app.get("/config")
def configuracao_publica():
    return {
        "application_id": DISCORD_APPLICATION_ID,
        "redirect_uri": os.getenv("OAUTH_REDIRECT_URI", "").strip() or None,
    }


async def discord_interactions(request: Request):
    body = await request.body()
    signature = request.headers.get("X-Signature-Ed25519", "")
    timestamp = request.headers.get("X-Signature-Timestamp", "")

    if HAS_CRYPTOGRAPHY and DISCORD_PUBLIC_KEY:
        try:
            public_key = Ed25519PublicKey.from_public_bytes(bytes.fromhex(DISCORD_PUBLIC_KEY))
            message = timestamp.encode() + body
            public_key.verify(bytes.fromhex(signature), message)
        except Exception:
            raise HTTPException(status_code=401, detail="Invalid request signature")

    payload = json.loads(body)

    if payload.get("type") == 1:
        return {"type": 1}

    return {"type": 4, "data": {"content": "Este jogo só funciona dentro do Discord Activity!", "flags": 64}}

app.add_api_route("/api/discord/interactions", discord_interactions, methods=["POST"])
app.add_api_route("/discord/interactions", discord_interactions, methods=["POST"])


@app.post("/token")
def trocar_codigo_por_token(dados: CodigoAutorizacao):
    if not DISCORD_APPLICATION_ID or not DISCORD_CLIENT_SECRET:
        raise HTTPException(status_code=500, detail="As credenciais do Discord não foram configuradas.")

    # O Discord exige que o redirect_uri do token bata exatamente com o usado
    # no authorize. Login do site: envia o mesmo valor (fallback env/padrão).
    # Activity (SDK authorize): não usa redirect_uri — não incluir na troca.
    payload = {
        "client_id": DISCORD_APPLICATION_ID,
        "client_secret": DISCORD_CLIENT_SECRET,
        "grant_type": "authorization_code",
        "code": dados.code,
    }
    if not dados.activity:
        redirect_uri = ((dados.redirect_uri or "").strip()
                        or os.getenv("OAUTH_REDIRECT_URI", "").strip()
                        or OAUTH_REDIRECT_PADRAO)
        payload["redirect_uri"] = redirect_uri

    resposta = requests.post(
        "https://discord.com/api/oauth2/token",
        data=payload,
        timeout=15,
    )

    if resposta.status_code != 200:
        try:
            corpo = resposta.json()
            motivo = corpo.get("error_description") or corpo.get("error") or resposta.text[:200]
        except Exception:
            motivo = resposta.text[:200]
        raise HTTPException(status_code=400, detail="Discord recusou o login: " + str(motivo))

    return resposta.json()


@app.post("/token/refresh")
def renovar_token(dados: RefreshTokenRequest):
    if not DISCORD_APPLICATION_ID or not DISCORD_CLIENT_SECRET:
        raise HTTPException(status_code=500, detail="As credenciais do Discord não foram configuradas.")

    resposta = requests.post(
        "https://discord.com/api/oauth2/token",
        data={
            "client_id": DISCORD_APPLICATION_ID,
            "client_secret": DISCORD_CLIENT_SECRET,
            "grant_type": "refresh_token",
            "refresh_token": dados.refresh_token,
        },
        timeout=15,
    )

    if resposta.status_code != 200:
        raise HTTPException(status_code=400, detail="Não foi possível renovar a sessão.")

    return resposta.json()


# ---------------------------------------------------------------------------
# Endpoints — jogos disponíveis
# ---------------------------------------------------------------------------

@app.get("/jogos")
def listar_jogos():
    return [
        {
            "id": "sudoku",
            "nome": "Sudoku",
            "descricao": "Complete a grade 9×9 com números de 1 a 9.",
        },
        {
            "id": "velha",
            "nome": "Jogo da Velha",
            "descricao": "Jogo clássico 3×3 contra a máquina ou outros jogadores.",
        },
        {
            "id": "campo",
            "nome": "Campo Minado",
            "descricao": "Solo contra o tempo ou 1x1 online — quem limpar primeiro vence.",
        },
    ]


# ---------------------------------------------------------------------------
# Endpoints — Sudoku
# ---------------------------------------------------------------------------

@app.post("/sudoku/novo")
def novo_sudoku(dados: NovoSudoku):
    dificuldade = dados.dificuldade.lower()
    if dificuldade not in {"facil", "medio", "dificil"}:
        raise HTTPException(status_code=400, detail="Dificuldade inválida.")

    solucao = criar_solucao()
    puzzle = criar_puzzle(solucao, dificuldade)
    jogo_id = secrets.token_urlsafe(12)
    jogos[jogo_id] = {"solucao": solucao, "puzzle": puzzle, "dificuldade": dificuldade}

    return {"jogo_id": jogo_id, "dificuldade": dificuldade, "grade": puzzle}


@app.post("/sudoku/verificar")
def verificar_sudoku(resposta: RespostaSudoku):
    jogo = jogos.get(resposta.jogo_id)
    if not jogo:
        raise HTTPException(status_code=404, detail="Partida não encontrada.")

    grade = resposta.grade
    if len(grade) != 9 or any(len(linha) != 9 for linha in grade):
        raise HTTPException(status_code=400, detail="A grade deve ser 9×9.")

    for linha in grade:
        if any(numero not in range(10) for numero in linha):
            raise HTTPException(status_code=400, detail="Use somente números de 1 a 9.")

    if grade_tem_duplicatas(grade):
        return {
            "correto": False,
            "completo": False,
            "erros": [
                [linha, coluna]
                for linha in range(9)
                for coluna in range(9)
                if grade[linha][coluna] != 0
                and grade[linha][coluna] != jogo["solucao"][linha][coluna]
            ],
            "mensagem": "Há números repetidos em uma linha, coluna ou bloco 3×3.",
        }

    puzzle = jogo["puzzle"]
    for linha in range(9):
        for coluna in range(9):
            if puzzle[linha][coluna] != 0 and grade[linha][coluna] != puzzle[linha][coluna]:
                return {
                    "correto": False,
                    "completo": False,
                    "erros": [[linha, coluna]],
                    "mensagem": "Não altere os números que já estavam preenchidos.",
                }

    if any(numero == 0 for linha in grade for numero in linha):
        return {
            "correto": False,
            "completo": False,
            "erros": [
                [linha, coluna]
                for linha in range(9)
                for coluna in range(9)
                if grade[linha][coluna] != 0
                and grade[linha][coluna] != jogo["solucao"][linha][coluna]
            ],
            "mensagem": "Preencha todas as casas antes de verificar.",
        }

    correto = grade == jogo["solucao"]
    erros = [
        [linha, coluna]
        for linha in range(9)
        for coluna in range(9)
        if grade[linha][coluna] != jogo["solucao"][linha][coluna]
    ]
    return {
        "correto": correto,
        "completo": correto,
        "erros": erros,
        "mensagem": "Parabéns! Você resolveu o Sudoku." if correto else "Ainda há números incorretos.",
    }


@app.get("/sudoku/recordes/{dificuldade}")
def obter_recordes(dificuldade: str):
    if dificuldade not in {"facil", "medio", "dificil"}:
        raise HTTPException(status_code=400, detail="Dificuldade inválida.")
    recordes = carregar_recordes()
    top3 = ranking_top(recordes["sudoku"].get(dificuldade, []), "tempo_segundos", reverse=False)
    return {"dificuldade": dificuldade, "recordes": top3}


@app.post("/sudoku/recordes")
def salvar_novo_record(dados: NovoRecord):
    if dados.dificuldade not in {"facil", "medio", "dificil"}:
        raise HTTPException(status_code=400, detail="Dificuldade inválida.")
    if dados.tempo_segundos <= 0:
        raise HTTPException(status_code=400, detail="Tempo inválido.")

    recordes = carregar_recordes()
    if eh_anonimo(dados.nick):
        return {"dificuldade": dados.dificuldade,
                "recordes": ranking_top(recordes["sudoku"].get(dados.dificuldade, []),
                                        "tempo_segundos", reverse=False)}
    registro = {"nome": dados.nome, "nick": dados.nick,
                "tempo_segundos": dados.tempo_segundos}
    if dados.avatar:
        registro["avatar"] = dados.avatar
    recordes["sudoku"].setdefault(dados.dificuldade, []).append(registro)
    recordes["sudoku"][dados.dificuldade].sort(key=lambda r: r["tempo_segundos"])
    recordes["sudoku"][dados.dificuldade] = recordes["sudoku"][dados.dificuldade][:50]
    salvar_recordes(recordes)

    top3 = ranking_top(recordes["sudoku"][dados.dificuldade], "tempo_segundos", reverse=False)
    return {"dificuldade": dados.dificuldade, "recordes": top3}


# ---------------------------------------------------------------------------
# Endpoints — Jogo da Velha
# ---------------------------------------------------------------------------

@app.post("/velha/novo")
async def novo_jogo_velha(dados: NovoJogoVelha):
    modo = dados.modo.lower()
    if modo not in {"maquina", "multiplayer"}:
        raise HTTPException(status_code=400, detail="Modo inválido.")
    dificuldade = dados.dificuldade.lower()
    if dificuldade not in {"facil", "medio", "dificil"}:
        raise HTTPException(status_code=400, detail="Dificuldade inválida.")

    jogo = criar_novo_jogo_velha(modo, dificuldade, dados.nome, dados.nick, dados.avatar)
    # Avisa imediatamente o lobby para os oponentes verem a sala em tempo real.
    if modo == "multiplayer":
        await transmitir_salas_lobby()
    return {
        "jogo_id": jogo["jogo_id"],
        "sala": jogo["sala"],
        "tabuleiro": jogo["tabuleiro"],
        "jogador_atual": jogo["jogador_atual"],
        "jogador_x": jogo["jogador_x"]["nick"] if jogo["jogador_x"] else None,
    }


@app.post("/velha/mover")
def mover_velha(dados: MoverJogoVelha):
    jogo = jogos.get(dados.jogo_id)
    if not jogo:
        raise HTTPException(status_code=404, detail="Partida não encontrada.")
    if not jogo["jogo_ativo"]:
        raise HTTPException(status_code=400, detail="Jogo já finalizado.")
    if jogo["modo"] != "maquina":
        raise HTTPException(status_code=400, detail="Use WebSocket para modo multiplayer.")
    if jogo["jogador_atual"] != "X":
        raise HTTPException(status_code=400, detail="Não é sua vez.")
    if dados.posicao not in range(9):
        raise HTTPException(status_code=400, detail="Posição inválida.")
    if jogo["tabuleiro"][dados.posicao] != "":
        raise HTTPException(status_code=400, detail="Posição já ocupada.")

    jogo["tabuleiro"][dados.posicao] = "X"

    vencedor = verificar_vencedor(jogo["tabuleiro"])
    if vencedor:
        jogo["jogo_ativo"] = False
        jogo["resultado"] = vencedor
        jogo.setdefault("placar", {"X": 0, "O": 0})
        jogo["placar"][vencedor] = jogo["placar"].get(vencedor, 0) + 1
        return estado_para_cliente(jogo, "X")
    if not espacos_vazios(jogo["tabuleiro"]):
        jogo["jogo_ativo"] = False
        jogo["resultado"] = "empate"
        return estado_para_cliente(jogo, "X")

    jogo["jogador_atual"] = "O"
    pos_ia = jogada_ia(jogo["tabuleiro"], jogo["dificuldade"])
    if pos_ia >= 0:
        jogo["tabuleiro"][pos_ia] = "O"

    vencedor = verificar_vencedor(jogo["tabuleiro"])
    if vencedor:
        jogo["jogo_ativo"] = False
        jogo["resultado"] = vencedor
        jogo.setdefault("placar", {"X": 0, "O": 0})
        jogo["placar"][vencedor] = jogo["placar"].get(vencedor, 0) + 1
    elif not espacos_vazios(jogo["tabuleiro"]):
        jogo["jogo_ativo"] = False
        jogo["resultado"] = "empate"
    else:
        jogo["jogador_atual"] = "X"

    return estado_para_cliente(jogo, "X")


@app.get("/velha/salas")
def listar_salas():
    salas_ativas = []
    for sala, jogo_id in list(salas_velha.items()):
        jogo = jogos.get(jogo_id)
        if not jogo or jogo["modo"] != "multiplayer":
            continue
        jogadores = (1 if jogo["jogador_x"] else 0) + (1 if jogo["jogador_o"] else 0)
        conns = len(conexoes_ws.get(sala, []))
        salas_ativas.append({
            "sala": sala,
            "jogador_x": jogo["jogador_x"]["nick"] if jogo["jogador_x"] else None,
            "jogador_o": jogo["jogador_o"]["nick"] if jogo["jogador_o"] else None,
            "jogadores": jogadores,
            "espectadores": max(0, conns - jogadores),
            "em_andamento": jogo["jogo_ativo"] and jogo["jogador_o"] is not None,
        })
    return {"salas": salas_ativas}


@app.get("/velha/recordes/{dificuldade}")
def obter_recordes_velha(dificuldade: str):
    if dificuldade not in {"facil", "medio", "dificil"}:
        raise HTTPException(status_code=400, detail="Dificuldade inválida.")
    recordes = carregar_recordes()
    brutos = recordes["velha"].get(dificuldade, [])[-10:]
    top3 = [r for r in reversed(brutos) if not eh_anonimo(str(r.get("nick", "")))][:3]
    return {"dificuldade": dificuldade, "recordes": top3}


@app.get("/velha/ranking")
def ranking_vitorias_velha(dificuldade: Optional[str] = None):
    recordes = carregar_recordes()
    ranking = ranking_vitorias(recordes.get("velha_vitorias", []),
                               dificuldade=dificuldade, limite=10)
    return {"ranking": ranking, "dificuldade": dificuldade}


# ---------------------------------------------------------------------------
# Endpoints — Sudoku online (salas público/privado)
# ---------------------------------------------------------------------------

def _codigo_sudoku_valido(codigo: str) -> bool:
    return bool(re.fullmatch(r"[a-z0-9_-]{3,16}", codigo or ""))


@app.get("/sudoku/salas")
async def listar_salas_sudoku():
    purgar_salas_sudoku_obsoletas()
    lista = []
    for codigo, s in salas_sudoku.items():
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


@app.post("/sudoku/sala/novo")
async def criar_sala_sudoku(dados: NovaSalaSudoku):
    codigo = (dados.codigo or "").strip().lower()
    if codigo and not _codigo_sudoku_valido(codigo):
        raise HTTPException(status_code=400,
                            detail="Código: 3 a 16 caracteres (letras, números, - ou _).")
    if codigo and codigo in salas_sudoku:
        raise HTTPException(status_code=409, detail="Já existe uma sala com esse código.")
    dificuldade = dados.dificuldade.lower()
    if dificuldade not in {"facil", "medio", "dificil"}:
        raise HTTPException(status_code=400, detail="Dificuldade inválida.")

    purgar_salas_sudoku_obsoletas()
    if not codigo:
        while True:
            codigo = secrets.token_urlsafe(6).lower().replace("-", "").replace("_", "")[:10]
            if not _codigo_sudoku_valido(codigo) or codigo not in salas_sudoku:
                break

    solucao = criar_solucao()
    puzzle = criar_puzzle(solucao, dificuldade)
    jogo_id = secrets.token_urlsafe(12)
    jogos[jogo_id] = {"solucao": solucao, "puzzle": puzzle, "dificuldade": dificuldade}

    salas_sudoku[codigo] = {
        "codigo": codigo,
        "publica": bool(dados.publica),
        "dificuldade": dificuldade,
        "jogo_id": jogo_id,
        "grade": puzzle,
        "lider": "p1",
        "fase": "esperando",
        "slots": {
            "p1": {
                "ws": None, "nome": dados.nome, "nick": dados.nick,
                "avatar": dados.avatar, "completou": False, "tempo_fim": None,
            },
            "p2": None,
        },
        "placar": {"p1": 0, "p2": 0},
        "vencedor_rodada": None,
        "tempos_rodada": {},
        "revanche_de": None,
        "countdown_task": None,
        "criado_em": time.time(),
    }
    log_tela("sudoku sala criada codigo=%s publica=%s dif=%s" % (
        codigo, bool(dados.publica), dificuldade))
    await _notificar_salas_sudoku_lobby()
    return {"sala": codigo, "publica": bool(dados.publica), "dificuldade": dificuldade}


# ---------------------------------------------------------------------------
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


@app.get("/ludo/ranking")
def ranking_ludo_vitorias():
    recordes = carregar_recordes()
    ranking = ranking_top(recordes.get("ludo_vitorias", []),
                          "vitorias", reverse=True, limite=10)
    return {"ranking": ranking}


@app.get("/ludo/salas")
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


@app.post("/ludo/sala/novo")
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
# Endpoints — Jogo da Velha
# ---------------------------------------------------------------------------

@app.post("/velha/recordes")
def salvar_record_velha(dados: NovoRecordVelha):
    if dados.dificuldade not in {"facil", "medio", "dificil"}:
        raise HTTPException(status_code=400, detail="Dificuldade inválida.")

    recordes = carregar_recordes()
    registro = {"nome": dados.nome, "nick": dados.nick}
    if dados.avatar:
        registro["avatar"] = dados.avatar

    if not eh_anonimo(dados.nick):
        recordes["velha"].setdefault(dados.dificuldade, []).append(registro)
        recordes["velha"][dados.dificuldade] = recordes["velha"][dados.dificuldade][-50:]
        vitorias = recordes.get("velha_vitorias", [])
        recordes["velha_vitorias"] = _registrar_vitoria(
            vitorias, dados.nick, dados.nome, dados.avatar, dados.dificuldade)
        salvar_recordes(recordes)

    top3 = ranking_top(recordes["velha"].get(dados.dificuldade, [])[-10:],
                       "vitorias", reverse=True, limite=3)
    ranking = ranking_vitorias(recordes.get("velha_vitorias", []),
                               dificuldade=dados.dificuldade, limite=10)
    return {"dificuldade": dados.dificuldade, "recordes": top3, "ranking": ranking}


# ---------------------------------------------------------------------------
# Endpoints — Campo Minado
# ---------------------------------------------------------------------------

@app.get("/campo/salas")
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


@app.post("/campo/sala/novo")
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


@app.get("/campo/novo")
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


@app.get("/campo/recordes/{dificuldade}")
def obter_recordes_campo(dificuldade: str):
    if dificuldade not in CAMPO_DIM:
        raise HTTPException(status_code=400, detail="Dificuldade inválida.")
    recordes = carregar_recordes()
    top3 = ranking_top(recordes["campo_minado"].get(dificuldade, []),
                       "tempo_segundos", reverse=False)
    return {"dificuldade": dificuldade, "recordes": top3}


@app.post("/campo/recordes")
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


@app.get("/campo/ranking")
def ranking_campo(dificuldade: Optional[str] = None):
    recordes = carregar_recordes()
    ranking = ranking_vitorias(recordes.get("campo_minado_vitorias", []),
                               dificuldade=dificuldade, limite=10)
    return {"ranking": ranking, "dificuldade": dificuldade}


# ---------------------------------------------------------------------------
# WebSocket — Lobby (atualizações em tempo real da lista de salas)
# ---------------------------------------------------------------------------

@app.websocket("/ws/lobby")
@app.websocket("/lobby")
async def ws_lobby(websocket: WebSocket):
    await websocket.accept()
    conexoes_lobby.append(websocket)
    try:
        await transmitir_salas_lobby()
        try:
            await websocket.send_json({"tipo": "salas_multi", "salas": await listar_salas_multi_publicas()})
        except Exception:
            pass
        try:
            purgar_salas_ludo_obsoletas()
            ludo = [{
                "sala": codigo,
                "lider": (s.get("slots", {}).get(s.get("lider")) or {}).get("nick", "—"),
                "jogadores": sum(1 for p in s.get("slots", {}).values() if p and p.get("ws")),
                "fase": s.get("fase", "esperando"),
            } for codigo, s in salas_ludo.items() if s.get("publica")]
            await websocket.send_json({"tipo": "salas_ludo", "salas": ludo})
        except Exception:
            pass
        try:
            purgar_salas_campo_obsoletas()
            campo = [{
                "sala": codigo,
                "dificuldade": s.get("dificuldade", "facil"),
                "lider": (s.get("slots", {}).get(s.get("lider")) or {}).get("nick", "—"),
                "jogadores": sum(1 for p in s.get("slots", {}).values() if p and p.get("ws")),
                "fase": s.get("fase", "esperando"),
            } for codigo, s in salas_campo.items() if s.get("publica")]
            await websocket.send_json({"tipo": "salas_campo", "salas": campo})
        except Exception:
            pass
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in conexoes_lobby:
            conexoes_lobby.remove(websocket)


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
@app.websocket("/ws/ludo/{sala}")
@app.websocket("/ludo/{sala}")
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
# WebSocket — Jogo da Velha (multiplayer + espectadores)
# ---------------------------------------------------------------------------

async def _vitoria_por_desistencia(sala: str, jogo: dict, peca_saiu: str, nick_saiu: str):
    """Oponente saiu: vitória para quem ficou, placar++, depois desfaz a sala."""
    peca_ficou = "O" if peca_saiu == "X" else "X"
    slot_saiu = f"jogador_{peca_saiu.lower()}"
    slot_ficou = f"jogador_{peca_ficou.lower()}"
    jogo[slot_saiu] = None
    ficou = jogo.get(slot_ficou)
    if not ficou:
        limpar_sala(sala)
        await transmitir_salas_lobby()
        return

    jogo["jogo_ativo"] = False
    jogo["resultado"] = peca_ficou
    placar = jogo.setdefault("placar", {"X": 0, "O": 0})
    placar[peca_ficou] = placar.get(peca_ficou, 0) + 1

    # Estado com vitória para quem ficou (e espectadores).
    await transmitir_sala(sala, estado_para_cliente(jogo, peca_ficou))
    await transmitir_sala(sala, {
        "tipo": "vitoria_desistencia",
        "mensagem": "Oponente saiu da sala. Você venceu!",
        "vencedor": peca_ficou,
        "nick_vencedor": ficou.get("nick", "—"),
        "nick_saiu": nick_saiu,
    })
    # Dá tempo do cliente mostrar a vitória antes de derrubar a sala.
    await asyncio.sleep(2.5)
    for ws in list(conexoes_ws.get(sala, [])):
        try:
            await ws.close()
        except Exception:
            pass
    limpar_sala(sala)
    await transmitir_salas_lobby()


async def _delayed_disconnect(sala: str, piece: str, jogo: dict, nick: str):
    await asyncio.sleep(RECONNECT_GRACE_SECONDS)
    key = f"{sala}:{piece}"
    _reconnect_timers.pop(key, None)
    slot_key = f"jogador_{piece.lower()}"
    slot = jogo.get(slot_key)
    if not slot or slot["nick"] != nick:
        return
    # Quem ficou vence; sala desfaz (independente de dono ou oponente).
    outro = "O" if piece == "X" else "X"
    if jogo.get(f"jogador_{outro.lower()}"):
        await _vitoria_por_desistencia(sala, jogo, piece, nick)
    else:
        # Ninguém mais na sala.
        jogo[slot_key] = None
        try:
            await transmitir_sala(sala, {"tipo": "oponente_desconectou", "nick": nick})
        except Exception:
            pass
        limpar_sala(sala)
        try:
            await transmitir_salas_lobby()
        except Exception:
            pass


@app.websocket("/ws/velha/{sala}")
@app.websocket("/velha/{sala}")
async def ws_velha(websocket: WebSocket, sala: str):
    await websocket.accept()
    query = websocket.query_params
    nome = query.get("nome", "Anônimo")
    nick = query.get("nick", "Anônimo")
    eh_espectador = query.get("espectador", "false") == "true"

    jogo_id = salas_velha.get(sala)
    if not jogo_id:
        await websocket.send_json({"tipo": "erro", "mensagem": "Sala não encontrada."})
        await websocket.close()
        return

    jogo = jogos.get(jogo_id)
    if not jogo:
        await websocket.send_json({"tipo": "erro", "mensagem": "Jogo não encontrado."})
        await websocket.close()
        return

    conexoes_ws.setdefault(sala, [])

    if eh_espectador:
        conexoes_ws[sala].append(websocket)
        total_spec = len([ws for ws in conexoes_ws[sala] if ws != websocket])
        await transmitir_sala(sala, {"tipo": "espectador_entrou", "nick": nick, "total": total_spec + 1})
        try:
            await websocket.send_json(estado_para_cliente(jogo, "X"))
            while True:
                await websocket.receive_text()
        except (WebSocketDisconnect, Exception):
            pass
        finally:
            if sala in conexoes_ws and websocket in conexoes_ws.get(sala, []):
                conexoes_ws[sala].remove(websocket)
            await transmitir_sala(sala, {"tipo": "espectador_saiu", "nick": nick})
        return

    my_piece = None
    is_reconnect = False
    avatar_q = query.get("avatar") or None
    # Verifica primeiro se o nick já ocupa um lugar (reconexão), ANTES de
    # preencher vagas livres. Com o criador pré-atribuído como "X" na criação,
    # o criador deve voltar a ser "X" e não virar "O" acidentalmente.
    if jogo["jogador_x"] and jogo["jogador_x"]["nick"] == nick:
        my_piece = "X"
        is_reconnect = True
        t = _reconnect_timers.pop(f"{sala}:X", None)
        if t:
            t.cancel()
    elif jogo["jogador_o"] and jogo["jogador_o"]["nick"] == nick:
        my_piece = "O"
        is_reconnect = True
        t = _reconnect_timers.pop(f"{sala}:O", None)
        if t:
            t.cancel()
    elif not jogo["jogador_x"]:
        jogo["jogador_x"] = {"nome": nome, "nick": nick}
        if avatar_q:
            jogo["jogador_x"]["avatar"] = avatar_q
        my_piece = "X"
    elif not jogo["jogador_o"]:
        jogo["jogador_o"] = {"nome": nome, "nick": nick}
        if avatar_q:
            jogo["jogador_o"]["avatar"] = avatar_q
        my_piece = "O"
    else:
        await websocket.send_json({"tipo": "erro", "mensagem": "Sala cheia."})
        await websocket.close()
        return

    conexoes_ws[sala].append(websocket)
    await transmitir_salas_lobby()

    if jogo["jogador_x"] and jogo["jogador_o"]:
        if is_reconnect:
            await websocket.send_json({
                "tipo": "inicio",
                "jogador_x": jogo["jogador_x"]["nick"],
                "jogador_o": jogo["jogador_o"]["nick"],
                "avatar_x": jogo["jogador_x"].get("avatar"),
                "avatar_o": jogo["jogador_o"].get("avatar"),
                "quem_comeca": jogo["jogador_atual"],
            })
            await websocket.send_json(estado_para_cliente(jogo, my_piece))
        else:
            primeiro = reiniciar_jogo(jogo)
            await transmitir_sala(sala, {
                "tipo": "inicio",
                "jogador_x": jogo["jogador_x"]["nick"],
                "jogador_o": jogo["jogador_o"]["nick"],
                "avatar_x": jogo["jogador_x"].get("avatar"),
                "avatar_o": jogo["jogador_o"].get("avatar"),
                "quem_comeca": primeiro,
            })
            await transmitir_sala(sala, estado_para_cliente(jogo, "X"), {id(websocket)})
            await websocket.send_json(estado_para_cliente(jogo, my_piece))
    else:
        await websocket.send_json({
            "tipo": "esperando",
            "mensagem": "Aguardando oponente...",
            "minha_peca": my_piece,
        })

    _saiu_explicitamente = False
    try:
        while True:
            dados = await websocket.receive_json()
            tipo = dados.get("tipo")

            if tipo == "ping":
                continue

            if tipo == "jogar" and jogo["jogo_ativo"]:
                if jogo["jogador_atual"] != my_piece:
                    await websocket.send_json({"tipo": "erro", "mensagem": "Não é sua vez."})
                    continue

                posicao = dados.get("posicao", -1)
                if posicao not in range(9):
                    await websocket.send_json({"tipo": "erro", "mensagem": "Posição inválida."})
                    continue
                if jogo["tabuleiro"][posicao] != "":
                    await websocket.send_json({"tipo": "erro", "mensagem": "Posição já ocupada."})
                    continue

                jogo["tabuleiro"][posicao] = my_piece

                vencedor = verificar_vencedor(jogo["tabuleiro"])
                if vencedor:
                    jogo["jogo_ativo"] = False
                    jogo["resultado"] = vencedor
                    jogo.setdefault("placar", {"X": 0, "O": 0})
                    jogo["placar"][vencedor] = jogo["placar"].get(vencedor, 0) + 1
                elif not espacos_vazios(jogo["tabuleiro"]):
                    jogo["jogo_ativo"] = False
                    jogo["resultado"] = "empate"
                else:
                    jogo["jogador_atual"] = "O" if my_piece == "X" else "X"

                await transmitir_sala(sala, estado_para_cliente(jogo, "X"))
                if jogo["jogador_o"]:
                    await transmitir_sala(sala, estado_para_cliente(jogo, "O"), {id(websocket)})

            elif tipo == "sair":
                _saiu_explicitamente = True
                # Saiu: quem ficou vence por desistência e a sala desfaz.
                outro = "O" if my_piece == "X" else "X"
                if jogo.get(f"jogador_{outro.lower()}"):
                    await _vitoria_por_desistencia(sala, jogo, my_piece, nick)
                    break
                # Ninguém mais: só limpa e sai.
                if my_piece == "X":
                    jogo["jogador_x"] = None
                else:
                    jogo["jogador_o"] = None
                await transmitir_sala(sala, {"tipo": "oponente_desconectou", "nick": nick})
                limpar_sala(sala)
                await transmitir_salas_lobby()
                break

    except (WebSocketDisconnect, Exception):
        pass
    finally:
        if sala in conexoes_ws and websocket in conexoes_ws.get(sala, []):
            conexoes_ws[sala].remove(websocket)

            if not eh_espectador and not _saiu_explicitamente:
                key = f"{sala}:{my_piece}"
                old = _reconnect_timers.pop(key, None)
                if old:
                    old.cancel()
                task = asyncio.create_task(
                    _delayed_disconnect(sala, my_piece, jogo, nick)
                )
                _reconnect_timers[key] = task


# ---------------------------------------------------------------------------
# Compartilhar Tela — salas (sinalização WebRTC)
# ---------------------------------------------------------------------------

RESOLUCOES_VALIDAS = {"480p", "720p", "1080p"}
FPS_VALIDOS = {30, 60}
MAX_ESPECTADORES_TELA = 9
SALA_TELA_SEM_HOST_SEGUNDOS = 90


def log_tela(mensagem: str) -> None:
    print("[tela] " + mensagem, flush=True)


def info_transmissao(sala: str, transmissao: dict) -> dict:
    info = {
        "sala": sala,
        "nick": transmissao["host_nick"],
        "avatar": transmissao.get("host_avatar"),
        "publica": bool(transmissao.get("publica")),
        "resolucao": transmissao["resolucao"],
        "fps": transmissao["fps"],
        "espectadores": len(transmissao["viewers"]),
        "host_conectado": transmissao.get("host_ws") is not None,
    }
    if transmissao.get("relay_codec"):
        info["codec"] = transmissao["relay_codec"]
    if transmissao.get("multi"):
        info["multi"] = transmissao["multi"]
    return info


def _codigo_multi_valido(codigo: str) -> bool:
    return bool(re.fullmatch(r"[a-z0-9_-]{3,16}", codigo or ""))


def lives_da_multi(codigo_multi: str) -> list:
    return [
        info_transmissao(sala, t)
        for sala, t in salas_tela.items()
        if t.get("multi") == codigo_multi and t.get("host_ws") is not None
    ]


def info_sala_multi(codigo: str, s: dict) -> dict:
    membros = [
        {
            "id": mid,
            "nick": m.get("nick") or "Anônimo",
            "avatar": m.get("avatar"),
            "logado": bool(m.get("logado")),
            "conectado": m.get("ws") is not None,
        }
        for mid, m in s.get("membros", {}).items()
    ]
    lives = lives_da_multi(codigo)
    return {
        "tipo": "multi_estado",
        "sala": codigo,
        "nome": s.get("nome") or ("Sala de " + (s.get("dono_nick") or "Anônimo")),
        "dono_nick": s.get("dono_nick") or "Anônimo",
        "dono_avatar": s.get("dono_avatar"),
        "publica": bool(s.get("publica")),
        "membros": membros,
        "total_membros": len(membros),
        "lives": lives,
        "total_lives": len(lives),
        "max_lives": MAX_LIVES_MULTI,
    }


async def notificar_multi(codigo: str) -> None:
    s = salas_multi.get(codigo)
    if not s:
        return
    payload = info_sala_multi(codigo, s)
    for m in list(s.get("membros", {}).values()):
        ws = m.get("ws")
        if ws:
            try:
                await ws.send_json(payload)
            except Exception:
                pass


async def destruir_multi(codigo: str, motivo: str) -> None:
    """Sala multi só morre sem membros — derruba as lives filhas junto."""
    s = salas_multi.pop(codigo, None)
    if not s:
        return
    log_tela("multi destruida sala=%s motivo=%s" % (codigo, motivo))
    for sala_tela, t in list(salas_tela.items()):
        if t.get("multi") == codigo:
            await _encerrar_transmissao(sala_tela, t, "sala_multi_encerrada")
    for m in list(s.get("membros", {}).values()):
        ws = m.get("ws")
        if ws:
            try:
                await ws.send_json({"tipo": "multi_encerrada", "motivo": motivo})
                await ws.close()
            except Exception:
                pass
    for ws in list(conexoes_lobby):
        try:
            await ws.send_json({"tipo": "multi_removida", "sala": codigo})
        except Exception:
            pass


async def listar_salas_multi_publicas() -> list:
    lista = []
    for codigo, s in salas_multi.items():
        if not s.get("publica"):
            continue
        conectados = sum(1 for m in s.get("membros", {}).values() if m.get("ws"))
        if conectados <= 0:
            continue
        lista.append({
            "sala": codigo,
            "nome": s.get("nome") or ("Sala de " + (s.get("dono_nick") or "Anônimo")),
            "dono_nick": s.get("dono_nick") or "Anônimo",
            "dono_avatar": s.get("dono_avatar"),
            "total_membros": conectados,
            "total_lives": len(lives_da_multi(codigo)),
            "max_lives": MAX_LIVES_MULTI,
        })
    return lista


async def notificar_lobbies_multi() -> None:
    msg = {"tipo": "salas_multi", "salas": await listar_salas_multi_publicas()}
    for ws in list(conexoes_lobby):
        try:
            await ws.send_json(msg)
        except Exception:
            pass


def lista_viewers_info(transmissao: dict) -> list:
    return list(transmissao.get("viewers_info", {}).values())


async def _notificar_viewers_lista(transmissao: dict):
    """Host vê quem está assistindo (nick/avatar, Discord ou Anônimo)."""
    host = transmissao.get("host_ws")
    if not host:
        return
    try:
        await host.send_json({
            "tipo": "viewers_lista",
            "total": len(transmissao["viewers"]),
            "viewers": lista_viewers_info(transmissao),
        })
    except Exception:
        pass
    if transmissao.get("multi"):
        await notificar_multi(transmissao["multi"])


def purgar_transmissoes_obsoletas() -> None:
    """Remove salas criadas mas sem host conectado (ex.: POST ok e WS falhou)."""
    agora = time.time()
    for sala, t in list(salas_tela.items()):
        if t["host_ws"] is None and agora - t.get("criado_em", agora) > SALA_TELA_SEM_HOST_SEGUNDOS:
            salas_tela.pop(sala, None)
            log_tela("sala obsoleta removida sala=" + sala)


@app.post("/tela/novo")
async def criar_transmissao(dados: NovaTransmissao):
    resolucao = dados.resolucao.lower()
    multi = (dados.multi or "").strip().lower() or None
    if multi:
        if multi not in salas_multi:
            raise HTTPException(status_code=404, detail="Sala multi-tela não encontrada.")
        # Qualidade fixa na multi-tela: 720p30, não alterável.
        resolucao = "720p"
        dados.fps = 30
        dados.publica = False
        atuais = [1 for t in salas_tela.values() if t.get("multi") == multi]
        if len(atuais) >= MAX_LIVES_MULTI:
            raise HTTPException(
                status_code=409,
                detail="Sala multi-tela cheia (máximo de %d telas)." % MAX_LIVES_MULTI)
    if resolucao not in RESOLUCOES_VALIDAS:
        raise HTTPException(status_code=400, detail="Resolução inválida.")
    if dados.fps not in FPS_VALIDOS:
        raise HTTPException(status_code=400, detail="FPS inválido.")

    sala = (dados.codigo or "").strip().lower()
    if sala:
        if not re.fullmatch(r"[a-z0-9_-]{3,16}", sala):
            raise HTTPException(
                status_code=400,
                detail="Código da sala: use de 3 a 16 caracteres (letras, números, - ou _).")
        if sala in salas_tela:
            raise HTTPException(status_code=409, detail="Este código já está em uso. Escolha outro.")
    else:
        sala = secrets.token_urlsafe(6)

    salas_tela[sala] = {
        "host_ws": None,
        "host_nick": dados.nick,
        "host_avatar": dados.avatar or None,
        "publica": bool(dados.publica),
        "instancia": (dados.instancia or "").strip()[:64] or None,
        "resolucao": resolucao,
        "fps": dados.fps,
        "viewers": {},
        "viewers_info": {},
        "relay_ws": {},  # espectadores da Activity (vídeo via WS binário)
        "criado_em": time.time(),
        "multi": multi,
    }
    log_tela("sala criada sala=%s res=%s fps=%s publica=%s multi=%s instancia=%s" % (
        sala, resolucao, dados.fps, dados.publica, multi or "-",
        salas_tela[sala]["instancia"] or "-"))
    if multi:
        await notificar_multi(multi)
    return {"sala": sala, "resolucao": resolucao, "fps": dados.fps, "multi": multi}


@app.get("/tela/transmissoes")
def listar_transmissoes(instancia: str = ""):
    """Lista transmissões públicas + as da instância da call (se houver)."""
    purgar_transmissoes_obsoletas()
    instancia = instancia.strip()[:64] or None
    return {
        "transmissoes": [
            info_transmissao(sala, t)
            for sala, t in salas_tela.items()
            if t["host_ws"] is not None
            and not t.get("multi")
            and (t.get("publica") or (instancia and t["instancia"] == instancia))
        ]
    }


@app.get("/tela/sala/{sala}")
def obter_transmissao(sala: str):
    purgar_transmissoes_obsoletas()
    transmissao = salas_tela.get(sala)
    if not transmissao:
        raise HTTPException(status_code=404, detail="Transmissão não encontrada.")
    return info_transmissao(sala, transmissao)


async def _encerrar_transmissao(sala: str, transmissao: dict, motivo: str):
    """Host saiu/perdeu conexão: encerra a sala e derruba todos os espectadores."""
    log_tela("encerrando sala=%s motivo=%s espectadores=%d" % (
        sala, motivo, len(transmissao["viewers"])))
    for ws in list(transmissao["viewers"].values()):
        try:
            await ws.send_json({"tipo": "transmissao_encerrada", "motivo": motivo})
            await ws.close()
        except Exception:
            pass
    salas_tela.pop(sala, None)
    codigo_multi = transmissao.get("multi")
    if codigo_multi and codigo_multi in salas_multi:
        await notificar_multi(codigo_multi)


async def _notificar_total(transmissao: dict):
    await _notificar_viewers_lista(transmissao)


async def _notificar_relay_total(transmissao: dict):
    host = transmissao.get("host_ws")
    total = len(transmissao.get("relay_ws", {}))
    if host:
        try:
            await host.send_json({"tipo": "relay_total", "total": total})
        except Exception:
            pass
    # Se em 12s não chegar nenhum quadro com viewer na Activity, o host está
    # rodando JS antigo (aba cacheada) — avisa o viewer com a ação concreta.
    if (total > 0 and host and not transmissao.get("_relay_bytes_log")
            and not transmissao.get("_relay_aviso_agendado")):
        transmissao["_relay_aviso_agendado"] = True
        asyncio.ensure_future(_avisar_relay_sem_quadros(transmissao))


async def _avisar_relay_sem_quadros(transmissao: dict):
    await asyncio.sleep(12)
    if transmissao.get("_relay_bytes_log") or not transmissao.get("relay_ws"):
        return
    log_tela("relay sem quadros apos 12s sala=%s" %
             next((s for s, t in salas_tela.items() if t is transmissao), "?"))
    for ws in list(transmissao.get("relay_ws", {}).values()):
        try:
            await ws.send_json({
                "tipo": "relay_erro",
                "mensagem": "Quem transmite não enviou vídeo em 12s. Peça para ele "
                            "Ctrl+F5 na aba de transmissão e transmitir de novo.",
            })
        except Exception:
            pass


async def _ws_tela_host(websocket: WebSocket, sala: str, transmissao: dict, nick: str):
    antigo = transmissao.get("host_ws")
    # Substitui ANTES de fechar o antigo: o finally do antigo só encerra a
    # sala se ele ainda for o host_ws registrado (senão mataria a sala nova).
    transmissao["host_ws"] = websocket
    transmissao["host_nick"] = nick
    if antigo is not None and antigo is not websocket:
        # Reconexão do host (ex.: aba recarregada): sem encerrar a sala.
        log_tela("host reconectado, substituindo conexao antiga sala=" + sala)
        try:
            await antigo.close()
        except Exception:
            pass

    log_tela("host conectado sala=%s nick=%s" % (sala, nick))
    if transmissao.get("multi"):
        await notificar_multi(transmissao["multi"])
    # Espectadores WebRTC já na sala precisam de oferta do (novo) host.
    relay_ws_map = transmissao.setdefault("relay_ws", {})
    for viewer_id, ws in list(transmissao["viewers"].items()):
        if relay_ws_map.get(viewer_id) is ws:
            continue  # quem assiste na Activity usa relay (sem WebRTC)
        try:
            await websocket.send_json({"tipo": "viewer_entrou", "viewer_id": viewer_id})
        except Exception:
            pass
    await websocket.send_json({"tipo": "host_pronto", "sala": sala})
    await _notificar_viewers_lista(transmissao)
    # Relay (Activity): avisa os espectadores e o host (inicia o encoder).
    for ws in list(relay_ws_map.values()):
        try:
            await ws.send_json({"tipo": "host_conectado"})
        except Exception:
            pass
    await _notificar_total(transmissao)
    await _notificar_relay_total(transmissao)

    try:
        while True:
            msg = await websocket.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                # Quadro de vídeo VP8 do relay → fã-out para quem assiste na Activity.
                if not transmissao.get("_relay_bytes_log"):
                    transmissao["_relay_bytes_log"] = True
                    log_tela("primeiro quadro binario do relay sala=%s" % sala)
                for ws in list(transmissao.get("relay_ws", {}).values()):
                    try:
                        await ws.send_bytes(msg["bytes"])
                    except Exception:
                        pass
                continue
            text = msg.get("text")
            if not text:
                continue
            try:
                dados = json.loads(text)
            except Exception:
                continue
            tipo = dados.get("tipo")
            viewer_id = str(dados.get("viewer_id", ""))
            viewer_ws = transmissao["viewers"].get(viewer_id)

            if tipo == "ping":
                continue
            if tipo == "relay_codec":
                # Host escolheu o codec (H.264/VP8) — viewers precisam saber.
                codec = str(dados.get("codec") or "vp8")
                transmissao["relay_codec"] = codec
                log_tela("relay_codec sala=%s codec=%s" % (sala, codec))
                for ws in list(transmissao.get("relay_ws", {}).values()):
                    try:
                        await ws.send_json({"tipo": "relay_codec", "codec": codec})
                    except Exception:
                        pass
                continue
            if tipo in {"relay_pronto", "relay_erro"}:
                # Host confirma que o encoder de relay ligou (ou falhou).
                log_tela("%s sala=%s %s" % (tipo, sala, dados.get("mensagem", "")))
                payload = {"tipo": tipo, "mensagem": dados.get("mensagem")}
                if dados.get("codec"):
                    payload["codec"] = dados["codec"]
                    transmissao["relay_codec"] = str(dados["codec"])
                for ws in list(transmissao.get("relay_ws", {}).values()):
                    try:
                        await ws.send_json(payload)
                    except Exception:
                        pass
                continue
            if tipo == "quadro":
                # Vídeo VP8 em JSON base64 — o proxy do Discord não repassa
                # frame binário no WS da Activity. Mensagens grandes podem cair:
                # fan-out é feito por parte (host já fragmenta em n/i).
                if not transmissao.get("_relay_bytes_log"):
                    transmissao["_relay_bytes_log"] = True
                    log_tela("primeiro quadro json do relay sala=%s tam=%d" % (sala, len(text)))
                enviados = 0
                for ws in list(transmissao.get("relay_ws", {}).values()):
                    try:
                        await ws.send_text(text)
                        enviados += 1
                    except Exception as e:
                        log_tela("falha ao enviar quadro sala=%s tam=%d err=%s" % (
                            sala, len(text), str(e)[:120]))
                if enviados and not transmissao.get("_relay_send_log"):
                    transmissao["_relay_send_log"] = True
                    log_tela("quadro encaminhado ao viewer sala=%s n=%d" % (sala, enviados))
                continue
            if tipo == "audio":
                # Áudio Opus do relay em JSON base64 — mesmo caminho do vídeo.
                if not transmissao.get("_relay_audio_log"):
                    transmissao["_relay_audio_log"] = True
                    log_tela("primeiro audio json do relay sala=%s" % sala)
                for ws in list(transmissao.get("relay_ws", {}).values()):
                    try:
                        await ws.send_text(text)
                    except Exception:
                        pass
                continue
            if tipo == "quadro_rx":
                # Viewer da Activity confirmou que o quadro chegou no JS.
                log_tela("viewer recebeu quadro sala=%s" % sala)
                continue
            if tipo == "relay_diag":
                # Diagnóstico do decoder/canvas na Activity (etapa → Render log).
                log_tela("relay_diag sala=%s etapa=%s%s%s%s" % (
                    sala,
                    dados.get("etapa", "?"),
                    (" q=%s" % dados["quadros"]) if dados.get("quadros") is not None else "",
                    (" k=%s" % dados["k"]) if dados.get("k") is not None else "",
                    (" %s" % str(dados.get("msg") or dados.get("state") or "")[:160]),
                ))
                continue
            if tipo == "sair":
                break
            if tipo == "config":
                # Host mudou resolução/fps durante a transmissão.
                nova_res = str(dados.get("resolucao", "")).lower()
                novo_fps = dados.get("fps")
                if nova_res in RESOLUCOES_VALIDAS and isinstance(novo_fps, int) and novo_fps in FPS_VALIDOS:
                    transmissao["resolucao"] = nova_res
                    transmissao["fps"] = novo_fps
                    log_tela("config atualizada sala=%s res=%s fps=%s" % (sala, nova_res, novo_fps))
                    # Avisa espectadores (site + Activity) para atualizar o badge.
                    payload_cfg = {"tipo": "config", "resolucao": nova_res, "fps": novo_fps}
                    for ws in list(transmissao.get("viewers", {}).values()):
                        try:
                            await ws.send_json(payload_cfg)
                        except Exception:
                            pass
                    for ws in list(transmissao.get("relay_ws", {}).values()):
                        try:
                            await ws.send_json(payload_cfg)
                        except Exception:
                            pass
                continue
            # Host gerencia a sala: expulsa um espectador (máx. 9 na tela).
            if tipo == "expulsar_viewer" and viewer_id and viewer_ws:
                try:
                    await viewer_ws.send_json({"tipo": "expulso", "mensagem": "Você foi expulso da sala pelo anfitrião."})
                    await viewer_ws.close()
                except Exception:
                    pass
                log_tela("host expulsou viewer sala=%s id=%s" % (sala, viewer_id[:8]))
                continue
            # Relay de oferta/ICE do host para o espectador alvo (só WebRTC).
            if tipo in {"oferta", "ice"} and viewer_ws and viewer_id not in relay_ws_map:
                try:
                    await viewer_ws.send_json({"tipo": tipo, "dados": dados.get("dados")})
                except Exception:
                    pass
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        if transmissao.get("host_ws") is websocket:
            log_tela("host desconectado sala=" + sala)
            codigo_multi = transmissao.get("multi")
            await _encerrar_transmissao(sala, transmissao, "host_saiu")
            # Liga a live ao membro que a abriu (para sair da multi = fechar live).
            if codigo_multi and codigo_multi in salas_multi:
                s = salas_multi[codigo_multi]
                for m in s.get("membros", {}).values():
                    if m.get("nick") == nick and not m.get("live_sala"):
                        m["live_sala"] = sala
                        break
        else:
            log_tela("conexao antiga de host ignorada sala=" + sala)


async def _ws_tela_viewer(websocket: WebSocket, sala: str, transmissao: dict, nick: str,
                          transporte: str, avatar: Optional[str] = None, logado: bool = False):
    if len(transmissao["viewers"]) >= MAX_ESPECTADORES_TELA:
        log_tela("viewer recusado (sala cheia) sala=" + sala)
        await websocket.send_json({"tipo": "erro", "mensagem": "Transmissão cheia (máximo de 9 espectadores)."})
        await websocket.close()
        return

    viewer_id = secrets.token_urlsafe(8)
    eh_relay = transporte == "relay"
    transmissao["viewers"][viewer_id] = websocket
    transmissao.setdefault("viewers_info", {})[viewer_id] = {
        "id": viewer_id,
        "nick": nick or ("Anônimo" if not logado else "—"),
        "avatar": avatar or None,
        "logado": bool(logado),
    }
    if eh_relay:
        transmissao.setdefault("relay_ws", {})[viewer_id] = websocket
    log_tela("viewer conectado sala=%s nick=%s logado=%s transporte=%s total=%d" % (
        sala, nick, logado, transporte, len(transmissao["viewers"])))
    await websocket.send_json(info_transmissao(sala, transmissao) | {"tipo": "entrada_ok"})
    await _notificar_total(transmissao)
    if eh_relay:
        await _notificar_relay_total(transmissao)
        if transmissao.get("relay_codec"):
            try:
                await websocket.send_json({"tipo": "relay_codec", "codec": transmissao["relay_codec"]})
            except Exception:
                pass

    host_ws = transmissao.get("host_ws")
    if host_ws:
        if eh_relay:
            await websocket.send_json({"tipo": "host_conectado"})
        else:
            try:
                await host_ws.send_json({"tipo": "viewer_entrou", "viewer_id": viewer_id, "nick": nick})
            except Exception:
                pass
    else:
        await websocket.send_json({"tipo": "aguardando_host"})

    relay_ws_map = transmissao.setdefault("relay_ws", {})
    try:
        while True:
            msg = await websocket.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                continue  # espectador não envia binário
            text = msg.get("text")
            if not text:
                continue
            try:
                dados = json.loads(text)
            except Exception:
                continue
            tipo = dados.get("tipo")

            if tipo == "ping":
                continue
            if tipo == "quadro_rx":
                log_tela("viewer recebeu quadro sala=%s" % sala)
                continue
            if tipo == "relay_diag":
                log_tela("relay_diag sala=%s etapa=%s%s%s" % (
                    sala,
                    dados.get("etapa", "?"),
                    (" q=%s" % dados["quadros"]) if dados.get("quadros") is not None else "",
                    (" %s" % str(dados.get("msg") or dados.get("state") or "")[:160]),
                ))
                continue
            if tipo == "sair":
                break
            # Host expulsa um espectador (gerencia a sala: máx. 9 na tela).
            if tipo == "expulsar_viewer":
                continue  # só o host envia — tratado no loop do host
            # Relay de resposta/ICE do espectador WebRTC para o host.
            if tipo in {"resposta", "ice"} and not eh_relay:
                host_ws = transmissao.get("host_ws")
                if host_ws:
                    try:
                        await host_ws.send_json({
                            "tipo": tipo,
                            "viewer_id": viewer_id,
                            "dados": dados.get("dados"),
                        })
                    except Exception:
                        pass
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        if transmissao["viewers"].get(viewer_id) is websocket:
            del transmissao["viewers"][viewer_id]
            transmissao.get("viewers_info", {}).pop(viewer_id, None)
            if relay_ws_map.get(viewer_id) is websocket:
                del relay_ws_map[viewer_id]
            log_tela("viewer desconectado sala=%s nick=%s total=%d" % (
                sala, nick, len(transmissao["viewers"])))
            await _notificar_total(transmissao)
            if eh_relay:
                await _notificar_relay_total(transmissao)
            host_ws = transmissao.get("host_ws")
            if host_ws and not eh_relay:
                try:
                    await host_ws.send_json({"tipo": "viewer_saiu", "viewer_id": viewer_id, "nick": nick})
                except Exception:
                    pass


@app.websocket("/ws/tela/{sala}")
@app.websocket("/tela/{sala}")
async def ws_tela(websocket: WebSocket, sala: str):
    await websocket.accept()
    papel = websocket.query_params.get("papel", "viewer")
    nick = websocket.query_params.get("nick", "Anônimo")
    transporte = websocket.query_params.get("transporte", "webrtc")
    avatar = websocket.query_params.get("avatar") or None
    logado = websocket.query_params.get("logado", "") in ("1", "true", "True")

    transmissao = salas_tela.get(sala)
    if not transmissao:
        log_tela("ws recusado, sala inexistente sala=" + sala)
        await websocket.send_json({"tipo": "erro", "mensagem": "Transmissão não encontrada."})
        await websocket.close()
        return

    if papel == "host":
        await _ws_tela_host(websocket, sala, transmissao, nick)
    else:
        await _ws_tela_viewer(websocket, sala, transmissao, nick, transporte, avatar, logado)


# ---------------------------------------------------------------------------
# Sala multi-tela (até 8 lives 720p30; vive enquanto houver membros)
# ---------------------------------------------------------------------------

@app.post("/multitela/novo")
async def criar_sala_multi(dados: NovaSalaMulti):
    codigo = (dados.codigo or "").strip().lower()
    if codigo:
        if not _codigo_multi_valido(codigo):
            raise HTTPException(
                status_code=400,
                detail="Código da sala: use de 3 a 16 caracteres (letras, números, - ou _).")
        if codigo in salas_multi:
            raise HTTPException(status_code=409, detail="Este código já está em uso. Escolha outro.")
    else:
        while True:
            codigo = secrets.token_urlsafe(6).lower().replace("-", "").replace("_", "")[:10]
            if len(codigo) >= 3 and codigo not in salas_multi:
                break

    nick = (dados.nick or "Anônimo").strip() or "Anônimo"
    dono_id = secrets.token_urlsafe(8)
    salas_multi[codigo] = {
        "codigo": codigo,
        "nome": "Sala de " + nick,
        "dono_nick": nick,
        "dono_avatar": dados.avatar or None,
        "publica": bool(dados.publica),
        "criado_em": time.time(),
        "dono_id": dono_id,
        "membros": {},  # mid -> {nick, avatar, logado, ws}
    }
    log_tela("multi criada sala=%s dono=%s publica=%s" % (codigo, nick, dados.publica))
    await notificar_lobbies_multi()
    return {"sala": codigo, "nome": salas_multi[codigo]["nome"], "dono_id": dono_id}


@app.get("/multitela/salas")
async def listar_salas_multi():
    return {"salas": await listar_salas_multi_publicas()}


@app.get("/multitela/sala/{codigo}")
async def obter_sala_multi(codigo: str):
    codigo = (codigo or "").strip().lower()
    s = salas_multi.get(codigo)
    if not s:
        raise HTTPException(status_code=404, detail="Sala multi-tela não encontrada.")
    return info_sala_multi(codigo, s)


@app.websocket("/ws/multitela/{codigo}")
@app.websocket("/multitela/{codigo}")
async def ws_multitela(websocket: WebSocket, codigo: str):
    await websocket.accept()
    codigo = (codigo or "").strip().lower()
    nick = websocket.query_params.get("nick", "Anônimo") or "Anônimo"
    avatar = websocket.query_params.get("avatar") or None
    logado = websocket.query_params.get("logado", "") in ("1", "true", "True")

    s = salas_multi.get(codigo)
    if not s:
        await websocket.send_json({"tipo": "erro", "mensagem": "Sala multi-tela não encontrada."})
        await websocket.close()
        return

    if len(s.get("membros", {})) >= MAX_LIVES_MULTI:
        # Teto de pessoas/telas da sala multi.
        if not any(m.get("ws") is None for m in s.get("membros", {}).values()):
            await websocket.send_json({
                "tipo": "erro",
                "mensagem": "Sala multi-tela cheia (máximo de %d pessoas)." % MAX_LIVES_MULTI,
            })
            await websocket.close()
            return

    mid = secrets.token_urlsafe(8)
    s.setdefault("membros", {})[mid] = {
        "id": mid,
        "nick": nick,
        "avatar": avatar,
        "logado": bool(logado),
        "ws": websocket,
        "live_sala": None,
        "entrou_em": time.time(),
    }
    log_tela("multi membro entrou sala=%s nick=%s total=%d" % (
        codigo, nick, len(s["membros"])))
    await notificar_multi(codigo)
    await notificar_lobbies_multi()

    try:
        while True:
            msg = await websocket.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            text = msg.get("text")
            if not text or text == "ping":
                continue
            try:
                dados = json.loads(text)
            except Exception:
                continue
            tipo = dados.get("tipo")
            if tipo == "ping":
                continue
            if tipo == "atualizar":
                await notificar_multi(codigo)
            # sair explícito cai no finally
            if tipo == "sair":
                break
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        membro = s.get("membros", {}).get(mid)
        if membro and membro.get("ws") is websocket:
            del s["membros"][mid]
            # Se a live desse membro existir, derruba só ela.
            live = membro.get("live_sala")
            if live and live in salas_tela and salas_tela[live].get("multi") == codigo:
                await _encerrar_transmissao(live, salas_tela[live], "membro_saiu")
            log_tela("multi membro saiu sala=%s nick=%s restantes=%d" % (
                codigo, nick, len(s["membros"])))
            if not s["membros"]:
                await destruir_multi(codigo, "sem_membros")
            else:
                await notificar_multi(codigo)
                await notificar_lobbies_multi()


# ---------------------------------------------------------------------------
# WebSocket — Sudoku online
# ---------------------------------------------------------------------------

async def _iniciar_contagem_sudoku(sala: str):
    s = salas_sudoku.get(sala)
    if not s or s.get("fase") not in ("esperando", "contagem"):
        return
    s["fase"] = "contagem"
    for n in (3, 2, 1, 0):
        s = salas_sudoku.get(sala)
        if not s or s.get("fase") != "contagem":
            return
        await broadcast_sudoku(sala, {"tipo": "contagem", "n": n})
        if n > 0:
            await asyncio.sleep(1)
    s = salas_sudoku.get(sala)
    if not s or s.get("fase") != "contagem":
        return
    s["fase"] = "jogando"
    s["vencedor_rodada"] = None
    s["tempos_rodada"] = {}
    s["revanche_de"] = None
    for p in s.get("slots", {}).values():
        if p:
            p["completou"] = False
            p["tempo_fim"] = None
    for slot in ("p1", "p2"):
        p = s.get("slots", {}).get(slot)
        if not p:
            continue
        try:
            if p.get("ws"):
                await p["ws"].send_json({
                    "tipo": "inicio_sudoku",
                    "jogo_id": s["jogo_id"],
                    "grade": s["grade"],
                    "dificuldade": s["dificuldade"],
                    "meu_slot": slot,
                })
        except Exception:
            pass


# Activity do Discord às vezes corta o prefixo /ws no WS — alias igual à velha/lobby.
@app.websocket("/ws/sudoku/{sala}")
@app.websocket("/sudoku/{sala}")
async def ws_sudoku(websocket: WebSocket, sala: str):
    await websocket.accept()
    query = websocket.query_params
    nome = query.get("nome", "Anônimo")
    nick = query.get("nick", "Anônimo")
    avatar = query.get("avatar") or None

    s = salas_sudoku.get(sala)
    if not s:
        await websocket.send_json({"tipo": "erro", "mensagem": "Sala não encontrada."})
        await websocket.close()
        return

    slot = None
    # Reconexão: mesmo nick em slot sem WS vivo.
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
                    "completou": False, "tempo_fim": None,
                }
        else:
            slot = "p2"
            if p2 is None:
                s["slots"]["p2"] = {
                    "ws": None, "nome": nome, "nick": nick, "avatar": avatar,
                    "completou": False, "tempo_fim": None,
                }

    if s["slots"][slot]:
        s["slots"][slot].update({
            "nome": nome, "nick": nick, "avatar": avatar,
        })

    s["slots"][slot]["ws"] = websocket

    await websocket.send_json(estado_sudoku_para(s, slot))
    await _notificar_salas_sudoku_lobby()

    iniciou_contagem = False
    if (s.get("fase") == "esperando"
            and s["slots"]["p1"] and s["slots"]["p1"].get("ws")
            and s["slots"]["p2"] and s["slots"]["p2"].get("ws")):
        s["countdown_task"] = asyncio.create_task(_iniciar_contagem_sudoku(sala))
        iniciou_contagem = True

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                dados = json.loads(raw)
            except Exception:
                continue
            tipo = dados.get("tipo")
            s = salas_sudoku.get(sala)
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

            if tipo == "concluiu":
                if s.get("fase") not in ("jogando", "parcial"):
                    continue
                p = s["slots"].get(slot)
                if not p or p.get("completou"):
                    continue
                p["completou"] = True
                p["tempo_fim"] = int(dados.get("tempo") or 0)
                s.setdefault("tempos_rodada", {})[slot] = p["tempo_fim"]
                if not s.get("vencedor_rodada"):
                    s["vencedor_rodada"] = slot
                    s["placar"][slot] = s["placar"].get(slot, 0) + 1
                    s["fase"] = "parcial"
                    await broadcast_sudoku(sala, {
                        "tipo": "vencedor_rodada",
                        "slot": slot,
                        "nick": p["nick"],
                        "tempo": p["tempo_fim"],
                        "placar": s["placar"],
                        "jogadores": [info_jogador_sudoku(s, "p1"), info_jogador_sudoku(s, "p2")],
                        "todos": bool((s["slots"]["p1"] or {}).get("completou", False)
                                      and (s["slots"]["p2"] or {}).get("completou", False)),
                    })
                ambos = bool((s["slots"]["p1"] or {}).get("completou", False)
                             and (s["slots"]["p2"] or {}).get("completou", False))
                if ambos:
                    await broadcast_sudoku(sala, {
                        "tipo": "ambos_acabaram",
                        "tempos": s["tempos_rodada"],
                        "placar": s["placar"],
                        "jogadores": [info_jogador_sudoku(s, "p1"), info_jogador_sudoku(s, "p2")],
                    })
                    # Sem revanche pendente → encerra.
                    if not s.get("revanche_de"):
                        await encerrar_sala_sudoku(sala, "ambos_acabaram")
                        break
                else:
                    await websocket.send_json(estado_sudoku_para(s, slot))
                continue

            if tipo == "pedir_revanche":
                s["revanche_de"] = slot
                outro = "p2" if slot == "p1" else "p1"
                p_outro = s["slots"].get(outro) or {}
                await broadcast_sudoku(sala, {
                    "tipo": "revanche_pedida",
                    "por": s["slots"][slot]["nick"],
                    "por_slot": slot,
                    "para": p_outro.get("nick"),
                    "placar": s["placar"],
                    "jogadores": [info_jogador_sudoku(s, "p1"), info_jogador_sudoku(s, "p2")],
                })
                continue

            if tipo == "responder_revanche":
                aceitar = bool(dados.get("aceitar"))
                if aceitar and s.get("revanche_de"):
                    s["fase"] = "esperando"
                    s["revanche_de"] = None
                    for p in s.get("slots", {}).values():
                        if p:
                            p["completou"] = False
                            p["tempo_fim"] = None
                    # novo puzzle para a próxima rodada
                    sol = criar_solucao()
                    puzzle = criar_puzzle(sol, s["dificuldade"])
                    jid = secrets.token_urlsafe(12)
                    jogos[jid] = {"solucao": sol, "puzzle": puzzle, "dificuldade": s["dificuldade"]}
                    s["jogo_id"] = jid
                    s["grade"] = puzzle
                    await broadcast_sudoku(sala, {"tipo": "revanche_aceita"})
                    s["countdown_task"] = asyncio.create_task(_iniciar_contagem_sudoku(sala))
                else:
                    await broadcast_sudoku(sala, {"tipo": "revanche_recusada"})
                    await encerrar_sala_sudoku(sala, "revanche_recusada")
                    break
                continue

            if tipo == "parar":
                await encerrar_sala_sudoku(sala, "parou")
                break

            if tipo == "sair":
                # Saiu: se tem oponente na rodada, quem ficou vence e sala desfaz.
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
                            "jogadores": [info_jogador_sudoku(s, "p1"), info_jogador_sudoku(s, "p2")],
                            "mensagem": "Oponente saiu. Você venceu!",
                        })
                    except Exception:
                        pass
                    await asyncio.sleep(2)
                    await encerrar_sala_sudoku(sala, "oponente_desistiu")
                    break
                if s.get("lider") == slot:
                    await encerrar_sala_sudoku(sala, "lider_saiu")
                    break
                s["slots"][slot] = None
                await broadcast_sudoku(sala, estado_sudoku_para(s, slot))
                if s.get("fase") not in ("jogando", "contagem"):
                    await encerrar_sala_sudoku(sala, "saiu_antes_de_jogar")
                    break
                continue

    except (WebSocketDisconnect, Exception):
        pass
    finally:
        s = salas_sudoku.get(sala)
        if s and s.get("slots", {}).get(slot, {}) is not None and \
                s["slots"][slot] and s["slots"][slot].get("ws") is websocket:
            s["slots"][slot]["ws"] = None
            outro = "p2" if slot == "p1" else "p1"
            p_outro = s.get("slots", {}).get(outro)
            # Rodada em andamento e ainda tem alguém: quem ficou vence, sala desfaz.
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
                        "jogadores": [info_jogador_sudoku(s, "p1"), info_jogador_sudoku(s, "p2")],
                        "mensagem": "Oponente saiu. Você venceu!",
                    })
                except Exception:
                    pass
                await asyncio.sleep(2)
                await encerrar_sala_sudoku(sala, "oponente_desistiu")
            elif s.get("lider") == slot:
                # Líder desconectou sem oponente ativo → encerra.
                if s.get("fase") == "jogando" and p_outro and p_outro.get("ws"):
                    # Oponente ficou sozinho jogando: vitória dele.
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
                            "jogadores": [info_jogador_sudoku(s, "p1"), info_jogador_sudoku(s, "p2")],
                            "mensagem": "O líder saiu. Você venceu!",
                        })
                    except Exception:
                        pass
                    await asyncio.sleep(2)
                    await encerrar_sala_sudoku(sala, "lider_desconectou")
                else:
                    await encerrar_sala_sudoku(sala, "lider_desconectou")
            else:
                await broadcast_sudoku(sala, estado_sudoku_para(s, slot))
                if s.get("fase") == "jogando":
                    await encerrar_sala_sudoku(sala, "oponente_desconectou")
                elif s.get("fase") == "esperando":
                    pass
                await _notificar_salas_sudoku_lobby()


# ---------------------------------------------------------------------------
# WebSocket — Campo Minado online (1x1 corrida)
# ---------------------------------------------------------------------------

@app.websocket("/ws/campo/{sala}")
@app.websocket("/campo/{sala}")
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
# Static files (por último, mas só HTTP GET — NÃO captura WebSocket)
# ---------------------------------------------------------------------------

from starlette.responses import FileResponse

@app.get("/{caminho:path}")
@app.get("/")
async def servir_estatico(caminho: str = ""):
    arquivo = PASTA_STATIC / caminho
    if caminho and arquivo.is_file():
        return FileResponse(arquivo)
    # HTML nunca fica no cache: aba antiga do transmissor sem o encoder novo
    # era a causa de "host conectou mas não chega vídeo" na Activity.
    return FileResponse(PASTA_STATIC / "index.html",
                        headers={"Cache-Control": "no-cache, must-revalidate"})
