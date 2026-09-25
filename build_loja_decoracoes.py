"""Gera loja_decoracoes.json a partir de output/links1.json (produzido pelo
scrape_shop_links.py) — busca o detalhe de cada item pra pegar o "asset"
usado na imagem da decoração (CDN da Discord).

Uso:
    python scrape_shop_links.py --no-pause --headless --api-only
    python build_loja_decoracoes.py

Precisa da sessão logada em .discord-profile/ (a mesma usada pelo scraper).
"""
from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
LINKS_FILE = ROOT / "output" / "links1.json"
SAIDA = ROOT / "loja_decoracoes.json"
PROFILE_DIR = ROOT / ".discord-profile"


def buscar_detalhe(page, sku_id: str) -> dict | None:
    try:
        payload = page.evaluate(
            """async (sku) => {
                const r = await fetch(`https://discord.com/api/v9/collectibles-products/${sku}`, {
                    credentials: "include",
                    headers: {"x-discord-locale": "pt-BR", "accept": "application/json"}
                });
                return await r.json();
            }""",
            sku_id,
        )
    except Exception as error:
        print(f"falhou {sku_id}: {error}")
        return None

    items = payload.get("items") or []
    asset = next((item.get("asset") for item in items if item.get("type") == 0 and item.get("asset")), None)
    if not asset:
        print(f"sem asset (não é decoração de avatar?): {sku_id} {payload.get('name')}")
        return None
    return {"sku_id": sku_id, "name": payload.get("name"), "asset": asset}


def main() -> None:
    if not LINKS_FILE.exists():
        raise SystemExit(f"Não achei {LINKS_FILE}. Rode o scrape_shop_links.py primeiro.")

    links = json.loads(LINKS_FILE.read_text(encoding="utf-8"))
    skus = [item["sku_id"] for item in links]
    print(f"{len(skus)} SKUs em {LINKS_FILE.name}")

    resultado = []
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(str(PROFILE_DIR), headless=True)
        page = context.pages[0] if context.pages else context.new_page()
        page.goto("https://discord.com/shop", wait_until="domcontentloaded")
        page.wait_for_timeout(1200)
        for sku_id in skus:
            item = buscar_detalhe(page, sku_id)
            if item:
                resultado.append(item)
                print(f"ok: {item['name']}")
        context.close()

    SAIDA.write_text(json.dumps(resultado, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n{len(resultado)} decorações salvas em {SAIDA.name}")


if __name__ == "__main__":
    main()
