# Jogos no Discord

Activity com backend em Python e primeiro jogo em formato Sudoku 9×9.

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
