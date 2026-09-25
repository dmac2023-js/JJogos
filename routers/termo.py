"""Termo — solo e 1x1 online (mesma palavra em privado)."""
import asyncio
import json
import re
import secrets
import time
import unicodedata
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from shared.config import ARQUIVO_TERMO_PALAVRAS_VALIDAS
from shared.economia import MOEDAS_VITORIA_MULTIPLAYER, MOEDAS_VITORIA_SOLO, creditar_moedas
from shared.lobby_state import conexoes_lobby
from shared.logging_util import log_tela
from shared.recordes import (
    _registrar_vitoria,
    carregar_recordes,
    eh_anonimo,
    ranking_vitorias,
    salvar_recordes,
)

router = APIRouter()


class NovoTermo(BaseModel):
    dificuldade: str = "facil"


class TentativaTermo(BaseModel):
    jogo_id: str
    palpite: str


class NovoRecordTermo(BaseModel):
    dificuldade: str
    nome: str
    nick: str
    tentativas: int
    avatar: Optional[str] = None


class NovaSalaTermo(BaseModel):
    codigo: Optional[str] = None
    publica: bool = True
    dificuldade: str = "facil"
    nome: str = "Anônimo"
    nick: str = "Anônimo"
    avatar: Optional[str] = None



# Termo online: código -> sala (1x1, cada um joga em privado a mesma palavra).
salas_termo: Dict[str, dict] = {}
termo_jogos: Dict[str, dict] = {}
TERMO_SALA_SEM_WS_SEGUNDOS = 60
TERMO_TAMANHO = 5
# facil = Termo (1 palavra), medio = Dueto (2), dificil = Quarteto (4).
TERMO_TABULEIROS = {"facil": 1, "medio": 2, "dificil": 4}
TERMO_TENTATIVAS = {"facil": 6, "medio": 7, "dificil": 9}
TERMO_PALAVRAS = [
    "PLACA", "TERRA", "FORTE", "CARRO", "LIVRO", "MOEDA", "PEDRA", "VIDRO", "PORTA", "CAIXA",
    "FALTA", "GRUPO", "FESTA", "NOITE", "MUNDO", "TEMPO", "CAMPO", "LINDO", "BARCO", "BOLSA",
    "CARTA", "DENTE", "FOGAO", "ARROZ", "LEITE", "FRUTA", "VERDE", "PRETO", "CINZA", "TREZE",
    "PERNA", "BRACO", "DEDOS", "NARIZ", "OLHOS", "GATOS", "LOBOS", "TIGRE", "LEOES", "COBRA",
    "RATOS", "PATOS", "PEIXE", "GALHO", "FOLHA", "GRAMA", "DOCES", "SALSA", "MASSA", "PIZZA",
    "MOLHO", "BOLOS", "SUCOS", "AGUAS", "MESAS", "CAMAS", "SOFAS", "LAPIS", "PAPEL", "CHAVE",
    "TELAS", "RADIO", "MOTOR", "CALCA", "SAIAS", "LUVAS", "BOTAS", "MEIAS", "BONES", "MARES",
    "VENTO", "CHUVA", "NUVEM", "NEVES", "AREIA", "MONTE", "VALES", "LAGOS", "ILHAS", "PRAIA",
    "MANHA", "TARDE", "MESES", "HORAS", "FALAR", "ANDAR", "NADAR", "PULAR", "DANCA", "OLHAR",
    "BEIJO", "ABRIR", "SUBIR", "JOGAR", "FELIZ", "FRACO", "LENTO", "LIMPO", "NOVOS", "VELHO",
    "LARGO", "CURTO", "ALTOS", "BAIXO", "FRIOS", "CLARO", "IRMAO", "IRMAS", "PRIMO", "NETOS",
    "FILHO", "FILHA", "NOIVA", "NOIVO", "AMIGO", "AMIGA", "CASAS", "VINTE", "CENTO", "PALCO",
    "FILME", "NOTAS", "LIVRE", "PRECO", "VALOR", "FORCA", "PODER", "SONHO", "MEDOS", "RISCO",
    "SORTE", "RAIVA", "OMBRO", "PEITO", "COSTA", "AULAS", "TESTE", "PROVA", "CHEFE",
]
TERMO_PALAVRAS_SET = set(TERMO_PALAVRAS)


def termo_carregar_palavras_validas() -> set:
    """Vocabulário aceito nos palpites — bem mais amplo que o pool de palavras-secreto."""
    validas = set(TERMO_PALAVRAS_SET)
    try:
        with open(ARQUIVO_TERMO_PALAVRAS_VALIDAS, encoding="utf-8") as arquivo:
            for linha in arquivo:
                palavra = linha.strip().upper()
                if len(palavra) == TERMO_TAMANHO and palavra.isalpha():
                    validas.add(palavra)
    except FileNotFoundError:
        pass
    return validas


TERMO_PALAVRAS_VALIDAS = termo_carregar_palavras_validas()


def termo_normalizar(palavra: str) -> str:
    """Maiúsculas, sem acento, só letras — teclado físico e virtual usam o mesmo formato."""
    sem_acento = unicodedata.normalize("NFKD", palavra or "").encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^A-Za-z]", "", sem_acento).upper()


def termo_avaliar(palpite: str, secreta: str) -> List[str]:
    """Algoritmo padrão do Wordle/Termo: 2 passadas para lidar com letras repetidas."""
    resultado = ["ausente"] * TERMO_TAMANHO
    restantes = list(secreta)
    for i in range(TERMO_TAMANHO):
        if palpite[i] == secreta[i]:
            resultado[i] = "certo"
            restantes[i] = None
    for i in range(TERMO_TAMANHO):
        if resultado[i] == "certo":
            continue
        letra = palpite[i]
        if letra in restantes:
            resultado[i] = "presente"
            restantes[restantes.index(letra)] = None
    return resultado


def termo_sortear_palavras(qtd: int) -> List[str]:
    return secrets.SystemRandom().sample(TERMO_PALAVRAS, qtd)


def registrar_vitoria_termo(nick: str, nome: str, avatar: Optional[str],
                            tentativas: Optional[int] = None,
                            dificuldade: str = "facil") -> None:
    """Vitória Termo por dificuldade (Termo/Dueto/Quarteto) + menos tentativas."""
    if eh_anonimo(nick):
        return
    recordes = carregar_recordes()
    lista = recordes.setdefault("termo_vitorias", [])
    recordes["termo_vitorias"] = _registrar_vitoria(
        lista, nick, nome, avatar, dificuldade, tentativas)
    salvar_recordes(recordes)



# Endpoints — Termo (solo)
# ---------------------------------------------------------------------------

@router.post("/termo/novo")
def novo_termo(dados: NovoTermo):
    dificuldade = dados.dificuldade.lower()
    if dificuldade not in TERMO_TABULEIROS:
        raise HTTPException(status_code=400, detail="Dificuldade inválida.")

    qtd = TERMO_TABULEIROS[dificuldade]
    max_tentativas = TERMO_TENTATIVAS[dificuldade]
    jogo_id = secrets.token_urlsafe(12)
    termo_jogos[jogo_id] = {
        "secretas": termo_sortear_palavras(qtd),
        "dificuldade": dificuldade,
        "tentativas": [],
        "resolvidos": [False] * qtd,
        "max_tentativas": max_tentativas,
        "criado_em": time.time(),
    }
    return {
        "jogo_id": jogo_id,
        "tamanho": TERMO_TAMANHO,
        "tabuleiros": qtd,
        "max_tentativas": max_tentativas,
        "dificuldade": dificuldade,
    }


@router.post("/termo/tentar")
def tentar_termo(dados: TentativaTermo):
    jogo = termo_jogos.get(dados.jogo_id)
    if not jogo:
        raise HTTPException(status_code=404, detail="Jogo não encontrado.")
    if all(jogo["resolvidos"]) or len(jogo["tentativas"]) >= jogo["max_tentativas"]:
        raise HTTPException(status_code=400, detail="Jogo já terminou.")

    palpite = termo_normalizar(dados.palpite)
    if len(palpite) != TERMO_TAMANHO:
        raise HTTPException(status_code=400, detail="A palavra deve ter 5 letras.")
    if palpite not in TERMO_PALAVRAS_VALIDAS:
        raise HTTPException(status_code=400, detail="Palavra não reconhecida.")

    resultados = [termo_avaliar(palpite, secreta) for secreta in jogo["secretas"]]
    jogo["tentativas"].append(palpite)
    for i, secreta in enumerate(jogo["secretas"]):
        if palpite == secreta:
            jogo["resolvidos"][i] = True

    venceu = all(jogo["resolvidos"])
    completo = venceu or len(jogo["tentativas"]) >= jogo["max_tentativas"]

    resposta = {
        "palpite": palpite,
        "resultados": resultados,
        "resolvidos": jogo["resolvidos"],
        "tentativas_usadas": len(jogo["tentativas"]),
        "max_tentativas": jogo["max_tentativas"],
        "completo": completo,
        "venceu": venceu,
    }
    if completo:
        resposta["palavras"] = jogo["secretas"]
        termo_jogos.pop(dados.jogo_id, None)
    return resposta


@router.post("/termo/recordes")
def salvar_record_termo(dados: NovoRecordTermo):
    if dados.dificuldade not in TERMO_TABULEIROS:
        raise HTTPException(status_code=400, detail="Dificuldade inválida.")
    registrar_vitoria_termo(dados.nick, dados.nome, dados.avatar,
                            dados.tentativas, dados.dificuldade)
    creditar_moedas(dados.nome, MOEDAS_VITORIA_SOLO)
    recordes = carregar_recordes()
    ranking = ranking_vitorias(recordes.get("termo_vitorias", []),
                               dificuldade=dados.dificuldade, limite=10)
    return {"dificuldade": dados.dificuldade, "ranking": ranking}


@router.get("/termo/ranking")
def ranking_termo(dificuldade: Optional[str] = None):
    recordes = carregar_recordes()
    ranking = ranking_vitorias(recordes.get("termo_vitorias", []),
                               dificuldade=dificuldade, limite=10)
    return {"ranking": ranking, "dificuldade": dificuldade}


# ---------------------------------------------------------------------------
# Endpoints — Termo online (salas público/privado, 1x1 em privado)
# ---------------------------------------------------------------------------

def purgar_salas_termo_obsoletas() -> None:
    agora = time.time()
    for codigo, s in list(salas_termo.items()):
        conectados = sum(1 for p in s.get("slots", {}).values() if p and p.get("ws"))
        if conectados == 0 and agora - s.get("criado_em", agora) > TERMO_SALA_SEM_WS_SEGUNDOS:
            salas_termo.pop(codigo, None)


def _codigo_termo_valido(codigo: str) -> bool:
    return bool(re.fullmatch(r"[a-z0-9_-]{3,16}", codigo or ""))


def info_jogador_termo(s: dict, slot: str) -> dict:
    p = s.get("slots", {}).get(slot) or {}
    return {
        "slot": slot,
        "nick": p.get("nick", "—"),
        "nome": p.get("nome", ""),
        "avatar": p.get("avatar"),
        "conectado": bool(p.get("ws")),
        "completou": p.get("completou", False),
        "venceu": p.get("venceu", False),
        "tentativas_usadas": len(p.get("tentativas", [])),
    }


def estado_termo_para(s: dict, slot: Optional[str] = None) -> dict:
    return {
        "tipo": "estado_termo",
        "sala": s["codigo"],
        "publica": s.get("publica", False),
        "dificuldade": s.get("dificuldade", "facil"),
        "tamanho": TERMO_TAMANHO,
        "tabuleiros": TERMO_TABULEIROS.get(s.get("dificuldade", "facil"), 1),
        "max_tentativas": s.get("max_tentativas") or TERMO_TENTATIVAS.get(s.get("dificuldade", "facil"), 6),
        "fase": s.get("fase", "esperando"),
        "meu_slot": slot,
        "lider": s.get("lider"),
        "placar": s.get("placar", {"p1": 0, "p2": 0}),
        "jogadores": [info_jogador_termo(s, "p1"), info_jogador_termo(s, "p2")],
        "revanche_de": s.get("revanche_de"),
    }


async def broadcast_termo(sala: str, msg: dict):
    s = salas_termo.get(sala)
    if not s:
        return
    for p in s.get("slots", {}).values():
        if p and p.get("ws"):
            try:
                await p["ws"].send_json(msg)
            except Exception:
                pass


async def encerrar_sala_termo(sala: str, motivo: str):
    s = salas_termo.pop(sala, None)
    if not s:
        return
    for p in list(s.get("slots", {}).values()):
        if p and p.get("ws"):
            try:
                await p["ws"].send_json({"tipo": "sala_termo_encerrada", "motivo": motivo})
                await p["ws"].close()
            except Exception:
                pass
    if s.get("countdown_task"):
        try:
            s["countdown_task"].cancel()
        except Exception:
            pass
    log_tela("termo sala encerrada codigo=%s motivo=%s" % (sala, motivo))
    await _notificar_salas_termo_lobby()


async def _notificar_salas_termo_lobby():
    purgar_salas_termo_obsoletas()
    lista = []
    for codigo, s in salas_termo.items():
        if not s.get("publica"):
            continue
        lista.append({
            "sala": codigo,
            "dificuldade": s.get("dificuldade", "facil"),
            "lider": (s.get("slots", {}).get(s.get("lider")) or {}).get("nick", "—"),
            "jogadores": sum(1 for p in s.get("slots", {}).values() if p and p.get("ws")),
            "fase": s.get("fase", "esperando"),
        })
    msg = {"tipo": "salas_termo", "salas": lista}
    for ws in list(conexoes_lobby):
        try:
            await ws.send_json(msg)
        except Exception:
            pass


@router.get("/termo/salas")
async def listar_salas_termo():
    purgar_salas_termo_obsoletas()
    lista = []
    for codigo, s in salas_termo.items():
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


@router.post("/termo/sala/novo")
async def criar_sala_termo(dados: NovaSalaTermo):
    codigo = (dados.codigo or "").strip().lower()
    if codigo and not _codigo_termo_valido(codigo):
        raise HTTPException(status_code=400,
                            detail="Código: 3 a 16 caracteres (letras, números, - ou _).")
    if codigo and codigo in salas_termo:
        raise HTTPException(status_code=409, detail="Já existe uma sala com esse código.")
    dificuldade = dados.dificuldade.lower()
    if dificuldade not in TERMO_TABULEIROS:
        raise HTTPException(status_code=400, detail="Dificuldade inválida.")

    purgar_salas_termo_obsoletas()
    if not codigo:
        while True:
            codigo = secrets.token_urlsafe(6).lower().replace("-", "").replace("_", "")[:10]
            if _codigo_termo_valido(codigo) and codigo not in salas_termo:
                break

    salas_termo[codigo] = {
        "codigo": codigo,
        "publica": bool(dados.publica),
        "dificuldade": dificuldade,
        "max_tentativas": TERMO_TENTATIVAS[dificuldade],
        "secretas": [],
        "lider": "p1",
        "fase": "esperando",
        "slots": {
            "p1": {
                "ws": None, "nome": dados.nome, "nick": dados.nick, "avatar": dados.avatar,
                "tentativas": [], "resolvidos": [], "completou": False, "venceu": False,
            },
            "p2": None,
        },
        "placar": {"p1": 0, "p2": 0},
        "revanche_de": None,
        "countdown_task": None,
        "criado_em": time.time(),
    }
    log_tela("termo sala criada codigo=%s publica=%s dif=%s" % (
        codigo, bool(dados.publica), dificuldade))
    await _notificar_salas_termo_lobby()
    return {"sala": codigo, "publica": bool(dados.publica), "dificuldade": dificuldade}


# ---------------------------------------------------------------------------

# WebSocket — Termo online (1x1 privado, mesma palavra pros dois)
# ---------------------------------------------------------------------------

async def _iniciar_contagem_termo(sala: str):
    s = salas_termo.get(sala)
    if not s or s.get("fase") not in ("esperando", "contagem"):
        return
    s["fase"] = "contagem"
    for n in (3, 2, 1, 0):
        s = salas_termo.get(sala)
        if not s or s.get("fase") != "contagem":
            return
        await broadcast_termo(sala, {"tipo": "contagem", "n": n})
        if n > 0:
            await asyncio.sleep(1)
    s = salas_termo.get(sala)
    if not s or s.get("fase") != "contagem":
        return

    qtd = TERMO_TABULEIROS[s["dificuldade"]]
    max_tentativas = TERMO_TENTATIVAS[s["dificuldade"]]
    s["secretas"] = termo_sortear_palavras(qtd)
    s["max_tentativas"] = max_tentativas
    s["fase"] = "jogando"
    s["revanche_de"] = None
    for p in s.get("slots", {}).values():
        if p:
            p["tentativas"] = []
            p["resolvidos"] = [False] * qtd
            p["completou"] = False
            p["venceu"] = False

    for slot in ("p1", "p2"):
        p = s.get("slots", {}).get(slot)
        if not p or not p.get("ws"):
            continue
        try:
            await p["ws"].send_json({
                "tipo": "inicio_termo",
                "tamanho": TERMO_TAMANHO,
                "tabuleiros": qtd,
                "max_tentativas": max_tentativas,
                "dificuldade": s["dificuldade"],
                "meu_slot": slot,
            })
        except Exception:
            pass


@router.websocket("/ws/termo/{sala}")
@router.websocket("/termo/{sala}")
async def ws_termo(websocket: WebSocket, sala: str):
    await websocket.accept()
    query = websocket.query_params
    nome = query.get("nome", "Anônimo")
    nick = query.get("nick", "Anônimo")
    avatar = query.get("avatar") or None

    s = salas_termo.get(sala)
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
                    "tentativas": [], "resolvidos": [], "completou": False, "venceu": False,
                }
        else:
            slot = "p2"
            if p2 is None:
                s["slots"]["p2"] = {
                    "ws": None, "nome": nome, "nick": nick, "avatar": avatar,
                    "tentativas": [], "resolvidos": [], "completou": False, "venceu": False,
                }

    if s["slots"][slot]:
        s["slots"][slot].update({"nome": nome, "nick": nick, "avatar": avatar})

    s["slots"][slot]["ws"] = websocket

    # Manda pros dois (não só pra quem entrou agora) — senão quem já estava
    # na sala nunca fica sabendo que o oponente chegou.
    for outro_slot in ("p1", "p2"):
        p_out = s["slots"].get(outro_slot)
        if p_out and p_out.get("ws"):
            try:
                await p_out["ws"].send_json(estado_termo_para(s, outro_slot))
            except Exception:
                pass
    await _notificar_salas_termo_lobby()

    if (s.get("fase") == "esperando"
            and s["slots"]["p1"] and s["slots"]["p1"].get("ws")
            and s["slots"]["p2"] and s["slots"]["p2"].get("ws")):
        s["countdown_task"] = asyncio.create_task(_iniciar_contagem_termo(sala))

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                dados = json.loads(raw)
            except Exception:
                continue
            tipo = dados.get("tipo")
            s = salas_termo.get(sala)
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

            if tipo == "tentar":
                if s.get("fase") != "jogando":
                    continue
                p = s["slots"].get(slot)
                if not p or p.get("completou"):
                    continue
                palpite = termo_normalizar(dados.get("palpite", ""))
                if len(palpite) != TERMO_TAMANHO:
                    await websocket.send_json({"tipo": "erro_palpite", "mensagem": "A palavra deve ter 5 letras."})
                    continue
                if palpite not in TERMO_PALAVRAS_VALIDAS:
                    await websocket.send_json({"tipo": "erro_palpite", "mensagem": "Palavra não reconhecida."})
                    continue

                secretas = s.get("secretas") or []
                resultados = [termo_avaliar(palpite, secreta) for secreta in secretas]
                p.setdefault("tentativas", []).append(palpite)
                if not p.get("resolvidos"):
                    p["resolvidos"] = [False] * len(secretas)
                for i, secreta in enumerate(secretas):
                    if palpite == secreta:
                        p["resolvidos"][i] = True

                venceu_agora = all(p["resolvidos"])
                completo = venceu_agora or len(p["tentativas"]) >= s.get("max_tentativas", 6)

                await websocket.send_json({
                    "tipo": "resultado_termo",
                    "palpite": palpite,
                    "resultados": resultados,
                    "resolvidos": p["resolvidos"],
                    "tentativas_usadas": len(p["tentativas"]),
                    "max_tentativas": s.get("max_tentativas", 6),
                    "completo": completo,
                    "venceu": venceu_agora,
                })

                # Só a contagem de tentativas pro adversário — nunca a palavra/cores.
                outro_progresso = "p2" if slot == "p1" else "p1"
                p_outro_progresso = s["slots"].get(outro_progresso)
                if not completo and p_outro_progresso and p_outro_progresso.get("ws"):
                    try:
                        await p_outro_progresso["ws"].send_json({
                            "tipo": "progresso_termo",
                            "slot": slot,
                            "tentativas_usadas": len(p["tentativas"]),
                        })
                    except Exception:
                        pass

                if completo:
                    p["completou"] = True
                    p["venceu"] = venceu_agora
                    if venceu_agora:
                        s["placar"][slot] = s.get("placar", {}).get(slot, 0) + 1
                        creditar_moedas(p.get("nome", ""), MOEDAS_VITORIA_MULTIPLAYER)
                    outro = "p2" if slot == "p1" else "p1"
                    p_outro = s["slots"].get(outro)
                    if p_outro and p_outro.get("ws"):
                        try:
                            await p_outro["ws"].send_json({
                                "tipo": "adversario_terminou",
                                "slot": slot,
                                "nick": p.get("nick", "—"),
                                "venceu": venceu_agora,
                                "jogadores": [info_jogador_termo(s, "p1"), info_jogador_termo(s, "p2")],
                            })
                        except Exception:
                            pass
                    ambos = bool((s["slots"]["p1"] or {}).get("completou")
                                 and (s["slots"]["p2"] or {}).get("completou"))
                    if ambos:
                        # Não encerra a sala aqui — fica em "fim" esperando o
                        # "jogar de novo"/revanche; só some se alguém sair.
                        s["fase"] = "fim"
                        await broadcast_termo(sala, {
                            "tipo": "ambos_acabaram",
                            "palavras": secretas,
                            "placar": s["placar"],
                            "jogadores": [info_jogador_termo(s, "p1"), info_jogador_termo(s, "p2")],
                        })
                continue

            if tipo == "pedir_revanche":
                s["revanche_de"] = slot
                outro = "p2" if slot == "p1" else "p1"
                p_outro = s["slots"].get(outro) or {}
                await broadcast_termo(sala, {
                    "tipo": "revanche_pedida",
                    "por": s["slots"][slot]["nick"],
                    "por_slot": slot,
                    "para": p_outro.get("nick"),
                    "placar": s["placar"],
                    "jogadores": [info_jogador_termo(s, "p1"), info_jogador_termo(s, "p2")],
                })
                continue

            if tipo == "responder_revanche":
                aceitar = bool(dados.get("aceitar"))
                if aceitar and s.get("revanche_de"):
                    s["fase"] = "esperando"
                    s["revanche_de"] = None
                    for p in s.get("slots", {}).values():
                        if p:
                            p["tentativas"] = []
                            p["resolvidos"] = []
                            p["completou"] = False
                            p["venceu"] = False
                    await broadcast_termo(sala, {"tipo": "revanche_aceita"})
                    s["countdown_task"] = asyncio.create_task(_iniciar_contagem_termo(sala))
                else:
                    await broadcast_termo(sala, {"tipo": "revanche_recusada"})
                    await encerrar_sala_termo(sala, "revanche_recusada")
                    break
                continue

            if tipo == "parar":
                await encerrar_sala_termo(sala, "parou")
                break

            if tipo == "sair":
                outro = "p2" if slot == "p1" else "p1"
                p_outro = (s.get("slots", {}) or {}).get(outro)
                if s.get("fase") in ("jogando", "contagem") and p_outro and p_outro.get("ws"):
                    s["slots"][slot]["ws"] = None
                    p_outro["completou"] = True
                    p_outro["venceu"] = True
                    s["placar"][outro] = s["placar"].get(outro, 0) + 1
                    creditar_moedas(p_outro.get("nome", ""), MOEDAS_VITORIA_MULTIPLAYER)
                    s["fase"] = "parcial"
                    try:
                        await p_outro["ws"].send_json({
                            "tipo": "adversario_terminou",
                            "slot": slot,
                            "nick": s["slots"][slot].get("nick", "—"),
                            "desistencia": True,
                            "venceu": False,
                            "placar": s["placar"],
                            "jogadores": [info_jogador_termo(s, "p1"), info_jogador_termo(s, "p2")],
                            "mensagem": "Oponente saiu. Você venceu!",
                        })
                    except Exception:
                        pass
                    await asyncio.sleep(2)
                    await encerrar_sala_termo(sala, "oponente_desistiu")
                    break
                if s.get("lider") == slot:
                    await encerrar_sala_termo(sala, "lider_saiu")
                    break
                s["slots"][slot] = None
                await broadcast_termo(sala, estado_termo_para(s, slot))
                if s.get("fase") not in ("jogando", "contagem"):
                    await encerrar_sala_termo(sala, "saiu_antes_de_jogar")
                    break
                continue

    except (WebSocketDisconnect, Exception):
        pass
    finally:
        s = salas_termo.get(sala)
        if s and s.get("slots", {}).get(slot, {}) is not None and \
                s["slots"][slot] and s["slots"][slot].get("ws") is websocket:
            s["slots"][slot]["ws"] = None
            outro = "p2" if slot == "p1" else "p1"
            p_outro = s.get("slots", {}).get(outro)
            if s.get("fase") in ("jogando", "contagem") and p_outro and p_outro.get("ws") is not None:
                p_outro["completou"] = True
                p_outro["venceu"] = True
                s["placar"][outro] = s["placar"].get(outro, 0) + 1
                creditar_moedas(p_outro.get("nome", ""), MOEDAS_VITORIA_MULTIPLAYER)
                s["fase"] = "parcial"
                try:
                    await p_outro["ws"].send_json({
                        "tipo": "adversario_terminou",
                        "slot": slot,
                        "desistencia": True,
                        "venceu": False,
                        "placar": s["placar"],
                        "jogadores": [info_jogador_termo(s, "p1"), info_jogador_termo(s, "p2")],
                        "mensagem": "Oponente saiu. Você venceu!",
                    })
                except Exception:
                    pass
                await asyncio.sleep(2)
                await encerrar_sala_termo(sala, "oponente_desistiu")
            elif s.get("lider") == slot:
                if s.get("fase") == "jogando" and p_outro and p_outro.get("ws"):
                    p_outro["completou"] = True
                    p_outro["venceu"] = True
                    s["placar"][outro] = s["placar"].get(outro, 0) + 1
                    creditar_moedas(p_outro.get("nome", ""), MOEDAS_VITORIA_MULTIPLAYER)
                    s["fase"] = "parcial"
                    try:
                        await p_outro["ws"].send_json({
                            "tipo": "adversario_terminou",
                            "slot": slot,
                            "desistencia": True,
                            "venceu": False,
                            "placar": s["placar"],
                            "jogadores": [info_jogador_termo(s, "p1"), info_jogador_termo(s, "p2")],
                            "mensagem": "O líder saiu. Você venceu!",
                        })
                    except Exception:
                        pass
                    await asyncio.sleep(2)
                    await encerrar_sala_termo(sala, "lider_desconectou")
                else:
                    await encerrar_sala_termo(sala, "lider_desconectou")
            else:
                await broadcast_termo(sala, estado_termo_para(s, slot))
                if s.get("fase") == "jogando":
                    await encerrar_sala_termo(sala, "oponente_desconectou")
                elif s.get("fase") == "esperando":
                    pass
                await _notificar_salas_termo_lobby()


# ---------------------------------------------------------------------------
