"""Conexões WebSocket do lobby (/ws/lobby) — todo jogo com salas públicas
notifica essa lista quando uma sala é criada/encerrada."""
from typing import List

from fastapi import WebSocket

conexoes_lobby: List[WebSocket] = []
