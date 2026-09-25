"""Sudoku — solo e 1x1 online (mesmo puzzle, corrida)."""
import asyncio
import json
import re
import secrets
import time
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from shared.economia import (
    MOEDAS_SUDOKU_ONLINE,
    MOEDAS_SUDOKU_SOLO,
    cosmeticos_equipados,
    creditar_moedas,
)
from shared.game_store import jogos
from shared.lobby_state import conexoes_lobby
from shared.logging_util import log_tela
from shared.recordes import carregar_recordes, eh_anonimo, ranking_top, salvar_recordes

router = APIRouter()

# Modelos
# ---------------------------------------------------------------------------

class NovoSudoku(BaseModel):
    dificuldade: str = "facil"


class RespostaSudoku(BaseModel):
    jogo_id: str
    grade: List[List[int]]



class NovoRecord(BaseModel):
    dificuldade: str
    nome: str
    nick: str
    tempo_segundos: int
    avatar: Optional[str] = None
    modo: str = "solo"  # "solo" ou "multiplayer" — evita creditar moeda 2x (a
    # vitória online já credita MOEDAS_SUDOKU_ONLINE direto no WS)




class NovaSalaSudoku(BaseModel):
    codigo: Optional[str] = None
    publica: bool = True
    dificuldade: str = "facil"
    nome: str = "Anônimo"
    nick: str = "Anônimo"
    avatar: Optional[str] = None





# ---------------------------------------------------------------------------
# Estado global
# ---------------------------------------------------------------------------

# Sudoku online: código -> estado da sala (2 jogadores, mesmo puzzle)
salas_sudoku: Dict[str, dict] = {}
SUDOKU_SALA_SEM_WS_SEGUNDOS = 60

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
        "cosmeticos": cosmeticos_equipados(p.get("nome", "")),
    }


def _resumo_sala_sudoku(codigo: str, s: dict) -> dict:
    lider = s.get("slots", {}).get(s.get("lider")) or {}
    return {
        "sala": codigo,
        "dificuldade": s.get("dificuldade", "facil"),
        "lider": lider.get("nick", "—"),
        "lider_avatar": lider.get("avatar"),
        "lider_cosmeticos": cosmeticos_equipados(lider.get("nome", "")),
        "jogadores": sum(1 for p in s.get("slots", {}).values() if p and p.get("ws")),
        "fase": s.get("fase", "esperando"),
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
        lista.append(_resumo_sala_sudoku(codigo, s))
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

# Endpoints — Sudoku
# ---------------------------------------------------------------------------

@router.post("/sudoku/novo")
def novo_sudoku(dados: NovoSudoku):
    dificuldade = dados.dificuldade.lower()
    if dificuldade not in {"facil", "medio", "dificil"}:
        raise HTTPException(status_code=400, detail="Dificuldade inválida.")

    solucao = criar_solucao()
    puzzle = criar_puzzle(solucao, dificuldade)
    jogo_id = secrets.token_urlsafe(12)
    jogos[jogo_id] = {"solucao": solucao, "puzzle": puzzle, "dificuldade": dificuldade}

    return {"jogo_id": jogo_id, "dificuldade": dificuldade, "grade": puzzle}


@router.post("/sudoku/verificar")
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


@router.get("/sudoku/recordes/{dificuldade}")
def obter_recordes(dificuldade: str):
    if dificuldade not in {"facil", "medio", "dificil"}:
        raise HTTPException(status_code=400, detail="Dificuldade inválida.")
    recordes = carregar_recordes()
    top3 = ranking_top(recordes["sudoku"].get(dificuldade, []), "tempo_segundos", reverse=False)
    return {"dificuldade": dificuldade, "recordes": top3}


@router.post("/sudoku/recordes")
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
    if dados.modo != "multiplayer":
        creditar_moedas(dados.nome, MOEDAS_SUDOKU_SOLO[dados.dificuldade])

    top3 = ranking_top(recordes["sudoku"][dados.dificuldade], "tempo_segundos", reverse=False)
    return {"dificuldade": dados.dificuldade, "recordes": top3}


# ---------------------------------------------------------------------------

# Endpoints — Sudoku online (salas público/privado)
# ---------------------------------------------------------------------------

def _codigo_sudoku_valido(codigo: str) -> bool:
    return bool(re.fullmatch(r"[a-z0-9_-]{3,16}", codigo or ""))


@router.get("/sudoku/salas")
async def listar_salas_sudoku():
    purgar_salas_sudoku_obsoletas()
    lista = []
    for codigo, s in salas_sudoku.items():
        if not s.get("publica"):
            continue
        lista.append(_resumo_sala_sudoku(codigo, s))
    return {"salas": lista}


@router.post("/sudoku/sala/novo")
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
@router.websocket("/ws/sudoku/{sala}")
@router.websocket("/sudoku/{sala}")
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
                    dif_sudoku = s.get("dificuldade", "facil")
                    creditar_moedas(p.get("nome", ""), MOEDAS_SUDOKU_ONLINE.get(dif_sudoku, MOEDAS_SUDOKU_ONLINE["facil"]))
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
