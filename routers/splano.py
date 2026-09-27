"""Splano.io — servidor autoritativo do jogo de bolinhas (WebSocket /ws/splano).

O cliente só manda intenção (direção, dividir, soltar energia); posição,
tamanho, quem comeu quem e o fim da partida são decididos aqui, num tick fixo.
A partida NÃO começa sozinha: todo mundo conectado precisa votar "pronto"
(mínimo de 1 humano) e aí sim conta regressiva — o resto da arena é
completado com bots (até 20 jogadores no total).
"""
import asyncio
import json
import math
import random
import time
from typing import Dict, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from shared import splano as regras
from shared.economia import cosmeticos_equipados, creditar_moedas, registrar_fim_partida, skin_splano
from shared.logging_util import log_tela
from shared.recordes import eh_anonimo

router = APIRouter()

TICKS_POR_SEGUNDO = 20
DT = 1.0 / TICKS_POR_SEGUNDO
TICKS_POR_PENSAMENTO_BOT = 4      # bots decidem 5x por segundo
HUMANOS_PARA_COMECAR = 1          # com 1 humano pronto já dá pra jogar (19 bots)
PARTICIPANTES_MINIMO = 20         # a arena sempre enche até aqui com bots
PARTICIPANTES_MAXIMO = 20
SEGUNDOS_CONTAGEM = 5
SEGUNDOS_PLACAR_FINAL = 10
SALA_PADRAO = "publica"

salas: Dict[str, dict] = {}
_lock_moedas = asyncio.Lock()


# ---------------------------------------------------------------------------
# Sala
# ---------------------------------------------------------------------------

def _nova_sala(codigo: str) -> dict:
    return {
        "codigo": codigo,
        "jogo": regras.novo_jogo(),
        "conexoes": {},        # nome -> {ws, nick, avatar, cosmeticos, skin, assistindo}
        "pids": {},            # nome -> id curto usado no tick
        "proximo_pid": 1,
        "prontos": set(),      # quem já votou "pronto" nesta rodada
        "contagem_ate": 0.0,
        "fim_em": 0.0,
        "resultado": None,
        "tarefa": None,
        "tick": 0,
    }


def _sala(codigo: str) -> dict:
    sala = salas.get(codigo)
    if sala is None:
        sala = salas[codigo] = _nova_sala(codigo)
    return sala


def _humanos(sala: dict) -> list:
    return [n for n, j in sala["jogo"]["jogadores"].items() if not j["bot"]]


def _humanos_conectados(sala: dict) -> list:
    return [n for n in sala["conexoes"] if n in sala["jogo"]["jogadores"]]


def _humanos_prontos(sala: dict) -> list:
    return [n for n in _humanos_conectados(sala) if n in sala["prontos"]]


def _todos_prontos(sala: dict) -> bool:
    """A votação só passa quando TODOS os humanos conectados votaram pronto."""
    conectados = _humanos_conectados(sala)
    return bool(conectados) and len(_humanos_prontos(sala)) == len(conectados)


def _nome_por_pid(sala: dict, pid) -> Optional[str]:
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return None
    for nome, valor in sala["pids"].items():
        if valor == pid:
            return nome
    return None


async def _enviar(sala: dict, nome: str, mensagem: dict) -> None:
    conexao = sala["conexoes"].get(nome)
    if not conexao:
        return
    try:
        await conexao["ws"].send_json(mensagem)
    except Exception:
        pass


async def _transmitir(sala: dict, mensagem: dict) -> None:
    for nome in list(sala["conexoes"]):
        await _enviar(sala, nome, mensagem)


# ---------------------------------------------------------------------------
# Informação "estática" de cada jogador (não muda a cada tick)
# ---------------------------------------------------------------------------

def _pid(sala: dict, nome: str) -> int:
    if nome not in sala["pids"]:
        sala["pids"][nome] = sala["proximo_pid"]
        sala["proximo_pid"] += 1
    return sala["pids"][nome]


def _info_jogadores(sala: dict) -> list:
    return [{
        "pid": _pid(sala, nome),
        "nome": nome,
        "nick": j["nick"],
        "avatar": j["avatar"],
        "cosmeticos": j["cosmeticos"],
        "skin": j["skin"],
        "bot": j["bot"],
        "pronto": (not j["bot"]) and nome in sala["prontos"],
    } for nome, j in sala["jogo"]["jogadores"].items()]


async def _mandar_sala(sala: dict, para: Optional[str] = None) -> None:
    mensagem = {
        "tipo": "sala",
        "fase": sala["jogo"]["fase"],
        "jogadores": _info_jogadores(sala),
        "humanos": len(_humanos_conectados(sala)),
        "humanos_necessarios": HUMANOS_PARA_COMECAR,
        "prontos": len(_humanos_prontos(sala)),
        "contagem": max(0, int(math.ceil(sala["contagem_ate"] - time.time()))) if sala["jogo"]["fase"] == "contagem" else 0,
    }
    if para:
        await _enviar(sala, para, mensagem)
    else:
        await _transmitir(sala, mensagem)


# ---------------------------------------------------------------------------
# Ciclo da partida
# ---------------------------------------------------------------------------

def _adicionar_bots(sala: dict) -> None:
    jogo = sala["jogo"]
    faltam = PARTICIPANTES_MINIMO - len(jogo["jogadores"])
    if faltam <= 0:
        return
    usados = {j["nick"] for j in jogo["jogadores"].values()}
    for i, nick in enumerate(regras.sortear_nomes_bots(faltam, usados)):
        # Metade competente, metade iniciante: dá partida equilibrada.
        nivel = regras.NIVEIS_BOT[1] if i % 2 == 0 else regras.NIVEIS_BOT[0]
        regras.entrar(jogo, "bot:%s:%d" % (sala["codigo"], i), nick, None, {},
                      {"tipo": "cor", "valor": _cor_bot(i)}, bot=True, nivel_bot=nivel)


def _cor_bot(i: int) -> str:
    cores = ["#8d939c", "#a8743f", "#7fa7c9", "#b0885f", "#9aa0b5", "#6f8f6f",
             "#a97b9c", "#7d8ba8"]
    return cores[i % len(cores)]


async def _talvez_comecar(sala: dict) -> None:
    """Começa só quando todo mundo conectado votou "pronto" (mínimo de
    HUMANOS_PARA_COMECAR humano) — nunca sozinho só por ter gente na sala."""
    jogo = sala["jogo"]
    if jogo["fase"] != "espera":
        return
    if len(_humanos_conectados(sala)) < HUMANOS_PARA_COMECAR:
        return
    if not _todos_prontos(sala):
        return
    jogo["fase"] = "contagem"
    sala["contagem_ate"] = time.time() + SEGUNDOS_CONTAGEM
    await _mandar_sala(sala)


def _comecar_partida(sala: dict, agora: float) -> None:
    jogo = sala["jogo"]
    # Todo mundo recomeça do zero, na posição sorteada.
    for nome, jogador in list(jogo["jogadores"].items()):
        x, y = regras._ponto_livre(300.0)
        jogador["celulas"] = [regras.nova_celula(jogo, x, y, regras.ENERGIA_INICIAL)]
        jogador["vivo"] = True
        jogador["kills"] = 0
        jogador["dobro_ate"] = 0.0
        jogador["energia_maxima"] = float(regras.ENERGIA_INICIAL)
        jogador["morto_por"] = None
        jogador["protegido_ate"] = agora + regras.SEGUNDOS_PROTEGIDO
    _adicionar_bots(sala)
    jogo["pellets"].clear()
    jogo["powerups"].clear()
    regras.encher_pellets(jogo)
    jogo["fase"] = "jogando"
    jogo["comecou_em"] = agora
    jogo["proximo_powerup"] = agora + 12.0
    jogo["vencedor"] = None


async def _pagar(nome: str, moedas: int) -> None:
    if not nome or nome.startswith("bot:") or eh_anonimo(nome) or moedas <= 0:
        return
    async with _lock_moedas:
        try:
            await asyncio.to_thread(creditar_moedas, nome, moedas)
        except Exception as erro:
            log_tela("splano: falha ao creditar moedas de %s: %r" % (nome, erro))


async def _registrar_partida(sala: dict, nome: str, venceu: bool, segundos: int) -> None:
    jogador = sala["jogo"]["jogadores"].get(nome)
    conexao = sala["conexoes"].get(nome)
    if not jogador or jogador["bot"] or eh_anonimo(nome):
        return
    try:
        await asyncio.to_thread(
            registrar_fim_partida, nome, jogador["nick"], segundos,
            "splano_io", (conexao or {}).get("avatar"), venceu,
            "vitoria" if venceu else "derrota")
    except Exception as erro:
        log_tela("splano: falha ao registrar partida de %s: %r" % (nome, erro))


async def _terminar(sala: dict, fim: dict, agora: float) -> None:
    jogo = sala["jogo"]
    jogo["fase"] = "fim"
    jogo["vencedor"] = fim["vencedor"]
    jogo["motivo_fim"] = fim["motivo"]
    sala["fim_em"] = agora + SEGUNDOS_PLACAR_FINAL
    duracao = int(agora - jogo["comecou_em"])

    placar = []
    for nome, jogador in jogo["jogadores"].items():
        venceu = nome == fim["vencedor"]
        moedas = (regras.MOEDAS_VITORIA if venceu else 0) + jogador["kills"] * regras.MOEDAS_KILL
        placar.append({
            "nick": jogador["nick"], "bot": jogador["bot"], "venceu": venceu,
            "kills": jogador["kills"], "energia": round(jogador["energia_maxima"]),
            "moedas": moedas if not jogador["bot"] else 0,
        })
        if not jogador["bot"]:
            await _pagar(nome, moedas)
            await _registrar_partida(sala, nome, venceu, duracao)
    placar.sort(key=lambda p: (-p["venceu"], -p["energia"]))

    sala["resultado"] = {
        "tipo": "fim", "vencedor": fim["vencedor"], "motivo": fim["motivo"],
        "placar": placar, "segundos": SEGUNDOS_PLACAR_FINAL,
    }
    await _transmitir(sala, sala["resultado"])


def _reiniciar_para_espera(sala: dict) -> None:
    jogo = sala["jogo"]
    for nome in [n for n, j in jogo["jogadores"].items() if j["bot"] or n not in sala["conexoes"]]:
        jogo["jogadores"].pop(nome, None)
        sala["pids"].pop(nome, None)
    # Quem chegou no meio da partida ficou só assistindo; agora entra de fato.
    for nome, conexao in sala["conexoes"].items():
        if nome not in jogo["jogadores"]:
            regras.entrar(jogo, nome, conexao["nick"], conexao["avatar"],
                          conexao["cosmeticos"], conexao["skin"])
    jogo["pellets"].clear()
    jogo["powerups"].clear()
    jogo["fase"] = "espera"
    jogo["vencedor"] = None
    sala["resultado"] = None
    sala["prontos"].clear()


# ---------------------------------------------------------------------------
# Envio do estado (com corte do que está fora da tela)
# ---------------------------------------------------------------------------

def _centro_da_camera(jogo: dict, jogador: Optional[dict],
                      observando: Optional[str] = None) -> tuple:
    if jogador and jogador["vivo"] and jogador["celulas"]:
        return _centro(jogador)
    # Morreu (ou nunca entrou): assiste quem o jogador escolheu.
    alvo = jogo["jogadores"].get(observando or "")
    if alvo and alvo["vivo"] and alvo["celulas"]:
        return _centro(alvo)
    restantes = regras.vivos(jogo)
    if restantes:  # sem escolha válida: segue quem está liderando
        return _centro(max(restantes, key=regras.energia_total))
    return regras.ARENA / 2, regras.ARENA / 2


def _centro(jogador: dict) -> tuple:
    total = sum(c["energia"] for c in jogador["celulas"]) or 1
    x = sum(c["x"] * c["energia"] for c in jogador["celulas"]) / total
    y = sum(c["y"] * c["energia"] for c in jogador["celulas"]) / total
    return x, y


def _estado_para(sala: dict, nome: str, agora: float) -> dict:
    jogo = sala["jogo"]
    eu = jogo["jogadores"].get(nome)
    conexao = sala["conexoes"].get(nome) or {}
    assistindo = conexao.get("assistindo") if (not eu or not eu["vivo"]) else None
    cx, cy = _centro_da_camera(jogo, eu, assistindo)
    meu_raio = regras.RAIO_BASE
    if eu and eu["celulas"]:
        meu_raio = max(regras.raio(c["energia"]) for c in eu["celulas"])
    # Quanto do mapa cabe na tela. Cresce mais devagar que a bola, então o
    # jogador se vê aumentando (e não sempre do mesmo tamanho na tela).
    alcance = 120.0 + 240.0 * (meu_raio / regras.RAIO_BASE) ** 0.55

    celulas = []
    for outro_nome, jogador in jogo["jogadores"].items():
        if not jogador["vivo"]:
            continue
        pid = _pid(sala, outro_nome)
        for celula in jogador["celulas"]:
            r = regras.raio(celula["energia"])
            if (abs(celula["x"] - cx) > alcance + r or abs(celula["y"] - cy) > alcance + r):
                continue
            # o id da célula vai junto pro cliente saber que é "a mesma bola"
            # entre um tick e outro e suavizar o movimento.
            celulas.append([pid, celula["id"], round(celula["x"], 1),
                            round(celula["y"], 1), round(r, 1)])

    pellets = [[round(p["x"], 1), round(p["y"], 1), p["v"]]
               for p in jogo["pellets"].values()
               if abs(p["x"] - cx) <= alcance and abs(p["y"] - cy) <= alcance]
    # [x, y, tipo, restante] — o cliente apaga o brilho quando tá acabando
    powerups = [[round(p["x"], 1), round(p["y"], 1), p["tipo"],
                 round(max(0.0, regras.POWERUP_VIDA - (agora - p.get("nasceu", agora))), 1)]
                for p in jogo["powerups"].values()
                if abs(p["x"] - cx) <= alcance + 60 and abs(p["y"] - cy) <= alcance + 60]

    placar = sorted(
        ({"pid": _pid(sala, n), "nick": j["nick"], "energia": round(regras.energia_total(j)),
          "vivo": j["vivo"], "bot": j["bot"], "kills": j["kills"]}
         for n, j in jogo["jogadores"].items()),
        key=lambda p: (-p["vivo"], -p["energia"]))

    return {
        "tipo": "estado",
        "cx": round(cx, 1), "cy": round(cy, 1), "alcance": round(alcance, 1),
        "celulas": celulas, "pellets": pellets, "powerups": powerups,
        "placar": placar[:10],
        "vivos_pids": [_pid(sala, n) for n, j in jogo["jogadores"].items() if j["vivo"]],
        "vivo": bool(eu and eu["vivo"]),
        "assistindo": _pid(sala, assistindo) if assistindo else 0,
        "protegido": max(0, round((eu or {}).get("protegido_ate", 0) - agora, 1)) if eu else 0,
        "energia": round(regras.energia_total(eu)) if eu else 0,
        "kills": eu["kills"] if eu else 0,
        "dobro": max(0, round(eu["dobro_ate"] - agora)) if eu else 0,
        "restante": max(0, round(regras.DURACAO_MAXIMA - (agora - jogo["comecou_em"]))),
        "vivos": len(regras.vivos(jogo)),
    }


# ---------------------------------------------------------------------------
# Loop da sala
# ---------------------------------------------------------------------------

async def _tick(sala: dict) -> None:
    agora = time.time()
    jogo = sala["jogo"]
    sala["tick"] += 1

    if jogo["fase"] == "contagem":
        if len(_humanos_conectados(sala)) < HUMANOS_PARA_COMECAR or not _todos_prontos(sala):
            # Alguém desistiu/entrou no meio da contagem: volta pra votação.
            jogo["fase"] = "espera"
            await _mandar_sala(sala)
        elif agora >= sala["contagem_ate"]:
            _comecar_partida(sala, agora)
            await _mandar_sala(sala)
        elif sala["tick"] % TICKS_POR_SEGUNDO == 0:
            await _mandar_sala(sala)
        return

    if jogo["fase"] == "fim":
        if agora >= sala["fim_em"]:
            _reiniciar_para_espera(sala)
            await _mandar_sala(sala)
            await _talvez_comecar(sala)
        return

    if jogo["fase"] != "jogando":
        return

    if sala["tick"] % TICKS_POR_PENSAMENTO_BOT == 0:
        for jogador in regras.vivos(jogo):
            if jogador["bot"]:
                regras.pensar_bot(jogo, jogador, agora)

    eventos = regras.passo(jogo, DT, agora)
    for comedor, comido in eventos["kills"]:
        vitima = jogo["jogadores"].get(comido)
        caçador = jogo["jogadores"].get(comedor)
        if vitima and caçador:
            await _transmitir(sala, {"tipo": "morte", "nick": vitima["nick"],
                                     "por": caçador["nick"]})

    for nome in list(sala["conexoes"]):
        await _enviar(sala, nome, _estado_para(sala, nome, agora))

    fim = regras.checar_fim(jogo, agora)
    if fim:
        await _terminar(sala, fim, agora)


async def _loop(sala: dict) -> None:
    try:
        while sala["conexoes"] or sala["jogo"]["fase"] != "espera":
            inicio = time.perf_counter()
            try:
                await _tick(sala)
            except Exception as erro:
                log_tela("splano: erro no tick da sala %s: %r" % (sala["codigo"], erro))
            await asyncio.sleep(max(0.0, DT - (time.perf_counter() - inicio)))
    finally:
        sala["tarefa"] = None
        if not sala["conexoes"]:
            salas.pop(sala["codigo"], None)


def _garantir_loop(sala: dict) -> None:
    if sala["tarefa"] is None or sala["tarefa"].done():
        sala["tarefa"] = asyncio.create_task(_loop(sala))


# ---------------------------------------------------------------------------
# Mensagens do cliente
# ---------------------------------------------------------------------------

async def _tratar(sala: dict, nome: str, dados: dict) -> None:
    jogador = sala["jogo"]["jogadores"].get(nome)
    tipo = dados.get("tipo")

    if tipo == "ping":
        await _enviar(sala, nome, {"tipo": "pong"})
        return
    if tipo == "assistir":
        # Escolha de quem observar depois de morrer — dá até pra quem entrou
        # no meio da partida e nem está jogando.
        conexao = sala["conexoes"].get(nome)
        if conexao is not None:
            alvo = _nome_por_pid(sala, dados.get("pid"))
            conexao["assistindo"] = alvo if alvo in sala["jogo"]["jogadores"] else None
        return
    if not jogador:
        return
    if tipo == "dir":
        try:
            regras.definir_direcao(jogador, float(dados.get("x", 0)), float(dados.get("y", 0)))
        except (TypeError, ValueError):
            pass
    elif tipo == "dividir":
        regras.dividir(sala["jogo"], jogador, time.time())
    elif tipo == "soltar":
        jogador["soltando"] = bool(dados.get("ativo"))
    elif tipo == "pronto":
        if bool(dados.get("ativo", True)):
            sala["prontos"].add(nome)
        else:
            sala["prontos"].discard(nome)
            # Desistiu no meio da contagem: volta pra votação.
            if sala["jogo"]["fase"] == "contagem":
                sala["jogo"]["fase"] = "espera"
        fase = sala["jogo"]["fase"]
        await _talvez_comecar(sala)          # só transmite se começar de fato
        if sala["jogo"]["fase"] == fase:
            await _mandar_sala(sala)


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------

@router.get("/splano/salas")
def listar_salas():
    return {"salas": [{
        "sala": codigo,
        "fase": sala["jogo"]["fase"],
        "jogadores": len(_humanos_conectados(sala)),
    } for codigo, sala in salas.items()]}


@router.websocket("/ws/splano")
@router.websocket("/splano")
async def ws_splano(websocket: WebSocket):
    await websocket.accept()
    query = websocket.query_params
    nome = (query.get("nome") or "").strip()
    nick = (query.get("nick") or "").strip() or nome
    avatar = query.get("avatar") or None
    codigo = (query.get("sala") or SALA_PADRAO).strip().lower()[:16] or SALA_PADRAO

    if not nome or eh_anonimo(nome) or eh_anonimo(nick):
        await websocket.send_json({"tipo": "erro_fatal",
                                   "mensagem": "Entre com Discord para jogar Splano.io."})
        await websocket.close()
        return

    sala = _sala(codigo)
    antiga = sala["conexoes"].get(nome)
    if antiga:
        try:
            await antiga["ws"].send_json({"tipo": "erro_fatal",
                                          "mensagem": "Você abriu o Splano.io em outra janela."})
            await antiga["ws"].close()
        except Exception:
            pass

    try:
        cosmeticos = await asyncio.to_thread(cosmeticos_equipados, nome)
    except Exception:
        cosmeticos = {}
    try:
        skin = await asyncio.to_thread(skin_splano, nome)
    except Exception:
        skin = {}

    sala["conexoes"][nome] = {"ws": websocket, "nick": nick, "avatar": avatar,
                              "cosmeticos": cosmeticos, "skin": skin,
                              "assistindo": None}

    jogo = sala["jogo"]
    if nome in jogo["jogadores"]:
        jogador = jogo["jogadores"][nome]
        jogador["nick"], jogador["avatar"] = nick, avatar
        jogador["cosmeticos"], jogador["skin"] = cosmeticos, skin
    elif jogo["fase"] in ("espera", "contagem"):
        regras.entrar(jogo, nome, nick, avatar, cosmeticos, skin)
    # Partida em andamento: fica só assistindo até a próxima.

    # Quem chegou durante a contagem ainda não votou "pronto" — a votação
    # volta atrás pra todo mundo decidir de novo.
    if jogo["fase"] == "contagem" and nome not in sala["prontos"]:
        jogo["fase"] = "espera"

    _pid(sala, nome)
    _garantir_loop(sala)

    await websocket.send_json({
        "tipo": "bem_vindo",
        "sala": codigo,
        "arena": regras.ARENA,
        "config": {
            "energia_inicial": regras.ENERGIA_INICIAL,
            "raio_base": regras.RAIO_BASE,
            "moedas_vitoria": regras.MOEDAS_VITORIA,
            "moedas_kill": regras.MOEDAS_KILL,
            "energia_minima_dividir": regras.ENERGIA_MINIMA_DIVIDIR,
            "dobro_segundos": int(regras.DOBRO_ENERGIA_SEGUNDOS),
            "powerup_raio": regras.POWERUP_RAIO,
            "powerup_vida": int(regras.POWERUP_VIDA),
            "juntar_segundos": regras.SEGUNDOS_PARA_JUNTAR,
            "jogadores": PARTICIPANTES_MAXIMO,
        },
    })
    await _mandar_sala(sala)
    if sala["resultado"]:
        await _enviar(sala, nome, sala["resultado"])
    await _talvez_comecar(sala)

    try:
        while True:
            bruto = await websocket.receive_text()
            try:
                dados = json.loads(bruto)
            except Exception:
                continue
            if isinstance(dados, dict):
                await _tratar(sala, nome, dados)
    except WebSocketDisconnect:
        pass
    except Exception as erro:
        log_tela("splano: erro no ws de %s: %r" % (nome, erro))
    finally:
        if (sala["conexoes"].get(nome) or {}).get("ws") is websocket:
            sala["conexoes"].pop(nome, None)
            sala["prontos"].discard(nome)
            jogador = sala["jogo"]["jogadores"].get(nome)
            if jogador and sala["jogo"]["fase"] in ("espera", "contagem"):
                sala["jogo"]["jogadores"].pop(nome, None)
                sala["pids"].pop(nome, None)
            elif jogador:
                # Saiu no meio da partida: vira comida parada e logo morre.
                jogador["dir_x"] = jogador["dir_y"] = 0.0
                jogador["soltando"] = False
            await _mandar_sala(sala)
