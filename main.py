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


class NovaTransmissao(BaseModel):
    instancia: Optional[str] = None
    nick: str = "Anônimo"
    resolucao: str = "720p"
    fps: int = 30
    codigo: Optional[str] = None


class RefreshTokenRequest(BaseModel):
    refresh_token: str


# ---------------------------------------------------------------------------
# Estado global
# ---------------------------------------------------------------------------

jogos: Dict[str, dict] = {}
salas_velha: Dict[str, str] = {}
# sala -> {"host_ws", "host_nick", "instancia", "resolucao", "fps", "viewers": {id: WebSocket}}
salas_tela: Dict[str, dict] = {}
conexoes_ws: Dict[str, List[WebSocket]] = {}
conexoes_lobby: List[WebSocket] = []
_reconnect_timers: Dict[str, asyncio.Task] = {}
RECONNECT_GRACE_SECONDS = 15

# Sudoku online: código -> estado da sala (2 jogadores, mesmo puzzle)
salas_sudoku: Dict[str, dict] = {}
SUDOKU_SALA_SEM_WS_SEGUNDOS = 60


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
def ranking_vitorias():
    recordes = carregar_recordes()
    ranking = ranking_top(recordes.get("velha_vitorias", []), "vitorias", reverse=True, limite=10)
    return {"ranking": ranking}


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
        encontrado = False
        for v in vitorias:
            if v["nick"] == dados.nick and v["nome"] == dados.nome:
                v["vitorias"] = v.get("vitorias", 0) + 1
                if dados.avatar:
                    v["avatar"] = dados.avatar
                encontrado = True
                break
        if not encontrado:
            novo = {"nick": dados.nick, "nome": dados.nome, "vitorias": 1}
            if dados.avatar:
                novo["avatar"] = dados.avatar
            vitorias.append(novo)
        recordes["velha_vitorias"] = sorted(vitorias, key=lambda r: r["vitorias"], reverse=True)[:50]
        salvar_recordes(recordes)

    top3 = ranking_top(recordes["velha"].get(dados.dificuldade, [])[-10:],
                       "vitorias", reverse=True, limite=3)
    ranking = ranking_top(recordes.get("velha_vitorias", []), "vitorias", reverse=True, limite=10)
    return {"dificuldade": dados.dificuldade, "recordes": top3, "ranking": ranking}


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
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in conexoes_lobby:
            conexoes_lobby.remove(websocket)


# ---------------------------------------------------------------------------
# WebSocket — Jogo da Velha (multiplayer + espectadores)
# ---------------------------------------------------------------------------

async def _delayed_disconnect(sala: str, piece: str, jogo: dict, nick: str):
    await asyncio.sleep(RECONNECT_GRACE_SECONDS)
    key = f"{sala}:{piece}"
    _reconnect_timers.pop(key, None)
    slot_key = f"jogador_{piece.lower()}"
    slot = jogo.get(slot_key)
    if not slot or slot["nick"] != nick:
        return
    # O dono da sala caiu e não voltou: encerra a sala e remove o oponente.
    if jogo.get("dono") == piece:
        await _fechar_sala_por_dono(sala, jogo)
        return
    jogo[slot_key] = None
    if not jogo["jogador_x"] and not jogo["jogador_o"]:
        try:
            await transmitir_sala(sala, {"tipo": "oponente_desconectou", "nick": nick})
        except Exception:
            pass
        limpar_sala(sala)
    else:
        reiniciar_jogo(jogo)
        try:
            await transmitir_sala(sala, {
                "tipo": "oponente_saiu reiniciando",
                "jogador_x": jogo["jogador_x"]["nick"] if jogo["jogador_x"] else None,
                "jogador_o": jogo["jogador_o"]["nick"] if jogo["jogador_o"] else None,
            })
        except Exception:
            pass
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
                # O dono saiu: encerra a sala e remove o oponente/espectadores.
                if jogo.get("dono") == my_piece:
                    await _fechar_sala_por_dono(sala, jogo, excluido=websocket)
                    break
                if my_piece == "X":
                    jogo["jogador_x"] = None
                else:
                    jogo["jogador_o"] = None

                if not jogo["jogador_x"] and not jogo["jogador_o"]:
                    await transmitir_sala(sala, {"tipo": "oponente_desconectou", "nick": nick})
                    limpar_sala(sala)
                    await transmitir_salas_lobby()
                    break

                reiniciar_jogo(jogo)
                await transmitir_sala(sala, {
                    "tipo": "oponente_saiu reiniciando",
                    "jogador_x": jogo["jogador_x"]["nick"] if jogo["jogador_x"] else None,
                    "jogador_o": jogo["jogador_o"]["nick"] if jogo["jogador_o"] else None,
                })
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
        "resolucao": transmissao["resolucao"],
        "fps": transmissao["fps"],
        "espectadores": len(transmissao["viewers"]),
        "host_conectado": transmissao.get("host_ws") is not None,
    }
    if transmissao.get("relay_codec"):
        info["codec"] = transmissao["relay_codec"]
    return info


def purgar_transmissoes_obsoletas() -> None:
    """Remove salas criadas mas sem host conectado (ex.: POST ok e WS falhou)."""
    agora = time.time()
    for sala, t in list(salas_tela.items()):
        if t["host_ws"] is None and agora - t.get("criado_em", agora) > SALA_TELA_SEM_HOST_SEGUNDOS:
            salas_tela.pop(sala, None)
            log_tela("sala obsoleta removida sala=" + sala)


@app.post("/tela/novo")
def criar_transmissao(dados: NovaTransmissao):
    resolucao = dados.resolucao.lower()
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
        "instancia": (dados.instancia or "").strip()[:64] or None,
        "resolucao": resolucao,
        "fps": dados.fps,
        "viewers": {},
        "relay_ws": {},  # espectadores da Activity (vídeo via WS binário)
        "criado_em": time.time(),
    }
    log_tela("sala criada sala=%s res=%s fps=%s instancia=%s" % (
        sala, resolucao, dados.fps, salas_tela[sala]["instancia"] or "-"))
    return {"sala": sala, "resolucao": resolucao, "fps": dados.fps}


@app.get("/tela/transmissoes")
def listar_transmissoes(instancia: str = ""):
    """Lista as transmissões de UMA instância da call.

    Salas são privadas: sem instância (call) não há lista — quem está fora
    só entra pelo código da sala.
    """
    purgar_transmissoes_obsoletas()
    instancia = instancia.strip()[:64] or None
    if not instancia:
        return {"transmissoes": []}
    return {
        "transmissoes": [
            info_transmissao(sala, t)
            for sala, t in salas_tela.items()
            if t["instancia"] == instancia and t["host_ws"] is not None
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


async def _notificar_total(transmissao: dict):
    host = transmissao.get("host_ws")
    if host:
        try:
            await host.send_json({"tipo": "viewers_total", "total": len(transmissao["viewers"])})
        except Exception:
            pass


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
            await _encerrar_transmissao(sala, transmissao, "host_saiu")
        else:
            log_tela("conexao antiga de host ignorada sala=" + sala)


async def _ws_tela_viewer(websocket: WebSocket, sala: str, transmissao: dict, nick: str, transporte: str):
    if len(transmissao["viewers"]) >= MAX_ESPECTADORES_TELA:
        log_tela("viewer recusado (sala cheia) sala=" + sala)
        await websocket.send_json({"tipo": "erro", "mensagem": "Transmissão cheia (máximo de 9 espectadores)."})
        await websocket.close()
        return

    viewer_id = secrets.token_urlsafe(8)
    eh_relay = transporte == "relay"
    transmissao["viewers"][viewer_id] = websocket
    if eh_relay:
        transmissao.setdefault("relay_ws", {})[viewer_id] = websocket
    log_tela("viewer conectado sala=%s nick=%s transporte=%s total=%d" % (
        sala, nick, transporte, len(transmissao["viewers"])))
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

    transmissao = salas_tela.get(sala)
    if not transmissao:
        log_tela("ws recusado, sala inexistente sala=" + sala)
        await websocket.send_json({"tipo": "erro", "mensagem": "Transmissão não encontrada."})
        await websocket.close()
        return

    if papel == "host":
        await _ws_tela_host(websocket, sala, transmissao, nick)
    else:
        await _ws_tela_viewer(websocket, sala, transmissao, nick, transporte)


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
                # Líder saiu → sala encerra. Se não, só desconecta o slot.
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
            # Líder desconectou → encerra (com pequena tolerância? sem: pede saída)
            if s.get("lider") == slot:
                await encerrar_sala_sudoku(sala, "lider_desconectou")
            else:
                await broadcast_sudoku(sala, estado_sudoku_para(s, slot))
                # Oponente caiu antes do fim da rodada → encerra para não travar
                if s.get("fase") == "jogando":
                    await encerrar_sala_sudoku(sala, "oponente_desconectou")
                elif s.get("fase") == "esperando":
                    # mantém sala aberta para novo join do p2? líder ainda aí.
                    pass
                await _notificar_salas_sudoku_lobby()


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
