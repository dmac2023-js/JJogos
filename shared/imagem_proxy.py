"""Reserva a imagem externa da skin personalizada pelo nosso próprio domínio.

Dentro da Activity do Discord a página roda em <id>.discordsays.com e a
sandbox só deixa passar requisição para os hosts mapeados — por isso a skin de
imagem personalizada aparecia no site e não na Activity. Servindo o arquivo
daqui, o navegador vê uma URL de mesma origem e carrega normalmente.

Buscar uma URL que o usuário escolheu é SSRF por definição, então tudo aqui é
desconfiança: só http(s), nada que resolva para IP privado (em nenhum salto do
redirecionamento), só content-type de imagem e um teto de tamanho.
"""
import ipaddress
import socket
from typing import Tuple
from urllib.parse import urlparse

import requests

TAMANHO_MAXIMO = 5 * 1024 * 1024   # 5 MB — skin é enfeite, não filme
TEMPO_LIMITE = 8                   # segundos
PEDACO = 64 * 1024
TIPOS_ACEITOS = ("image/",)
MAX_REDIRECIONAMENTOS = 3
# O Referer vazio evita o 403 de host que bloqueia hotlink; o UA evita os que
# recusam cliente sem identificação.
CABECALHOS = {"User-Agent": "JJogos/1.0 (+https://jogos7.duckdns.org)", "Accept": "image/*"}


class ImagemRecusada(Exception):
    """URL que não passou na checagem — a mensagem vai pro usuário."""


def _ip_e_publico(ip_texto: str) -> bool:
    ip = ipaddress.ip_address(ip_texto)
    return not (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_multicast or ip.is_reserved or ip.is_unspecified)


def validar_url(url: str) -> None:
    """Recusa o que não for http(s) público. Resolve o DNS e checa TODOS os
    endereços — um host pode ter um IPv6 público e um IPv4 interno."""
    partes = urlparse(url)
    if partes.scheme not in ("http", "https") or not partes.hostname:
        raise ImagemRecusada("Só link http(s) direto de imagem.")
    try:
        enderecos = socket.getaddrinfo(partes.hostname, partes.port or
                                       (443 if partes.scheme == "https" else 80),
                                       proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise ImagemRecusada("Não achei esse endereço.")
    if not enderecos:
        raise ImagemRecusada("Não achei esse endereço.")
    for familia, _, _, _, sockaddr in enderecos:
        if not _ip_e_publico(sockaddr[0]):
            raise ImagemRecusada("Esse endereço não é público.")


def buscar(url: str) -> Tuple[bytes, str]:
    """Baixa a imagem e devolve (bytes, content-type). Levanta ImagemRecusada
    em qualquer coisa fora do esperado."""
    validar_url(url)
    try:
        resposta = requests.get(url, headers=CABECALHOS, timeout=TEMPO_LIMITE,
                                stream=True, allow_redirects=True)
    except requests.RequestException:
        raise ImagemRecusada("Não consegui baixar essa imagem.")

    with resposta:
        # O requests já seguiu os redirecionamentos; o corpo ainda não foi lido,
        # então dá tempo de conferir cada salto antes de gastar banda.
        if len(resposta.history) > MAX_REDIRECIONAMENTOS:
            raise ImagemRecusada("Link com redirecionamento demais.")
        for salto in list(resposta.history) + [resposta]:
            validar_url(salto.url)
        if resposta.status_code != 200:
            raise ImagemRecusada("O site da imagem respondeu %d." % resposta.status_code)

        tipo = (resposta.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if not tipo.startswith(TIPOS_ACEITOS):
            raise ImagemRecusada("Esse link não é uma imagem.")

        declarado = resposta.headers.get("Content-Length")
        if declarado and declarado.isdigit() and int(declarado) > TAMANHO_MAXIMO:
            raise ImagemRecusada("Imagem maior que 5 MB.")

        corpo = bytearray()
        for pedaco in resposta.iter_content(PEDACO):
            corpo.extend(pedaco)
            # Content-Length mente; o corte de verdade é durante a leitura.
            if len(corpo) > TAMANHO_MAXIMO:
                raise ImagemRecusada("Imagem maior que 5 MB.")
    return bytes(corpo), tipo
