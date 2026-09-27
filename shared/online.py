"""Quantas pessoas estão em cada jogo agora.

Cada jogo guarda suas conexões de um jeito (uns por sala com "slots", outros
por lista de WebSocket, o ClickJ por nome), então a contagem mora aqui, num
lugar só, em vez de espalhada pelo lobby. Tudo é lido de estruturas em
memória: é uma foto do processo, não vai ao Redis.

Nada aqui pode levantar exceção — é um enfeite da tela inicial, e um jogo com
estrutura inesperada não pode derrubar a contagem dos outros.
"""
from typing import Callable, Dict, List, Tuple

# Rótulo que o front usa pra casar com o cartão do jogo (o id do botão é
# "jogo-<chave>").
JOGOS: List[Tuple[str, str]] = [
    ("sudoku", "Sudoku"),
    ("velha", "Jogo da Velha"),
    ("ludo", "Ludo"),
    ("campo", "Campo Minado"),
    ("termo", "Termo"),
    ("clickj", "ClickJ"),
    ("splano", "Splano.io"),
    ("tela", "Compartilhar Tela"),
]


def _por_slots(salas: dict) -> int:
    """Sudoku, Ludo, Campo e Termo: sala com "slots", cada um com seu ws."""
    return sum(1 for sala in list(salas.values())
               for p in list((sala or {}).get("slots", {}).values())
               if p and p.get("ws"))


def _contadores() -> Dict[str, Callable[[], int]]:
    # Importar aqui dentro evita import circular (os routers importam shared).
    from routers.campo import salas_campo
    from routers.clickj import conexoes as conexoes_clickj
    from routers.ludo import salas_ludo
    from routers.splano import salas as salas_splano
    from routers.sudoku import salas_sudoku
    from routers.tela import salas_multi, salas_tela
    from routers.termo import salas_termo
    from routers.velha import conexoes_ws as conexoes_velha

    def tela() -> int:
        # Quem transmite + quem assiste + quem está numa sala multi.
        total = 0
        for sala in list(salas_tela.values()):
            if (sala or {}).get("host_ws"):
                total += 1
            total += len((sala or {}).get("viewers", {}))
        for sala in list(salas_multi.values()):
            total += len((sala or {}).get("membros", {}))
        return total

    def splano() -> int:
        return sum(len((sala or {}).get("conexoes", {})) for sala in list(salas_splano.values()))

    return {
        "sudoku": lambda: _por_slots(salas_sudoku),
        "velha": lambda: sum(len(v or []) for v in list(conexoes_velha.values())),
        "ludo": lambda: _por_slots(salas_ludo),
        "campo": lambda: _por_slots(salas_campo),
        "termo": lambda: _por_slots(salas_termo),
        "clickj": lambda: len(conexoes_clickj),
        "splano": splano,
        "tela": tela,
    }


def contagem() -> dict:
    """{"jogos": [{chave, nome, online}], "total": n}. Jogo que falhar conta 0
    em vez de derrubar a resposta inteira."""
    try:
        contadores = _contadores()
    except Exception:
        contadores = {}
    jogos = []
    for chave, nome in JOGOS:
        try:
            quantos = int(contadores[chave]())
        except Exception:
            quantos = 0
        jogos.append({"chave": chave, "nome": nome, "online": max(0, quantos)})
    return {"jogos": jogos, "total": sum(j["online"] for j in jogos)}
