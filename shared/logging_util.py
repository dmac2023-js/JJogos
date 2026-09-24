"""Log simples usado por todas as salas online pra registrar eventos."""


def log_tela(mensagem: str) -> None:
    print("[tela] " + mensagem, flush=True)
