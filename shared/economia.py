"""Moedas, loja de decorações de avatar e cor do nick.

Carteira é indexada por "nome" (o username do Discord, já usado como chave
única em todo o app pra recordes/vitórias) — quem não está logado com
Discord (anônimo) não ganha nem gasta moeda nenhuma.
"""
import hashlib
import json
import secrets
import threading
import time
from pathlib import Path
from typing import Optional

from shared.config import ARQUIVO_ECONOMIA, PASTA_BASE
from shared.db import carregar_json, salvar_json
from shared.recordes import eh_anonimo

CHAVE_ECONOMIA = "jjogos:economia"

# Todo mundo começa com esse saldo — quem entra pela primeira vez já tem com
# que mexer na loja e na roleta sem precisar farmar do zero.
SALDO_INICIAL = 100

# Toda leitura+alteração+gravação da carteira (o blob inteiro de TODOS os
# jogadores) precisa passar por aqui. carregar_economia()/salvar_economia()
# leem e reescrevem o dicionário inteiro sem merge — duas gravações
# concorrentes (ex: comprar na loja enquanto converte Jcoins no ClickJ, ou
# duas pessoas comprando ao mesmo tempo) faziam uma sobrescrever a outra e
# "sumir" moedas/itens. Um único lock global serializa todo write.
LOCK_ECONOMIA = threading.Lock()

BONUS_INTERVALO_SEGUNDOS = 15 * 60
BONUS_QUANTIDADE = 5
PRECO_DECORACAO = 400  # valor médio, usado só como prêmio de roleta (preço real varia por item)
PRECOS_DECORACAO_NIVEIS = [300, 350, 400, 450, 500]
PRECO_COR_NICK = 400
PRECO_FONTE_NICK = 500


def _preco_decoracao(sku_id: str) -> int:
    # Preço fixo por item (determinístico a partir do sku_id), variando entre
    # os níveis de PRECOS_DECORACAO_NIVEIS — não muda a cada carregamento.
    indice = int(hashlib.md5(str(sku_id).encode("utf-8")).hexdigest(), 16) % len(PRECOS_DECORACAO_NIVEIS)
    return PRECOS_DECORACAO_NIVEIS[indice]


HISTORICO_MAXIMO = 10

# id -> nome exibido na loja (o visual de cada uma fica em .nick-fonte-<id> no css).
FONTES_NICK = {
    "negrito": "Negrito",
    "italico": "Itálico",
    "mono": "Monoespaçada",
    "serifa": "Serifada",
    "cursiva": "Cursiva",
    "impacto": "Impacto",
    "versalete": "Versalete",
    "espacada": "Espaçada",
}

# Moedas por vitória — cada jogo tem sua própria tabela (por dificuldade,
# quando aplicável). Online sempre paga mais que o modo solo/vs-máquina.
MOEDAS_SUDOKU_SOLO = {"facil": 5, "medio": 10, "dificil": 15}
MOEDAS_SUDOKU_ONLINE = {"facil": 10, "medio": 20, "dificil": 30}

MOEDAS_VELHA_SOLO = 1
MOEDAS_VELHA_ONLINE = 5

MOEDAS_TERMO_SOLO = {"facil": 2, "medio": 5, "dificil": 10}
MOEDAS_TERMO_ONLINE = {"facil": 5, "medio": 10, "dificil": 15}

MOEDAS_CAMPO_SOLO = {"facil": 2, "medio": 5, "dificil": 10}
MOEDAS_CAMPO_ONLINE = {"facil": 5, "medio": 10, "dificil": 15}

# Ludo não tem modo solo nem dificuldade — todo mundo que participa até o
# fim da partida ganha a moeda de participação; quem vence some MAIS a
# moeda de vitória por cima.
MOEDAS_LUDO_VITORIA = 20
MOEDAS_LUDO_PARTICIPACAO = 5

# label em português -> valor CSS (usado pelo front pra colorir o nick).
CORES_NICK = {
    "azul": "#5b9dff",
    "verde": "#7ddea3",
    "vermelho": "#ff8a8a",
    "amarelo": "#ffd36a",
    "roxo": "#c9a6ff",
    "rosa": "#ff9ecf",
    "laranja": "#ffab66",
    "ciano": "#7ef0e0",
    "arco-iris": None,  # animação (ver .nick-arco-iris no css), não é cor fixa
}

# --- Skins do Splano.io -----------------------------------------------------
# padrao: como o círculo é pintado no canvas.
#   solido    -> uma cor só
#   listras   -> faixas horizontais alternando as cores
#   vertical  -> faixas verticais alternando as cores
#   faixa     -> cor de fundo com uma faixa diagonal da segunda cor
#   rainbow   -> matiz girando (animada)
#   imagem    -> o próprio jogador escolhe a imagem (url na carteira)
PRECO_SKIN_SPLANO = 1000
PRECO_SKIN_SPLANO_IMAGEM = 2000
PRECO_SKIN_SPLANO_RAINBOW = 1500

def _skin(nome, grupo, cores, padrao="solido"):
    return {"nome": nome, "grupo": grupo, "cores": cores, "padrao": padrao}


SKINS_SPLANO = {
    # Cores simples
    "azul": _skin("Azul", "cores", ["#3b82f6"]),
    "verde": _skin("Verde", "cores", ["#22c55e"]),
    "vermelho": _skin("Vermelho", "cores", ["#ef4444"]),
    "amarelo": _skin("Amarelo", "cores", ["#facc15"]),
    "roxo": _skin("Roxo", "cores", ["#a855f7"]),
    "rosa": _skin("Rosa", "cores", ["#ec4899"]),
    "laranja": _skin("Laranja", "cores", ["#fb923c"]),
    "ciano": _skin("Ciano", "cores", ["#22d3ee"]),
    "branco": _skin("Branco", "cores", ["#e8edf7"]),
    "preto": _skin("Preto", "cores", ["#2b2f3a"]),
    "dourado": _skin("Dourado", "cores", ["#e0a526"]),
    "lima": _skin("Lima", "cores", ["#a3e635"]),
    # Times brasileiros
    "flamengo": _skin("Flamengo", "times_br", ["#d50000", "#141414"], "listras"),
    "corinthians": _skin("Corinthians", "times_br", ["#141414", "#f2f2f2"], "vertical"),
    "palmeiras": _skin("Palmeiras", "times_br", ["#046a38"], "solido"),
    "sao-paulo": _skin("São Paulo", "times_br", ["#f2f2f2", "#d50000"], "faixa"),
    "vasco": _skin("Vasco", "times_br", ["#141414", "#f2f2f2"], "faixa"),
    "gremio": _skin("Grêmio", "times_br", ["#0d80bf", "#141414"], "vertical"),
    "internacional": _skin("Internacional", "times_br", ["#c8102e"], "solido"),
    "cruzeiro": _skin("Cruzeiro", "times_br", ["#1b3f94"], "solido"),
    "atletico-mg": _skin("Atlético-MG", "times_br", ["#141414", "#f2f2f2"], "vertical"),
    "santos": _skin("Santos", "times_br", ["#f2f2f2", "#141414"], "listras"),
    "botafogo": _skin("Botafogo", "times_br", ["#141414", "#f2f2f2"], "vertical"),
    "fluminense": _skin("Fluminense", "times_br", ["#7a1e38", "#046a38"], "vertical"),
    "bahia": _skin("Bahia", "times_br", ["#0d80bf", "#d50000"], "listras"),
    "vitoria": _skin("Vitória", "times_br", ["#d50000", "#141414"], "vertical"),
    # Times internacionais
    "real-madrid": _skin("Real Madrid", "times_int", ["#f4f6ff", "#d4af37"], "faixa"),
    "barcelona": _skin("Barcelona", "times_int", ["#1c3a94", "#a50044"], "vertical"),
    "man-united": _skin("Man. United", "times_int", ["#da291c"], "solido"),
    "man-city": _skin("Man. City", "times_int", ["#6cabdd"], "solido"),
    "liverpool": _skin("Liverpool", "times_int", ["#c8102e"], "solido"),
    "chelsea": _skin("Chelsea", "times_int", ["#034694"], "solido"),
    "arsenal": _skin("Arsenal", "times_int", ["#ef0107", "#f2f2f2"], "faixa"),
    "bayern": _skin("Bayern", "times_int", ["#dc052d"], "solido"),
    "juventus": _skin("Juventus", "times_int", ["#f2f2f2", "#141414"], "vertical"),
    "milan": _skin("Milan", "times_int", ["#fb090b", "#141414"], "vertical"),
    "inter-milao": _skin("Inter de Milão", "times_int", ["#0068a8", "#141414"], "vertical"),
    "psg": _skin("PSG", "times_int", ["#0b1c3d", "#d50000"], "faixa"),
    "boca": _skin("Boca Juniors", "times_int", ["#1c3a94", "#facc15"], "listras"),
    "river": _skin("River Plate", "times_int", ["#f2f2f2", "#d50000"], "faixa"),
    # Seleções
    "brasil": _skin("Brasil", "selecoes", ["#ffdf00", "#009c3b"], "faixa"),
    "argentina": _skin("Argentina", "selecoes", ["#75aadb", "#f2f2f2"], "vertical"),
    "alemanha": _skin("Alemanha", "selecoes", ["#f2f2f2", "#141414"], "faixa"),
    "franca": _skin("França", "selecoes", ["#1c3a94", "#d50000"], "faixa"),
    "italia": _skin("Itália", "selecoes", ["#0f5ba7"], "solido"),
    "espanha": _skin("Espanha", "selecoes", ["#c60b1e", "#facc15"], "listras"),
    "portugal": _skin("Portugal", "selecoes", ["#d50000", "#046a38"], "vertical"),
    "inglaterra": _skin("Inglaterra", "selecoes", ["#f2f2f2", "#d50000"], "faixa"),
    "uruguai": _skin("Uruguai", "selecoes", ["#75aadb"], "solido"),
    "holanda": _skin("Holanda", "selecoes", ["#fb923c"], "solido"),
    "japao": _skin("Japão", "selecoes", ["#0b1c3d", "#d50000"], "faixa"),
    "mexico": _skin("México", "selecoes", ["#046a38", "#d50000"], "vertical"),
    # Especiais (preço próprio)
    "rainbow": _skin("Rainbow RGB", "especiais", ["#ff0000"], "rainbow"),
    "imagem": _skin("Imagem personalizada", "especiais", ["#2b2f3a"], "imagem"),
}
SKINS_SPLANO_GRUPOS = {
    "cores": "Cores",
    "times_br": "Times do Brasil",
    "times_int": "Times do mundo",
    "selecoes": "Seleções",
    "especiais": "Especiais",
}


def preco_skin_splano(skin_id: str) -> int:
    if skin_id == "rainbow":
        return PRECO_SKIN_SPLANO_RAINBOW
    if skin_id == "imagem":
        return PRECO_SKIN_SPLANO_IMAGEM
    return PRECO_SKIN_SPLANO


ARQUIVO_LOJA_DECORACOES = PASTA_BASE / "loja_decoracoes.json"

PARTIDAS_JOGOS = [
    "sudoku_solo", "sudoku_online",
    "velha_maquina", "velha_online",
    "campo_solo", "campo_online",
    "termo_solo", "termo_online",
    "ludo",
    "clickj_pvp",
    "splano_io",
]

# Roleta da sorte — 19 setores do MESMO tamanho: 4 de 2x, 4 de 1.5x, 6 de
# 0.75x, 4 de 0.5x e 1 de presente. Todos têm peso igual, então é sorte pura:
# cada setor tem a mesma chance (1/19) e não há fatia "grande" pra mirar.
# 10 setores pagam menos do que a aposta (0.75x e 0.5x) contra 9 que pagam
# mais (2x, 1.5x e presente) — o jogador perde mais vezes do que ganha.
#
# A ordem abaixo é embaralhada de propósito e FIXA: uma roleta de verdade não
# se remonta a cada giro, e com ordem fixa dá pra conferir o resultado olhando
# onde o ponteiro parou. Não existe padrão — não alterna por categoria nem
# repete ciclo; o presente fica fora do centro e fora das pontas.
# A aposta só anda de 100 em 100 e começa em 100: com 10 de mínimo dava pra
# girar quase de graça, e 100 é múltiplo de 4 — o 0.75x fecha em moeda cheia
# (75 moedas de volta) em vez de perder fração no arredondamento.
ROLETA_APOSTA_MINIMA = 100
ROLETA_APOSTA_MULTIPLO = 100
_ROLETA_ORDEM = [
    "0.75x", "2x", "0.5x", "0.75x", "1.5x", "2x", "0.75x", "presente",
    "0.5x", "0.75x", "2x", "1.5x", "0.5x", "0.75x", "2x", "0.75x",
    "1.5x", "0.5x", "1.5x",
]
_ROLETA_MODELOS = {
    "2x": {"tipo": "multiplicador", "valor": 2.0, "label": "2x"},
    "1.5x": {"tipo": "multiplicador", "valor": 1.5, "label": "1.5x"},
    "0.75x": {"tipo": "multiplicador", "valor": 0.75, "label": "0.75x"},
    "0.5x": {"tipo": "multiplicador", "valor": 0.5, "label": "0.5x"},
    "presente": {"tipo": "presente", "label": "Presente"},
}
# peso = tamanho do setor em %, e a soma tem que dar 100 (o front desenha a
# roda a partir disso). Com 19 setores iguais não fecha em número redondo, por
# isso o resto vai pro último — a diferença é invisível e o sorteio não usa o
# peso pra nada além do desenho.
_ROLETA_PESO = round(100 / len(_ROLETA_ORDEM), 4)
ROLETA_FATIAS = []
for _i, _chave in enumerate(_ROLETA_ORDEM):
    _fatia = dict(_ROLETA_MODELOS[_chave])
    _fatia["peso"] = (round(100 - _ROLETA_PESO * (len(_ROLETA_ORDEM) - 1), 4)
                      if _i == len(_ROLETA_ORDEM) - 1 else _ROLETA_PESO)
    ROLETA_FATIAS.append(_fatia)


def _carregar_catalogo_decoracoes() -> list:
    try:
        brutos = json.loads(ARQUIVO_LOJA_DECORACOES.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return []
    catalogo = []
    for item in brutos:
        sku_id = item.get("sku_id")
        asset = item.get("asset")
        if not sku_id or not asset:
            continue
        catalogo.append({
            "sku_id": sku_id,
            "nome": item.get("name") or sku_id,
            "preco": _preco_decoracao(sku_id),
            # .webp = quadro parado (usado em repouso); .png = APNG animado
            # (o CDN da Discord só anima nesse formato) — trocado no hover.
            "imagem": f"https://cdn.discordapp.com/avatar-decoration-presets/{asset}.webp?size=96",
            "imagem_animada": f"https://cdn.discordapp.com/avatar-decoration-presets/{asset}.png?size=96",
        })
    return catalogo


CATALOGO_DECORACOES = _carregar_catalogo_decoracoes()
_DECORACOES_POR_SKU = {item["sku_id"]: item for item in CATALOGO_DECORACOES}


def decoracao_existe(sku_id: str) -> bool:
    return sku_id in _DECORACOES_POR_SKU


def preco_decoracao_item(sku_id: str) -> int:
    item = _DECORACOES_POR_SKU.get(sku_id)
    return item["preco"] if item else PRECO_DECORACAO


_cache_carteiras = {"em": 0.0, "carteiras": None}
CACHE_CARTEIRAS_SEGUNDOS = 5


def carregar_economia() -> dict:
    dados = carregar_json(CHAVE_ECONOMIA, ARQUIVO_ECONOMIA)
    dados.setdefault("carteiras", {})
    return dados


def salvar_economia(dados: dict) -> None:
    salvar_json(CHAVE_ECONOMIA, dados, ARQUIVO_ECONOMIA)
    _cache_carteiras.update(em=time.time(), carteiras=dados.get("carteiras", {}))


def _carteiras_recentes() -> dict:
    """Carteiras de até 5s atrás — os placares pedem os cosméticos de cada
    jogador a cada atualização, e sem isso cada pedido era uma ida ao Redis."""
    agora = time.time()
    if _cache_carteiras["carteiras"] is None or agora - _cache_carteiras["em"] > CACHE_CARTEIRAS_SEGUNDOS:
        _cache_carteiras.update(em=agora, carteiras=carregar_economia().get("carteiras", {}))
    return _cache_carteiras["carteiras"]


def obter_carteira(dados: dict, nome: str, nick: str = None, avatar: str = None,
                   discord_id: str = None) -> dict:
    carteira = dados["carteiras"].setdefault(nome, {})
    carteira.setdefault("saldo", SALDO_INICIAL)
    carteira.setdefault("ultimo_bonus", 0)
    carteira.setdefault("decoracoes", [])
    carteira.setdefault("cores_nick", [])
    carteira.setdefault("fontes_nick", [])
    carteira.setdefault("skins_splano", [])
    carteira.setdefault("skin_splano_imagem", "")
    equipado = carteira.setdefault("equipado", {})
    for chave in ("decoracao", "cor_nick", "fonte_nick", "skin_splano"):
        equipado.setdefault(chave, None)
    carteira.setdefault("segundos_jogados", 0)
    carteira.setdefault("partidas", {})
    carteira.setdefault("vitorias", {})
    carteira.setdefault("historico", [])
    carteira.setdefault("discord_id", None)
    if nick:
        carteira["nick"] = nick
    if avatar:
        carteira["avatar"] = avatar
    if discord_id:
        carteira["discord_id"] = discord_id
    return carteira


# ID(s) do Discord com acesso ao botão "Doar/Gerar moedas" da loja. Nunca
# confiar num "sou admin" mandado pelo cliente — só esse ID é aceito.
ADMIN_DISCORD_IDS = {"1527038915628761110"}


def eh_admin_discord_id(discord_id: str) -> bool:
    return bool(discord_id) and discord_id in ADMIN_DISCORD_IDS


def resolver_nome_por_discord_id(discord_id: str) -> Optional[str]:
    """Acha o 'nome' (chave da carteira) de quem tem esse ID do Discord.
    Só funciona pra quem já abriu o site logado ao menos uma vez (é quando
    o discord_id é gravado na carteira)."""
    if not discord_id:
        return None
    carteiras = carregar_economia().get("carteiras", {})
    for nome, carteira in carteiras.items():
        if carteira.get("discord_id") == discord_id:
            return nome
    return None


def resolver_nome_alvo(identificador: str) -> Optional[str]:
    """Aceita ID do Discord OU o 'nome' (username) direto — o ID só resolve
    pra quem já teve o discord_id gravado na carteira (após abrir o site com
    a versão atual); o username sempre funciona, pois é a própria chave."""
    if not identificador:
        return None
    carteiras = carregar_economia().get("carteiras", {})
    if identificador in carteiras:
        return identificador
    return resolver_nome_por_discord_id(identificador)


def _imagem_decoracao(sku: Optional[str], animada: bool) -> Optional[str]:
    if not sku:
        return None
    return _DECORACOES_POR_SKU.get(sku, {}).get("imagem_animada" if animada else "imagem")


def carteira_publica(carteira: dict) -> dict:
    equipado = carteira.get("equipado") or {}
    return {
        "saldo": carteira.get("saldo", 0),
        "decoracoes": carteira.get("decoracoes", []),
        "cores_nick": carteira.get("cores_nick", []),
        "fontes_nick": carteira.get("fontes_nick", []),
        "skins_splano": carteira.get("skins_splano", []),
        "skin_splano_imagem": carteira.get("skin_splano_imagem", ""),
        "equipado": {
            "decoracao": equipado.get("decoracao"),
            "cor_nick": equipado.get("cor_nick"),
            "fonte_nick": equipado.get("fonte_nick"),
            "skin_splano": equipado.get("skin_splano"),
        },
        # URL pronta da decoração equipada, pro front não precisar carregar o
        # catálogo inteiro só pra desenhar o avatar do cabeçalho/perfil.
        "decoracao_imagem": _imagem_decoracao(equipado.get("decoracao"), animada=True),
        "historico": carteira.get("historico", []),
    }


def _cosmeticos_da_carteira(carteira: Optional[dict]) -> dict:
    equipado = (carteira or {}).get("equipado") or {}
    return {
        "decoracao": _imagem_decoracao(equipado.get("decoracao"), animada=False),
        "cor_nick": equipado.get("cor_nick"),
        "fonte_nick": equipado.get("fonte_nick"),
    }


def cosmeticos_equipados(nome: str) -> dict:
    """Usado pelos jogos pra mostrar a decoração/cor/fonte equipada de
    QUALQUER jogador (não só o usuário atual) — ex: no placar de uma partida."""
    if eh_anonimo(nome) or not nome:
        return _cosmeticos_da_carteira(None)
    return _cosmeticos_da_carteira(_carteiras_recentes().get(nome))


def cosmeticos_de_varios(nomes) -> dict:
    carteiras = _carteiras_recentes()
    return {n: _cosmeticos_da_carteira(carteiras.get(n)) for n in nomes if n}


def skin_splano(nome: str) -> dict:
    """Skin equipada no Splano.io, já pronta pro canvas desenhar. Sem skin
    (ou anônimo), a cor sai do próprio nome — cada um fica com a sua."""
    carteira = None
    if nome and not eh_anonimo(nome):
        carteira = _carteiras_recentes().get(nome)
    skin_id = ((carteira or {}).get("equipado") or {}).get("skin_splano")
    skin = SKINS_SPLANO.get(skin_id)
    if not skin:
        cores = list(CORES_NICK.values())
        cor = [c for c in cores if c][sum(map(ord, nome or "?")) % len([c for c in cores if c])]
        return {"id": None, "padrao": "solido", "cores": [cor], "imagem": ""}
    return {
        "id": skin_id,
        "padrao": skin["padrao"],
        "cores": skin["cores"],
        "imagem": (carteira or {}).get("skin_splano_imagem", "") if skin["padrao"] == "imagem" else "",
    }


def registrar_fim_partida(nome: str, nick: str, segundos: int,
                          jogo: str = "", avatar: str = None,
                          venceu: bool = False, resultado: str = "") -> None:
    """Registra fim de partida: acumula segundos, incrementa partidas e
    vitórias por jogo e guarda no histórico das últimas partidas."""
    if eh_anonimo(nome) or not nome:
        return
    with LOCK_ECONOMIA:
        dados = carregar_economia()
        carteira = obter_carteira(dados, nome, nick=nick, avatar=avatar)
        if segundos > 0:
            carteira["segundos_jogados"] = carteira.get("segundos_jogados", 0) + segundos
        if jogo in PARTIDAS_JOGOS:
            partidas = carteira.setdefault("partidas", {})
            partidas[jogo] = partidas.get(jogo, 0) + 1
            if venceu:
                vitorias = carteira.setdefault("vitorias", {})
                vitorias[jogo] = vitorias.get(jogo, 0) + 1
            if resultado not in ("vitoria", "derrota", "empate"):
                resultado = "vitoria" if venceu else "derrota"
            historico = carteira.setdefault("historico", [])
            historico.insert(0, {"jogo": jogo, "resultado": resultado, "em": int(time.time())})
            del historico[HISTORICO_MAXIMO:]
        salvar_economia(dados)


def _entrada_publica(nome: str, carteira: dict) -> dict:
    equipado = carteira.get("equipado") or {}
    partidas = carteira.get("partidas", {})
    return {
        "nome": nome,
        "nick": carteira.get("nick") or nome,
        "cor_nick": equipado.get("cor_nick"),
        "fonte_nick": equipado.get("fonte_nick"),
        "avatar": carteira.get("avatar"),
        "decoracao_imagem": _imagem_decoracao(equipado.get("decoracao"), animada=True),
        "saldo": carteira.get("saldo", 0),
        "segundos": carteira.get("segundos_jogados", 0),
        "partidas": partidas,
        "vitorias": carteira.get("vitorias", {}),
        "total_partidas": sum(partidas.values()),
    }


def perfil_publico(nome: str) -> Optional[dict]:
    carteira = carregar_economia().get("carteiras", {}).get(nome)
    return _entrada_publica(nome, carteira) if carteira else None


def top_ranking(limit: int = 10) -> dict:
    """Retorna os top jogadores por moedas e por partidas jogadas."""
    entradas = [_entrada_publica(nome, c) for nome, c in carregar_economia().get("carteiras", {}).items()]
    top_moedas = sorted(entradas, key=lambda x: x["saldo"], reverse=True)
    top_partidas = sorted(entradas, key=lambda x: x["total_partidas"], reverse=True)
    return {
        "top_moedas": top_moedas[:limit],
        "top_horas": top_partidas[:limit],
    }


def creditar_moedas(nome: str, quantidade: int) -> Optional[int]:
    """Credita moedas pro jogador (ignora anônimo/nome vazio). Retorna o
    novo saldo, ou None se não creditou nada."""
    if eh_anonimo(nome) or not nome or quantidade <= 0:
        return None
    with LOCK_ECONOMIA:
        dados = carregar_economia()
        carteira = obter_carteira(dados, nome)
        carteira["saldo"] = carteira.get("saldo", 0) + quantidade
        salvar_economia(dados)
        return carteira["saldo"]


def debitar_moedas(nome: str, quantidade: int) -> Optional[int]:
    """Remove moedas da conta (o saldo nunca fica negativo). Retorna o novo
    saldo, ou None se não removeu nada."""
    if eh_anonimo(nome) or not nome or quantidade <= 0:
        return None
    with LOCK_ECONOMIA:
        dados = carregar_economia()
        carteira = obter_carteira(dados, nome)
        carteira["saldo"] = max(0, carteira.get("saldo", 0) - quantidade)
        salvar_economia(dados)
        return carteira["saldo"]


def _contagem_itens(carteira: dict) -> dict:
    contagem = {
        "decoracoes": len(carteira.get("decoracoes") or []),
        "cores_nick": len(carteira.get("cores_nick") or []),
        "fontes_nick": len(carteira.get("fontes_nick") or []),
        "skins_splano": len(carteira.get("skins_splano") or []),
    }
    contagem["total"] = sum(v for k, v in contagem.items() if k != "total")
    return contagem


def zerar_saldo_admin(nome: str) -> Optional[int]:
    """Tira TODO o dinheiro do jogador de uma vez (o botão "remover todo o
    dinheiro" do painel). Retorna o novo saldo — sempre 0."""
    if eh_anonimo(nome) or not nome:
        return None
    with LOCK_ECONOMIA:
        dados = carregar_economia()
        carteira = obter_carteira(dados, nome)
        carteira["saldo"] = 0
        salvar_economia(dados)
        return 0


def consulta_admin(nome: str) -> dict:
    """Saldo + quantos itens da loja o jogador tem — pro painel de admin."""
    if not nome:
        return {"nome": "", "nick": None, "saldo": 0, "itens": _contagem_itens({})}
    with LOCK_ECONOMIA:
        dados = carregar_economia()
        carteira = obter_carteira(dados, nome)
        return {"nome": nome, "nick": carteira.get("nick"), "saldo": carteira.get("saldo", 0),
                "itens": _contagem_itens(carteira)}


def limpar_itens_admin(nome: str) -> dict:
    """Apaga tudo que o jogador comprou/ganhou na loja (decorações, cores,
    fontes e skins do Splano). As moedas ficam na conta."""
    if not nome:
        return {"nome": "", "removidos": 0, "saldo": 0, "itens": _contagem_itens({})}
    with LOCK_ECONOMIA:
        dados = carregar_economia()
        carteira = obter_carteira(dados, nome)
        removidos = 0
        for chave in ("decoracoes", "cores_nick", "fontes_nick", "skins_splano"):
            removidos += len(carteira.get(chave) or [])
            carteira[chave] = []
        carteira["skin_splano_imagem"] = ""
        equipado = carteira.setdefault("equipado", {})
        for chave in ("decoracao", "cor_nick", "fonte_nick", "skin_splano"):
            equipado[chave] = None
        salvar_economia(dados)
        return {"nome": nome, "removidos": removidos, "saldo": carteira.get("saldo", 0),
                "itens": _contagem_itens(carteira)}


def tentar_reclamar_bonus(nome: str, nick: str = None, avatar: str = None) -> dict:
    """Credita o bônus de atividade (5 moedas a cada 15 min), se já deu
    tempo desde o último. O cliente chama isso periodicamente enquanto a
    aba/Activity está aberta — o servidor decide, não confia no relógio do
    cliente."""
    if eh_anonimo(nome) or not nome:
        return {"creditado": False, "saldo": 0, "proximo_em_segundos": BONUS_INTERVALO_SEGUNDOS}

    with LOCK_ECONOMIA:
        dados = carregar_economia()
        carteira = obter_carteira(dados, nome, nick=nick, avatar=avatar)
        agora = time.time()
        passado = agora - carteira.get("ultimo_bonus", 0)

        if passado >= BONUS_INTERVALO_SEGUNDOS:
            carteira["saldo"] = carteira.get("saldo", 0) + BONUS_QUANTIDADE
            carteira["ultimo_bonus"] = agora
            salvar_economia(dados)
            return {"creditado": True, "saldo": carteira["saldo"], "proximo_em_segundos": BONUS_INTERVALO_SEGUNDOS}

        return {
            "creditado": False,
            "saldo": carteira["saldo"],
            "proximo_em_segundos": int(BONUS_INTERVALO_SEGUNDOS - passado),
        }


def sortear_fatia_roleta() -> dict:
    """Sorteia um setor. Todos têm a mesma chance — o "peso" só existe pro
    desenho da roda, não pesa no sorteio."""
    indice = secrets.SystemRandom().randrange(len(ROLETA_FATIAS))
    fatia = dict(ROLETA_FATIAS[indice])
    fatia["indice"] = indice
    return fatia


def sortear_presente(carteira: dict) -> Optional[dict]:
    """Presente da roleta: sorteia primeiro a categoria (decoração, cor do
    nick, fonte do nick ou skin do Splano.io) entre as que ainda têm item não
    possuído, depois o item."""
    aleatorio = secrets.SystemRandom()
    decoracoes = [d for d in CATALOGO_DECORACOES if d["sku_id"] not in carteira.get("decoracoes", [])]
    cores = [c for c in CORES_NICK if c not in carteira.get("cores_nick", [])]
    fontes = [f for f in FONTES_NICK if f not in carteira.get("fontes_nick", [])]
    skins = [s for s in SKINS_SPLANO if s not in carteira.get("skins_splano", [])]
    categorias = [nome for nome, itens in (("decoracao", decoracoes), ("cor_nick", cores),
                                           ("fonte_nick", fontes), ("skin_splano", skins)) if itens]
    if not categorias:
        return None
    categoria = aleatorio.choice(categorias)
    if categoria == "decoracao":
        item = aleatorio.choice(decoracoes)
        carteira["decoracoes"].append(item["sku_id"])
        return {"tipo": "decoracao", "id": item["sku_id"], "nome": item["nome"], "imagem": item["imagem"]}
    if categoria == "cor_nick":
        cor = aleatorio.choice(cores)
        carteira["cores_nick"].append(cor)
        return {"tipo": "cor_nick", "id": cor, "nome": "Arco-íris" if cor == "arco-iris" else cor.capitalize()}
    if categoria == "fonte_nick":
        fonte = aleatorio.choice(fontes)
        carteira["fontes_nick"].append(fonte)
        return {"tipo": "fonte_nick", "id": fonte, "nome": FONTES_NICK[fonte]}
    skin = aleatorio.choice(skins)
    carteira["skins_splano"].append(skin)
    return {"tipo": "skin_splano", "id": skin, "nome": SKINS_SPLANO[skin]["nome"],
            "cores": SKINS_SPLANO[skin].get("cores", []),
            "padrao": SKINS_SPLANO[skin].get("padrao", "solido")}


def girar_roleta(nome: str, aposta: int) -> dict:
    """Aposta na roleta: debita a aposta, sorteia a fatia e aplica o prêmio
    (moedas ou decoração). Levanta ValueError se a aposta for inválida ou o
    saldo for insuficiente — o router traduz isso pra HTTPException."""
    if aposta < ROLETA_APOSTA_MINIMA or aposta % ROLETA_APOSTA_MULTIPLO != 0:
        raise ValueError(
            f"Aposta mínima é {ROLETA_APOSTA_MINIMA} moedas, sempre em múltiplos de {ROLETA_APOSTA_MULTIPLO}."
        )

    with LOCK_ECONOMIA:
        dados = carregar_economia()
        carteira = obter_carteira(dados, nome)
        if carteira["saldo"] < aposta:
            raise ValueError("Moedas insuficientes.")

        carteira["saldo"] -= aposta
        fatia = sortear_fatia_roleta()
        premio_moedas = 0
        presente = None

        if fatia["tipo"] == "multiplicador":
            premio_moedas = int(aposta * fatia["valor"])
            carteira["saldo"] += premio_moedas
        elif fatia["tipo"] == "presente":
            presente = sortear_presente(carteira)
            if not presente:
                # já tem tudo da loja — credita o preço de uma decoração em moedas.
                premio_moedas = PRECO_DECORACAO
                carteira["saldo"] += premio_moedas

        salvar_economia(dados)
        return {
            "fatia_indice": fatia["indice"],
            "resultado": fatia,
            "premio_moedas": premio_moedas,
            "presente": presente,
            "carteira": carteira_publica(carteira),
        }
