"""Persistência e ranking de recordes — compartilhado por todos os jogos."""
from typing import Optional

from shared.config import ARQUIVO_RECORDES
from shared.db import carregar_json, salvar_json

# ---------------------------------------------------------------------------
# Recordes — persistência
# ---------------------------------------------------------------------------

def carregar_recordes() -> dict:
    dados = carregar_json("jjogos:recordes", ARQUIVO_RECORDES)
    dados.setdefault("sudoku", {"facil": [], "medio": [], "dificil": []})
    dados.setdefault("velha", {"facil": [], "medio": [], "dificil": []})
    dados.setdefault("velha_vitorias", [])
    dados.setdefault("ludo_vitorias", [])
    dados.setdefault("campo_minado", {"facil": [], "medio": [], "dificil": []})
    dados.setdefault("campo_minado_vitorias", [])
    dados.setdefault("termo_vitorias", [])
    return dados


def salvar_recordes(recordes: dict) -> None:
    salvar_json("jjogos:recordes", recordes, ARQUIVO_RECORDES)


def eh_anonimo(nick: str) -> bool:
    """Anônimo não entra em rankings nem conta vitórias."""
    return (nick or "").strip().lower() in {"anônimo", "anonimo"}


def com_cosmeticos(registros: list) -> list:
    """Cópias dos registros com a decoração/cor/fonte equipadas HOJE por cada
    jogador (cópia pra não gravar isso dentro dos recordes por acidente)."""
    from shared.economia import cosmeticos_de_varios  # economia importa este módulo
    try:
        cosmeticos = cosmeticos_de_varios([r.get("nome") for r in registros])
    except Exception:
        cosmeticos = {}
    return [dict(r, cosmeticos=cosmeticos.get(r.get("nome")) or {}) for r in registros]


def ranking_top(registros: list, chave: str, reverse: bool, limite: int = 3) -> list:
    filtrados = [r for r in registros if not eh_anonimo(str(r.get("nick", "")))]
    return com_cosmeticos(sorted(filtrados, key=lambda r: r.get(chave, 0), reverse=reverse)[:limite])


def ranking_vitorias(lista: list, dificuldade: Optional[str] = None,
                     limite: int = 10) -> list:
    """Top vitórias; se dificuldade informada, filtra por ela."""
    filtrados = []
    for r in lista:
        if eh_anonimo(str(r.get("nick", ""))):
            continue
        if dificuldade and r.get("dificuldade") not in (None, dificuldade):
            continue
        filtrados.append(r)
    return com_cosmeticos(sorted(filtrados, key=lambda r: r.get("vitorias", 0),
                                 reverse=True)[:limite])


def _registrar_vitoria(lista: list, nick: str, nome: str,
                       avatar: Optional[str], dificuldade: str,
                       tempo: Optional[int] = None) -> list:
    """Incrementa vitória do jogador na dificuldade (mesma lista plana)."""
    for v in lista:
        if (v.get("nick") == nick and v.get("nome") == nome
                and v.get("dificuldade") == dificuldade):
            v["vitorias"] = v.get("vitorias", 0) + 1
            if avatar:
                v["avatar"] = avatar
            if tempo and tempo > 0:
                anterior = v.get("melhor_tempo")
                if not anterior or tempo < anterior:
                    v["melhor_tempo"] = tempo
            return sorted(lista, key=lambda r: r.get("vitorias", 0),
                          reverse=True)[:50]
    novo = {"nick": nick, "nome": nome, "vitorias": 1,
            "dificuldade": dificuldade}
    if avatar:
        novo["avatar"] = avatar
    if tempo and tempo > 0:
        novo["melhor_tempo"] = tempo
    lista.append(novo)
    return sorted(lista, key=lambda r: r.get("vitorias", 0), reverse=True)[:50]


