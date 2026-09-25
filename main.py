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
    response.headers["Permissions-Policy"] = (
        "camera=(self), microphone=(self), display-capture=(self), "
        "geolocation=(), payment=()"
    )
    return response


from routers import auth, economia, perfil, sudoku, velha, ludo, campo, termo, tela, lobby  # noqa: E402

app.include_router(auth.router)
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
        return FileResponse(arquivo)
    # HTML nunca fica no cache: aba antiga do transmissor sem o encoder novo
    # era a causa de "host conectou mas não chega vídeo" na Activity.
    return FileResponse(PASTA_STATIC / "index.html",
                        headers={"Cache-Control": "no-cache, must-revalidate"})
