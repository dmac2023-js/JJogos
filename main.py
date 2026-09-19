import json
import os
import secrets
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


class NovoRecord(BaseModel):
    dificuldade: str
    nome: str
    nick: str
    tempo_segundos: int


class NovoJogoVelha(BaseModel):
    modo: str
    dificuldade: str = "facil"
    nome: str = "Anônimo"
    nick: str = "Anônimo"


class MoverJogoVelha(BaseModel):
    jogo_id: str
    posicao: int


class NovoRecordVelha(BaseModel):
    dificuldade: str
    nome: str
    nick: str


# ---------------------------------------------------------------------------
# Estado global
# ---------------------------------------------------------------------------

jogos: Dict[str, dict] = {}
salas_velha: Dict[str, str] = {}
conexoes_ws: Dict[str, List[WebSocket]] = {}
conexoes_lobby: List[WebSocket] = []


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

def criar_novo_jogo_velha(modo: str, dificuldade: str, nome_x: str, nick_x: str) -> dict:
    jogo_id = secrets.token_urlsafe(12)
    sala = secrets.token_urlsafe(6) if modo == "multiplayer" else None
    jogo = {
        "jogo_id": jogo_id,
        "modo": modo,
        "tabuleiro": ["", "", "", "", "", "", "", "", ""],
        "jogador_atual": "X",
        "jogador_x": None,
        "jogador_o": None,
        "jogo_ativo": True,
        "resultado": None,
        "sala": sala,
        "dificuldade": dificuldade if modo == "maquina" else None,
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
    if sala in salas_velha:
        del salas_velha[sala]
    if sala in conexoes_ws:
        del conexoes_ws[sala]


# ---------------------------------------------------------------------------
# Endpoints — saúde / config / auth
# ---------------------------------------------------------------------------

@app.get("/saude")
def saude():
    return {"online": True}


@app.get("/config")
def configuracao_publica():
    return {"application_id": DISCORD_APPLICATION_ID}


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

    resposta = requests.post(
        "https://discord.com/api/oauth2/token",
        data={
            "client_id": DISCORD_APPLICATION_ID,
            "client_secret": DISCORD_CLIENT_SECRET,
            "grant_type": "authorization_code",
            "code": dados.code,
        },
        timeout=15,
    )

    if resposta.status_code != 200:
        raise HTTPException(status_code=400, detail="Não foi possível autenticar com o Discord.")

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
    top3 = sorted(recordes["sudoku"].get(dificuldade, []), key=lambda r: r["tempo_segundos"])[:3]
    return {"dificuldade": dificuldade, "recordes": top3}


@app.post("/sudoku/recordes")
def salvar_novo_record(dados: NovoRecord):
    if dados.dificuldade not in {"facil", "medio", "dificil"}:
        raise HTTPException(status_code=400, detail="Dificuldade inválida.")
    if dados.tempo_segundos <= 0:
        raise HTTPException(status_code=400, detail="Tempo inválido.")

    recordes = carregar_recordes()
    registro = {"nome": dados.nome, "nick": dados.nick, "tempo_segundos": dados.tempo_segundos}
    recordes["sudoku"].setdefault(dados.dificuldade, []).append(registro)
    recordes["sudoku"][dados.dificuldade].sort(key=lambda r: r["tempo_segundos"])
    recordes["sudoku"][dados.dificuldade] = recordes["sudoku"][dados.dificuldade][:50]
    salvar_recordes(recordes)

    top3 = recordes["sudoku"][dados.dificuldade][:3]
    return {"dificuldade": dados.dificuldade, "recordes": top3}


# ---------------------------------------------------------------------------
# Endpoints — Jogo da Velha
# ---------------------------------------------------------------------------

@app.post("/velha/novo")
def novo_jogo_velha(dados: NovoJogoVelha):
    modo = dados.modo.lower()
    if modo not in {"maquina", "multiplayer"}:
        raise HTTPException(status_code=400, detail="Modo inválido.")
    dificuldade = dados.dificuldade.lower()
    if dificuldade not in {"facil", "medio", "dificil"}:
        raise HTTPException(status_code=400, detail="Dificuldade inválida.")

    jogo = criar_novo_jogo_velha(modo, dificuldade, dados.nome, dados.nick)
    return {
        "jogo_id": jogo["jogo_id"],
        "sala": jogo["sala"],
        "tabuleiro": jogo["tabuleiro"],
        "jogador_atual": jogo["jogador_atual"],
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
    top3 = recordes["velha"].get(dificuldade, [])[-3:]
    return {"dificuldade": dificuldade, "recordes": top3}


@app.get("/velha/ranking")
def ranking_vitorias():
    recordes = carregar_recordes()
    ranking = sorted(recordes.get("velha_vitorias", []), key=lambda r: r["vitorias"], reverse=True)[:10]
    return {"ranking": ranking}


@app.post("/velha/recordes")
def salvar_record_velha(dados: NovoRecordVelha):
    if dados.dificuldade not in {"facil", "medio", "dificil"}:
        raise HTTPException(status_code=400, detail="Dificuldade inválida.")

    recordes = carregar_recordes()
    registro = {"nome": dados.nome, "nick": dados.nick}
    recordes["velha"].setdefault(dados.dificuldade, []).append(registro)
    recordes["velha"][dados.dificuldade] = recordes["velha"][dados.dificuldade][-50:]

    vitorias = recordes.get("velha_vitorias", [])
    encontrado = False
    for v in vitorias:
        if v["nick"] == dados.nick and v["nome"] == dados.nome:
            v["vitorias"] = v.get("vitorias", 0) + 1
            encontrado = True
            break
    if not encontrado:
        vitorias.append({"nick": dados.nick, "nome": dados.nome, "vitorias": 1})
    recordes["velha_vitorias"] = sorted(vitorias, key=lambda r: r["vitorias"], reverse=True)[:50]

    salvar_recordes(recordes)

    top3 = recordes["velha"].get(dados.dificuldade, [])[-3:]
    ranking = sorted(recordes.get("velha_vitorias", []), key=lambda r: r["vitorias"], reverse=True)[:10]
    return {"dificuldade": dados.dificuldade, "recordes": top3, "ranking": ranking}


# ---------------------------------------------------------------------------
# WebSocket — Lobby (atualizações em tempo real da lista de salas)
# ---------------------------------------------------------------------------

@app.websocket("/ws/lobby")
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

@app.websocket("/ws/velha/{sala}")
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
    if not jogo["jogador_x"]:
        jogo["jogador_x"] = {"nome": nome, "nick": nick}
        my_piece = "X"
    elif not jogo["jogador_o"]:
        jogo["jogador_o"] = {"nome": nome, "nick": nick}
        my_piece = "O"
    elif jogo["jogador_x"]["nick"] == nick:
        my_piece = "X"
    elif jogo["jogador_o"]["nick"] == nick:
        my_piece = "O"
    else:
        await websocket.send_json({"tipo": "erro", "mensagem": "Sala cheia."})
        await websocket.close()
        return

    conexoes_ws[sala].append(websocket)
    await transmitir_salas_lobby()

    if jogo["jogador_x"] and jogo["jogador_o"]:
        primeiro = reiniciar_jogo(jogo)
        await transmitir_sala(sala, {
            "tipo": "inicio",
            "jogador_x": jogo["jogador_x"]["nick"],
            "jogador_o": jogo["jogador_o"]["nick"],
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
                if my_piece == "X":
                    jogo["jogador_x"] = None
                else:
                    jogo["jogador_o"] = None

                if not jogo["jogador_x"] and not jogo["jogador_o"]:
                    try:
                        await transmitir_sala(sala, {
                            "tipo": "oponente_desconectou",
                            "nick": nick,
                        })
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
    return FileResponse(PASTA_STATIC / "index.html")
