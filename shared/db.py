"""Persistência de dados (recordes, economia) — usa Upstash Redis (REST) em
produção quando configurado via variável de ambiente, e cai pra um arquivo
JSON local (útil pra rodar sem depender de conta nenhuma) quando não está.

Sem isso, tudo que o servidor grava (recordes, moedas) some a cada deploy no
Render, porque o disco do serviço web é efêmero."""
import json
from pathlib import Path
from typing import Any, Optional

import requests

from shared.config import UPSTASH_REDIS_REST_TOKEN, UPSTASH_REDIS_REST_URL


def usando_redis() -> bool:
    return bool(UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN)


def _headers() -> dict:
    return {"Authorization": "Bearer " + UPSTASH_REDIS_REST_TOKEN}


def redis_get(chave: str) -> Optional[str]:
    resposta = requests.get(
        f"{UPSTASH_REDIS_REST_URL}/get/{chave}", headers=_headers(), timeout=10
    )
    resposta.raise_for_status()
    return resposta.json().get("result")


def redis_set(chave: str, valor: str) -> None:
    resposta = requests.post(
        f"{UPSTASH_REDIS_REST_URL}/set/{chave}",
        headers=_headers(),
        data=valor.encode("utf-8"),
        timeout=10,
    )
    resposta.raise_for_status()


def carregar_json(chave: str, arquivo_local: Path) -> dict:
    """Lê um blob JSON pela chave no Redis (produção) ou do arquivo local
    (dev/fallback). Nunca lança — retorna {} se não existir nada ainda."""
    if usando_redis():
        try:
            bruto = redis_get(chave)
            return json.loads(bruto) if bruto else {}
        except Exception:
            return {}
    if arquivo_local.exists():
        with open(arquivo_local, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def salvar_json(chave: str, dados: dict, arquivo_local: Path) -> None:
    if usando_redis():
        redis_set(chave, json.dumps(dados, ensure_ascii=False))
        return
    with open(arquivo_local, "w", encoding="utf-8") as f:
        json.dump(dados, f, ensure_ascii=False, indent=2)
