"""Configuração compartilhada: variáveis de ambiente, caminhos de arquivo."""
import os
from pathlib import Path

from dotenv import load_dotenv

try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    from cryptography.exceptions import InvalidSignature
    HAS_CRYPTOGRAPHY = True
except ImportError:
    HAS_CRYPTOGRAPHY = False


load_dotenv()

# .parent.parent: sai de shared/ e volta pra raiz do projeto.
PASTA_BASE = Path(__file__).resolve().parent.parent
PASTA_STATIC = PASTA_BASE / "static"
ARQUIVO_RECORDES = PASTA_BASE / "recordes.json"
ARQUIVO_TERMO_PALAVRAS_VALIDAS = PASTA_BASE / "termo_palavras_validas.txt"
DISCORD_APPLICATION_ID = os.getenv("DISCORD_APPLICATION_ID", "")
DISCORD_CLIENT_SECRET = os.getenv("DISCORD_CLIENT_SECRET", "")
DISCORD_PUBLIC_KEY = os.getenv("DISCORD_PUBLIC_KEY", "")
OAUTH_REDIRECT_PADRAO = "https://jogos7.onrender.com/auth/callback"
