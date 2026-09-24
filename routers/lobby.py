"""WebSocket do lobby — manda o estado inicial das salas públicas de cada
jogo assim que alguém conecta (atualizações depois disso vêm dos próprios
módulos de cada jogo, via shared.lobby_state.conexoes_lobby)."""
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from routers.campo import purgar_salas_campo_obsoletas, salas_campo
from routers.ludo import purgar_salas_ludo_obsoletas, salas_ludo
from routers.tela import listar_salas_multi_publicas
from routers.velha import transmitir_salas_lobby
from shared.lobby_state import conexoes_lobby

router = APIRouter()


@router.websocket("/ws/lobby")
@router.websocket("/lobby")
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
