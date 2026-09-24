"""Perfil — recordes pessoais do jogador em todos os jogos."""
from fastapi import APIRouter

from shared.recordes import carregar_recordes, eh_anonimo

router = APIRouter()


@router.get("/perfil/recordes")
def obter_recordes_perfil(nome: str = "", nick: str = ""):
    """Agrega os recordes do jogador (identificado por nome/nick) em cada jogo."""
    if not (nome or nick) or eh_anonimo(nick):
        return {"sudoku": {}, "velha": {}, "campo_minado": {}, "ludo": None, "termo": {}}

    def eh_jogador(r: dict) -> bool:
        if nome and r.get("nome") == nome:
            return True
        return bool(nick) and not nome and r.get("nick") == nick

    def melhor_tempo_por_dificuldade(grupos: dict) -> dict:
        resultado = {}
        for dificuldade, lista in grupos.items():
            proprios = [r for r in lista if eh_jogador(r)]
            if proprios:
                melhor = min(proprios, key=lambda r: r.get("tempo_segundos", 10 ** 9))
                resultado[dificuldade] = {"tempo_segundos": melhor.get("tempo_segundos")}
        return resultado

    def vitorias_por_dificuldade(lista: list) -> dict:
        resultado = {}
        for r in lista:
            if eh_jogador(r):
                dif = r.get("dificuldade") or "geral"
                resultado[dif] = {
                    "vitorias": r.get("vitorias", 0),
                    "melhor_tempo": r.get("melhor_tempo"),
                }
        return resultado

    recordes = carregar_recordes()

    sudoku = melhor_tempo_por_dificuldade(recordes.get("sudoku", {}))
    velha = vitorias_por_dificuldade(recordes.get("velha_vitorias", []))
    campo_minado = {
        "tempos": melhor_tempo_por_dificuldade(recordes.get("campo_minado", {})),
        "vitorias": vitorias_por_dificuldade(recordes.get("campo_minado_vitorias", [])),
    }
    ludo = None
    for r in recordes.get("ludo_vitorias", []):
        if eh_jogador(r):
            ludo = {"vitorias": r.get("vitorias", 0)}
            break

    termo = vitorias_por_dificuldade(recordes.get("termo_vitorias", []))

    return {"sudoku": sudoku, "velha": velha, "campo_minado": campo_minado, "ludo": ludo, "termo": termo}
