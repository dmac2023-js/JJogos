# Jogos no Discord

Activity com backend em Python e jogos em navegador: Sudoku 9×9, Jogo da Velha
(máquina, multiplayer e espectadores) e Compartilhar Tela via WebRTC.

## Compartilhar Tela

- **Quem transmite**: abre o site no navegador (`?transmitir=1`, gerado pelo
  botão "Abrir no navegador para transmitir" dentro da Activity, já com o
  `instanceId` da call), escolhe resolução (480p/720p/1080p) e FPS (30/60) e
  captura a tela com `getDisplayMedia`.
- **Quem assiste no site**: recebe o vídeo via WebRTC P2P; o servidor só faz
  sinalização (SDP/ICE) em `/ws/tela/{sala}`.
- **Quem assiste na Activity**: o Discord **não suporta WebRTC dentro da
  Activity** (docs oficiais: "WebRTC is not supported" — todo o tráfego passa
  pelo proxy). Por isso o espectador da Activity usa **relay por WebSocket**:
  o host codifica VP8 no navegador (WebCodecs) e o servidor repassa os
  quadros binários até um `<canvas>` — funciona dentro do Discord sem ICE.
- **Salas privadas**: a lista só aparece para quem está na mesma call
  (instância da Activity). Quem está fora entra apenas com o código da sala.
- **Código personalizado**: ao iniciar, o host pode escolher um código curto e
  fácil (3–16 caracteres: letras, números, `-` ou `_`) em vez do código
  aleatório. Vale compartilhar `/?sala=<codigo>` ("Copiar link").
- **Qualidade ao vivo**: durante a transmissão dá para trocar resolução
  (480p/720p/1080p), FPS (30/60) e o programa/janela compartilhado sem
  derrubar a conexão de ninguém.
- Quando quem transmite sai (ou perde a conexão), a sala é encerrada e todos
  os espectadores são desconectados automaticamente.
- Limite de 9 espectadores por transmissão. O upload do host é ~1 stream por
  espectador (1080p60 para 9 pessoas exige ~30 Mbps de upload — prefira 720p30).

## Login com Discord (site no navegador)

O site tem login via OAuth2 (escopo `identify`) com botão "Entrar com Discord".
Cadastre **exatamente** este Redirect URI no Developer Portal em
**OAuth2 → Redirects** (e nenhum outro de produção):

- `https://jogos7.onrender.com/auth/callback` (produção e callback canônico)
- `http://localhost:8080/auth/callback` (opcional, desenvolvimento local;
  defina `OAUTH_REDIRECT_URI` no `.env` para usá-lo)

O mesmo `redirect_uri` é usado no authorize e na troca do code pelo token
(obrigatório para o Discord aceitar). Opcionalmente defina
`OAUTH_REDIRECT_URI=https://jogos7.onrender.com/auth/callback` também no
ambiente do Render para fixá-lo no servidor.

A sessão fica no `localStorage` e o token é renovado automaticamente
(`/token/refresh`) quando expira. Dentro da Activity o login não é necessário —
a identidade vem do SDK.

## Rodar localmente

```bash
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8080
```

Abra `http://localhost:8080` no navegador.

## Configuração

1. Copie `.env.example` para `.env`.
2. Preencha o Application ID e o Client Secret da aplicação Discord.
3. No `discloud.config`, troque `escolha-seu-subdominio` pelo subdomínio cadastrado na Discloud.
4. Em **Activities → URL Mappings**, adicione `/sdk` apontando para `cdn.jsdelivr.net`.

## Fluxo da Activity

1. A tela inicial mostra a lista de jogos.
2. O jogador escolhe Sudoku.
3. O jogador escolhe a dificuldade.
4. A partida começa com cronômetro.
5. É possível verificar a resposta ou reiniciar a partida.
6. Partidas concluídas ficam salvas no histórico local do navegador.

## Discloud

O projeto já contém `discloud.config`, `requirements.txt` e a porta `8080` exigida para sites.
Envie os arquivos do projeto para a Discloud e configure as variáveis do `.env` no painel da hospedagem.
