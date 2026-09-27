"""Splano.io — regras e física do jogo de bolinhas (estilo agar.io).

Só lógica pura aqui (sem rede nem disco): o servidor autoritativo, as salas e
o WebSocket ficam em routers/splano.py. Toda posição é em "unidades" do mapa;
a arena é um quadrado de lado ARENA fechado (as bolinhas nunca saem dela).
"""
import math
import random
from typing import Optional

# ---------------------------------------------------------------------------
# Constantes do mundo
# ---------------------------------------------------------------------------

ARENA = 3000.0            # lado do quadrado (dá pra 20 jogadores respirarem)
ENERGIA_INICIAL = 10
RAIO_BASE = 26.0          # raio de quem está com ENERGIA_INICIAL
VELOCIDADE_BASE = 250.0   # unidades por segundo com ENERGIA_INICIAL
VELOCIDADE_EXPOENTE = 0.22  # quanto maior, mais a velocidade cai com o tamanho
VELOCIDADE_MINIMA = 55.0

PELLET_VALOR = 1
PELLET_RAIO = 7.0
PELLETS_POR_AREA = 1 / 11000.0   # ~818 pellets numa arena de 3000x3000 (20 jogadores)
PELLETS_POR_TICK = 3             # quantos repõem por tick quando falta

# Divisão (clique duplo) — as metades se juntam de novo e a bolinha "volta
# ao normal" passados SEGUNDOS_PARA_JUNTAR segundos.
CELULAS_MAXIMO = 8
ENERGIA_MINIMA_DIVIDIR = 24
IMPULSO_DIVISAO = 520.0
SEGUNDOS_PARA_JUNTAR = 5.0
VELOCIDADE_JUNTAR = 300.0   # o quão rápido as metades se reaproximam depois disso

# Soltar energia (segurar o botão)
CUSTO_SOLTAR = 4
VALOR_SOLTAR = 3          # parte da energia se perde no caminho
IMPULSO_SOLTAR = 430.0
INTERVALO_SOLTAR = 0.14   # segundos entre uma bolinha e outra
ENERGIA_MINIMA_SOLTAR = ENERGIA_INICIAL + CUSTO_SOLTAR

# Comer
SEGUNDOS_PROTEGIDO = 4.0    # logo que a partida começa ninguém pode ser comido
VANTAGEM_PARA_COMER = 1.2   # preciso ter 20% a mais de energia
SOBREPOSICAO_PARA_COMER = 0.35

# Itens especiais — nascem em leva, espalhados pelo mapa, e somem sozinhos
# se ninguém comer a tempo.
POWERUPS_MAXIMO = 24
POWERUPS_POR_LEVA = 6       # quantos nascem de uma vez
POWERUP_RAIO = 34.0         # bem maior que o pellet, pra dá pra ver de longe
POWERUP_INTERVALO = 30.0    # segundos entre uma leva e outra
POWERUP_VIDA = 10.0         # segundos até sumir se ninguém comer
DOBRO_ENERGIA_SEGUNDOS = 30.0
TIPOS_POWERUP = ("energia2x", "tamanho2x")

# Fim de partida
FRACAO_ARENA_VITORIA = 0.34   # raio >= 34% da metade da arena = tomou conta
DURACAO_MAXIMA = 6 * 60.0     # empate técnico: ganha quem tiver mais energia
MOEDAS_VITORIA = 100
MOEDAS_KILL = 20

NIVEIS_BOT = ("iniciante", "competente")
NOMES_BOTS = [
    "Bolhinha", "Zé da Bola", "Comilão", "Pac-Zin", "Orbitz", "Redondo",
    "Gorducho", "Sr. Círculo", "Bolota", "Esferinha", "Tiozão", "Rolim",
    "Nuvem", "Pipoca", "Melancia", "Brigadeiro", "Gulodice", "Bolinha Azul",
    "Planeta X", "Lua Cheia", "Mochi", "Tapioca", "Pingo", "Bolha do Mal",
    "Disquete", "Marmita", "Didi Bolinha", "Bolonha", "Caçula", "Redonda",
    "Bolão", "Tampinha",
]


# ---------------------------------------------------------------------------
# Helpers de tamanho/velocidade
# ---------------------------------------------------------------------------

def raio(energia: float) -> float:
    """Área proporcional à energia — dobrar energia não dobra o raio."""
    return RAIO_BASE * math.sqrt(max(energia, 1) / ENERGIA_INICIAL)


def velocidade(energia: float) -> float:
    fator = (ENERGIA_INICIAL / max(energia, 1)) ** VELOCIDADE_EXPOENTE
    return max(VELOCIDADE_MINIMA, VELOCIDADE_BASE * fator)


def _distancia(ax: float, ay: float, bx: float, by: float) -> float:
    return math.hypot(ax - bx, ay - by)


def _normalizar(dx: float, dy: float):
    tamanho = math.hypot(dx, dy)
    if tamanho < 0.01:
        return 0.0, 0.0
    return dx / tamanho, dy / tamanho


# ---------------------------------------------------------------------------
# Criação de estado
# ---------------------------------------------------------------------------

def novo_jogo() -> dict:
    return {
        "fase": "espera",
        "jogadores": {},
        "pellets": {},
        "powerups": {},
        "proximo_id": 1,
        "comecou_em": 0.0,
        "proximo_powerup": 0.0,
        "vencedor": None,
        "motivo_fim": "",
    }


def _novo_id(jogo: dict) -> int:
    jogo["proximo_id"] += 1
    return jogo["proximo_id"]


def _ponto_livre(margem: float = 160.0) -> tuple:
    return (random.uniform(margem, ARENA - margem),
            random.uniform(margem, ARENA - margem))


def nova_celula(jogo: dict, x: float, y: float, energia: float) -> dict:
    return {"id": _novo_id(jogo), "x": x, "y": y, "vx": 0.0, "vy": 0.0,
            "energia": float(energia), "juntar_em": 0.0}


def entrar(jogo: dict, nome: str, nick: str, avatar: Optional[str],
           cosmeticos: dict, skin: dict, bot: bool = False,
           nivel_bot: str = "") -> dict:
    x, y = _ponto_livre(300.0)
    jogador = {
        "nome": nome, "nick": nick, "avatar": avatar,
        "cosmeticos": cosmeticos or {}, "skin": skin or {},
        "bot": bot, "nivel_bot": nivel_bot,
        "celulas": [nova_celula(jogo, x, y, ENERGIA_INICIAL)],
        "vivo": True, "kills": 0, "dobro_ate": 0.0,
        "dir_x": 0.0, "dir_y": 0.0, "soltando": False, "ultimo_soltar": 0.0,
        "energia_maxima": float(ENERGIA_INICIAL),
        "morto_por": None, "protegido_ate": 0.0,
    }
    jogo["jogadores"][nome] = jogador
    return jogador


def energia_total(jogador: dict) -> float:
    return sum(c["energia"] for c in jogador["celulas"])


def vivos(jogo: dict) -> list:
    return [j for j in jogo["jogadores"].values() if j["vivo"]]


# ---------------------------------------------------------------------------
# Pellets e power-ups
# ---------------------------------------------------------------------------

def pellets_alvo() -> int:
    return int(ARENA * ARENA * PELLETS_POR_AREA)


def repor_pellets(jogo: dict, quantidade: int = PELLETS_POR_TICK) -> None:
    faltando = pellets_alvo() - len(jogo["pellets"])
    for _ in range(min(quantidade, max(0, faltando))):
        x, y = _ponto_livre(40.0)
        jogo["pellets"][_novo_id(jogo)] = {"x": x, "y": y, "v": PELLET_VALOR}


def encher_pellets(jogo: dict) -> None:
    repor_pellets(jogo, pellets_alvo())


def _nascer_powerups(jogo: dict, agora: float) -> None:
    """Nasce uma leva inteira de itens espalhados pelo mapa (a cada
    POWERUP_INTERVALO segundos)."""
    if agora < jogo["proximo_powerup"]:
        return
    jogo["proximo_powerup"] = agora + POWERUP_INTERVALO
    for _ in range(POWERUPS_POR_LEVA):
        if len(jogo["powerups"]) >= POWERUPS_MAXIMO:
            break
        x, y = _ponto_livre(220.0)
        jogo["powerups"][_novo_id(jogo)] = {
            "x": x, "y": y, "tipo": random.choice(TIPOS_POWERUP), "nasceu": agora,
        }


def _expirar_powerups(jogo: dict, agora: float) -> None:
    """Item que ninguém comeu em POWERUP_VIDA segundos some."""
    vencidos = [pid for pid, item in jogo["powerups"].items()
                if agora - item.get("nasceu", agora) >= POWERUP_VIDA]
    for pid in vencidos:
        jogo["powerups"].pop(pid, None)


# ---------------------------------------------------------------------------
# Ações do jogador
# ---------------------------------------------------------------------------

def definir_direcao(jogador: dict, dx: float, dy: float) -> None:
    jogador["dir_x"], jogador["dir_y"] = _normalizar(dx, dy)


def dividir(jogo: dict, jogador: dict, agora: float) -> bool:
    if not jogador["vivo"]:
        return False
    dx, dy = jogador["dir_x"], jogador["dir_y"]
    if dx == 0.0 and dy == 0.0:
        dx, dy = 1.0, 0.0
    novas = []
    for celula in list(jogador["celulas"]):
        if len(jogador["celulas"]) + len(novas) >= CELULAS_MAXIMO:
            break
        if celula["energia"] < ENERGIA_MINIMA_DIVIDIR:
            continue
        metade = celula["energia"] / 2.0
        celula["energia"] = metade
        celula["juntar_em"] = agora + SEGUNDOS_PARA_JUNTAR
        filha = nova_celula(jogo, celula["x"], celula["y"], metade)
        filha["vx"] = dx * IMPULSO_DIVISAO
        filha["vy"] = dy * IMPULSO_DIVISAO
        filha["juntar_em"] = agora + SEGUNDOS_PARA_JUNTAR
        novas.append(filha)
    if not novas:
        return False
    jogador["celulas"].extend(novas)
    return True


def soltar_energia(jogo: dict, jogador: dict, agora: float) -> bool:
    if not jogador["vivo"] or agora - jogador["ultimo_soltar"] < INTERVALO_SOLTAR:
        return False
    dx, dy = jogador["dir_x"], jogador["dir_y"]
    if dx == 0.0 and dy == 0.0:
        dx, dy = 1.0, 0.0
    soltou = False
    for celula in jogador["celulas"]:
        if celula["energia"] < ENERGIA_MINIMA_SOLTAR:
            continue
        celula["energia"] -= CUSTO_SOLTAR
        r = raio(celula["energia"])
        jogo["pellets"][_novo_id(jogo)] = {
            "x": celula["x"] + dx * (r + PELLET_RAIO + 4),
            "y": celula["y"] + dy * (r + PELLET_RAIO + 4),
            "v": VALOR_SOLTAR,
            "vx": dx * IMPULSO_SOLTAR, "vy": dy * IMPULSO_SOLTAR,
        }
        soltou = True
    if soltou:
        jogador["ultimo_soltar"] = agora
    return soltou


# ---------------------------------------------------------------------------
# Passo da simulação
# ---------------------------------------------------------------------------

def _mover_celulas(jogador: dict, dt: float) -> None:
    dx, dy = jogador["dir_x"], jogador["dir_y"]
    for celula in jogador["celulas"]:
        vel = velocidade(celula["energia"])
        celula["x"] += (dx * vel + celula["vx"]) * dt
        celula["y"] += (dy * vel + celula["vy"]) * dt
        # o impulso da divisão/solta some rápido
        amortecimento = math.exp(-dt * 4.0)
        celula["vx"] *= amortecimento
        celula["vy"] *= amortecimento
        # a arena é fechada: a bolinha só desliza pela borda, nunca sai
        # (nem mata quem encosta nela).
        r = raio(celula["energia"])
        celula["x"] = min(max(celula["x"], r), ARENA - r)
        celula["y"] = min(max(celula["y"], r), ARENA - r)


def _mover_pellets(jogo: dict, dt: float) -> None:
    for pellet in jogo["pellets"].values():
        if not pellet.get("vx") and not pellet.get("vy"):
            continue
        pellet["x"] += pellet["vx"] * dt
        pellet["y"] += pellet["vy"] * dt
        amortecimento = math.exp(-dt * 5.0)
        pellet["vx"] *= amortecimento
        pellet["vy"] *= amortecimento
        pellet["x"] = min(max(pellet["x"], 10.0), ARENA - 10.0)
        pellet["y"] = min(max(pellet["y"], 10.0), ARENA - 10.0)


def _separar_ou_juntar(jogador: dict, dt: float, agora: float) -> None:
    """Células do mesmo jogador: enquanto o tempo de divisão não venceu elas se
    empurram; vencido o prazo elas se ATRAEM até virar uma bolinha só.

    Sem a atração a bolinha nunca voltava ao normal sozinha: o empurrão parava
    exatamente onde elas se encostam (d == ra + rb) e a fusão só acontecia se o
    jogador conseguisse sobrepor as metades na mão.
    """
    celulas = jogador["celulas"]
    for i in range(len(celulas)):
        for k in range(i + 1, len(celulas)):
            a, b = celulas[i], celulas[k]
            if a.get("_comida") or b.get("_comida"):
                continue
            ra, rb = raio(a["energia"]), raio(b["energia"])
            d = _distancia(a["x"], a["y"], b["x"], b["y"])
            pode_juntar = agora >= a["juntar_em"] and agora >= b["juntar_em"]

            if pode_juntar:
                # Encostou o bastante: vira uma só.
                if d < max(ra, rb):
                    maior, menor = (a, b) if a["energia"] >= b["energia"] else (b, a)
                    maior["energia"] += menor["energia"]
                    menor["_comida"] = True
                    continue
                if d < 0.01:
                    continue
                # Ainda longe: puxa uma na direção da outra (o passo nunca passa
                # da metade da distância, senão elas atravessariam uma à outra).
                passo = min(VELOCIDADE_JUNTAR * dt, d / 2.0)
                nx, ny = (a["x"] - b["x"]) / d, (a["y"] - b["y"]) / d
                a["x"] -= nx * passo
                a["y"] -= ny * passo
                b["x"] += nx * passo
                b["y"] += ny * passo
                continue

            if d >= ra + rb or d < 0.01:
                continue
            empurrao = (ra + rb - d) / 2.0
            nx, ny = (a["x"] - b["x"]) / d, (a["y"] - b["y"]) / d
            a["x"] += nx * empurrao
            a["y"] += ny * empurrao
            b["x"] -= nx * empurrao
            b["y"] -= ny * empurrao
    jogador["celulas"] = [c for c in celulas if not c.get("_comida")]


def _comer_pellets(jogo: dict, jogador: dict, agora: float) -> None:
    dobro = 2 if agora < jogador["dobro_ate"] else 1
    for celula in jogador["celulas"]:
        r = raio(celula["energia"])
        comidos = [pid for pid, p in jogo["pellets"].items()
                   if _distancia(celula["x"], celula["y"], p["x"], p["y"]) < r]
        for pid in comidos:
            celula["energia"] += jogo["pellets"].pop(pid)["v"] * dobro


def _pegar_powerups(jogo: dict, jogador: dict, agora: float) -> list:
    pegos = []
    for celula in jogador["celulas"]:
        r = raio(celula["energia"])
        for pid in [p for p, item in jogo["powerups"].items()
                    if _distancia(celula["x"], celula["y"], item["x"], item["y"]) < r + POWERUP_RAIO]:
            item = jogo["powerups"].pop(pid)
            if item["tipo"] == "energia2x":
                jogador["dobro_ate"] = agora + DOBRO_ENERGIA_SEGUNDOS
            else:
                celula["energia"] *= 2
            pegos.append(item["tipo"])
    return pegos


def _comer_jogadores(jogo: dict, agora: float) -> list:
    """Retorna lista de (comedor, comido_nome) pra quem morreu por completo."""
    mortes = []
    lista = vivos(jogo)
    for atacante in lista:
        dobro = 2 if agora < atacante["dobro_ate"] else 1
        for alvo in lista:
            if alvo is atacante or not alvo["vivo"]:
                continue
            if agora < alvo.get("protegido_ate", 0.0):
                continue  # acabou de nascer: ainda não pode ser comido
            for ca in atacante["celulas"]:
                ra = raio(ca["energia"])
                for cb in list(alvo["celulas"]):
                    if ca["energia"] < cb["energia"] * VANTAGEM_PARA_COMER:
                        continue
                    rb = raio(cb["energia"])
                    d = _distancia(ca["x"], ca["y"], cb["x"], cb["y"])
                    if d < ra - rb * SOBREPOSICAO_PARA_COMER:
                        ca["energia"] += cb["energia"] * dobro
                        alvo["celulas"].remove(cb)
                        ra = raio(ca["energia"])
            if not alvo["celulas"]:
                alvo["vivo"] = False
                alvo["morto_por"] = atacante["nome"]
                atacante["kills"] += 1
                mortes.append((atacante["nome"], alvo["nome"]))
    return mortes


def passo(jogo: dict, dt: float, agora: float) -> dict:
    """Roda um tick da simulação. Retorna o que aconteceu de notável."""
    eventos = {"kills": [], "powerups": {}}
    for jogador in vivos(jogo):
        if jogador["soltando"]:
            soltar_energia(jogo, jogador, agora)
        _mover_celulas(jogador, dt)
    _mover_pellets(jogo, dt)
    for jogador in vivos(jogo):
        _separar_ou_juntar(jogador, dt, agora)
        _comer_pellets(jogo, jogador, agora)
        pegos = _pegar_powerups(jogo, jogador, agora)
        if pegos:
            eventos["powerups"][jogador["nome"]] = pegos
    eventos["kills"] = _comer_jogadores(jogo, agora)
    for jogador in jogo["jogadores"].values():
        if jogador["vivo"]:
            jogador["energia_maxima"] = max(jogador["energia_maxima"], energia_total(jogador))
    repor_pellets(jogo)
    _expirar_powerups(jogo, agora)
    _nascer_powerups(jogo, agora)
    return eventos


# ---------------------------------------------------------------------------
# Fim de partida
# ---------------------------------------------------------------------------

def checar_fim(jogo: dict, agora: float) -> Optional[dict]:
    restantes = vivos(jogo)
    if len(restantes) == 1:
        return {"vencedor": restantes[0]["nome"], "motivo": "ultimo"}
    if not restantes:
        return {"vencedor": None, "motivo": "ninguem"}
    limite = ARENA / 2.0 * FRACAO_ARENA_VITORIA
    for jogador in restantes:
        if any(raio(c["energia"]) >= limite for c in jogador["celulas"]):
            return {"vencedor": jogador["nome"], "motivo": "arena"}
    if agora - jogo["comecou_em"] >= DURACAO_MAXIMA:
        melhor = max(restantes, key=energia_total)
        return {"vencedor": melhor["nome"], "motivo": "tempo"}
    return None


# ---------------------------------------------------------------------------
# Bots
# ---------------------------------------------------------------------------

def sortear_nomes_bots(quantidade: int, usados) -> list:
    livres = [n for n in NOMES_BOTS if n not in usados]
    random.shuffle(livres)
    return livres[:quantidade]


def _alvo_mais_perto(celula: dict, itens, chave_x="x", chave_y="y"):
    melhor, melhor_d = None, float("inf")
    for item in itens:
        d = _distancia(celula["x"], celula["y"], item[chave_x], item[chave_y])
        if d < melhor_d:
            melhor, melhor_d = item, d
    return melhor, melhor_d


def _melhor_pellet(jogo: dict, celula: dict, raio_busca: float):
    """Não é o mais perto e sim o que rende mais: conta quantos outros pellets
    tem em volta, pra o bot ir na direção de um monte e não de um solto."""
    perto = [p for p in jogo["pellets"].values()
             if abs(p["x"] - celula["x"]) < raio_busca and abs(p["y"] - celula["y"]) < raio_busca]
    if not perto:
        return None
    melhor, melhor_nota = None, -1.0
    for p in random.sample(perto, min(len(perto), 14)):
        d = _distancia(celula["x"], celula["y"], p["x"], p["y"]) + 1.0
        vizinhos = sum(1 for o in perto
                       if abs(o["x"] - p["x"]) < 150 and abs(o["y"] - p["y"]) < 150)
        nota = vizinhos / d
        if nota > melhor_nota:
            melhor, melhor_nota = p, nota
    return melhor


def pensar_bot(jogo: dict, bot: dict, agora: float) -> None:
    """Decide pra onde o bot vai.

    Detalhe que muda tudo: quem é menor é sempre MAIS RÁPIDO, então sair
    correndo atrás de presa não funciona — só dá pra pegar dividindo em cima
    dela. Por isso o competente caça só quando dá pra matar na divisão, e o
    resto do tempo farma comida e corre atrás dos itens especiais.
    """
    if not bot["vivo"] or not bot["celulas"]:
        return
    principal = max(bot["celulas"], key=lambda c: c["energia"])
    minha = principal["energia"]
    competente = bot["nivel_bot"] == "competente"
    visao = 950.0 if competente else 520.0
    meu_raio = raio(minha)

    ameaca, ameaca_d = None, float("inf")
    presa, presa_d = None, float("inf")
    for outro in vivos(jogo):
        if outro is bot:
            continue
        for celula in outro["celulas"]:
            d = _distancia(principal["x"], principal["y"], celula["x"], celula["y"])
            if d > visao:
                continue
            if celula["energia"] >= minha * VANTAGEM_PARA_COMER and d < ameaca_d:
                ameaca, ameaca_d = celula, d
            elif (minha >= celula["energia"] * VANTAGEM_PARA_COMER and d < presa_d
                    and agora >= outro.get("protegido_ate", 0.0)):
                presa, presa_d = celula, d

    alcance_divisao = meu_raio + IMPULSO_DIVISAO * 0.45
    pode_dividir = minha >= ENERGIA_MINIMA_DIVIDIR and len(bot["celulas"]) < CELULAS_MAXIMO
    # Só vale dividir se as metades continuarem maiores que a presa.
    divisao_mata = (pode_dividir and presa is not None
                    and minha / 2.0 >= presa["energia"] * VANTAGEM_PARA_COMER * 1.15)

    powerup, powerup_d = (None, float("inf"))
    if competente and jogo["powerups"]:
        powerup, powerup_d = _alvo_mais_perto(principal, list(jogo["powerups"].values()))

    if ameaca is not None and (competente or random.random() < 0.55):
        definir_direcao(bot, principal["x"] - ameaca["x"], principal["y"] - ameaca["y"])
    elif divisao_mata and presa_d < alcance_divisao:
        definir_direcao(bot, presa["x"] - principal["x"], presa["y"] - principal["y"])
        if presa_d < alcance_divisao * 0.7:
            dividir(jogo, bot, agora)
    elif powerup is not None and powerup_d < visao:
        definir_direcao(bot, powerup["x"] - principal["x"], powerup["y"] - principal["y"])
    elif presa is not None and presa_d < meu_raio * 1.6:
        # Presa colada: vale a pena tentar encurralar mesmo sem dividir.
        definir_direcao(bot, presa["x"] - principal["x"], presa["y"] - principal["y"])
    else:
        # O competente procura MONTE de comida; o iniciante vai no que estiver
        # mais perto (e às vezes sai andando à toa).
        if competente:
            alvo = _melhor_pellet(jogo, principal, 700.0)
        elif random.random() < 0.12:
            alvo = None
        else:
            alvo, _ = _alvo_mais_perto(principal, list(jogo["pellets"].values()))
        if alvo is not None:
            definir_direcao(bot, alvo["x"] - principal["x"], alvo["y"] - principal["y"])
        elif random.random() < 0.08:
            definir_direcao(bot, random.uniform(-1, 1), random.uniform(-1, 1))

    # Ninguém quer morrer na parede: perto da borda, vira pro centro.
    margem = meu_raio + (110.0 if competente else 55.0)
    if (principal["x"] < margem or principal["x"] > ARENA - margem
            or principal["y"] < margem or principal["y"] > ARENA - margem):
        definir_direcao(bot, ARENA / 2 - principal["x"], ARENA / 2 - principal["y"])
