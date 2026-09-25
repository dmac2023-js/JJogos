"""Gera loja_decoracoes.json a partir de links1.txt (nome em PT-BR + link com
itemSkuId) — busca o detalhe de cada item na API da Discord pra confirmar que
é decoração de avatar (type 0) e pegar o "asset" usado nas imagens do CDN.

Uso:
    python build_loja_decoracoes.py

Precisa da sessão logada em .discord-profile/ (mesma usada pelo scraper).
Retoma de onde parou se já existir um loja_decoracoes.json parcial.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
LINKS_FILE = ROOT / "links1.txt"
SAIDA = ROOT / "loja_decoracoes.json"
PROFILE_DIR = ROOT / ".discord-profile"
SALVAR_A_CADA = 15


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


def carregar_resultado_parcial() -> list[dict]:
    if not SAIDA.exists():
        return []
    try:
        return json.loads(SAIDA.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def salvar_resultado(resultado: list[dict]) -> None:
    SAIDA.write_text(json.dumps(resultado, ensure_ascii=False, indent=2), encoding="utf-8")


def buscar_detalhe(page, sku_id: str, nome_pt: str) -> dict | None:
    try:
        payload = page.evaluate(
            """async (sku) => {
                const r = await fetch(`https://discord.com/api/v9/collectibles-products/${sku}`, {
                    credentials: "include",
                    headers: {"x-discord-locale": "pt-BR", "accept": "application/json"}
                });
                if (!r.ok) return {erro: r.status};
                return await r.json();
            }""",
            sku_id,
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

        for i, item in enumerate(pendentes, 1):
            detalhe = buscar_detalhe(page, item["sku_id"], item["nome_pt"])
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


if __name__ == "__main__":
    main()
