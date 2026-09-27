"""ClickJ — regras, catálogo e fórmulas (clicker + PvP por turnos).

Só lógica pura aqui (sem rede nem disco): o estado em memória, o WebSocket e
a persistência ficam em routers/clickj.py. Jcoins são uma moeda própria do
ClickJ — não se misturam com as moedas da loja do site.
"""
import random
import secrets
from typing import Optional, Tuple

SKILLS = ["magia", "precisao", "forca", "resistencia", "agilidade"]
SKILL_NOMES = {
    "magia": "Magia",
    "precisao": "Precisão",
    "forca": "Força",
    "resistencia": "Resistência",
    "agilidade": "Agilidade",
}
SKILL_BASE = 10
BONUS_CLASSE = 5

CLASSES = {
    "mago": {"skill": "magia", "arma": "Cajado", "titulo": {"m": "Mago", "f": "Maga"}},
    "arqueiro": {"skill": "precisao", "arma": "Arco", "titulo": {"m": "Arqueiro", "f": "Arqueira"}},
    "guerreiro": {"skill": "forca", "arma": "Espada", "titulo": {"m": "Guerreiro", "f": "Guerreira"}},
    "curandeiro": {"skill": "resistencia", "arma": "Varinha", "titulo": {"m": "Curandeiro", "f": "Curandeira"}},
    "monge": {"skill": "agilidade", "arma": "Lança", "titulo": {"m": "Monge", "f": "Monja"}},
}
GENEROS = ("m", "f")

# Nível -> (cliques totais pra chegar nele, quanto 1 clique conta, Jcoins por clique).
NIVEIS = [
    (0, 1, 1),
    (100, 5, 5),
    (10_000, 10, 10),
    (100_000, 20, 50),
    (500_000, 50, 100),
    (2_000_000, 100, 250),
    (10_000_000, 200, 500),
    (50_000_000, 500, 1_000),
    (250_000_000, 1_000, 2_500),
    (1_000_000_000, 2_000, 5_000),
    (3_000_000_000, 3_000, 7_500),
    (9_000_000_000, 4_500, 11_000),
    (27_000_000_000, 7_000, 17_000),
    (80_000_000_000, 10_000, 25_000),
    (240_000_000_000, 15_000, 37_000),
    (700_000_000_000, 22_000, 55_000),
    (2_000_000_000_000, 33_000, 80_000),
    (6_000_000_000_000, 50_000, 120_000),
    (18_000_000_000_000, 75_000, 180_000),
    (50_000_000_000_000, 110_000, 270_000),
]
NIVEL_MAX = len(NIVEIS)

# Moedas do site pagas a cada rebirth feito. Depois de REBIRTHS_QUE_PAGAM
# rebirths o jogo para de pagar — o rebirth continua valendo pelas skills.
MOEDAS_POR_REBIRTH = 100
REBIRTHS_QUE_PAGAM = 20

NIVEL_AUTOCLICKER = 5  # nível do personagem em que o autoclicker libera de graça (nível 1 dele)
AUTO_CPS = {
    1: 50, 2: 100, 3: 200, 4: 500, 5: 750,
    6: 1_000, 7: 2_000, 8: 3_000, 9: 4_000, 10: 5_000,
}
AUTO_PRECO_UPGRADE = {
    2: 1_000_000, 3: 5_000_000, 4: 10_000_000, 5: 50_000_000,
    6: 200_000_000, 7: 500_000_000, 8: 1_000_000_000, 9: 2_500_000_000, 10: 5_000_000_000,
}

# Hierarquia de materiais: cada um é mais forte (e mais caro) que o anterior.
# Tem que comprar na ordem — o próximo só libera depois do anterior.
MATERIAIS = [
    {"id": "madeira", "nome": "Madeira", "categoria": "basico", "bonus": 5, "preco": 100, "cor": "#a8743f"},
    {"id": "pedra", "nome": "Pedra", "categoria": "basico", "bonus": 10, "preco": 500, "cor": "#8d939c"},
    {"id": "cobre", "nome": "Cobre", "categoria": "basico", "bonus": 20, "preco": 2_000, "cor": "#d07a3f"},
    {"id": "bronze", "nome": "Bronze", "categoria": "medio", "bonus": 40, "preco": 8_000, "cor": "#b8925a"},
    {"id": "ferro", "nome": "Ferro", "categoria": "medio", "bonus": 75, "preco": 30_000, "cor": "#aab4c0"},
    {"id": "prata", "nome": "Prata", "categoria": "medio", "bonus": 125, "preco": 100_000, "cor": "#e3e9f0"},
    {"id": "ouro", "nome": "Ouro", "categoria": "medio", "bonus": 200, "preco": 350_000, "cor": "#f5c542"},
    {"id": "titanio", "nome": "Titânio", "categoria": "avancado", "bonus": 350, "preco": 1_000_000, "cor": "#7fa7c9"},
    {"id": "obsidiana", "nome": "Obsidiana", "categoria": "avancado", "bonus": 600, "preco": 3_500_000, "cor": "#8a63c9"},
    {"id": "diamante", "nome": "Diamante", "categoria": "avancado", "bonus": 1_000, "preco": 10_000_000, "cor": "#8ef3ff"},
    {"id": "platina", "nome": "Platina", "categoria": "lendario", "bonus": 1_500, "preco": 30_000_000, "cor": "#c9d6e3"},
    {"id": "mithril", "nome": "Mithril", "categoria": "lendario", "bonus": 2_200, "preco": 90_000_000, "cor": "#7de8ff"},
    {"id": "adamantina", "nome": "Adamantina", "categoria": "lendario", "bonus": 3_300, "preco": 270_000_000, "cor": "#5865f2"},
    {"id": "draconio", "nome": "Dracônio", "categoria": "lendario", "bonus": 5_000, "preco": 800_000_000, "cor": "#ff5c3d"},
    {"id": "divino", "nome": "Divino", "categoria": "lendario", "bonus": 7_500, "preco": 2_500_000_000, "cor": "#ffe28a"},
]
_MATERIAL_INDICE = {m["id"]: i for i, m in enumerate(MATERIAIS)}

SLOTS_ARMADURA = {
    "capacete": {"nome": "Capacete", "skill": "resistencia"},
    "peitoral": {"nome": "Peitoral", "skill": "resistencia"},
    "calca": {"nome": "Calça", "skill": "resistencia"},
    "bota": {"nome": "Bota", "skill": "agilidade"},
}
SLOTS_LIVRO = {
    "livro_" + s: {"nome": "Livro de " + SKILL_NOMES[s], "skill": s} for s in SKILLS
}
# Tudo que precisa estar no material máximo pra liberar o rebirth.
SLOTS_REBIRTH = ["arma"] + list(SLOTS_ARMADURA) + list(SLOTS_LIVRO)

POCOES = {}
# Preços por (1 min, 10 min, 1 h) — na mesma ordem de _dur logo abaixo.
for _mult, _precos in ((2, (2_000, 20_000, 100_000)), (5, (10_000_000, 100_000_000, 500_000_000)),
                       (10, (20_000_000, 200_000_000, 1_000_000_000))):
    for _dur, _rotulo, _preco in zip((60, 600, 3600), ("1 min", "10 min", "1 h"), _precos):
        _id = "clique_x%d_%d" % (_mult, _dur)
        POCOES[_id] = {"id": _id, "tipo": "clique", "valor": _mult, "dur": _dur, "preco": _preco,
                       "nome": "Poção de Clique %dx (%s)" % (_mult, _rotulo)}
for _s in SKILLS:
    # Só valem durante uma luta (usar_pocao_luta) — o bônus fica pro resto
    # daquela luta, sem gastar turno; só uma por skill por luta.
    for _nivel, _rotulo, _bonus, _preco in (
        ("menor", "Menor", 50, 1_000),
        ("media", "Média", 200, 20_000),
        ("maior", "Maior", 500, 250_000),
    ):
        _id = "%s_%s" % (_s, _nivel)
        POCOES[_id] = {"id": _id, "tipo": "skill", "skill": _s, "valor": _bonus, "dur": 0,
                       "preco": _preco,
                       "nome": "Poção de %s %s (+%d na luta)" % (SKILL_NOMES[_s], _rotulo, _bonus)}

# Títulos — um por skill, específico de cada classe (comprado uma vez,
# depois é só trocar de equipado). Persistem entre rebirths de propósito:
# são o único "prestígio" permanente do jogo, resto reseta.
PRECO_TITULO = 1_000_000_000_000
TITULO_HP_BONUS = 5
TITULO_SKILL_BONUS = 500
TITULOS = {
    "mago": {
        "magia": {"id": "arquimago", "nome": "Arquimago"},
        "precisao": {"id": "sabio", "nome": "Sábio"},
        "forca": {"id": "destruidor_arcano", "nome": "Destruidor Arcano"},
        "resistencia": {"id": "necromante", "nome": "Necromante"},
        "agilidade": {"id": "ilusionista", "nome": "Ilusionista"},
    },
    "arqueiro": {
        "precisao": {"id": "mestre_atirador", "nome": "Mestre Atirador"},
        "agilidade": {"id": "rastreador", "nome": "Rastreador"},
        "forca": {"id": "cacador", "nome": "Caçador"},
        "magia": {"id": "encantador_de_flechas", "nome": "Encantador de Flechas"},
        "resistencia": {"id": "vigia", "nome": "Vigia"},
    },
    "guerreiro": {
        "forca": {"id": "barbaro", "nome": "Bárbaro"},
        "resistencia": {"id": "sanguinario", "nome": "Sanguinário"},
        "precisao": {"id": "duelista", "nome": "Duelista"},
        "agilidade": {"id": "berserker", "nome": "Berserker"},
        "magia": {"id": "cavaleiro_runico", "nome": "Cavaleiro Rúnico"},
    },
    "curandeiro": {
        "resistencia": {"id": "guardiao", "nome": "Guardião"},
        "magia": {"id": "mistico", "nome": "Místico"},
        "precisao": {"id": "clerigo", "nome": "Clérigo"},
        "agilidade": {"id": "andarilho", "nome": "Andarilho"},
        "forca": {"id": "paladino", "nome": "Paladino"},
    },
    "monge": {
        "agilidade": {"id": "mestre_do_vento", "nome": "Mestre do Vento"},
        "forca": {"id": "punho_de_ferro", "nome": "Punho de Ferro"},
        "precisao": {"id": "andarilho_silencioso", "nome": "Andarilho Silencioso"},
        "resistencia": {"id": "monge_de_pedra", "nome": "Monge de Pedra"},
        "magia": {"id": "iluminado", "nome": "Iluminado"},
    },
}
# id do título -> (classe dona, skill que ele reforça, dict do título).
_TITULO_POR_ID = {
    t["id"]: (classe, skill, t)
    for classe, mapa in TITULOS.items() for skill, t in mapa.items()
}

# Redistribuir skills — some os pontos investidos nos 5 livros (o único
# equipamento que cobre as 5 skills 1 pra 1) e deixa reaplicar como quiser.
NIVEL_REBIRTHS_RESPEC = 2
PRECO_RESPEC = 1_000_000_000

NIVEL_MAESTRIA_DESBLOQUEIO = 10
MAESTRIA_MAX = 10
# Nível de maestria -> custo em Jcoins e % de bônus sobre o total da skill
# escolhida (base + classe + equipamento + livros + poção), aplicado por
# cima de tudo isso. Só uma maestria ativa por vez — trocar de skill zera o nível.
MAESTRIA_PRECO = {
    1: 50_000_000, 2: 500_000_000, 3: 1_500_000_000, 4: 3_000_000_000, 5: 6_000_000_000,
    6: 12_000_000_000, 7: 25_000_000_000, 8: 50_000_000_000, 9: 100_000_000_000, 10: 1_000_000_000_000,
}
MAESTRIA_BONUS_PCT = {1: 20, 2: 40, 3: 80, 4: 150, 5: 250, 6: 400, 7: 600, 8: 900, 9: 1_300, 10: 2_000}

# Nível necessário pra próxima rebirth, indexado pelo número de rebirths já
# feitos (0 = ainda nenhuma). Da 3ª em diante sempre exige o nível máximo.
NIVEL_REBIRTH_REQUERIDO = {0: 10, 1: 15}

HP_BASE = 50
HP_POR_REBIRTH = 10
ESQUIVA_INTERVALO = 3
RECOMPENSA_VITORIA = 100
RECOMPENSA_DERROTA = 10
ACOES_LUTA = ("atacar", "esquivar", "defender", "curar")

# Fórmulas da luta. Cada skill é comparada com a mesma skill do oponente
# (_disputa), então quem está mais equipado leva vantagem clara, e entre
# jogadores do mesmo nível nenhuma classe dispara na frente. Os expoentes
# compensam o fato de a armadura inflar resistência/agilidade bem mais que as
# outras skills — calibrados simulando milhares de lutas entre as 5 classes.
DANO_BASE = 14
G_ATAQUE = 0.6
G_RESISTENCIA = 0.8
# Mesmo dominando MUITO a resistência, o atacante sempre causa pelo menos
# essa fração do dano de ataque bruto — sem isso, empilhar resistência
# reduzia o dano recebido a ~0 contra qualquer atacante.
RESISTENCIA_DISPUTA_MIN = 0.25
G_PRECISAO = 1.2
G_AGILIDADE = 2.0
ESQUIVA_PASSIVA = 0.2
ESQUIVA_ATIVA_BASE = 0.25
ESQUIVA_ATIVA_FATOR = 0.6
DANO_PARCIAL = (0.2, 0.5)
CURA_BASE = 6
CURA_FATOR = 12
CURA_DECAIMENTO = 0.75
PESO_ARMADURA = 1 / 3
PESO_BOTA = 0.3
PESO_MAGIA_ATAQUE = 0.9

# Resistência a cada tipo de ataque, por classe (multiplica o dano recebido).
# Tipo do ataque = "magica" se a magia do atacante for >= força dele, senão
# "fisica". >1 = fraqueza, <1 = resistência, 1 = neutro.
RESISTENCIA_CLASSE = {
    "mago": {"fisica": 1.0, "magica": 1.0},
    "curandeiro": {"fisica": 1.20, "magica": 0.85},
    "arqueiro": {"fisica": 0.8, "magica": 1.9},
    "guerreiro": {"fisica": 1.0, "magica": 1.0},
    "monge": {"fisica": 0.85, "magica": 0.85},
}
# Mago também sofre extra de quem ataca com muita precisão (até +15% de
# dano quando a precisão do atacante domina completamente a do mago). A
# fraqueza do mago é só essa (a física neutra acima já conta a precisão do
# arqueiro aqui) — somar as duas em cima do arqueiro (que é precisão E
# físico) deixava esse confronto praticamente imperdível pro arqueiro.
PRECISAO_EXTRA_MAGO = 0.15
# Arqueiro toma "crítico de magia": chance extra de dano mágico ampliado.
CHANCE_CRITICO_MAGICO_ARQUEIRO = 0.38
CRITICO_MAGICO_MULT = 1.72
# Curandeiro é fraco contra força bruta: quanto mais o atacante domina em
# força, mais dano extra o curandeiro toma (até +50%). Cobre monge e
# guerreiro, as duas classes que vivem de força.
FORCA_EXTRA_CURANDEIRO = 0.5
# Monge é pouco ágil: sua agilidade em combate rende menos que a mostrada
# na ficha (afeta esquiva, tanto passiva quanto ativa).
AGILIDADE_MULT_CLASSE = {"monge": 0.6}
# Guerreiro é ruim de cura: quando escolhe "curar", a cura rende bem menos
# que a de qualquer outra classe com a mesma magia.
HEALING_MULT_CLASSE = {"guerreiro": 0.5}


# ---------------------------------------------------------------------------
# Pets — 3 roletas (básica, épica, divina). Guardados em j["pets"] (lista de
# instâncias possuídas, até PET_MAX_MOCHILA) e j["pets_equipados"] (até
# PET_MAX_EQUIPADOS ids). Somem no rebirth (caros, mas não são "prestígio"
# como os títulos).
# ---------------------------------------------------------------------------
PET_MAX_EQUIPADOS_BASE = 3
PET_MAX_MOCHILA = 9
PET_TIERS = {
    "basica": {"nome": "Roleta Básica", "preco": 1_000_000},
    "epica": {"nome": "Roleta Épica", "preco": 10_000_000_000},
    "divina": {"nome": "Roleta Divina", "preco": 1_000_000_000_000},
}
PET_REBIRTH_MINIMO = {"basica": 0, "epica": 1, "divina": 3}  # rebirths mínimos p/ cada roleta
PET_VENDA_FATOR = 0.5  # vender devolve metade do preço pago na roleta
PET_MULT_BASICA = (1.0, 2.0)  # sorteado uniformemente nesse intervalo
PET_MULT_EPICA = (2.0, 2.5)   # idem
PET_MULT_DIVINA = (3.0, 5.0)  # idem
PET_BONUS_EPICA = 1_000
PET_BONUS_DIVINA_FOCO = 2_000
PET_BONUS_DIVINA_RESTO = 1_000
PET_NOMES = {
    "basica": ["Gatinho", "Cachorrinho", "Coelhinho", "Passarinho", "Raposa", "Coruja", "Filhote de Lobo"],
    "epica": ["Fênix", "Grifo", "Hidra", "Quimera", "Basilisco", "Ciclope"],
    "divina": ["Leviatã", "Behemoth", "Ancião Celestial", "Avatar Divino", "Serafim"],
}


def pet_max_equipados(rebirths: int) -> int:
    """3 pets equipáveis até o 3º rebirth; do 4º em diante, 1 a mais por
    rebirth (4º = 4, 5º = 5...) até o teto da mochila (9, no 9º rebirth)."""
    if rebirths < 4:
        return PET_MAX_EQUIPADOS_BASE
    return min(PET_MAX_MOCHILA, rebirths)


def catalogo() -> dict:
    return {
        "classes": CLASSES,
        "skills": SKILLS,
        "skill_nomes": SKILL_NOMES,
        "niveis": [{"nivel": i + 1, "cliques": req, "vale": cpc, "jcoins": jpc}
                   for i, (req, cpc, jpc) in enumerate(NIVEIS)],
        "materiais": MATERIAIS,
        "armaduras": SLOTS_ARMADURA,
        "livros": SLOTS_LIVRO,
        "pocoes": list(POCOES.values()),
        "auto": {"cps": AUTO_CPS, "precos": AUTO_PRECO_UPGRADE, "nivel_desbloqueio": NIVEL_AUTOCLICKER},
        "luta": {"hp_base": HP_BASE, "hp_por_rebirth": HP_POR_REBIRTH,
                 "esquiva_intervalo": ESQUIVA_INTERVALO},
        "maestria": {"desbloqueio": NIVEL_MAESTRIA_DESBLOQUEIO, "precos": MAESTRIA_PRECO,
                     "bonus_pct": MAESTRIA_BONUS_PCT, "max": MAESTRIA_MAX},
        "titulos": TITULOS, "preco_titulo": PRECO_TITULO,
        "titulo_hp_bonus": TITULO_HP_BONUS, "titulo_skill_bonus": TITULO_SKILL_BONUS,
        "respec": {"rebirths_necessarios": NIVEL_REBIRTHS_RESPEC, "preco": PRECO_RESPEC},
        "rebirth_moedas": {"quantia": MOEDAS_POR_REBIRTH, "limite": REBIRTHS_QUE_PAGAM},
        "pets": {
            "tiers": PET_TIERS, "max_equipados": PET_MAX_EQUIPADOS_BASE, "max_mochila": PET_MAX_MOCHILA,
            "rebirth_minimo": PET_REBIRTH_MINIMO,
            "venda_fator": PET_VENDA_FATOR,
            "mult_basica": PET_MULT_BASICA, "mult_epica": PET_MULT_EPICA, "mult_divina": PET_MULT_DIVINA,
            "bonus_epica": PET_BONUS_EPICA,
            "bonus_divina_foco": PET_BONUS_DIVINA_FOCO, "bonus_divina_resto": PET_BONUS_DIVINA_RESTO,
        },
    }


# ---------------------------------------------------------------------------
# Jogador
# ---------------------------------------------------------------------------

def novo_jogador(nome: str, nick: str, avatar: Optional[str], classe: str,
                 genero: str, agora: float) -> dict:
    return normalizar({
        "nome": nome, "nick": nick, "avatar": avatar,
        "classe": classe, "genero": genero, "criado_em": agora,
    })


def normalizar(j: dict) -> dict:
    j.setdefault("jcoins", 0)
    j.setdefault("cliques", 0)
    j.setdefault("nivel", 1)
    j.setdefault("rebirths", 0)
    j.setdefault("auto_nivel", 0)
    j.setdefault("equip", {})
    j.setdefault("pocoes", {})
    j.setdefault("efeitos", {})
    j.setdefault("pvp_vitorias", 0)
    j.setdefault("pvp_derrotas", 0)
    j.setdefault("maestria_skill", None)
    j.setdefault("maestria_nivel", 0)
    j.setdefault("titulos", [])
    j.setdefault("titulo_equipado", None)
    j.setdefault("respec_pontos", {})
    j.setdefault("pets", [])
    j.setdefault("pets_equipados", [])
    return j


def titulo(j: dict) -> str:
    return CLASSES[j["classe"]]["titulo"].get(j.get("genero", "m"), "")


def _titulo_equipado_info(j: dict):
    tid = j.get("titulo_equipado")
    if not tid or tid not in j.get("titulos", []):
        return None
    info = _TITULO_POR_ID.get(tid)
    return info if info and info[0] == j["classe"] else None


def hp_max(j: dict) -> int:
    base = HP_BASE + HP_POR_REBIRTH * j.get("rebirths", 0)
    return base + (TITULO_HP_BONUS if _titulo_equipado_info(j) else 0)


def nivel_por_cliques(cliques: int) -> int:
    nivel = 1
    for i, (req, _, _) in enumerate(NIVEIS):
        if cliques >= req:
            nivel = i + 1
    return nivel


def _mult_rebirth(j: dict) -> int:
    # 1º rebirth = conta 10x mais cliques por clique, 2º = 20x... (sem
    # rebirth = 1x). Os Jcoins por clique NÃO mudam com rebirth — só o
    # progresso de nível anda mais rápido.
    return max(1, 10 * j.get("rebirths", 0))


LIMITE_JCOINS_MARGEM = 1.10  # teto = preço do autoclick nível 10 + 10%


def limite_jcoins(rebirths: int) -> int:
    """Teto de jcoins guardados: 10% a mais que o preço do autoclick nível 10
    (do rebirth atual) — o autoclick nível 10 encarece MUITO a cada rebirth
    (mult_preco_autoclicker), então o teto precisa acompanhar isso pra sempre
    dar pra juntar o suficiente pra comprá-lo."""
    preco_nivel_10 = AUTO_PRECO_UPGRADE[10] * mult_preco_autoclicker(max(0, rebirths))
    return round(preco_nivel_10 * LIMITE_JCOINS_MARGEM)


def _adicionar_jcoins(j: dict, quantidade: int) -> None:
    limite = limite_jcoins(j.get("rebirths", 0))
    j["jcoins"] = min(limite, j.get("jcoins", 0) + quantidade)


def limpar_efeitos(j: dict, agora: float) -> bool:
    vencidos = [k for k, ef in j["efeitos"].items() if ef.get("expira", 0) <= agora]
    for k in vencidos:
        del j["efeitos"][k]
    return bool(vencidos)


def _efeito(j: dict, chave: str, agora: float) -> int:
    ef = j["efeitos"].get(chave)
    if ef and ef.get("expira", 0) > agora:
        return ef.get("valor", 0)
    return 0


def _pets_equipados(j: dict) -> list:
    por_id = {p["id"]: p for p in j.get("pets", [])}
    return [por_id[pid] for pid in j.get("pets_equipados", []) if pid in por_id]


def _mult_pets(j: dict) -> float:
    mult = 1.0
    for p in _pets_equipados(j):
        mult *= p.get("mult", 1)
    return mult


def _bonus_skill_pets(j: dict) -> dict:
    bonus = {s: 0 for s in SKILLS}
    for p in _pets_equipados(j):
        extra = p.get("skill_extra")
        if not extra:
            continue
        if extra["tipo"] == "todas":
            for s in SKILLS:
                bonus[s] += extra["bonus"]
        elif extra["tipo"] == "foco":
            for s in SKILLS:
                bonus[s] += extra["bonus_foco"] if s == extra["foco"] else extra["bonus_resto"]
    return bonus


def valores_clique(j: dict, agora: float) -> Tuple[int, int]:
    """(quanto 1 clique conta pro nível, quantos Jcoins 1 clique dá)."""
    _, cpc, jpc = NIVEIS[j["nivel"] - 1]
    mult = _efeito(j, "clique", agora) or 1
    mult_pets = _mult_pets(j)
    return round(cpc * _mult_rebirth(j) * mult * mult_pets), round(jpc * mult * mult_pets)


def _atualizar_nivel(j: dict) -> int:
    antigo = j["nivel"]
    novo = max(antigo, nivel_por_cliques(j["cliques"]))
    j["nivel"] = novo
    if novo >= NIVEL_AUTOCLICKER and j["auto_nivel"] == 0:
        j["auto_nivel"] = 1
    return novo - antigo


def aplicar_cliques(j: dict, n: int, agora: float) -> int:
    """Soma n cliques; retorna quantos níveis subiu."""
    if n <= 0:
        return 0
    cpc, jpc = valores_clique(j, agora)
    j["cliques"] += n * cpc
    _adicionar_jcoins(j, n * jpc)
    return _atualizar_nivel(j)


def recompensa_pvp(j: dict, venceu: bool) -> dict:
    """Vencedor ganha 100 cliques, perdedor 10 — no valor do nível de cada um
    (poção de clique não conta aqui)."""
    n = RECOMPENSA_VITORIA if venceu else RECOMPENSA_DERROTA
    _, cpc, jpc = NIVEIS[j["nivel"] - 1]
    cliques = n * cpc * _mult_rebirth(j)
    jcoins = n * jpc
    j["cliques"] += cliques
    _adicionar_jcoins(j, jcoins)
    subiu = _atualizar_nivel(j)
    return {"cliques": cliques, "jcoins": jcoins, "subiu_nivel": subiu}


# ---------------------------------------------------------------------------
# Skills
# ---------------------------------------------------------------------------

def _bonus_slot(j: dict, slot: str) -> int:
    idx = j["equip"].get(slot, -1)
    return MATERIAIS[idx]["bonus"] if 0 <= idx < len(MATERIAIS) else 0


MULT_SKILL_POR_REBIRTH = 1.5  # cada rebirth multiplica todas as skills por isso


def _mult_skill_rebirth(j: dict) -> float:
    return MULT_SKILL_POR_REBIRTH ** j.get("rebirths", 0)


def skills(j: dict, agora: float) -> dict:
    """Total de cada skill (base + classe + equipamento + livros + poções) e,
    separado, só a parte que vem de poção ativa (pra mostrar na tela)."""
    total = {s: SKILL_BASE for s in SKILLS}
    skill_classe = CLASSES[j["classe"]]["skill"]
    total[skill_classe] += BONUS_CLASSE
    total[skill_classe] += _bonus_slot(j, "arma")
    for slot, info in SLOTS_ARMADURA.items():
        total[info["skill"]] += _bonus_slot(j, slot)
    for slot, info in SLOTS_LIVRO.items():
        total[info["skill"]] += _bonus_slot(j, slot)
    bonus_pets = _bonus_skill_pets(j)
    for s in SKILLS:
        total[s] += bonus_pets[s]
    pocao = {}
    for s in SKILLS:
        extra = _efeito(j, s, agora)
        if extra:
            pocao[s] = extra
            total[s] += extra
    m_skill, m_nivel = j.get("maestria_skill"), j.get("maestria_nivel", 0)
    if m_skill and m_nivel:
        total[m_skill] += round(total[m_skill] * MAESTRIA_BONUS_PCT[m_nivel] / 100)
    titulo_info = _titulo_equipado_info(j)
    if titulo_info:
        total[titulo_info[1]] += TITULO_SKILL_BONUS
    for s, valor in (j.get("respec_pontos") or {}).items():
        if s in total:
            total[s] += valor
    mult_rebirth = _mult_skill_rebirth(j)
    if mult_rebirth != 1:
        total = {s: round(v * mult_rebirth) for s, v in total.items()}
    return {"total": total, "pocao": pocao}


# ---------------------------------------------------------------------------
# Loja
# ---------------------------------------------------------------------------

def _slot_valido(slot: str) -> bool:
    return slot == "arma" or slot in SLOTS_ARMADURA or slot in SLOTS_LIVRO


def nome_item(j: dict, slot: str, idx: int) -> str:
    material = MATERIAIS[idx]["nome"]
    if slot == "arma":
        return "%s de %s" % (CLASSES[j["classe"]]["arma"], material)
    if slot in SLOTS_ARMADURA:
        return "%s de %s" % (SLOTS_ARMADURA[slot]["nome"], material)
    return "%s (%s)" % (SLOTS_LIVRO[slot]["nome"], material)


def _preco_equip(j: dict, idx: int) -> int:
    return MATERIAIS[idx]["preco"] * mult_preco_equip(j.get("rebirths", 0))


def comprar(j: dict, item_id: str) -> Tuple[bool, str]:
    if item_id in POCOES:
        p = POCOES[item_id]
        if j["jcoins"] < p["preco"]:
            return False, "Jcoins insuficientes."
        j["jcoins"] -= p["preco"]
        j["pocoes"][item_id] = j["pocoes"].get(item_id, 0) + 1
        return True, "Comprou: " + p["nome"] + "."

    slot, _, material = item_id.partition(":")
    if not _slot_valido(slot) or material not in _MATERIAL_INDICE:
        return False, "Item inválido."
    idx = _MATERIAL_INDICE[material]
    atual = j["equip"].get(slot, -1)
    if idx <= atual:
        return False, "Você já tem esse item."
    if idx != atual + 1:
        return False, "Compre antes: " + nome_item(j, slot, atual + 1) + "."
    preco = _preco_equip(j, idx)
    if j["jcoins"] < preco:
        return False, "Jcoins insuficientes."
    j["jcoins"] -= preco
    j["equip"][slot] = idx
    return True, "Comprou: " + nome_item(j, slot, idx) + "."


def comprar_maximo_equip(j: dict, slot: str) -> Tuple[bool, str, int]:
    """Compra todos os materiais consecutivos acessíveis no slot."""
    if not _slot_valido(slot):
        return False, "Slot inválido.", 0
    comprados = 0
    ultimo = ""
    while True:
        atual = j["equip"].get(slot, -1)
        prox = atual + 1
        if prox >= len(MATERIAIS):
            break
        preco = _preco_equip(j, prox)
        if j["jcoins"] < preco:
            break
        j["jcoins"] -= preco
        j["equip"][slot] = prox
        ultimo = nome_item(j, slot, prox)
        comprados += 1
    if comprados == 0:
        return False, "Jcoins insuficientes para o próximo item.", 0
    return True, "Comprou %d item(ns) — equipado: %s." % (comprados, ultimo), comprados


def usar_pocao(j: dict, pocao_id: str, agora: float) -> Tuple[bool, str]:
    """Só poções de clique passam por aqui — as de skill só valem em combate
    (ver usar_pocao_luta), então nunca consomem/expiram fora de uma luta."""
    p = POCOES.get(pocao_id)
    if not p:
        return False, "Poção inválida."
    if p["tipo"] != "clique":
        return False, "Essa poção só pode ser usada durante uma luta."
    if j["pocoes"].get(pocao_id, 0) <= 0:
        return False, "Você não tem essa poção."
    ativo = j["efeitos"].get("clique")
    if ativo and ativo.get("expira", 0) > agora:
        if ativo["valor"] > p["valor"]:
            return False, "Você já tem uma poção mais forte desse tipo ativa."
        if ativo["valor"] == p["valor"]:
            ativo["expira"] += p["dur"]
        else:
            j["efeitos"]["clique"] = {"valor": p["valor"], "expira": agora + p["dur"]}
    else:
        j["efeitos"]["clique"] = {"valor": p["valor"], "expira": agora + p["dur"]}
    j["pocoes"][pocao_id] -= 1
    if j["pocoes"][pocao_id] <= 0:
        del j["pocoes"][pocao_id]
    return True, "Usou: " + p["nome"] + "."


def pode_usar_pocao_luta(lutador: dict, pocao_id: str) -> bool:
    p = POCOES.get(pocao_id)
    return bool(p) and p["tipo"] == "skill" and p["skill"] not in lutador.get("pocoes_usadas", [])


def usar_pocao_luta(j: dict, lutador: dict, pocao_id: str) -> Tuple[bool, str]:
    """Poção de atributo em combate: some com a skill pro resto da luta, não
    gasta o turno e só uma por skill (não empilha nem troca de vez)."""
    p = POCOES.get(pocao_id)
    if not p or p["tipo"] != "skill":
        return False, "Poção inválida para uso em luta."
    if j["pocoes"].get(pocao_id, 0) <= 0:
        return False, "Você não tem essa poção."
    if p["skill"] in lutador.get("pocoes_usadas", []):
        return False, "Você já usou uma poção de %s nesta luta." % SKILL_NOMES[p["skill"]]
    j["pocoes"][pocao_id] -= 1
    if j["pocoes"][pocao_id] <= 0:
        del j["pocoes"][pocao_id]
    lutador["stats"][p["skill"]] = lutador["stats"].get(p["skill"], 0) + p["valor"]
    lutador.setdefault("pocoes_usadas", []).append(p["skill"])
    return True, "Usou: " + p["nome"] + "."


def mult_preco_autoclicker(rebirths: int) -> int:
    """Cada rebirth encarece MUITO o autoclicker (todos os níveis, não só o
    10) — no 3º rebirth o nível 10 (base 5B) vira 1T, no 4º vira 10T, no 5º
    100T e por aí vai (×10 a cada rebirth a partir do 3º)."""
    if rebirths <= 0:
        return 1
    if rebirths == 1:
        return 10
    if rebirths == 2:
        return 50
    return 200 * (10 ** (rebirths - 3))


def mult_preco_equip(rebirths: int) -> int:
    """Arma, armadura e livros ficam mais caros a cada rebirth (menos
    agressivo que o autoclicker, mas ainda pesado no fim do jogo)."""
    if rebirths <= 0:
        return 1
    if rebirths == 1:
        return 3
    if rebirths == 2:
        return 8
    return 8 * (5 ** (rebirths - 2))


def melhorar_autoclicker(j: dict) -> Tuple[bool, str]:
    atual = j["auto_nivel"]
    if atual == 0:
        return False, "O autoclicker libera no nível %d." % NIVEL_AUTOCLICKER
    if atual >= max(AUTO_CPS):
        return False, "Seu autoclicker já está no nível máximo."
    preco = AUTO_PRECO_UPGRADE[atual + 1] * mult_preco_autoclicker(j.get("rebirths", 0))
    if j["jcoins"] < preco:
        return False, "Jcoins insuficientes."
    j["jcoins"] -= preco
    j["auto_nivel"] = atual + 1
    return True, "Autoclicker agora é nível %d (%d cliques/s)." % (atual + 1, AUTO_CPS[atual + 1])


# ---------------------------------------------------------------------------
# Pets
# ---------------------------------------------------------------------------

def rolar_pet(j: dict, tier: str, agora: float) -> Tuple[bool, str, Optional[dict]]:
    info = PET_TIERS.get(tier)
    if not info:
        return False, "Roleta inválida.", None
    minimo = PET_REBIRTH_MINIMO.get(tier, 0)
    if j.get("rebirths", 0) < minimo:
        return False, "Essa roleta exige %d rebirth(s)." % minimo, None
    if len(j.get("pets", [])) >= PET_MAX_MOCHILA:
        return False, "Sua mochila de pets está cheia (máx. %d) — venda algum antes de rolar de novo." % PET_MAX_MOCHILA, None
    preco = info["preco"]  # preço fixo — não varia com rebirth
    if j["jcoins"] < preco:
        return False, "Jcoins insuficientes.", None
    j["jcoins"] -= preco
    rng = random.Random()
    nome = rng.choice(PET_NOMES[tier])
    if tier == "basica":
        mult = round(rng.uniform(*PET_MULT_BASICA), 2)
        skill_extra = None
    elif tier == "epica":
        mult = round(rng.uniform(*PET_MULT_EPICA), 2)
        skill_extra = {"tipo": "todas", "bonus": PET_BONUS_EPICA}
    else:  # divina
        mult = round(rng.uniform(*PET_MULT_DIVINA), 2)
        total_atual = skills(j, agora)["total"]
        foco = min(SKILLS, key=lambda s: total_atual[s])
        skill_extra = {"tipo": "foco", "foco": foco,
                       "bonus_foco": PET_BONUS_DIVINA_FOCO, "bonus_resto": PET_BONUS_DIVINA_RESTO}
    pet = {
        "id": secrets.token_hex(4),
        "tier": tier,
        "nome": nome,
        "mult": mult,
        "preco_pago": preco,
        "skill_extra": skill_extra,
    }
    j.setdefault("pets", []).append(pet)
    return True, "Pet obtido: %s (%s, %sx no clique)!" % (nome, info["nome"], mult), pet


def equipar_pet(j: dict, pet_id: str, equipar: bool) -> Tuple[bool, str]:
    por_id = {p["id"]: p for p in j.get("pets", [])}
    if pet_id not in por_id:
        return False, "Pet não encontrado."
    equipados = j.setdefault("pets_equipados", [])
    if equipar:
        if pet_id in equipados:
            return False, "Esse pet já está equipado."
        maximo = pet_max_equipados(j.get("rebirths", 0))
        if len(equipados) >= maximo:
            return False, "Você só pode equipar até %d pets." % maximo
        equipados.append(pet_id)
        return True, "Pet equipado: %s." % por_id[pet_id]["nome"]
    if pet_id not in equipados:
        return False, "Esse pet não está equipado."
    equipados.remove(pet_id)
    return True, "Pet removido: %s." % por_id[pet_id]["nome"]


def vender_pet(j: dict, pet_id: str) -> Tuple[bool, str]:
    pets = j.get("pets", [])
    pet = next((p for p in pets if p["id"] == pet_id), None)
    if not pet:
        return False, "Pet não encontrado."
    reembolso = round(pet.get("preco_pago", 0) * PET_VENDA_FATOR)
    pets.remove(pet)
    equipados = j.get("pets_equipados", [])
    if pet_id in equipados:
        equipados.remove(pet_id)
    _adicionar_jcoins(j, reembolso)
    return True, "Vendeu %s por %s Jcoins." % (pet["nome"], format(reembolso, ",d").replace(",", "."))


def titulos_da_classe(classe: str) -> list:
    return [dict(t, skill=skill) for skill, t in TITULOS.get(classe, {}).items()]


def comprar_titulo(j: dict, titulo_id: str) -> Tuple[bool, str]:
    info = _TITULO_POR_ID.get(titulo_id)
    if not info or info[0] != j["classe"]:
        return False, "Esse título não é da sua classe."
    if titulo_id in j.get("titulos", []):
        return False, "Você já tem esse título."
    if j["jcoins"] < PRECO_TITULO:
        return False, "Jcoins insuficientes."
    j["jcoins"] -= PRECO_TITULO
    j.setdefault("titulos", []).append(titulo_id)
    return True, "Título conquistado: " + info[2]["nome"] + "!"


def equipar_titulo(j: dict, titulo_id: Optional[str]) -> Tuple[bool, str]:
    if not titulo_id:
        j["titulo_equipado"] = None
        return True, "Título removido."
    if titulo_id not in j.get("titulos", []):
        return False, "Você não tem esse título."
    j["titulo_equipado"] = titulo_id
    return True, "Título equipado: " + _TITULO_POR_ID[titulo_id][2]["nome"] + "."


def pode_respec(j: dict) -> bool:
    return j.get("rebirths", 0) >= NIVEL_REBIRTHS_RESPEC


def respec_distribuicao_atual(j: dict) -> dict:
    """Como o total de pontos redistribuíveis está dividido HOJE entre as 5
    skills: a última redistribuição guardada (se já usou respec antes) MAIS
    o bônus de qualquer arma/armadura/livro comprado desde então (cada um na
    sua skill normal) — assim um respec seguinte também derrete gear
    reequipado depois do último."""
    dist = dict(j.get("respec_pontos") or {})
    for s in SKILLS:
        dist.setdefault(s, 0)
    dist[CLASSES[j["classe"]]["skill"]] += _bonus_slot(j, "arma")
    for slot, info in SLOTS_ARMADURA.items():
        dist[info["skill"]] += _bonus_slot(j, slot)
    for slot, info in SLOTS_LIVRO.items():
        dist[info["skill"]] += _bonus_slot(j, slot)
    return dist


def total_pontos_respec(j: dict) -> int:
    return sum(respec_distribuicao_atual(j).values())


def respec_livros(j: dict, distribuicao: dict) -> Tuple[bool, str]:
    """Derrete TUDO que dá bônus de skill via equipamento — arma, as 4
    armaduras e os 5 livros — numa pilha só de pontos, e deixa redistribuir
    como quiser entre as 5 skills (não precisa mais seguir a skill "normal"
    de cada peça). Arma e armaduras somem do personagem nesse processo —
    pra outro rebirth precisa comprá-las de novo."""
    if not pode_respec(j):
        return False, "Redistribuir skills libera depois do 2º rebirth."
    if j["jcoins"] < PRECO_RESPEC:
        return False, "Jcoins insuficientes."
    total_atual = total_pontos_respec(j)
    try:
        nova = {s: int(distribuicao.get(s, 0)) for s in SKILLS}
    except (TypeError, ValueError):
        return False, "Distribuição inválida."
    if any(v < 0 for v in nova.values()):
        return False, "Cada skill precisa ter 0 ou mais pontos."
    if sum(nova.values()) != total_atual:
        return False, "A soma precisa ser igual ao total atual (%d)." % total_atual
    j["jcoins"] -= PRECO_RESPEC
    j["equip"].pop("arma", None)
    for slot in SLOTS_ARMADURA:
        j["equip"].pop(slot, None)
    for slot in SLOTS_LIVRO:
        j["equip"].pop(slot, None)
    j["respec_pontos"] = nova
    return True, "Skills redistribuídas! Arma, armaduras e livros foram derretidos — compre de novo se quiser reequipar."


def nivel_requerido_rebirth(rebirths: int) -> int:
    return NIVEL_REBIRTH_REQUERIDO.get(rebirths, NIVEL_MAX)


def faltando_rebirth(j: dict) -> list:
    faltando = []
    necessario = nivel_requerido_rebirth(j.get("rebirths", 0))
    if j["nivel"] < necessario:
        faltando.append("Nível %d" % necessario)
    ultimo = len(MATERIAIS) - 1
    for slot in SLOTS_REBIRTH:
        if j["equip"].get(slot, -1) < ultimo:
            faltando.append(nome_item(j, slot, ultimo))
    return faltando


def fazer_rebirth(j: dict) -> Tuple[bool, str]:
    if faltando_rebirth(j):
        return False, "Ainda falta coisa pro rebirth."
    j["rebirths"] += 1
    j.update({
        "jcoins": 0, "cliques": 0, "nivel": 1, "auto_nivel": 1,
        "equip": {}, "pocoes": {}, "efeitos": {},
        "maestria_skill": None, "maestria_nivel": 0,
        "respec_pontos": {},
        "pets": [], "pets_equipados": [],
    })
    return True, "Rebirth %d feito! Agora cada clique conta %dx mais pro nível e você tem %d de vida." % (
        j["rebirths"], _mult_rebirth(j), hp_max(j))


# ---------------------------------------------------------------------------
# Maestria — bônus permanente (até o próximo rebirth) numa única skill.
# ---------------------------------------------------------------------------

def escolher_maestria(j: dict, skill: str) -> Tuple[bool, str]:
    if skill not in SKILLS:
        return False, "Skill inválida."
    if j["nivel"] < NIVEL_MAESTRIA_DESBLOQUEIO:
        return False, "A maestria libera no nível %d." % NIVEL_MAESTRIA_DESBLOQUEIO
    if j.get("maestria_skill") == skill:
        return False, "Você já está trilhando essa maestria."
    j["maestria_skill"] = skill
    j["maestria_nivel"] = 0
    return True, "Maestria escolhida: " + SKILL_NOMES[skill] + "."


def melhorar_maestria(j: dict) -> Tuple[bool, str]:
    skill = j.get("maestria_skill")
    if not skill:
        return False, "Escolha uma skill pra evoluir a maestria primeiro."
    nivel = j.get("maestria_nivel", 0)
    if nivel >= MAESTRIA_MAX:
        return False, "Maestria já está no nível máximo."
    preco = MAESTRIA_PRECO[nivel + 1]
    if j["jcoins"] < preco:
        return False, "Jcoins insuficientes."
    j["jcoins"] -= preco
    j["maestria_nivel"] = nivel + 1
    return True, "Maestria de %s agora é nível %d (+%d%%)." % (
        SKILL_NOMES[skill], nivel + 1, MAESTRIA_BONUS_PCT[nivel + 1])


# ---------------------------------------------------------------------------
# Luta por turnos
# ---------------------------------------------------------------------------

def novo_lutador(j: dict, agora: float) -> dict:
    vida = hp_max(j)
    stats = dict(skills(j, agora)["total"])
    # Capacete + peitoral + calça (até +3000 de resistência) e bota (até +1000
    # de agilidade) diluiriam o bônus de Curandeiro e Monge; na luta essas
    # peças pesam menos nessas duas skills.
    for s, info in SLOTS_ARMADURA.items():
        peso = PESO_BOTA if s == "bota" else PESO_ARMADURA
        stats[info["skill"]] -= round(_bonus_slot(j, s) * (1 - peso))
    mult_agil = AGILIDADE_MULT_CLASSE.get(j["classe"], 1.0)
    if mult_agil != 1.0:
        stats["agilidade"] = round(stats["agilidade"] * mult_agil)
    return {
        "stats": stats,
        "classe": j["classe"],
        "hp": vida,
        "hp_max": vida,
        "defendendo": False,
        "esquivando": False,
        "turnos": 0,
        "esquiva_livre_em": 0,
        "curou_ultimo": False,
        "curas": 0,
        "pocoes_usadas": [],
    }


def _disputa(x: float, y: float, gama: float = 1.0) -> float:
    """0..1 — 0.5 quando empatam; gama maior = diferença pesa mais."""
    if x <= 0 or y <= 0:
        return 0.5 if x == y else (1.0 if y <= 0 else 0.0)
    return 1.0 / (1.0 + (y / x) ** gama)


def _poder_ataque(st: dict) -> float:
    # Magia e força são de ataque: vale a maior, e a menor ajuda um pouco.
    # Magia rende um pouco menos no ataque porque também turbina a cura.
    forca, magia = st["forca"], st["magia"] * PESO_MAGIA_ATAQUE
    return max(forca, magia) + 0.25 * min(forca, magia)


def _cura(ator: dict, alvo: dict) -> int:
    # Cada cura rende menos que a anterior — sem isso, com muita magia, a luta
    # nunca acabava (a cura passava do dano).
    base = CURA_BASE + CURA_FATOR * _disputa(ator["stats"]["magia"], alvo["stats"]["magia"])
    base *= HEALING_MULT_CLASSE.get(ator.get("classe"), 1.0)
    return max(1, round(base * CURA_DECAIMENTO ** ator["curas"]))


def _tipo_ataque(stats: dict) -> str:
    return "magica" if stats["magia"] >= stats["forca"] else "fisica"


def _resolver_ataque(ator: dict, alvo: dict, rng: random.Random) -> dict:
    a, d = ator["stats"], alvo["stats"]
    agil = _disputa(d["agilidade"], a["agilidade"], G_AGILIDADE)
    prec = _disputa(a["precisao"], d["precisao"], G_PRECISAO)
    # Precisão do atacante atrapalha a esquiva (1.0 quando as duas empatam).
    contra_esquiva = 1.5 - prec
    if alvo["esquivando"]:
        chance_esquiva = (ESQUIVA_ATIVA_BASE + ESQUIVA_ATIVA_FATOR * agil) * contra_esquiva
    else:
        chance_esquiva = ESQUIVA_PASSIVA * 2 * agil * contra_esquiva
    if rng.random() < chance_esquiva:
        return {"resultado": "esquivou", "dano": 0, "total": False}

    # Piso na disputa de resistência: sem isso, quem empilha resistência (o
    # próprio bônus de classe do curandeiro) reduzia o dano recebido a
    # praticamente zero contra QUALQUER atacante — o floor de "1 de dano" no
    # fim da conta virava o único dano possível, tornando o curandeiro
    # invencível na prática, mesmo contra força bruta (monge/guerreiro).
    resist_disputa = max(RESISTENCIA_DISPUTA_MIN, _disputa(a["resistencia"], d["resistencia"], G_RESISTENCIA))
    dano = (DANO_BASE
            * 2 * _disputa(_poder_ataque(a), _poder_ataque(d), G_ATAQUE)
            * 2 * resist_disputa)

    # Fraquezas/resistências por classe, conforme o tipo do ataque.
    tipo = _tipo_ataque(a)
    classe_alvo = alvo.get("classe")
    dano *= RESISTENCIA_CLASSE.get(classe_alvo, {}).get(tipo, 1.0)

    # Mago é fraco contra precisão: quanto mais o atacante domina em
    # precisão, mais dano extra o mago toma (até +15%).
    if classe_alvo == "mago":
        dano *= 1 + PRECISAO_EXTRA_MAGO * prec

    # Curandeiro é fraco contra força bruta: quanto mais o atacante domina em
    # força, mais dano extra o curandeiro toma — cobre monge e guerreiro, que
    # vivem de força, sem depender só da resistência (que o curandeiro
    # empilha como classe e o deixava praticamente invencível).
    if classe_alvo == "curandeiro":
        forca_dom = _disputa(a["forca"], d["forca"], G_ATAQUE)
        dano *= 1 + FORCA_EXTRA_CURANDEIRO * forca_dom

    # Arqueiro toma "crítico de magia": chance extra de dano mágico ampliado.
    critico_magico = False
    if tipo == "magica" and classe_alvo == "arqueiro" and rng.random() < CHANCE_CRITICO_MAGICO_ARQUEIRO:
        dano *= CRITICO_MAGICO_MULT
        critico_magico = True

    total = rng.random() < 0.3 + 0.6 * prec
    if not total:
        dano *= rng.uniform(*DANO_PARCIAL)
    resultado = "acertou"
    if alvo["defendendo"]:
        dano *= 1 - (0.3 + 0.45 * _disputa(d["resistencia"], a["resistencia"], G_RESISTENCIA))
        resultado = "defendeu"
    dano = max(1, round(dano))
    alvo["hp"] = max(0, alvo["hp"] - dano)
    return {"resultado": resultado, "dano": dano, "total": total, "critico_magico": critico_magico}


def pode_esquivar(lutador: dict) -> bool:
    return lutador["turnos"] >= lutador["esquiva_livre_em"]


def pode_curar(lutador: dict) -> bool:
    return not lutador["curou_ultimo"] and lutador["hp"] < lutador["hp_max"]


def executar_acao(ator: dict, alvo: dict, acao: str, nick_ator: str, nick_alvo: str,
                  rng: random.Random) -> Tuple[bool, dict]:
    """Aplica a ação do jogador da vez. A postura (defender/esquivar) de quem
    age agora vale só até o próximo turno dele — então é limpa aqui."""
    if acao not in ACOES_LUTA:
        return False, {"texto": "Ação inválida."}
    if acao == "esquivar" and not pode_esquivar(ator):
        falta = ator["esquiva_livre_em"] - ator["turnos"]
        return False, {"texto": "Esquiva disponível em %d turno(s)." % falta}
    if acao == "curar" and not pode_curar(ator):
        motivo = "Sua vida já está cheia." if ator["hp"] >= ator["hp_max"] else "Não dá pra curar dois turnos seguidos."
        return False, {"texto": motivo}

    ator["defendendo"] = False
    ator["esquivando"] = False
    evento = {"acao": acao, "dano": 0, "cura": 0, "resultado": "", "total": False}

    if acao == "atacar":
        evento.update(_resolver_ataque(ator, alvo, rng))
        alvo["defendendo"] = False
        alvo["esquivando"] = False
        if evento["resultado"] == "esquivou":
            evento["texto"] = "%s esquivou do ataque de %s!" % (nick_alvo, nick_ator)
        elif evento["resultado"] == "defendeu":
            evento["texto"] = "%s atacou, mas %s defendeu: só %d de dano." % (nick_ator, nick_alvo, evento["dano"])
        else:
            sufixo = " (dano total!)" if evento["total"] else ""
            if evento.get("critico_magico"):
                sufixo += " (crítico mágico!)"
            evento["texto"] = "%s deu um tapa em %s: %d de dano%s." % (
                nick_ator, nick_alvo, evento["dano"], sufixo)
    elif acao == "esquivar":
        ator["esquivando"] = True
        ator["esquiva_livre_em"] = ator["turnos"] + ESQUIVA_INTERVALO
        evento["texto"] = "%s se prepara pra esquivar do próximo ataque." % nick_ator
    elif acao == "defender":
        ator["defendendo"] = True
        evento["texto"] = "%s levantou o escudo." % nick_ator
    else:
        cura = min(_cura(ator, alvo), ator["hp_max"] - ator["hp"])
        ator["curas"] += 1
        ator["hp"] += cura
        evento["cura"] = cura
        evento["texto"] = "%s se curou em %d de vida." % (nick_ator, cura)

    ator["curou_ultimo"] = acao == "curar"
    ator["turnos"] += 1
    return True, evento
