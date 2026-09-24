"""Partidas solo por jogo_id — histórico: Sudoku, Jogo da Velha (vs máquina) e
Campo Minado (solo) usam esse mesmo dicionário desde antes de existir um
módulo por jogo, então continua compartilhado pra não duplicar estado."""
from typing import Dict

jogos: Dict[str, dict] = {}
