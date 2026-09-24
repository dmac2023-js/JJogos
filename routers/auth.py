"""Autenticação Discord (OAuth2 do site + verificação de interactions) e
endpoints utilitários (/saude, /config, /jogos)."""
import json
import os
from typing import Optional

import requests
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from shared.config import (
    DISCORD_APPLICATION_ID,
    DISCORD_CLIENT_SECRET,
    DISCORD_PUBLIC_KEY,
    HAS_CRYPTOGRAPHY,
    OAUTH_REDIRECT_PADRAO,
)

if HAS_CRYPTOGRAPHY:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

router = APIRouter()


class CodigoAutorizacao(BaseModel):
    code: str
    redirect_uri: Optional[str] = None
    # true = fluxo da Activity (SDK authorize): NÃO enviar redirect_uri
    # (o authorize do Embedded SDK não usa um — fallback quebraria a troca).
    activity: bool = False


class RefreshTokenRequest(BaseModel):
    refresh_token: str


# ---------------------------------------------------------------------------
# Endpoints — saúde / config / auth
# ---------------------------------------------------------------------------

@router.get("/saude")
def saude():
    return {"online": True}


@router.get("/config")
def configuracao_publica():
    return {
        "application_id": DISCORD_APPLICATION_ID,
        "redirect_uri": os.getenv("OAUTH_REDIRECT_URI", "").strip() or None,
    }


async def discord_interactions(request: Request):
    body = await request.body()
    signature = request.headers.get("X-Signature-Ed25519", "")
    timestamp = request.headers.get("X-Signature-Timestamp", "")

    if HAS_CRYPTOGRAPHY and DISCORD_PUBLIC_KEY:
        try:
            public_key = Ed25519PublicKey.from_public_bytes(bytes.fromhex(DISCORD_PUBLIC_KEY))
            message = timestamp.encode() + body
            public_key.verify(bytes.fromhex(signature), message)
        except Exception:
            raise HTTPException(status_code=401, detail="Invalid request signature")

    payload = json.loads(body)

    if payload.get("type") == 1:
        return {"type": 1}

    return {"type": 4, "data": {"content": "Este jogo só funciona dentro do Discord Activity!", "flags": 64}}

router.add_api_route("/api/discord/interactions", discord_interactions, methods=["POST"])
router.add_api_route("/discord/interactions", discord_interactions, methods=["POST"])


@router.post("/token")
def trocar_codigo_por_token(dados: CodigoAutorizacao):
    if not DISCORD_APPLICATION_ID or not DISCORD_CLIENT_SECRET:
        raise HTTPException(status_code=500, detail="As credenciais do Discord não foram configuradas.")

    # O Discord exige que o redirect_uri do token bata exatamente com o usado
    # no authorize. Login do site: envia o mesmo valor (fallback env/padrão).
    # Activity (SDK authorize): não usa redirect_uri — não incluir na troca.
    payload = {
        "client_id": DISCORD_APPLICATION_ID,
        "client_secret": DISCORD_CLIENT_SECRET,
        "grant_type": "authorization_code",
        "code": dados.code,
    }
    if not dados.activity:
        redirect_uri = ((dados.redirect_uri or "").strip()
                        or os.getenv("OAUTH_REDIRECT_URI", "").strip()
                        or OAUTH_REDIRECT_PADRAO)
        payload["redirect_uri"] = redirect_uri

    resposta = requests.post(
        "https://discord.com/api/oauth2/token",
        data=payload,
        timeout=15,
    )

    if resposta.status_code != 200:
        try:
            corpo = resposta.json()
            motivo = corpo.get("error_description") or corpo.get("error") or resposta.text[:200]
        except Exception:
            motivo = resposta.text[:200]
        raise HTTPException(status_code=400, detail="Discord recusou o login: " + str(motivo))

    token_data = resposta.json()

    # Busca o perfil (@me) aqui no servidor. Dentro da Activity, o iframe é
    # restrito às URLs mapeadas no portal (Root Mapping / URL Mappings) — um
    # fetch do cliente direto para discord.com trava sem erro visível e a
    # tela nunca sai de "Modo navegador". Fazendo aqui não há esse limite.
    try:
        resposta_me = requests.get(
            "https://discord.com/api/users/@me",
            headers={"Authorization": "Bearer " + token_data["access_token"]},
            timeout=15,
        )
        resposta_me.raise_for_status()
        token_data["user"] = resposta_me.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Não foi possível obter o perfil do Discord.")

    return token_data


@router.post("/token/refresh")
def renovar_token(dados: RefreshTokenRequest):
    if not DISCORD_APPLICATION_ID or not DISCORD_CLIENT_SECRET:
        raise HTTPException(status_code=500, detail="As credenciais do Discord não foram configuradas.")

    resposta = requests.post(
        "https://discord.com/api/oauth2/token",
        data={
            "client_id": DISCORD_APPLICATION_ID,
            "client_secret": DISCORD_CLIENT_SECRET,
            "grant_type": "refresh_token",
            "refresh_token": dados.refresh_token,
        },
        timeout=15,
    )

    if resposta.status_code != 200:
        raise HTTPException(status_code=400, detail="Não foi possível renovar a sessão.")

    return resposta.json()


# ---------------------------------------------------------------------------
# Endpoints — jogos disponíveis
# ---------------------------------------------------------------------------

@router.get("/jogos")
def listar_jogos():
    return [
        {
            "id": "sudoku",
            "nome": "Sudoku",
            "descricao": "Complete a grade 9×9 com números de 1 a 9.",
        },
        {
            "id": "velha",
            "nome": "Jogo da Velha",
            "descricao": "Jogo clássico 3×3 contra a máquina ou outros jogadores.",
        },
        {
            "id": "campo",
            "nome": "Campo Minado",
            "descricao": "Solo contra o tempo ou 1x1 online — quem limpar primeiro vence.",
        },
    ]
