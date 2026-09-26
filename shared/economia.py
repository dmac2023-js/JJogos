"""Moedas, loja de decorações de avatar e cor do nick.

Carteira é indexada por "nome" (o username do Discord, já usado como chave
única em todo o app pra recordes/vitórias) — quem não está logado com
Discord (anônimo) não ganha nem gasta moeda nenhuma.
"""
import json
import secrets
import time
from pathlib import Path
from typing import Optional

from shared.config import ARQUIVO_ECONOMIA, PASTA_BASE
from shared.db import carregar_json, salvar_json
from shared.recordes import eh_anonimo

CHAVE_ECONOMIA = "jjogos:economia"

BONUS_INTERVALO_SEGUNDOS = 15 * 60
BONUS_QUANTIDADE = 5
PRECO_DECORACAO = 70
PRECO_COR_NICK = 30
PRECO_FONTE_NICK = 60
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

ARQUIVO_LOJA_DECORACOES = PASTA_BASE / "loja_decoracoes.json"

PARTIDAS_JOGOS = [
    "sudoku_solo", "sudoku_online",
    "velha_maquina", "velha_online",
    "campo_solo", "campo_online",
    "termo_solo", "termo_online",
    "ludo",
    "clickj_pvp",
]

# Roleta da sorte — 7 fatias intercaladas (mesma categoria nunca é vizinha),
# peso = tamanho da fatia em % (soma sempre 100). "indice" é preenchido em
# sortear_fatia_roleta() e usado pelo front pra girar até a fatia certa.
ROLETA_APOSTA_MINIMA = 10
ROLETA_APOSTA_MULTIPLO = 10
ROLETA_FATIAS = [
    {"tipo": "multiplicador", "valor": 2.0, "peso": 15, "label": "2x"},
    {"tipo": "multiplicador", "valor": 1.5, "peso": 10, "label": "1.5x"},
    {"tipo": "multiplicador", "valor": 0.5, "peso": 20, "label": "0.5x"},
    {"tipo": "presente", "peso": 10, "label": "Presente"},
    {"tipo": "multiplicador", "valor": 0.5, "peso": 20, "label": "0.5x"},
    {"tipo": "multiplicador", "valor": 1.5, "peso": 10, "label": "1.5x"},
    {"tipo": "multiplicador", "valor": 2.0, "peso": 15, "label": "2x"},
]


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


def obter_carteira(dados: dict, nome: str, nick: str = None, avatar: str = None) -> dict:
    carteira = dados["carteiras"].setdefault(nome, {})
    carteira.setdefault("saldo", 0)
    carteira.setdefault("ultimo_bonus", 0)
    carteira.setdefault("decoracoes", [])
    carteira.setdefault("cores_nick", [])
    carteira.setdefault("fontes_nick", [])
    equipado = carteira.setdefault("equipado", {})
    for chave in ("decoracao", "cor_nick", "fonte_nick"):
        equipado.setdefault(chave, None)
    carteira.setdefault("segundos_jogados", 0)
    carteira.setdefault("partidas", {})
    carteira.setdefault("vitorias", {})
    carteira.setdefault("historico", [])
    if nick:
        carteira["nick"] = nick
    if avatar:
        carteira["avatar"] = avatar
    return carteira


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
        "equipado": {
            "decoracao": equipado.get("decoracao"),
            "cor_nick": equipado.get("cor_nick"),
            "fonte_nick": equipado.get("fonte_nick"),
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


def registrar_fim_partida(nome: str, nick: str, segundos: int,
                          jogo: str = "", avatar: str = None,
                          venceu: bool = False, resultado: str = "") -> None:
    """Registra fim de partida: acumula segundos, incrementa partidas e
    vitórias por jogo e guarda no histórico das últimas partidas."""
    if eh_anonimo(nome) or not nome:
        return
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
    dados = carregar_economia()
    carteira = obter_carteira(dados, nome)
    carteira["saldo"] = carteira.get("saldo", 0) + quantidade
    salvar_economia(dados)
    return carteira["saldo"]


def tentar_reclamar_bonus(nome: str, nick: str = None, avatar: str = None) -> dict:
    """Credita o bônus de atividade (5 moedas a cada 15 min), se já deu
    tempo desde o último. O cliente chama isso periodicamente enquanto a
    aba/Activity está aberta — o servidor decide, não confia no relógio do
    cliente."""
    if eh_anonimo(nome) or not nome:
        return {"creditado": False, "saldo": 0, "proximo_em_segundos": BONUS_INTERVALO_SEGUNDOS}

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
    """Sorteia uma fatia respeitando os pesos (%) de cada uma."""
    pesos = [fatia["peso"] for fatia in ROLETA_FATIAS]
    indice = secrets.SystemRandom().choices(range(len(ROLETA_FATIAS)), weights=pesos, k=1)[0]
    fatia = dict(ROLETA_FATIAS[indice])
    fatia["indice"] = indice
    return fatia


def sortear_presente(carteira: dict) -> Optional[dict]:
    """Presente da roleta: sorteia primeiro a categoria (decoração, cor ou
    fonte do nick) entre as que ainda têm item não possuído, depois o item."""
    aleatorio = secrets.SystemRandom()
    decoracoes = [d for d in CATALOGO_DECORACOES if d["sku_id"] not in carteira.get("decoracoes", [])]
    cores = [c for c in CORES_NICK if c not in carteira.get("cores_nick", [])]
    fontes = [f for f in FONTES_NICK if f not in carteira.get("fontes_nick", [])]
    categorias = [nome for nome, itens in (("decoracao", decoracoes), ("cor_nick", cores), ("fonte_nick", fontes)) if itens]
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
    fonte = aleatorio.choice(fontes)
    carteira["fontes_nick"].append(fonte)
    return {"tipo": "fonte_nick", "id": fonte, "nome": FONTES_NICK[fonte]}


def girar_roleta(nome: str, aposta: int) -> dict:
    """Aposta na roleta: debita a aposta, sorteia a fatia e aplica o prêmio
    (moedas ou decoração). Levanta ValueError se a aposta for inválida ou o
    saldo for insuficiente — o router traduz isso pra HTTPException."""
    if aposta < ROLETA_APOSTA_MINIMA or aposta % ROLETA_APOSTA_MULTIPLO != 0:
        raise ValueError(
            f"Aposta mínima é {ROLETA_APOSTA_MINIMA} moedas, sempre em múltiplos de {ROLETA_APOSTA_MULTIPLO}."
        )

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
