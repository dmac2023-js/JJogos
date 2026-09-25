from __future__ import annotations

import argparse
import json
import re
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from playwright.sync_api import BrowserContext, Page, TimeoutError as PlaywrightTimeoutError, sync_playwright


ROOT = Path(__file__).resolve().parent
PROFILE_DIR = ROOT / ".discord-profile"
OUTPUT_DIR = ROOT / "output"
MAXIMIZED_VIEWPORT = {"width": 1920, "height": 1080}

SHOP_URL = "https://discord.com/shop?tab=catalog"
DISCORD_ORIGIN = "https://discord.com"
SNOWFLAKE_RE = re.compile(r"^\d{16,24}$")
DEFAULT_PRICE = "R$0,00"
DEFAULT_COUNTRY = "BR"
SHOP_API_WAIT_MS = 8000
SHOP_NAME_STOP_MARKERS = (
    " Pre\u00e7o",
    " Pre\u00c3\u00a7o",
    " Preco",
    " Price",
    " R$",
    " Comprar por",
    " Buy for",
    " Enviar um presente",
    " Send a gift",
)

CATALOG_XPATH = '//*[@id="app-mount"]/div[2]/div/div[1]/div/div[2]/div/div/div/div[2]/div[2]/div/div[2]/div/main/div/div[1]/div/div[2]/div'
CLOSE_ITEM_XPATH = '//*[@id="app-mount"]/div[2]/div/div[6]/div[2]/div/div/div/div[2]/div[2]/button[2]'
NEXT_PAGE_XPATH = '//*[@id="app-mount"]/div[2]/div/div[1]/div/div[2]/div/div/div/div[2]/div[2]/div/div[2]/div/main/div/div[1]/div/div[3]/div/div/nav/button[2]'
ITEM_NAME_XPATH = '//*[@id="app-mount"]/div[2]/div/div[6]/div[2]/div/div/div/div[1]/div[3]/div[1]/h1'


@dataclass
class ShopLink:
    sku_id: str
    link: str
    name: str | None = None
    price: str | None = None
    product_type: str | int | None = None
    copied_link: str | None = None
    copy_status: str = "not_requested"
    source_filter: str | None = None
    page_index: int | None = None


@dataclass(frozen=True)
class FilterChoice:
    key: str
    label: str
    product_type: int
    ui_labels: tuple[str, ...]


FILTER_CHOICES = {
    "1": FilterChoice(
        key="avatar_decoration",
        label="decoracao de avatar",
        product_type=0,
        ui_labels=(
            "Decoração de avatar",
            "Decoracao de avatar",
            "Decorações de avatar",
            "Decoracoes de avatar",
            "Avatar Decoration",
            "Avatar Decorations",
        ),
    ),
    "2": FilterChoice(
        key="profile_effect",
        label="efeito de perfil",
        product_type=1,
        ui_labels=(
            "Efeito de perfil",
            "Efeitos de perfil",
            "Profile Effect",
            "Profile Effects",
        ),
    ),
    "3": FilterChoice(
        key="nameplate",
        label="placa de identificacao",
        product_type=2,
        ui_labels=(
            "Placa de identificação",
            "Placa de identificacao",
            "Placas de identificação",
            "Placas de identificacao",
            "Nameplate",
            "Nameplates",
        ),
    ),
    "4": FilterChoice(
        key="bundle",
        label="pacotes",
        product_type=1000,
        ui_labels=(
            "Pacote",
            "Pacotes",
            "Bundle",
            "Bundles",
        ),
    ),
    "5": FilterChoice(
        key="profile_frame",
        label="moldura de perfil",
        product_type=3,
        ui_labels=(
            "Moldura de perfil",
            "Molduras de perfil",
            "Profile Frame",
            "Profile Frames",
        ),
    ),
}

ALL_FILTER_LABELS = tuple(label for choice in FILTER_CHOICES.values() for label in choice.ui_labels)
# JJogos só usa decoração de avatar (a que fica ao redor da foto de perfil) —
# as outras categorias (efeito, placa, moldura, pacote) ficam de fora.
SCRAPE_FILTERS = (FILTER_CHOICES["1"],)

SEARCH_ITEM_TYPES = {
    "avatar_decoration": "AVATAR_DECORATION",
    "profile_effect": "PROFILE_EFFECT",
    "nameplate": "NAMEPLATE",
    "bundle": "BUNDLE",
    "profile_frame": "PROFILE_FRAME",
}

EXPECTED_MIN_COUNTS = {
    "avatar_decoration": 652,
    "profile_effect": 329,
    "nameplate": 250,
    "bundle": 208,
}

TYPE_ALIASES = {
    "avatar_decoration": {"0", "avatar_decoration", "avatar decoration", "avatar_decorations", "AVATAR_DECORATION"},
    "profile_effect": {"1", "profile_effect", "profile effect", "profile_effects", "PROFILE_EFFECT"},
    "nameplate": {"2", "nameplate", "nameplates", "NAMEPLATE"},
    "bundle": {"1000", "bundle", "bundles", "BUNDLE", "collectibles_shop_bundle"},
    "profile_frame": {"3", "profile_frame", "profile frame", "profile_frames", "PROFILE_FRAME"},
}


def discord_shop_link(sku_id: str) -> str:
    return f"https://discord.com/shop#itemSkuId={sku_id}"


def clean_shop_item_name(name: str | None, sku_id: str | None = None) -> str | None:
    if not name:
        return None

    cleaned = re.sub(r"\s+", " ", name).strip()
    if not cleaned:
        return None

    lowered = cleaned.casefold()
    cut_at = len(cleaned)
    for marker in SHOP_NAME_STOP_MARKERS:
        index = lowered.find(marker.casefold())
        if index >= 0:
            cut_at = min(cut_at, index)

    cleaned = cleaned[:cut_at].strip(" \t\r\n-:|")
    if not cleaned or (sku_id and sku_id in cleaned):
        return None
    return cleaned


def extract_shop_item_price(text: str | None) -> str | None:
    if not text:
        return None

    normalized = re.sub(r"\s+", " ", text).strip()
    if not normalized:
        return None

    money_match = re.search(r"R\$\s*\d{1,3}(?:\.\d{3})*,\d{2}", normalized)
    if money_match:
        return money_match.group(0).replace("R$ ", "R$ ").strip()

    dollar_match = re.search(r"\$\s*\d+(?:\.\d{2})?", normalized)
    if dollar_match:
        return dollar_match.group(0).strip()

    orbs_match = re.search(
        r"(?:pre(?:\u00e7|c)o|pre\u00c3\u00a7o|price)\s*:?\s*(\d{1,6}\s+orbs?)\b",
        normalized,
        re.IGNORECASE,
    )
    if orbs_match:
        return orbs_match.group(1).strip()

    return None


def output_shop_item_price(text: str | None) -> str:
    return extract_shop_item_price(text) or DEFAULT_PRICE


def format_currency_price(amount: int, currency: str, exponent: int) -> str | None:
    currency = currency.lower()
    if currency == "brl":
        value = amount / (10 ** exponent)
        whole = int(value)
        cents = int(round((value - whole) * 100))
        whole_text = f"{whole:,}".replace(",", ".")
        return f"R$ {whole_text},{cents:02d}"
    if currency == "usd":
        return f"$ {amount / (10 ** exponent):.2f}"
    if currency == "discord_orb":
        return f"{amount} orbs"
    return None


def extract_price_from_discord_price(value: dict[str, Any]) -> str | None:
    country_prices = value.get("country_prices")
    if isinstance(country_prices, dict):
        prices = country_prices.get("prices")
        if isinstance(prices, list):
            for price in prices:
                if not isinstance(price, dict):
                    continue
                currency = str(price.get("currency") or "").lower()
                if currency != "brl":
                    continue
                amount = int_or_none(price.get("amount"))
                exponent = int_or_none(price.get("exponent"))
                if amount is not None and exponent is not None:
                    return format_currency_price(amount, currency, exponent)
            for price in prices:
                if not isinstance(price, dict):
                    continue
                amount = int_or_none(price.get("amount"))
                exponent = int_or_none(price.get("exponent"))
                currency = str(price.get("currency") or "")
                if amount is not None and exponent is not None and currency:
                    formatted = format_currency_price(amount, currency, exponent)
                    if formatted:
                        return formatted
    return None


def extract_price_from_value(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return extract_shop_item_price(value)
    if isinstance(value, (int, float)):
        return None
    if isinstance(value, dict):
        if "country_prices" in value:
            found = extract_price_from_discord_price(value)
            if found:
                return found

        for tier_key in ("4", "0"):
            tier = value.get(tier_key)
            if isinstance(tier, dict):
                found = extract_price_from_discord_price(tier)
                if found:
                    return found

        price_keys = (
            "price",
            "prices",
            "display_price",
            "localized_price",
            "formatted_price",
            "amount",
            "sale_price",
            "current_price",
        )
        for key in price_keys:
            if key in value:
                found = extract_price_from_value(value[key])
                if found:
                    return found
        for child in value.values():
            found = extract_price_from_value(child)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = extract_price_from_value(child)
            if found:
                return found
    return None


def regex_for_labels(labels: tuple[str, ...]) -> re.Pattern[str]:
    return re.compile("|".join(re.escape(label) for label in labels), re.IGNORECASE)


def prompt_filter_choice(value: str | None) -> FilterChoice:
    if value in FILTER_CHOICES:
        return FILTER_CHOICES[value]

    print("\nQual tipo voce quer extrair?")
    print("1 = decoracao de avatar")
    print("2 = efeito de perfil")
    print("3 = placa de identificacao")
    print("4 = pacotes")
    print("5 = moldura de perfil")

    while True:
        answer = input("Digite 1, 2, 3, 4 ou 5: ").strip()
        if answer in FILTER_CHOICES:
            return FILTER_CHOICES[answer]
        print("Opcao invalida.")


def compact_product(product: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "sku_id",
        "id",
        "name",
        "summary",
        "type",
        "item_type",
        "product_type",
        "collectible_type",
        "premium_type",
        "category_sku_id",
        "unpublished_at",
        "published_at",
        "store_listing_id",
        "price",
        "prices",
        "display_price",
        "localized_price",
        "formatted_price",
        "items",
        "asset",
    )
    compact = {key: product.get(key) for key in keys if key in product}
    price = extract_price_from_value(product)
    if price:
        compact["price"] = price
    return compact


def merge_product(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    for key, value in incoming.items():
        if value is None or value == "":
            continue
        current = existing.get(key)
        if current is None or current == "":
            existing[key] = value
        elif key == "price" and not extract_shop_item_price(str(current)):
            existing[key] = value
    return existing


def walk_products(value: Any, found: dict[str, dict[str, Any]], source_choice: FilterChoice | None = None) -> None:
    if isinstance(value, dict):
        sku_id = value.get("sku_id")
        name = value.get("name")
        if isinstance(sku_id, (str, int)) and SNOWFLAKE_RE.match(str(sku_id)) and name:
            product = compact_product(value)
            if source_choice:
                product["type"] = source_choice.product_type
                product["item_type"] = SEARCH_ITEM_TYPES.get(source_choice.key)
                product["source_filter"] = source_choice.label
            existing = found.setdefault(str(sku_id), {})
            merge_product(existing, product)
        for child in value.values():
            walk_products(child, found, source_choice)
    elif isinstance(value, list):
        for child in value:
            walk_products(child, found, source_choice)


def fetch_json_in_page(page: Page, url: str) -> Any:
    return page.evaluate(
        """async (url) => {
            function readToken() {
                const raw = window.localStorage?.getItem("token");
                if (!raw || raw === "null" || raw === "undefined") return null;
                try {
                    const parsed = JSON.parse(raw);
                    return typeof parsed === "string" ? parsed : raw;
                } catch {
                    return raw.replace(/^"|"$/g, "");
                }
            }

            const headers = {
                "accept": "application/json",
                // Fixo em pt-BR independente do idioma da conta logada —
                // o JJogos só quer os nomes em português.
                "x-discord-locale": "pt-BR"
            };
            const token = readToken();
            if (token) headers.authorization = token;

            const response = await fetch(url, {
                credentials: "include",
                headers
            });
            const text = await response.text();
            if (!response.ok) {
                throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
            }
            return JSON.parse(text);
        }""",
        url,
    )


def collect_products_via_scroll_sniff(
    page: Page,
    choice: FilterChoice,
    max_scrolls: int = 400,
    max_sem_novidade: int = 12,
) -> dict[str, dict[str, Any]]:
    """Aplica o filtro da loja de verdade e rola a página, capturando (por
    escuta passiva) as respostas que o PRÓPRIO app do Discord dispara — é
    mais confiável que remontar um fetch autenticado nosso (o token do
    localStorage não vale mais pra /shop/search, dá 401), porque aqui é a
    sessão real do cliente fazendo a chamada."""
    products: dict[str, dict[str, Any]] = {}

    def handle_response(response: Any) -> None:
        url = response.url
        if "discord.com/api/v" not in url:
            return
        if "collectibles" not in url and "shop" not in url:
            return
        payload = safe_response_json(response)
        if payload is not None:
            # Não força o tipo pelo filtro da UI: o filtro pode não valer pra
            # 100% do tráfego (prefetch etc.), então guarda o tipo real do
            # item e filtra depois com product_matches_choice.
            walk_products(payload, products, source_choice=None)

    page.on("response", handle_response)
    try:
        page.goto(SHOP_URL, wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        select_shop_filter(page, choice)
        page.wait_for_timeout(1200)

        sem_novidade = 0
        for _ in range(max_scrolls):
            antes = len(products)
            scroll_catalog_down(page)
            page.wait_for_timeout(500)
            if len(products) > antes:
                sem_novidade = 0
            else:
                sem_novidade += 1
                if sem_novidade >= max_sem_novidade or is_near_bottom(page):
                    if not click_next_page(page):
                        break
                    sem_novidade = 0
                    page.wait_for_timeout(900)
    finally:
        try:
            page.remove_listener("response", handle_response)
        except Exception:
            pass

    filtrados = filter_products_for_choice(products, choice)
    for produto in filtrados.values():
        produto["source_filter"] = choice.label
    return filtrados


def collect_products_from_shop_api(page: Page, country: str, include_nameplates_on_mobile: bool) -> dict[str, dict[str, Any]]:
    params = {
        "country_code": country,
        "tab": "catalog",
        "include_bundles": "true",
        "include_nameplates_on_mobile": "true" if include_nameplates_on_mobile else "false",
        "variants_return_style": "2",
    }
    query = urlencode(params)
    payload = fetch_json_in_page(page, f"{DISCORD_ORIGIN}/api/v9/collectibles-shop?{query}")
    products: dict[str, dict[str, Any]] = {}
    walk_products(payload, products)
    return products


def int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def product_effective_type(product: dict[str, Any]) -> int | str | None:
    raw_type = product.get("output_type")
    if raw_type is None:
        raw_type = product.get("type")
    if raw_type in (0, 1, 2, 3, 1000):
        return raw_type

    items = product.get("items")
    if isinstance(items, list):
        item_types = {
            item.get("type")
            for item in items
            if isinstance(item, dict) and item.get("type") in (0, 1, 2, 3)
        }
        if len(item_types) == 1:
            return next(iter(item_types))

    text = " ".join(
        str(product.get(key) or "")
        for key in ("summary", "description", "name")
    ).casefold()
    if "moldura" in text or "frame" in text or "profile frame" in text:
        return 3
    if "avatar" in text or "renove o visual" in text:
        return 0
    if "perfil" in text or "profile" in text:
        return 1
    if "nome" in text or "servidores" in text or "chats" in text:
        return 2

    return raw_type


def product_type_tokens(product: dict[str, Any]) -> set[str]:
    tokens: set[str] = set()
    for key in ("type", "item_type", "product_type", "collectible_type"):
        value = product.get(key)
        if isinstance(value, (str, int)):
            raw = str(value).strip()
            if raw:
                tokens.add(raw)
                tokens.add(raw.casefold())
    effective_type = product_effective_type(product)
    if effective_type is not None:
        tokens.add(str(effective_type))
    return tokens


def product_matches_choice(product: dict[str, Any], choice: FilterChoice) -> bool:
    aliases = {alias.casefold() for alias in TYPE_ALIASES.get(choice.key, set())}
    tokens = {token.casefold() for token in product_type_tokens(product)}
    if aliases.intersection(tokens):
        return True

    source_filter = product.get("source_filter")
    if isinstance(source_filter, str) and source_filter == choice.label:
        return True

    return False


def filter_products_for_choice(products: dict[str, dict[str, Any]], choice: FilterChoice) -> dict[str, dict[str, Any]]:
    return {
        sku_id: product
        for sku_id, product in products.items()
        if product_matches_choice(product, choice)
    }


def safe_response_json(response: Any) -> Any:
    try:
        return response.json()
    except Exception:
        return None


def public_discord_api_headers(headers: dict[str, str]) -> dict[str, str]:
    allowed = {
        "authorization",
        "x-super-properties",
        "x-discord-locale",
        "x-debug-options",
        "accept",
        "user-agent",
    }
    return {key: value for key, value in headers.items() if key.lower() in allowed and value}


def collect_loaded_shop_api_data(page: Page, wait_ms: int = SHOP_API_WAIT_MS) -> tuple[dict[str, str], dict[str, dict[str, Any]]]:
    products: dict[str, dict[str, Any]] = {}
    captured_headers: dict[str, str] = {}

    try:
        session = page.context.new_cdp_session(page)
        session.send("Network.enable")
        session.send("Network.setCacheDisabled", {"cacheDisabled": True})
    except Exception:
        pass

    def handle_response(response: Any) -> None:
        url = response.url
        if "discord.com/api/v9/" not in url:
            return
        if "collectibles" not in url and "shop" not in url:
            return
        if "collectibles-categories/v2" in url and not captured_headers:
            captured_headers.update(public_discord_api_headers(response.request.headers))

        payload = safe_response_json(response)
        if payload is not None:
            walk_products(payload, products)

    page.on("response", handle_response)
    page.goto(SHOP_URL, wait_until="domcontentloaded")
    page.wait_for_timeout(wait_ms)
    return captured_headers, products


def collect_skus_from_search_api(page: Page, choice: FilterChoice, api_headers: dict[str, str]) -> list[str]:
    # Usa o token do localStorage (via fetch_json_in_page) em vez de depender
    # de farejar o header de autorização no tráfego de rede — mais confiável
    # (funciona igual em headless) e não exige api_headers nenhum.
    item_type = SEARCH_ITEM_TYPES[choice.key]
    skus: list[str] = []
    seen: set[str] = set()
    offset = 0
    limit = 100

    while True:
        query = urlencode(
            [
                ("item_types", item_type),
                ("limit", str(limit)),
                ("offset", str(offset)),
            ]
        )
        try:
            payload = fetch_json_in_page(page, f"{DISCORD_ORIGIN}/api/v9/shop/search?{query}")
        except Exception as error:
            print(f"API de busca atual falhou para {choice.label}: {error}")
            break

        page_skus = payload.get("skus") if isinstance(payload, dict) else None
        if not isinstance(page_skus, list) or not page_skus:
            break

        for sku in page_skus:
            sku_id = str(sku)
            if SNOWFLAKE_RE.match(sku_id) and sku_id not in seen:
                seen.add(sku_id)
                skus.append(sku_id)

        pagination = payload.get("pagination") if isinstance(payload, dict) else {}
        if not isinstance(pagination, dict) or not pagination.get("has_more"):
            break
        offset = int_or_none(pagination.get("offset"))
        if offset is None:
            offset = len(skus)
        else:
            offset += int_or_none(pagination.get("limit")) or limit
        time.sleep(0.15)

    return skus


def products_from_search_skus(
    skus: list[str],
    known_products: dict[str, dict[str, Any]],
    choice: FilterChoice,
    page: Page | None = None,
    api_headers: dict[str, str] | None = None,
) -> dict[str, dict[str, Any]]:
    products: dict[str, dict[str, Any]] = {}
    for sku_id in skus:
        product = dict(known_products.get(sku_id) or {})
        if not product and page is not None:
            product = fetch_collectible_product_detail(page, sku_id, api_headers or {}) or {}
        product.setdefault("sku_id", sku_id)
        product["output_type"] = choice.product_type
        product["item_type"] = SEARCH_ITEM_TYPES[choice.key]
        product["source_filter"] = choice.label
        products[sku_id] = product
    return products


def fetch_collectible_product_detail(page: Page, sku_id: str, api_headers: dict[str, str]) -> dict[str, Any] | None:
    try:
        payload = fetch_json_in_page(page, f"{DISCORD_ORIGIN}/api/v9/collectibles-products/{sku_id}")
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    product = compact_product(payload)
    product["source_detail"] = "collectibles-products"
    product["copy_status"] = "generated_from_product_detail"
    return product


def collect_products_from_search_api(page: Page, choice: FilterChoice, country: str) -> dict[str, dict[str, Any]]:
    products: dict[str, dict[str, Any]] = {}
    offset = 0
    limit = 100
    item_type = SEARCH_ITEM_TYPES[choice.key]

    while True:
        query = urlencode(
            [
                ("item_types", item_type),
                ("limit", str(limit)),
                ("offset", str(offset)),
                ("country_code", country),
            ]
        )
        url = f"{DISCORD_ORIGIN}/api/v9/shop/search?{query}"
        payload = fetch_json_in_page(page, url)
        before = len(products)
        walk_products(payload, products, source_choice=choice)

        if isinstance(payload, dict):
            total = int_or_none(payload.get("total_results") or payload.get("total") or payload.get("count"))
            items = payload.get("items") or payload.get("results") or payload.get("skus") or []
            item_count = len(items) if isinstance(items, list) else len(products) - before
            if item_count <= 0:
                break
            if total is not None and offset + item_count >= total:
                break
        elif isinstance(payload, list):
            item_count = len(payload)
            if len(payload) < limit:
                break
        else:
            break

        if item_count <= 0:
            break
        offset += limit
        time.sleep(0.25)

    return products


def collect_products_for_choice_from_apis(
    page: Page,
    choice: FilterChoice,
    country: str,
    api_headers: dict[str, str] | None = None,
    known_products: dict[str, dict[str, Any]] | None = None,
) -> dict[str, dict[str, Any]]:
    products: dict[str, dict[str, Any]] = {}
    known_products = known_products or {}

    # Primeira tentativa: escuta passiva enquanto rola a loja de verdade com
    # o filtro aplicado (a sessão real do cliente faz a chamada — sem 401).
    try:
        scroll_products = collect_products_via_scroll_sniff(page, choice)
        for sku_id, product in scroll_products.items():
            merge_product(products.setdefault(sku_id, {}), product)
    except Exception as error:
        print(f"Rolagem com escuta passiva falhou para {choice.label}: {error}")
    if products:
        return products

    # collect_skus_from_search_api usa o token do localStorage (via
    # fetch_json_in_page), não precisa mais do header farejado da rede.
    search_skus = collect_skus_from_search_api(page, choice, api_headers or {})
    if search_skus:
        return products_from_search_skus(search_skus, known_products, choice, page, api_headers)

    for sku_id, product in filter_products_for_choice(known_products, choice).items():
        product = dict(product)
        product["source_filter"] = choice.label
        product["output_type"] = choice.product_type
        merge_product(products.setdefault(sku_id, {}), product)
    if products:
        return products

    try:
        search_products = collect_products_from_search_api(page, choice, country)
        for sku_id, product in search_products.items():
            merge_product(products.setdefault(sku_id, {}), product)
    except Exception as error:
        print(f"API de busca falhou para {choice.label}: {error}")

    try:
        catalog_products = collect_products_from_shop_api(page, country, include_nameplates_on_mobile=True)
        for sku_id, product in filter_products_for_choice(catalog_products, choice).items():
            product["source_filter"] = choice.label
            merge_product(products.setdefault(sku_id, {}), product)
    except Exception as error:
        print(f"API do catalogo falhou para {choice.label}: {error}")

    return products


def save_links(links: list[ShopLink], filename: str) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    ordered_links = sorted(links, key=lambda item: (item.page_index or 0, item.name or "", item.sku_id))
    (OUTPUT_DIR / filename).write_text(
        "\n".join(
            f"{clean_shop_item_name(item.name, item.sku_id) or item.sku_id}\t{item.copied_link or item.link}"
            for item in ordered_links
        )
        + ("\n" if ordered_links else ""),
        encoding="utf-8",
    )
    json_filename = str(Path(filename).with_suffix(".json").name)
    (OUTPUT_DIR / json_filename).write_text(
        json.dumps(
            [
                {
                    **asdict(item),
                    "name": clean_shop_item_name(item.name, item.sku_id) or item.sku_id,
                    "price": output_shop_item_price(item.price),
                    "url": item.copied_link or item.link,
                }
                for item in ordered_links
            ],
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


def button_name_regex() -> re.Pattern[str]:
    return re.compile(
        r"(copiar\s+link|copy\s+link|compartilhar|share|copiar|copy)",
        re.IGNORECASE,
    )


def read_clipboard(page: Page) -> str | None:
    try:
        value = page.evaluate("navigator.clipboard.readText()")
        return value if isinstance(value, str) and value.strip() else None
    except Exception:
        return None


def read_clipboard_quick(page: Page, attempts: int = 5, delay_ms: int = 80) -> str | None:
    for _ in range(attempts):
        value = read_clipboard(page)
        if value:
            return value
        page.wait_for_timeout(delay_ms)
    return None


def press_escape(page: Page) -> None:
    try:
        page.keyboard.press("Escape")
        page.wait_for_timeout(100)
    except Exception:
        pass


def try_click(locator: Any, timeout_ms: int = 2500) -> bool:
    try:
        locator.click(timeout=timeout_ms)
        return True
    except Exception:
        return False


def open_filter_panel_if_needed(page: Page) -> None:
    if page.get_by_text(re.compile(r"Exibir\s+apenas|Show\s+only", re.IGNORECASE)).first.is_visible(timeout=800):
        return

    opener_re = re.compile(
        r"(filtro|filtrar|filter|tipo|item\s*type|categoria|category|todos|all|exibir|show)",
        re.IGNORECASE,
    )
    openers = [
        page.get_by_role("button", name=opener_re).first,
        page.get_by_label(opener_re).first,
        page.locator("button").filter(has_text=opener_re).first,
    ]
    for opener in openers:
        if try_click(opener, timeout_ms=1800):
            page.wait_for_timeout(500)
            return


def checkbox_state(page: Page, labels: tuple[str, ...]) -> bool | None:
    label_re = regex_for_labels(labels)
    candidates = [
        page.get_by_role("checkbox", name=label_re).first,
        page.get_by_role("menuitemcheckbox", name=label_re).first,
    ]
    for candidate in candidates:
        try:
            return bool(candidate.is_checked(timeout=700))
        except Exception:
            pass

    try:
        return page.evaluate(
            """(labels) => {
                const normalized = labels.map((label) => label.toLowerCase());
                const nodes = Array.from(document.querySelectorAll("[role='checkbox'], input[type='checkbox']"));
                for (const node of nodes) {
                    const row = node.closest("label, div, li") || node;
                    const text = (row.innerText || node.getAttribute("aria-label") || "").toLowerCase();
                    if (!normalized.some((label) => text.includes(label))) continue;
                    if (node instanceof HTMLInputElement) return node.checked;
                    const checked = node.getAttribute("aria-checked");
                    if (checked === "true") return true;
                    if (checked === "false") return false;
                    return /\u2713|✓/.test(row.innerText || "");
                }
                return null;
            }""",
            list(labels),
        )
    except Exception:
        return None


def click_filter_checkbox(page: Page, labels: tuple[str, ...], timeout_ms: int = 2500) -> bool:
    option_re = regex_for_labels(labels)
    candidates = [
        page.get_by_role("checkbox", name=option_re).first,
        page.get_by_role("menuitemcheckbox", name=option_re).first,
        page.get_by_text(option_re).first,
    ]
    for candidate in candidates:
        if try_click(candidate, timeout_ms):
            page.wait_for_timeout(900)
            return True

    try:
        return bool(
            page.evaluate(
                """(labels) => {
                    const normalized = labels.map((label) => label.toLowerCase());
                    const textNodes = Array.from(document.querySelectorAll("div, label, span"))
                        .filter((node) => {
                            const text = (node.innerText || node.textContent || "").trim().toLowerCase();
                            return normalized.some((label) => text === label || text.includes(label));
                        });
                    const node = textNodes[0];
                    if (!node) return false;
                    const row = node.closest("label, div[role='menuitemcheckbox'], div") || node;
                    row.click();
                    return true;
                }""",
                list(labels),
            )
        )
    except Exception:
        return False


def set_bundle_filter_by_dom(page: Page) -> bool:
    try:
        return bool(
            page.evaluate(
                """() => {
                    const label = Array.from(document.querySelectorAll("span, div, label"))
                        .find((node) => {
                            const text = (node.innerText || node.textContent || "").trim().toLowerCase();
                            return text === "pacotes" || text === "bundles";
                        });
                    if (!label) return false;

                    const labelRect = label.getBoundingClientRect();
                    const candidates = Array.from(document.querySelectorAll("[role='checkbox'], input[type='checkbox'], button, div"))
                        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
                        .filter(({ rect }) =>
                            rect.width >= 12 &&
                            rect.width <= 36 &&
                            rect.height >= 12 &&
                            rect.height <= 36 &&
                            Math.abs((rect.top + rect.height / 2) - (labelRect.top + labelRect.height / 2)) <= 14 &&
                            rect.left < labelRect.left
                        )
                        .sort((a, b) => Math.abs(b.rect.left - labelRect.left) - Math.abs(a.rect.left - labelRect.left));

                    const target = candidates[candidates.length - 1]?.node || label;
                    const checked = target instanceof HTMLInputElement
                        ? target.checked
                        : target.getAttribute("aria-checked") === "true";
                    if (!checked) target.click();
                    return true;
                }"""
            )
        )
    except Exception:
        return False


def set_filter_checkbox(page: Page, labels: tuple[str, ...], desired: bool) -> bool:
    current = checkbox_state(page, labels)
    if current is desired:
        return True
    if click_filter_checkbox(page, labels):
        page.wait_for_timeout(120)
        return checkbox_state(page, labels) is desired or checkbox_state(page, labels) is None
    return False


def select_shop_filter(page: Page, choice: FilterChoice) -> None:
    open_filter_panel_if_needed(page)

    if not page.get_by_text(re.compile(r"Exibir\s+apenas|Show\s+only", re.IGNORECASE)).first.is_visible(timeout=900):
        raise RuntimeError("Nao encontrei o painel de filtro 'Exibir apenas'.")

    for other in FILTER_CHOICES.values():
        if other.key != choice.key:
            set_filter_checkbox(page, other.ui_labels, False)

    selected = set_filter_checkbox(page, choice.ui_labels, True)
    if not selected and choice.key == "bundle":
        selected = set_bundle_filter_by_dom(page)

    if not selected:
        raise RuntimeError(f"Nao consegui marcar o filtro: {choice.label}.")

    page.wait_for_timeout(300)


def collect_visible_shop_items(page: Page) -> list[dict[str, Any]]:
    return page.evaluate(
        """() => {
            const skuRe = /\\b\\d{16,24}\\b/g;
            const blockedText = /carrinho|cart|nitro|presente|gift|entrar|login|biblioteca|library/i;

            function isVisible(el) {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 16 &&
                    rect.height > 16 &&
                    rect.bottom >= 0 &&
                    rect.top <= window.innerHeight &&
                    style.visibility !== "hidden" &&
                    style.display !== "none";
            }

            function blobFor(el) {
                const imgText = Array.from(el.querySelectorAll("img, source, video"))
                    .map((node) => [
                        node.getAttribute("src"),
                        node.getAttribute("srcset"),
                        node.getAttribute("poster"),
                        node.getAttribute("alt")
                    ].filter(Boolean).join(" "))
                    .join(" ");
                return [
                    el.getAttribute("href"),
                    el.getAttribute("aria-label"),
                    el.getAttribute("title"),
                    el.textContent,
                    imgText,
                    JSON.stringify(el.dataset || {})
                ].filter(Boolean).join(" ");
            }

            function itemName(el, sku) {
                const text = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "")
                    .replace(/\\s+/g, " ")
                    .trim();
                const stopRe = /\\s+(?:pre(?:\\u00e7|\\u00c3\\u00a7|c)o|price)(?:\\s*:)?|\\s+(?:R\\$|comprar\\s+por|buy\\s+for|enviar\\s+um\\s+presente|send\\s+a\\s+gift)\\b/i;
                const stop = text.search(stopRe);
                const cleaned = (stop >= 0 ? text.slice(0, stop) : text).trim();
                if (!cleaned || cleaned.length > 120 || cleaned.includes(sku)) return null;
                return cleaned;
            }

            function itemPrice(el) {
                const text = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "")
                    .replace(/\\s+/g, " ")
                    .trim();
                const money = text.match(/R\\$\\s*\\d{1,3}(?:\\.\\d{3})*,\\d{2}|\\$\\s*\\d+(?:\\.\\d{2})?/);
                if (money) return money[0].trim();
                const orbs = text.match(/(?:pre(?:\\u00e7|\\u00c3\\u00a7|c)o|price)\\s*:?\\s*(\\d{1,6}\\s+orbs?)\\b/i);
                return orbs ? orbs[1].trim() : null;
            }

            const roots = Array.from(document.querySelectorAll("a, button, [role='button']"))
                .filter(isVisible);
            const results = [];
            const seen = new Set();

            roots.forEach((el, index) => {
                const blob = blobFor(el);
                const matches = Array.from(blob.matchAll(skuRe)).map((match) => match[0]);
                if (!matches.length) return;
                if (blockedText.test((el.innerText || "").trim()) && !/collectibles-shop|itemSkuId|\\/shop/i.test(blob)) {
                    return;
                }
                for (const sku of matches) {
                    if (seen.has(sku)) continue;
                    seen.add(sku);
                    results.push({
                        sku_id: sku,
                        name: itemName(el, sku),
                        price: itemPrice(el),
                        index,
                        top: Math.round(el.getBoundingClientRect().top),
                        href: el.getAttribute("href") || null
                    });
                }
            });

            return results.sort((a, b) => a.top - b.top);
        }"""
    )


def sku_from_text(value: str | None) -> str | None:
    if not value:
        return None
    match = re.search(r"(?:itemSkuId=|/)(\d{16,24})\b|\b(\d{16,24})\b", value)
    if not match:
        return None
    return next(group for group in match.groups() if group)


def collect_visible_catalog_cards(page: Page) -> list[dict[str, Any]]:
    return page.evaluate(
        """() => {
            const blocked = /exibir apenas|decora[cç][oõ]es de avatar|efeitos de perfil|placas de identifica[cç][aã]o|molduras de perfil|profile frames|pacotes|dispon[ií]veis com orbs|carrinho|cart|nitro|gift|presente/i;

            function isVisible(el) {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width >= 120 &&
                    rect.height >= 120 &&
                    rect.bottom >= 0 &&
                    rect.top <= window.innerHeight &&
                    style.visibility !== "hidden" &&
                    style.display !== "none";
            }

            function hasMedia(el) {
                return Boolean(el.querySelector("img, video, source, canvas, picture"));
            }

            function nameFor(el) {
                const label = el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || "";
                const cleaned = label.replace(/\\s+/g, " ").trim();
                const stopRe = /\\s+(?:pre(?:\\u00e7|\\u00c3\\u00a7|c)o|price)(?:\\s*:)?|\\s+(?:R\\$|comprar\\s+por|buy\\s+for|enviar\\s+um\\s+presente|send\\s+a\\s+gift)\\b/i;
                const name = (cleaned.search(stopRe) >= 0 ? cleaned.slice(0, cleaned.search(stopRe)) : cleaned).trim();
                if (!name || name.length > 160 || blocked.test(name)) return null;
                return name;
            }

            function priceFor(el) {
                const label = el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || "";
                const cleaned = label.replace(/\\s+/g, " ").trim();
                const money = cleaned.match(/R\\$\\s*\\d{1,3}(?:\\.\\d{3})*,\\d{2}|\\$\\s*\\d+(?:\\.\\d{2})?/);
                if (money) return money[0].trim();
                const orbs = cleaned.match(/(?:pre(?:\\u00e7|\\u00c3\\u00a7|c)o|price)\\s*:?\\s*(\\d{1,6}\\s+orbs?)\\b/i);
                return orbs ? orbs[1].trim() : null;
            }

            const nodes = Array.from(document.querySelectorAll("main a, main button, main [role='button'], a, button, [role='button']"));
            const cards = [];
            const seenRects = new Set();

            nodes.forEach((el, dom_index) => {
                if (!isVisible(el) || !hasMedia(el)) return;
                const rect = el.getBoundingClientRect();
                const key = `${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
                if (seenRects.has(key)) return;
                seenRects.add(key);
                cards.push({
                    card_id: key,
                    dom_index,
                    name: nameFor(el),
                    price: priceFor(el),
                    top: Math.round(rect.top),
                    left: Math.round(rect.left),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                });
            });

            return cards.sort((a, b) => a.top - b.top || a.left - b.left);
        }"""
    )


def collect_catalog_xpath_cards(page: Page) -> list[dict[str, Any]]:
    cards: list[dict[str, Any]] = []
    children = page.locator(f"xpath={CATALOG_XPATH}/div")
    try:
        count = children.count()
    except Exception:
        return cards

    for index in range(count):
        child = children.nth(index)
        try:
            box = child.bounding_box(timeout=700)
        except Exception:
            box = None
        if not box or box["width"] < 80 or box["height"] < 80:
            continue

        try:
            text = re.sub(r"\s+", " ", child.inner_text(timeout=500)).strip()
        except Exception:
            text = ""
        name = clean_shop_item_name(text)
        price = extract_shop_item_price(text)
        cards.append(
            {
                "card_id": f"xpath:{index + 1}",
                "xpath": f"{CATALOG_XPATH}/div[{index + 1}]",
                "name": name[:140] if name else None,
                "price": price,
                "top": round(box["y"]),
                "left": round(box["x"]),
                "width": round(box["width"]),
                "height": round(box["height"]),
            }
        )
    return sorted(cards, key=lambda item: (item["top"], item["left"]))


def click_visible_card(page: Page, card_id: str) -> bool:
    return bool(
        page.evaluate(
            """(cardId) => {
                function isVisible(el) {
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    return rect.width >= 120 &&
                        rect.height >= 120 &&
                        rect.bottom >= 0 &&
                        rect.top <= window.innerHeight &&
                        style.visibility !== "hidden" &&
                        style.display !== "none";
                }

                function hasMedia(el) {
                    return Boolean(el.querySelector("img, video, source, canvas, picture"));
                }

                const nodes = Array.from(document.querySelectorAll("main a, main button, main [role='button'], a, button, [role='button']"));
                for (const el of nodes) {
                    if (!isVisible(el) || !hasMedia(el)) continue;
                    const rect = el.getBoundingClientRect();
                    const key = `${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
                    if (key !== cardId) continue;
                    el.scrollIntoView({ block: "center", inline: "center" });
                    el.click();
                    return true;
                }
                return false;
            }""",
            card_id,
        )
    )


def click_catalog_card(page: Page, card: dict[str, Any]) -> bool:
    xpath = card.get("xpath")
    if xpath:
        locator = page.locator(f"xpath={xpath}")
        try:
            locator.scroll_into_view_if_needed(timeout=1200)
            locator.click(timeout=1400, force=True)
            return True
        except Exception:
            pass
    return click_visible_card(page, str(card["card_id"]))


def click_visible_item_by_sku(page: Page, sku_id: str) -> bool:
    return bool(
        page.evaluate(
            """(sku) => {
                function isVisible(el) {
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    return rect.width > 16 &&
                        rect.height > 16 &&
                        rect.bottom >= 0 &&
                        rect.top <= window.innerHeight &&
                        style.visibility !== "hidden" &&
                        style.display !== "none";
                }

                function blobFor(el) {
                    const imgText = Array.from(el.querySelectorAll("img, source, video"))
                        .map((node) => [
                            node.getAttribute("src"),
                            node.getAttribute("srcset"),
                            node.getAttribute("poster"),
                            node.getAttribute("alt")
                        ].filter(Boolean).join(" "))
                        .join(" ");
                    return [
                        el.getAttribute("href"),
                        el.getAttribute("aria-label"),
                        el.getAttribute("title"),
                        el.textContent,
                        imgText,
                        JSON.stringify(el.dataset || {})
                    ].filter(Boolean).join(" ");
                }

                const candidates = Array.from(document.querySelectorAll("a, button, [role='button']"))
                    .filter(isVisible)
                    .filter((el) => blobFor(el).includes(sku));
                const target = candidates[0];
                if (!target) return false;
                target.scrollIntoView({ block: "center", inline: "center" });
                target.click();
                return true;
            }""",
            sku_id,
        )
    )


def is_near_bottom(page: Page) -> bool:
    return bool(
        page.evaluate(
            "() => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 120"
        )
    )


def scroll_catalog_down(page: Page) -> None:
    page.evaluate("() => window.scrollBy({ top: Math.floor(window.innerHeight * 0.78), behavior: 'instant' })")
    page.wait_for_timeout(650)


def click_next_page(page: Page) -> bool:
    next_button = page.locator(f"xpath={NEXT_PAGE_XPATH}")
    try:
        next_button.wait_for(state="attached", timeout=700)
        if next_button.is_disabled(timeout=250):
            return False
        aria_disabled = next_button.get_attribute("aria-disabled", timeout=250)
        disabled_attr = next_button.get_attribute("disabled", timeout=250)
        class_name = next_button.get_attribute("class", timeout=250) or ""
        if aria_disabled == "true" or disabled_attr is not None or "disabled" in class_name.lower():
            return False
        next_button.click(timeout=1200, force=True)
        page.wait_for_timeout(1000)
        return True
    except Exception:
        pass

    next_re = re.compile(r"(proxima|próxima|seguinte|avancar|avançar|next|>)", re.IGNORECASE)
    candidates = [
        page.get_by_role("button", name=next_re).first,
        page.get_by_role("link", name=next_re).first,
        page.get_by_label(next_re).first,
        page.locator("button").filter(has_text=next_re).first,
        page.locator("a").filter(has_text=next_re).first,
    ]
    for candidate in candidates:
        try:
            if candidate.is_disabled(timeout=400):
                continue
        except Exception:
            pass
        if try_click(candidate, timeout_ms=1200):
            page.wait_for_timeout(1000)
            return True
    return False


def close_current_item(page: Page, catalog_scroll_y: int) -> None:
    close_button = page.locator(f"xpath={CLOSE_ITEM_XPATH}")
    try:
        close_button.click(timeout=900, force=True)
        page.wait_for_timeout(300)
    except Exception:
        press_escape(page)
    if "itemSkuId=" in page.url:
        try:
            page.go_back(wait_until="domcontentloaded", timeout=2200)
            page.wait_for_timeout(450)
        except Exception:
            page.goto(SHOP_URL, wait_until="domcontentloaded")
            page.wait_for_timeout(800)
    page.evaluate("(y) => window.scrollTo(0, y)", catalog_scroll_y)
    page.wait_for_timeout(220)


def copy_link_from_current_item(page: Page) -> tuple[str | None, str]:
    modal_root = page.locator('xpath=//*[@id="app-mount"]/div[2]/div/div[6]').first
    candidates = [
        page.get_by_role("button", name=button_name_regex()).first,
        page.get_by_label(button_name_regex()).first,
        page.locator("button").filter(has_text=button_name_regex()).first,
        modal_root.get_by_role("button", name=button_name_regex()).first,
        modal_root.get_by_label(button_name_regex()).first,
        modal_root.locator("button").filter(has_text=button_name_regex()).first,
    ]
    for locator in candidates:
        try:
            locator.click(timeout=1400)
            copied = read_clipboard_quick(page, attempts=7, delay_ms=100)
            if copied and "discord.com" in copied:
                return copied.strip(), "copied"
            return copied.strip() if copied else None, "clicked_but_clipboard_unavailable"
        except PlaywrightTimeoutError:
            continue
        except Exception as error:
            return None, f"copy_error: {error}"

    try:
        copied = page.evaluate(
            """() => {
                const root = document.evaluate(
                    '//*[@id="app-mount"]/div[2]/div/div[6]',
                    document,
                    null,
                    XPathResult.FIRST_ORDERED_NODE_TYPE,
                    null
                ).singleNodeValue || document;
                const buttons = Array.from(root.querySelectorAll("button"));
                const matcher = /(copiar\\s+link|copy\\s+link|compartilhar|share|copiar|copy)/i;
                const button = buttons.find((node) => matcher.test([
                    node.innerText,
                    node.getAttribute("aria-label"),
                    node.getAttribute("title")
                ].filter(Boolean).join(" ")));
                if (!button) return null;
                button.click();
                return true;
            }"""
        )
        if copied:
            value = read_clipboard_quick(page, attempts=7, delay_ms=100)
            if value:
                return value.strip(), "copied"
            return None, "clicked_but_clipboard_unavailable"
    except Exception:
        pass
    return None, "copy_button_not_found"


def current_item_name(page: Page) -> str | None:
    try:
        name = page.locator(f"xpath={ITEM_NAME_XPATH}").inner_text(timeout=900).strip()
        return clean_shop_item_name(name)
    except Exception:
        return None


def wait_item_open(page: Page, timeout_ms: int) -> None:
    try:
        page.locator(f"xpath={ITEM_NAME_XPATH}").wait_for(state="visible", timeout=timeout_ms)
    except Exception:
        page.wait_for_timeout(min(timeout_ms, 450))


def open_item_and_copy_link(page: Page, item: dict[str, Any], pause_ms: int) -> tuple[str | None, str, str | None]:
    sku_id = str(item["sku_id"])
    catalog_scroll_y = int(page.evaluate("() => window.scrollY"))
    clicked = click_visible_item_by_sku(page, sku_id)
    if not clicked:
        page.goto(discord_shop_link(sku_id), wait_until="domcontentloaded")
    wait_item_open(page, pause_ms)

    name = current_item_name(page)
    copied, status = copy_link_from_current_item(page)
    close_current_item(page, catalog_scroll_y)
    return copied, status if clicked else f"{status}; opened_by_url", name


def open_card_and_copy_link(page: Page, card: dict[str, Any], pause_ms: int) -> tuple[str | None, str | None, str, str | None]:
    catalog_scroll_y = int(page.evaluate("() => window.scrollY"))
    clicked = click_catalog_card(page, card)
    if not clicked:
        return None, None, "card_not_found", None

    wait_item_open(page, pause_ms)
    sku_id = sku_from_text(page.url)
    name = current_item_name(page)
    copied, status = copy_link_from_current_item(page)
    sku_id = sku_id or sku_from_text(copied)
    close_current_item(page, catalog_scroll_y)
    return sku_id, copied, status, name


def scrape_visible_catalog(page: Page, choice: FilterChoice, args: argparse.Namespace, output_filename: str) -> list[ShopLink]:
    links_by_sku: dict[str, ShopLink] = {}
    products: dict[str, dict[str, Any]] = {}
    seen_cards: set[str] = set()
    page_index = 1

    while page_index <= args.max_pages:
        empty_scrolls = 0

        while empty_scrolls <= args.max_empty_scrolls:
            visible_items = collect_visible_shop_items(page)
            new_items = [item for item in visible_items if item["sku_id"] not in links_by_sku]
            visual_cards = [
                card for card in collect_catalog_xpath_cards(page)
                if str(card["card_id"]) not in seen_cards
            ]
            if not new_items:
                fallback_cards = [
                    card for card in collect_visible_catalog_cards(page)
                    if str(card["card_id"]) not in seen_cards
                ]
                visual_cards.extend(fallback_cards)

            if not new_items and not visual_cards:
                empty_scrolls += 1
                if is_near_bottom(page):
                    break
                scroll_catalog_down(page)
                continue

            empty_scrolls = 0
            for item in new_items:
                sku_id = str(item["sku_id"])
                seen_cards.add(f"sku:{sku_id}")
                product = {
                    "sku_id": sku_id,
                    "name": item.get("name"),
                    "price": item.get("price"),
                    "type": choice.product_type,
                    "source_filter": choice.label,
                    "page_index": page_index,
                }
                products[sku_id] = product
                shop_link = ShopLink(
                    sku_id=sku_id,
                    link=discord_shop_link(sku_id),
                    name=item.get("name"),
                    price=item.get("price"),
                    product_type=choice.product_type,
                    source_filter=choice.label,
                    page_index=page_index,
                )
                links_by_sku[sku_id] = shop_link
                print(f"[pagina {page_index}] Copiando: {shop_link.name or sku_id}")
                copied, status, modal_name = open_item_and_copy_link(page, item, args.item_wait_ms)
                if modal_name:
                    shop_link.name = modal_name
                    product["name"] = modal_name
                shop_link.copied_link = copied
                shop_link.copy_status = status
                save_links(list(links_by_sku.values()), output_filename)

            for card in visual_cards:
                card_id = str(card["card_id"])
                seen_cards.add(card_id)
                print(f"[pagina {page_index}] Abrindo card: {card.get('name') or card_id}")
                sku_id, copied, status, modal_name = open_card_and_copy_link(page, card, args.item_wait_ms)
                if not sku_id:
                    print(f"  Nao consegui obter SKU/link desse card: {status}")
                    continue
                if sku_id in links_by_sku:
                    if modal_name:
                        links_by_sku[sku_id].name = modal_name
                    if card.get("price") and not links_by_sku[sku_id].price:
                        links_by_sku[sku_id].price = card.get("price")
                    if copied and not links_by_sku[sku_id].copied_link:
                        links_by_sku[sku_id].copied_link = copied
                        links_by_sku[sku_id].copy_status = status
                    save_links(list(links_by_sku.values()), output_filename)
                    continue
                product = {
                    "sku_id": sku_id,
                    "name": modal_name or card.get("name"),
                    "price": card.get("price"),
                    "type": choice.product_type,
                    "source_filter": choice.label,
                    "page_index": page_index,
                }
                products[sku_id] = product
                shop_link = ShopLink(
                    sku_id=sku_id,
                    link=discord_shop_link(sku_id),
                    name=modal_name or card.get("name"),
                    price=card.get("price"),
                    product_type=choice.product_type,
                    copied_link=copied,
                    copy_status=status,
                    source_filter=choice.label,
                    page_index=page_index,
                )
                links_by_sku[sku_id] = shop_link
                save_links(list(links_by_sku.values()), output_filename)

            if is_near_bottom(page):
                break
            scroll_catalog_down(page)

        if not click_next_page(page):
            break
        page_index += 1
        seen_cards.clear()
        page.evaluate("() => window.scrollTo(0, 0)")
        page.wait_for_timeout(450)

    return list(links_by_sku.values())


def copy_link_for_sku(page: Page, sku_id: str, pause_ms: int) -> tuple[str | None, str]:
    target = discord_shop_link(sku_id)
    page.goto(target, wait_until="domcontentloaded")
    page.wait_for_timeout(pause_ms)

    candidates = [
        page.get_by_role("button", name=button_name_regex()).first,
        page.get_by_label(button_name_regex()).first,
        page.locator("button").filter(has_text=button_name_regex()).first,
    ]

    for locator in candidates:
        try:
            locator.click(timeout=2500)
            page.wait_for_timeout(400)
            copied = read_clipboard(page)
            if copied and ("discord.com" in copied or sku_id in copied):
                press_escape(page)
                return copied.strip(), "copied"
            press_escape(page)
            return None, "clicked_but_clipboard_unavailable"
        except PlaywrightTimeoutError:
            continue
        except Exception as error:
            press_escape(page)
            return None, f"copy_error: {error}"

    press_escape(page)
    return None, "copy_button_not_found"


def build_links(products: dict[str, dict[str, Any]], choice: FilterChoice) -> list[ShopLink]:
    links: list[ShopLink] = []
    for sku_id, product in products.items():
        links.append(
            ShopLink(
                sku_id=sku_id,
                link=discord_shop_link(sku_id),
                name=product.get("name"),
                price=product.get("price"),
                product_type=product.get("output_type", product.get("type", choice.product_type)),
                copied_link=discord_shop_link(sku_id),
                copy_status=product.get("copy_status", "generated_from_api"),
                source_filter=product.get("source_filter", choice.label),
            )
        )
    return links


def merge_shop_links(primary: list[ShopLink], secondary: list[ShopLink]) -> list[ShopLink]:
    by_sku = {link.sku_id: link for link in primary}
    for incoming in secondary:
        existing = by_sku.get(incoming.sku_id)
        if not existing:
            by_sku[incoming.sku_id] = incoming
            continue

        if incoming.name and not existing.name:
            existing.name = incoming.name
        if incoming.price and not existing.price:
            existing.price = incoming.price
        if incoming.copied_link and not existing.copied_link:
            existing.copied_link = incoming.copied_link
        if incoming.copy_status != "not_requested" and existing.copy_status == "not_requested":
            existing.copy_status = incoming.copy_status
        if incoming.page_index is not None and existing.page_index is None:
            existing.page_index = incoming.page_index
    return list(by_sku.values())


def ensure_shop_ready(page: Page, no_pause: bool) -> None:
    page.goto(SHOP_URL, wait_until="domcontentloaded")
    page.wait_for_timeout(1300)
    if no_pause:
        return
    print("\nO navegador abriu no Discord.")
    print("Se pedir login, faca login e abra/deixe a loja carregada.")
    input("Quando estiver pronto, pressione Enter aqui para coletar os links... ")


def maximize_page(page: Page) -> None:
    try:
        session = page.context.new_cdp_session(page)
        window = session.send("Browser.getWindowForTarget")
        session.send("Browser.setWindowBounds", {"windowId": window["windowId"], "bounds": {"windowState": "maximized"}})
        page.wait_for_timeout(250)
        size = page.evaluate(
            """() => ({
                width: Math.max(1280, Math.floor(window.outerWidth || screen.availWidth || 1920)),
                height: Math.max(720, Math.floor((window.outerHeight || screen.availHeight || 1080) - 88))
            })"""
        )
        page.set_viewport_size(size)
    except Exception:
        try:
            page.set_viewport_size(MAXIMIZED_VIEWPORT)
        except Exception:
            pass


def run(args: argparse.Namespace) -> None:
    country = args.country.upper()
    with sync_playwright() as playwright:
        context: BrowserContext = playwright.chromium.launch_persistent_context(
            str(PROFILE_DIR),
            headless=args.headless,
            viewport=MAXIMIZED_VIEWPORT if args.headless else None,
            screen=MAXIMIZED_VIEWPORT,
            no_viewport=not args.headless,
            locale=args.locale,
            permissions=["clipboard-read", "clipboard-write"],
            args=[
                "--start-maximized",
                "--window-position=0,0",
                f"--window-size={MAXIMIZED_VIEWPORT['width']},{MAXIMIZED_VIEWPORT['height']}",
            ],
        )
        page = context.pages[0] if context.pages else context.new_page()
        maximize_page(page)

        try:
            ensure_shop_ready(page, args.no_pause)

            api_headers: dict[str, str] = {}
            api_products: dict[str, dict[str, Any]] = {}
            if not args.visual_only:
                print("\nCarregando dados da loja pelo cliente do Discord...")
                api_headers, api_products = collect_loaded_shop_api_data(page)
                print(f"Produtos detalhados carregados: {len(api_products)}")
                if not api_headers.get("authorization"):
                    print("AVISO: nao consegui capturar o header autenticado do cliente; usando fallbacks.")

            total_links = 0
            for index, choice in enumerate(SCRAPE_FILTERS, start=1):
                output_filename = f"links{index}.txt"
                expected = EXPECTED_MIN_COUNTS.get(choice.key)
                links: list[ShopLink] = []

                if not args.visual_only:
                    print(f"\nColetando via API: {choice.label}")
                    products = collect_products_for_choice_from_apis(page, choice, country, api_headers, api_products)
                    links = build_links(products, choice)
                    if links:
                        save_links(links, output_filename)
                    print(f"API {choice.label}: {len(links)} links")

                should_run_visual = args.visual_only or args.force_visual
                if expected is not None and len(links) < expected and not args.api_only:
                    print(
                        f"{choice.label}: API ficou abaixo do minimo conhecido "
                        f"({len(links)}/{expected}); usando fallback visual."
                    )
                    should_run_visual = True
                elif not links and not args.api_only:
                    should_run_visual = True

                if should_run_visual and not args.api_only:
                    page.goto(SHOP_URL, wait_until="domcontentloaded")
                    page.wait_for_timeout(1100)
                    print(f"Selecionando filtro: {choice.label}")
                    select_shop_filter(page, choice)
                    page.wait_for_timeout(750)
                    visual_links = scrape_visible_catalog(page, choice, args, output_filename)
                    links = merge_shop_links(links, visual_links)

                if links:
                    save_links(links, output_filename)
                    print(f"{choice.label}: {len(links)} links salvos em {output_filename}")
                else:
                    print(f"{choice.label}: 0 links coletados; arquivo existente preservado.")
                total_links += len(links)
                if expected is not None and len(links) < expected:
                    print(f"AVISO: esperado pelo menos {expected}, faltam {expected - len(links)}.")

            print(f"Total de links encontrados: {total_links}")
            print(f"Salvo em: {OUTPUT_DIR}")
        finally:
            context.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Coleta links de itens da loja do Discord.")
    parser.add_argument("--locale", default="pt-BR", help="Locale do navegador. Padrao: pt-BR")
    parser.add_argument("--no-pause", action="store_true", help="Nao espera Enter depois de abrir o Discord.")
    parser.add_argument("--headless", action="store_true", help="Executa sem janela visivel, util apenas com sessao ja logada.")
    parser.add_argument("--item-wait-ms", type=int, default=1400, help="Tempo maximo esperando o item abrir. Padrao: 1400")
    parser.add_argument("--max-pages", type=int, default=50, help="Maximo de paginas para tentar avancar. Padrao: 50")
    parser.add_argument("--max-empty-scrolls", type=int, default=4, help="Rolagens sem item novo antes de parar a pagina.")
    parser.add_argument("--country", default=DEFAULT_COUNTRY, help=f"Pais usado para precos da API. Padrao: {DEFAULT_COUNTRY}")
    parser.add_argument("--api-only", action="store_true", help="Usa apenas APIs, sem fallback visual.")
    parser.add_argument("--visual-only", action="store_true", help="Usa apenas o scraping visual antigo.")
    parser.add_argument("--force-visual", action="store_true", help="Roda o fallback visual mesmo quando a API atinge a contagem esperada.")
    args = parser.parse_args()
    if args.api_only and args.visual_only:
        parser.error("--api-only e --visual-only nao podem ser usados juntos.")
    return args


if __name__ == "__main__":
    run(parse_args())
