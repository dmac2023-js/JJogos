"""Compartilhar Tela — transmissão (host/espectador) e sala multi-tela
(grade de lives). As duas features moram juntas porque são fortemente
acopladas: uma transmissão pode pertencer a uma sala multi-tela, então
encerrar/iniciar uma mexe no estado da outra."""
import asyncio
import json
import re
import secrets
import time
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from shared.lobby_state import conexoes_lobby
from shared.logging_util import log_tela

router = APIRouter()


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


# sala -> {"host_ws", "host_nick", "host_avatar", "publica", "instancia",
#          "resolucao", "fps", "viewers": {id: WebSocket},
#          "viewers_info": {id: {"nick", "avatar", "logado"}}}
salas_tela: Dict[str, dict] = {}


# Sala multi-tela: código -> membros + lives (até 8) 720p30 fixo.
# Vive enquanto houver pelo menos 1 membro com WS.
salas_multi: Dict[str, dict] = {}
MAX_LIVES_MULTI = 8
SALA_MULTI_SEM_MEMBRO_SEGUNDOS = 90


# Compartilhar Tela — salas (sinalização WebRTC)
# ---------------------------------------------------------------------------

RESOLUCOES_VALIDAS = {"480p", "720p", "1080p"}
FPS_VALIDOS = {30, 60}
MAX_ESPECTADORES_TELA = 9
SALA_TELA_SEM_HOST_SEGUNDOS = 90




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


@router.post("/tela/novo")
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


@router.get("/tela/transmissoes")
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


@router.get("/tela/sala/{sala}")
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


@router.websocket("/ws/tela/{sala}")
@router.websocket("/tela/{sala}")
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

@router.post("/multitela/novo")
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


@router.get("/multitela/salas")
async def listar_salas_multi():
    return {"salas": await listar_salas_multi_publicas()}


@router.get("/multitela/sala/{codigo}")
async def obter_sala_multi(codigo: str):
    codigo = (codigo or "").strip().lower()
    s = salas_multi.get(codigo)
    if not s:
        raise HTTPException(status_code=404, detail="Sala multi-tela não encontrada.")
    return info_sala_multi(codigo, s)


@router.websocket("/ws/multitela/{codigo}")
@router.websocket("/multitela/{codigo}")
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
