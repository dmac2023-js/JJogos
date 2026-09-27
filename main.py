"""Jogos no Discord — ponto de entrada da aplicação FastAPI.

O código de cada jogo mora em routers/<jogo>.py (modelos, estado em memória,
endpoints REST e WebSocket). O que é compartilhado entre jogos (config,
persistência de recordes, log, lista de conexões do lobby) mora em shared/.
Aqui só criamos o app, registramos as rotas de cada jogo e, por último,
servimos os arquivos estáticos (precisa ser o último — é um catch-all)."""
from fastapi import FastAPI, Request
from starlette.responses import FileResponse

from shared.config import PASTA_STATIC

app = FastAPI(title="Jogos no Discord")


@app.middleware("http")
async def liberar_embed_discord(request: Request, call_next):
    if request.scope["type"] != "http":
        return await call_next(request)
    if request.method == "OPTIONS":
        from starlette.responses import Response
        response = Response(status_code=204)
    else:
        response = await call_next(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "*"
    # O proxy da Discloud injeta X-Frame-Options: DENY, que mataria o iframe da
    # Activity. Não dá pra removê-lo daqui (ele é adicionado depois de nós), mas
    # o Chromium ignora XFO quando há CSP frame-ancestors — e o cliente do
    # Discord é Chromium. Então declaramos frame-ancestors explicitamente.
    response.headers.pop("x-frame-options", None)
    response.headers["Content-Security-Policy"] = (
        "frame-ancestors https://discord.com https://*.discord.com "
        "https://*.discordsays.com"
    )
    response.headers["Permissions-Policy"] = (
        "camera=(self), microphone=(self), display-capture=(self), "
        "geolocation=(), payment=()"
    )
    return response


from routers import auth, economia, perfil, sudoku, velha, ludo, campo, termo, tela, lobby, clickj, splano  # noqa: E402

app.include_router(auth.router)
app.include_router(clickj.router)
app.include_router(splano.router)
app.include_router(economia.router)
app.include_router(perfil.router)
app.include_router(sudoku.router)
app.include_router(velha.router)
app.include_router(ludo.router)
app.include_router(campo.router)
app.include_router(termo.router)
app.include_router(tela.router)
app.include_router(lobby.router)


# ---------------------------------------------------------------------------
# Static files (por último, mas só HTTP GET — NÃO captura WebSocket)
# ---------------------------------------------------------------------------

@app.get("/{caminho:path}")
@app.get("/")
async def servir_estatico(caminho: str = ""):
    arquivo = PASTA_STATIC / caminho
    if caminho and arquivo.is_file():
        # JS/CSS sempre vêm com ?v=... (cache-busting manual a cada mudança) —
        # dá pra cachear "para sempre" sem risco de servir versão velha, o que
        # corta round-trips de revalidação a cada load (crítico no mobile,
        # onde a Activity tem pouco tempo pra terminar de carregar).
        cabecalhos = {}
        if arquivo.suffix in (".js", ".css"):
            cabecalhos["Cache-Control"] = "public, max-age=31536000, immutable"
        return FileResponse(arquivo, headers=cabecalhos)
    # HTML nunca fica no cache: aba antiga do transmissor sem o encoder novo
    # era a causa de "host conectou mas não chega vídeo" na Activity.
    return FileResponse(PASTA_STATIC / "index.html",
                        headers={"Cache-Control": "no-cache, must-revalidate"})


# ---------------------------------------------------------------------------
# Execução direta: `python main.py`
# ---------------------------------------------------------------------------
# A Discloud roteia o proxy do subdomínio para a porta 8080 em 0.0.0.0 — é
# fixo, não existe $PORT lá. Render/Railway injetam $PORT, então lemos a env
# com 8080 de padrão e o mesmo arquivo serve pros dois.
if __name__ == "__main__":
    import os

    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
