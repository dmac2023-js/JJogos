"""Jogo da Velha — vs máquina, multiplayer e espectador."""
import asyncio
import re
import secrets
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from shared.economia import (
    MOEDAS_VELHA_ONLINE,
    MOEDAS_VELHA_SOLO,
    cosmeticos_equipados,
    creditar_moedas,
)
from shared.game_store import jogos
from shared.lobby_state import conexoes_lobby
from shared.recordes import (
    _registrar_vitoria,
    carregar_recordes,
    eh_anonimo,
    ranking_top,
    ranking_vitorias,
    salvar_recordes,
)

router = APIRouter()

class NovoJogoVelha(BaseModel):
    modo: str
    dificuldade: str = "facil"
    nome: str = "Anônimo"
    nick: str = "Anônimo"
    avatar: Optional[str] = None
    codigo: Optional[str] = None
    publica: bool = True


class MoverJogoVelha(BaseModel):
    jogo_id: str
    posicao: int


class NovoRecordVelha(BaseModel):
    dificuldade: str
    nome: str
    nick: str
    avatar: Optional[str] = None
    modo: str = "maquina"  # "maquina" (solo) ou "multiplayer" — define as moedas


salas_velha: Dict[str, str] = {}

conexoes_ws: Dict[str, List[WebSocket]] = {}

_reconnect_timers: Dict[str, asyncio.Task] = {}
RECONNECT_GRACE_SECONDS = 15

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
                          avatar_x: Optional[str] = None,
                          codigo: Optional[str] = None,
                          publica: bool = True) -> dict:
    jogo_id = secrets.token_urlsafe(12)
    sala = None
    if modo == "multiplayer":
        if codigo:
            sala = codigo
        else:
            while True:
                sala = secrets.token_urlsafe(6).lower().replace("-", "").replace("_", "")[:10]
                if sala not in salas_velha:
                    break
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
        "publica": bool(publica) if modo == "multiplayer" else False,
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
        "cosmeticos_x": cosmeticos_equipados((jogo["jogador_x"] or {}).get("nome", "")),
        "cosmeticos_o": cosmeticos_equipados((jogo["jogador_o"] or {}).get("nome", "")),
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
        if not jogo.get("publica", True):
            continue
        jogadores = (1 if jogo["jogador_x"] else 0) + (1 if jogo["jogador_o"] else 0)
        conns = len(conexoes_ws.get(sala, []))
        salas_ativas.append({
            "sala": sala,
            "jogador_x": jogo["jogador_x"]["nick"] if jogo["jogador_x"] else None,
            "jogador_o": jogo["jogador_o"]["nick"] if jogo["jogador_o"] else None,
            "avatar_x": (jogo["jogador_x"] or {}).get("avatar"),
            "cosmeticos_x": cosmeticos_equipados((jogo["jogador_x"] or {}).get("nome", "")),
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

# Endpoints — Jogo da Velha
# ---------------------------------------------------------------------------

@router.post("/velha/novo")
async def novo_jogo_velha(dados: NovoJogoVelha):
    modo = dados.modo.lower()
    if modo not in {"maquina", "multiplayer"}:
        raise HTTPException(status_code=400, detail="Modo inválido.")
    dificuldade = dados.dificuldade.lower()
    if dificuldade not in {"facil", "medio", "dificil"}:
        raise HTTPException(status_code=400, detail="Dificuldade inválida.")

    codigo = (dados.codigo or "").strip().lower() if modo == "multiplayer" else None
    if codigo and not _codigo_velha_valido(codigo):
        raise HTTPException(status_code=400,
                            detail="Código: 3 a 16 caracteres (letras, números, - ou _).")
    if codigo and codigo in salas_velha:
        raise HTTPException(status_code=409, detail="Já existe uma sala com esse código.")

    jogo = criar_novo_jogo_velha(modo, dificuldade, dados.nome, dados.nick, dados.avatar,
                                 codigo=codigo, publica=dados.publica)
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


@router.post("/velha/mover")
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


@router.get("/velha/salas")
def listar_salas():
    salas_ativas = []
    for sala, jogo_id in list(salas_velha.items()):
        jogo = jogos.get(jogo_id)
        if not jogo or jogo["modo"] != "multiplayer":
            continue
        if not jogo.get("publica", True):
            continue
        jogadores = (1 if jogo["jogador_x"] else 0) + (1 if jogo["jogador_o"] else 0)
        conns = len(conexoes_ws.get(sala, []))
        salas_ativas.append({
            "sala": sala,
            "jogador_x": jogo["jogador_x"]["nick"] if jogo["jogador_x"] else None,
            "jogador_o": jogo["jogador_o"]["nick"] if jogo["jogador_o"] else None,
            "avatar_x": (jogo["jogador_x"] or {}).get("avatar"),
            "cosmeticos_x": cosmeticos_equipados((jogo["jogador_x"] or {}).get("nome", "")),
            "jogadores": jogadores,
            "espectadores": max(0, conns - jogadores),
            "em_andamento": jogo["jogo_ativo"] and jogo["jogador_o"] is not None,
        })
    return {"salas": salas_ativas}


@router.get("/velha/recordes/{dificuldade}")
def obter_recordes_velha(dificuldade: str):
    if dificuldade not in {"facil", "medio", "dificil"}:
        raise HTTPException(status_code=400, detail="Dificuldade inválida.")
    recordes = carregar_recordes()
    brutos = recordes["velha"].get(dificuldade, [])[-10:]
    top3 = [r for r in reversed(brutos) if not eh_anonimo(str(r.get("nick", "")))][:3]
    return {"dificuldade": dificuldade, "recordes": top3}


@router.get("/velha/ranking")
def ranking_vitorias_velha(dificuldade: Optional[str] = None):
    recordes = carregar_recordes()
    ranking = ranking_vitorias(recordes.get("velha_vitorias", []),
                               dificuldade=dificuldade, limite=10)
    return {"ranking": ranking, "dificuldade": dificuldade}


# ---------------------------------------------------------------------------

# Endpoints — Jogo da Velha
# ---------------------------------------------------------------------------

def _codigo_velha_valido(codigo: str) -> bool:
    return bool(re.fullmatch(r"[a-z0-9_-]{3,16}", codigo or ""))


@router.post("/velha/recordes")
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
        moedas = MOEDAS_VELHA_ONLINE if dados.modo == "multiplayer" else MOEDAS_VELHA_SOLO
        creditar_moedas(dados.nome, moedas)

    top3 = ranking_top(recordes["velha"].get(dados.dificuldade, [])[-10:],
                       "vitorias", reverse=True, limite=3)
    ranking = ranking_vitorias(recordes.get("velha_vitorias", []),
                               dificuldade=dados.dificuldade, limite=10)
    return {"dificuldade": dados.dificuldade, "recordes": top3, "ranking": ranking}


# ---------------------------------------------------------------------------

# WebSocket — Jogo da Velha (multiplayer + espectadores)
# ---------------------------------------------------------------------------

async def _vitoria_por_desistencia(sala: str, jogo: dict, peca_saiu: str, nick_saiu: str,
                                   excluido: Optional[WebSocket] = None):
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

    # Estado só para quem ficou/espectadores — o que saiu não deve
    # receber a peça do vencedor (evita creditar vitória ao perdedor).
    await transmitir_sala(sala, estado_para_cliente(jogo, peca_ficou),
                          {id(excluido)} if excluido is not None else None)
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


@router.websocket("/ws/velha/{sala}")
@router.websocket("/velha/{sala}")
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
                "cosmeticos_x": cosmeticos_equipados(jogo["jogador_x"].get("nome", "")),
                "cosmeticos_o": cosmeticos_equipados(jogo["jogador_o"].get("nome", "")),
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
                "cosmeticos_x": cosmeticos_equipados(jogo["jogador_x"].get("nome", "")),
                "cosmeticos_o": cosmeticos_equipados(jogo["jogador_o"].get("nome", "")),
                "quem_comeca": primeiro,
            })
            # Cada conexão recebe a própria peça; quem não é jogador mantém
            # o guard de espectador no cliente e ignora minha_peca.
            for ws in list(conexoes_ws.get(sala, [])):
                peca_envio = my_piece if ws is websocket else (
                    "O" if my_piece == "X" else "X")
                try:
                    await ws.send_json(estado_para_cliente(jogo, peca_envio))
                except Exception:
                    pass
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

                # Cada jogador recebe o estado com a própria peça; espectadores
                # ignoram minha_peca. Evita troca de peças (vitória creditada ao perdedor).
                await websocket.send_json(estado_para_cliente(jogo, my_piece))
                outro = "O" if my_piece == "X" else "X"
                await transmitir_sala(sala, estado_para_cliente(jogo, outro), {id(websocket)})

            elif tipo == "sair":
                _saiu_explicitamente = True
                # Saiu: quem ficou vence por desistência e a sala desfaz.
                outro = "O" if my_piece == "X" else "X"
                if jogo.get(f"jogador_{outro.lower()}"):
                    await _vitoria_por_desistencia(sala, jogo, my_piece, nick,
                                                   excluido=websocket)
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
