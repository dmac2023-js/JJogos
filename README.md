# Jogos no Discord

Activity com backend em Python e jogos em navegador: Sudoku 9×9, Jogo da Velha
(máquina, multiplayer e espectadores) e Compartilhar Tela via WebRTC.

## Compartilhar Tela

- **Quem transmite**: abre o site no navegador (`?transmitir=1`, gerado pelo
  botão "Abrir no navegador para transmitir" dentro da Activity, já com o
  `instanceId` da call), escolhe resolução (480p/720p/1080p) e FPS (30/60) e
  captura a tela com `getDisplayMedia`.
- **Quem assiste**: de dentro da própria Activity (ou do navegador com o código
  da sala), recebe o vídeo via WebRTC P2P. O servidor só faz sinalização
  (SDP/ICE) em `/ws/tela/{sala}`; o vídeo nunca passa pelo backend.
- Limite de 9 espectadores por transmissão. O upload do host é ~1 stream por
  espectador (1080p60 para 9 pessoas exige ~30 Mbps de upload — prefira 720p30).
- Salas criadas a partir da Activity ficam vinculadas à instância da call
  (só aparecem na lista de quem está na mesma call).

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
