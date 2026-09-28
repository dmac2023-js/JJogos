"""Gera os catálogos da loja a partir da API da Discord usando a sessão logada.

Uso:
    python build_loja_decoracoes.py            # decorações de avatar (links1.txt -> loja_decoracoes.json)
    python build_loja_decoracoes.py --molduras # molduras de perfil (links4.txt -> loja_molduras.json)

No modo --molduras a lista de skus vem da API de busca do próprio cliente
(item_types=PROFILE_FRAME), porque a rolagem da loja só enxerga uma página e
o token guardado no localStorage já não vale pra /shop/search — o que vale é o
header de authorization que o app manda nas chamadas dele.

Precisa da sessão logada em .discord-profile/ (mesma usada pelo scraper).
Retoma de onde parou se já existir um arquivo de saída parcial.
"""
from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
LINKS_FILE = ROOT / "links1.txt"
SAIDA = ROOT / "loja_decoracoes.json"
LINKS_MOLDURAS = ROOT / "links4.txt"
SAIDA_MOLDURAS = ROOT / "loja_molduras.json"
PROFILE_DIR = ROOT / ".discord-profile"
SALVAR_A_CADA = 15
SHOP_URL = "https://discord.com/shop?tab=catalog"
DISCORD_ORIGIN = "https://discord.com"


def carregar_links() -> list[dict]:
    itens = []
    for linha in LINKS_FILE.read_text(encoding="utf-8").splitlines():
        linha = linha.strip()
        if not linha or "\t" not in linha:
            continue
        nome_pt, url = linha.split("\t", 1)
        m = re.search(r"itemSkuId=(\d+)", url)
        if not m:
            continue
        itens.append({"sku_id": m.group(1), "nome_pt": nome_pt.strip()})
    return itens


def carregar_resultado_parcial(saida: Path = SAIDA) -> list[dict]:
    if not saida.exists():
        return []
    try:
        return json.loads(saida.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def salvar_resultado(resultado: list[dict], saida: Path = SAIDA) -> None:
    saida.write_text(json.dumps(resultado, ensure_ascii=False, indent=2), encoding="utf-8")


def capturar_auth(page) -> str | None:
    """Pega o header de authorization que o próprio app do Discord manda.

    O token do localStorage não existe mais (ou expirou): sem ele dá 401 em
    /shop/search e /collectibles-shop. O cliente segue autorizado, então a
    gente lê o header de uma chamada real dele e reusa — sem nunca imprimir.
    """
    capturado: dict = {}

    def ao_pedir(request) -> None:
        if capturado.get("auth") or "discord.com/api/v9/" not in request.url:
            return
        auth = request.headers.get("authorization")
        if auth:
            capturado["auth"] = auth

    page.on("request", ao_pedir)
    try:
        for _ in range(2):
            if page.url.startswith("about:"):
                page.goto(SHOP_URL, wait_until="domcontentloaded")
            else:
                page.reload(wait_until="domcontentloaded")
            page.wait_for_timeout(4500)
            if capturado.get("auth"):
                break
    finally:
        try:
            page.remove_listener("request", ao_pedir)
        except Exception:
            pass
    return capturado.get("auth")


def buscar_detalhe(page, sku_id: str, nome_pt: str, auth: str | None = None) -> dict | None:
    try:
        payload = page.evaluate(
            """async ([sku, auth]) => {
                const headers = {"x-discord-locale": "pt-BR", "accept": "application/json"};
                if (auth) headers.authorization = auth;
                const r = await fetch(`https://discord.com/api/v9/collectibles-products/${sku}`, {
                    credentials: "include",
                    headers
                });
                if (!r.ok) return {erro: r.status};
                return await r.json();
            }""",
            [sku_id, auth],
        )
    except Exception as error:
        print(f"falhou {sku_id} ({nome_pt}): {error}")
        return None

    if not payload or payload.get("erro"):
        print(f"erro http {payload.get('erro') if payload else '?'}: {sku_id} ({nome_pt})")
        return None

    items = payload.get("items") or []
    asset = next((item.get("asset") for item in items if item.get("type") == 0 and item.get("asset")), None)
    if not asset:
        print(f"não é decoração de avatar (pulando): {sku_id} {nome_pt}")
        return None
    return {"sku_id": sku_id, "name": nome_pt, "asset": asset}


def main() -> None:
    if not LINKS_FILE.exists():
        raise SystemExit(f"Não achei {LINKS_FILE}.")

    todos = carregar_links()
    print(f"{len(todos)} itens em {LINKS_FILE.name}")

    resultado = carregar_resultado_parcial()
    ja_processados = {item["sku_id"] for item in resultado}
    print(f"{len(ja_processados)} já processados anteriormente (retomando)")

    pendentes = [item for item in todos if item["sku_id"] not in ja_processados]
    if not pendentes:
        print("Nada pendente.")
        return

    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(str(PROFILE_DIR), headless=True)
        page = context.pages[0] if context.pages else context.new_page()
        page.goto("https://discord.com/shop", wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        auth = capturar_auth(page)

        for i, item in enumerate(pendentes, 1):
            detalhe = buscar_detalhe(page, item["sku_id"], item["nome_pt"], auth)
            if detalhe:
                resultado.append(detalhe)
                print(f"[{i}/{len(pendentes)}] ok: {detalhe['name']}")
            if i % SALVAR_A_CADA == 0:
                salvar_resultado(resultado)
                print(f"--- progresso salvo ({len(resultado)} decorações) ---")
            time.sleep(0.35)

        context.close()

    salvar_resultado(resultado)
    print(f"\n{len(resultado)} decorações de avatar salvas em {SAIDA.name}")


# ---------------------------------------------------------------------------
# Molduras de perfil (python build_loja_decoracoes.py --molduras)
# ---------------------------------------------------------------------------

# A rolagem da loja só enxerga a primeira página de molduras, e o token do
# localStorage dá 401 na busca — por isso a lista de skus vem da API de busca
# com o header authorization capturado do cliente (ver capturar_auth).
JS_BUSCA_MOLDURAS = """async (auth) => {
    const skus = [];
    let offset = 0;
    const limit = 100;
    for (let pagina = 0; pagina < 40; pagina++) {
        const url = `https://discord.com/api/v9/shop/search?item_types=PROFILE_FRAME&limit=${limit}&offset=${offset}`;
        const r = await fetch(url, { credentials: "include", headers: {
            "accept": "application/json", "authorization": auth, "x-discord-locale": "pt-BR" } });
        if (!r.ok) return { erro: r.status, skus };
        const j = await r.json();
        const novos = j.skus || [];
        skus.push(...novos);
        const pag = j.pagination || {};
        if (!pag.has_more || !novos.length) break;
        offset = pag.offset != null ? pag.offset + (pag.limit || limit) : offset + novos.length;
    }
    return { skus };
}"""

JS_DETALHE_MOLDURA = """async ([auth, sku]) => {
    const r = await fetch(`https://discord.com/api/v9/collectibles-products/${sku}`, {
        credentials: "include", headers: { "accept": "application/json",
            "authorization": auth, "x-discord-locale": "pt-BR" } });
    if (!r.ok) return { erro: r.status };
    const j = await r.json();
    j.sku_id = sku;
    return j;
}"""


def montar_moldura(payload: dict) -> dict | None:
    """Converte o detalhe do produto no formato do loja_molduras.json.

    Moldura (type 3) não tem um "asset" único como a decoração: são camadas
    PNG em /media/v1/collectibles-shop/{sku}/{id}/static posicionadas por
    anchor (top/bottom) e order (front/back) dentro de um perfil de
    inner_width px, com overflow indicando quanto sobe/desce/sai de lado.
    """
    if not isinstance(payload, dict) or payload.get("erro"):
        return None
    itens = payload.get("items") or []
    item = next((i for i in itens if i.get("type") == 3), None)
    if item is None and itens and payload.get("type") == 3:
        item = itens[0]
    if not item:
        return None

    camadas = []
    for camada in item.get("layers") or []:
        camada_id = camada.get("id")
        if not camada_id:
            continue
        camadas.append({
            "id": str(camada_id),
            "type": camada.get("type"),
            "order": camada.get("order"),
            "anchor": camada.get("anchor"),
            "responsive": bool(camada.get("responsive")),
        })
    if not camadas:
        return None

    return {
        "sku_id": str(payload.get("sku_id") or item.get("sku_id") or ""),
        "name": (payload.get("name") or "").strip(),
        "layers": camadas,
        "inner_width": item.get("inner_width") or 1200,
        "overflow_top": item.get("overflow_top") or 0,
        "overflow_bottom": item.get("overflow_bottom") or 0,
        "overflow_horizontal": item.get("overflow_horizontal") or 0,
    }


def listar_skus_molduras(page, auth: str) -> list[str]:
    resposta = page.evaluate(JS_BUSCA_MOLDURAS, auth)
    if resposta.get("erro"):
        raise SystemExit(f"Busca de molduras falhou: HTTP {resposta['erro']}")
    skus, vistos = [], set()
    for sku in resposta.get("skus") or []:
        sku = str(sku)
        if sku not in vistos:
            vistos.add(sku)
            skus.append(sku)
    return skus


def gravar_links_molduras(resultado: list[dict]) -> None:
    linhas = [f"{m['name']}\thttps://discord.com/shop#itemSkuId={m['sku_id']}"
              for m in resultado if m.get("sku_id") and m.get("name")]
    LINKS_MOLDURAS.write_text("\n".join(linhas) + "\n", encoding="utf-8")


def main_molduras() -> None:
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(str(PROFILE_DIR), headless=True)
        page = context.pages[0] if context.pages else context.new_page()

        page.goto(SHOP_URL, wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        auth = capturar_auth(page)
        if not auth:
            context.close()
            raise SystemExit("Sem header de authorization do cliente — a sessão está logada?")

        skus = listar_skus_molduras(page, auth)
        print(f"{len(skus)} skus PROFILE_FRAME na loja")

        resultado = carregar_resultado_parcial(SAIDA_MOLDURAS)
        ja_feitas = {m["sku_id"] for m in resultado}
        print(f"{len(ja_feitas)} já processadas (retomando)")

        pendentes = [sku for sku in skus if sku not in ja_feitas]
        if not pendentes:
            print("Nada pendente.")
        for i, sku in enumerate(pendentes, 1):
            payload = page.evaluate(JS_DETALHE_MOLDURA, [auth, sku])
            moldura = montar_moldura(payload)
            if moldura:
                resultado.append(moldura)
                print(f"[{i}/{len(pendentes)}] ok: {moldura['name']} "
                      f"({len(moldura['layers'])} camadas)")
            else:
                print(f"[{i}/{len(pendentes)}] pulou {sku} (erro {payload.get('erro') if isinstance(payload, dict) else '?'})")
            if i % SALVAR_A_CADA == 0:
                salvar_resultado(resultado, SAIDA_MOLDURAS)
                print(f"--- progresso salvo ({len(resultado)} molduras) ---")
            time.sleep(0.25)

        context.close()

    salvar_resultado(resultado, SAIDA_MOLDURAS)
    gravar_links_molduras(resultado)
    print(f"\n{len(resultado)} molduras salvas em {SAIDA_MOLDURAS.name} "
          f"(e {len(resultado)} linhas em {LINKS_MOLDURAS.name})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Gera os catálogos da loja do JJogos.")
    parser.add_argument("--molduras", action="store_true",
                        help="Gera links4.txt + loja_molduras.json (molduras de perfil).")
    args = parser.parse_args()
    if args.molduras:
        main_molduras()
    else:
        main()
