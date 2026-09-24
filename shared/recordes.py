"""Persistência e ranking de recordes — compartilhado por todos os jogos."""
import json
from typing import Optional

from shared.config import ARQUIVO_RECORDES

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
    dados.setdefault("ludo_vitorias", [])
    dados.setdefault("campo_minado", {"facil": [], "medio": [], "dificil": []})
    dados.setdefault("campo_minado_vitorias", [])
    dados.setdefault("termo_vitorias", [])
    return dados


def salvar_recordes(recordes: dict) -> None:
    with open(ARQUIVO_RECORDES, "w", encoding="utf-8") as f:
        json.dump(recordes, f, ensure_ascii=False, indent=2)


def eh_anonimo(nick: str) -> bool:
    """Anônimo não entra em rankings nem conta vitórias."""
    return (nick or "").strip().lower() in {"anônimo", "anonimo"}


def ranking_top(registros: list, chave: str, reverse: bool, limite: int = 3) -> list:
    filtrados = [r for r in registros if not eh_anonimo(str(r.get("nick", "")))]
    return sorted(filtrados, key=lambda r: r.get(chave, 0), reverse=reverse)[:limite]


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
    return sorted(filtrados, key=lambda r: r.get("vitorias", 0),
                  reverse=True)[:limite]


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


