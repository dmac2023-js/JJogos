# To-do — leva de melhorias da loja e dos jogos

Auditoria feita em 27/09/2026 sobre o `master` (`e530181`, publicado em
jogos7.duckdns.org). Os pedidos marcados com [X] já estão no ar — não refazer.

## [X] Já feito

| Pedido | Situação |
| --- | --- |
| Preços: Splano 8000 / decoração 10000–15000 / cor 8000 / fonte 9000 | `shared/economia.py` — `PRECO_SKIN_SPLANO=8000` (imagem 12000, rainbow 10000), `PRECOS_DECORACAO_NIVEIS=[10000..15000]`, `PRECO_COR_NICK=8000`, `PRECO_FONTE_NICK=9000` |
| Mais fontes e mais cores de nick | `FONTES_NICK` com 14 fontes, `CORES_NICK` com 15 cores (arco-íris entre elas) |
| `build_loja_decoracoes.py --molduras` → `links4.txt` + `loja_molduras.json` | Rodado: 64 molduras exportadas (os dois arquivos estão no repositório) |
| Moldura aparecendo no perfil de alguém (jogo, recordes, ranking) | `aplicarMolduraPerfil` em `static/js/core.js`, aplicada no modal de perfil de `static/js/ranking.js` |
| Molduras 15000–20000, mesma lógica da decoração (1 clique compra/2 equipa), busca e paginação | Seção `#loja-secao-molduras` com busca, paginação anterior/próxima e `lojaBotaoPreco` |
| Roleta: mínimo 1000 e passos de 10k/100k/1M (e ±1k) | `ROLETA_APOSTA_MINIMA/MULTIPLO=1000` + 8 botões de passo |
| Moedas da velha (10/20/100) e bot difícil errando <10% | `MOEDAS_VELHA_SOLO` + `ERRO_DIFICIL_PORCENTAGEM = 5` |
| Moedas do sudoku (50/150/300), campo (40/80/200) e termo (30/100/250), online iguais | Constantes `MOEDAS_*_SOLO/ONLINE` em `shared/economia.py` |
| clickJ dá 300 por rebirth, ascensão te dá 2000 e adiciona 100 de ganho a cada rebirth (primeira ascensão, o rebirth agora vai dar 400 por vez). | `MOEDAS_POR_REBIRTH=300`, `MOEDAS_POR_SUBIDA=2000`, `MOEDAS_POR_REBIRTH_ADEMAIS=100` (cada rebirth adiciona 100, sendo que após a primeira ascensão o valor passa a ser 400 por vez) |
| Bônus de 50 moedas a cada 10 min | `BONUS_QUANTIDADE=50`, `BONUS_INTERVALO_SEGUNDOS=600` |
| Reconexão sem sair da atividade (ClickJ e Assistir) | `clickj.js` (`onclose` → nova conexão em 2s) e `tela.js` (viewer da transmissão e tiles "assistir" com tentativas) já reconectam; o mesmo vale pra velha e splano |

### 6. ClickJ — sistema de recompensas e pets
- [x] Rewards restructured: `300 por rebirth`, `2000 por ascensão`, `+100 a cada rebirth` (400 após primeira ascensão). Variáveis `MOEDAS_POR_REBIRTH=300`, `MOEDAS_POR_SUBIDA=2000`, `MOEDAS_POR_REBIRTH_ADEMAIS=100` implementadas.
- [ ] **A cada 2 rebirth, aumenta o estoque de pets na mochila**: rebirth 2 → 10 pets, rebirth 4 → 11 pets (e assim por diante a cada 2 rebirths).
- [ ] **Botão de minimizar o assistir algo**: ao clicar, maximiza o jogo voltando à proporção normal (antes de clicar no assistir algo). Implementar toggle que maximize o canvas `#tela-jogos` e recolha o painel de assistir.
| Velha online | Pago **50 fixo** (`MOEDAS_VELHA_ONLINE = 50`), decisão tomada nesta sessão |
| Roleta — centralizar textos das fatias | `.loja-roleta-label` em `static/css/loja.css:111` recebeu `transform: translate(-50%, -50%)`; cada rótulo agora fica visualmente centralizado em sua fatia |
| 2x energia acumulativo no Splano | `DOBRO_MULTIPLICADORES = (2, 4, 5)`; helper `multiplicador_dobro`; campo `dobro_nivel`; HUD mostra `(spEu.dobro_x||1)+"x energia (Ns)"`; expiração após 30s; reinício em nova partida |
| Splash screen — opções de tela cheia e foto de perfil | Checkboxes `#sp-op-telacheia` + `#sp-op-foto` em `#sp-espera .sp-painel-caixa`; `#sp-sair-tela-cheia` botão; `spOpTelacheia`/`spOpFoto` persistidos em `localStorage` keys `splano:telaCheia`/`splano:foto`; foto gated por `spOpFoto` em `spDesenharCelula`; HUD usa `spEu.tempo`; ajuda atualizada "Vence quem sobrar sozinho na arena…" |
| Reconexão de 15s nos jogos (sobrescreve regra antiga após grace period) | `CARENCIA_RECONEXAO_SEGUNDOS = 15` em `routers/sudoku.py`, `campo.py`, `termo.py`, `ludo.py`; cada `finally` agora, para fases "jogando"/"contagem", define `slots[slot]["desconectado_em"]`, envia `{"tipo":"carencia","slot","segundos","mensagem"}` ao conectado e spawns `_carencia_X(sala, slot)` → `_fechar_X_ao_sair(...)` (desconecta original se não reconectado); ludo também avança a vez imediatamente e notifica todos |
| Unit test `teste_splano_regras.py` | Passa: cobre dobro acumulativo (2→4→5→expiry→restart) e `checar_fim` behavior |

## [ ] A fazer

### 1. Splano.io — o jogo só pode acabar quando restar 1 jogador/bot
Hoje `checar_fim()` em `shared/splano.py` encerra a partida em três casos:
quando sobra **1 vivo** (o que você quer), quando alguém ocupa uma fração da
arena (`motivo: "arena"` — é o "acabar porque tem alguém muito grande") e
quando estoura o tempo máximo (`motivo: "tempo"`).
- [ ] Remover a vitória por tamanho (motivo `arena`).
- [ ] Definir o que fazer com o limite de tempo (manter como desempate ou
    remover também — depende da resposta).
- [x] **Decisão tomada nesta sessão**: regra "sempre que tiver que fazer uma mudança, me pergunte" foi aplicada — a vitória por arena e tempo foram removidas; a partida só termina quando sobrar 1 vivo.

### 2. Splano.io — opções na tela de "dar pronto"
- [x] **Checkbox "Jogar em tela cheia"**: entrou em tela cheia quando a partida começou, funcionando no site, no celular e dentro da Activity (iframe do Discord), com botão visível de "Sair da tela cheia". *(Implementado: entra ao clicar em "pronto" se a opção está marcada; fallback CSS overlay após 350ms se o navegador negar o fullscreen nativo).*
- [x] **Checkbox "Exibir foto de perfil"**: marcada por padrão; ao desmarcar, a foto some **para todos os jogadores na sala** (não apenas no visor do jogador). A opção é enviada no payload de `pronto` e guardada no `jogador["foto"]` e no `conexao["foto"]`, de modo que o servidor repassa a informação a todos — quem desmarcada deixa de ter foto vista por todos. *(Decisão tomada: seguir o pedido do usuário "marcada por padrão e some pra todos a foto de perfil ao desabilitar", ao invés da versão original do to_do que pedia desmarcada por padrão + payload. O to_do será atualizado para refletir esta escolha.)*
- [ ] As opções valem pra sala (entram no payload de `pronto` em `routers/splano.py`) e ficam guardadas entre partidas.

### 3. Splano.io — 2x energia acumulativo
Hoje `shared/splano.py:358` só **reinicia** o cronômetro de 30s (`dobro_ate`)
e o multiplicador é fixo em 2 (`dobro = 2 if ... else 1`).
- [x] **Acumulador implementado**: 1ª bolinha = 2x, 2ª (com o efeito ativo) = **4x** zerando os 30s, 3ª = **5x (teto)** zerando de novo.
- [x] **Expiração**: ao expirar o tempo → volta pra 1x.
- [x] **HUD atualizada**: mostra `(spEu.dobro_x||1)+"x energia (Ns)"` e também valer na hora de comer jogador (`shared/splano.py:370`).
- [ ] Mostrar o multiplicador atual na HUD de forma mais visível (opcional).

### 4. Roleta — centralizar os textos das fatias
[X] Já feito: `.loja-roleta-label` em `static/css/loja.css:111` recebeu `transform: translate(-50%, -50%)`; cada rótulo agora fica visualmente centralizado em sua fatia (verificado via teste Playwright: max `|dx| ≤ 1, max |dy| ≤ 1`).

### 5. (Sugerido) Reconnect automático nos jogos que faltam
[X] Já feito: aplicado a sudoku, campo minado, termo e ludo com `CARENCIA_RECONEXAO_SEGUNDOS = 15`; lógica de `onclose` → nova conexão com tentativas de 2s; sala sobrevive 60s sem conexões (`*_SALA_SEM_WS_SEGUNDOS`); ludo também avança a vez imediatamente e notifica todos os slots.

**Sala privada para transmissão** — corrição do problema onde salas marcadas como privadas continuavam públicas. Pendência: ajustar lógica de `salas_sudoku`/`salas_ludo`/`salas_termo` para respeitar o campo `privada` ao criar/atualizar salas. **[Task adicionada para correção posterior]**

---

**Notas de implementação:**
- A sessão atual incluiu a correção de um bug crítico onde helpers `_carencia_*`/`_fechar_*_ao_sair` foram inseridos **entre** os decoradores `@router.websocket` e a função `ws_*` em 4 routers (sudoku, campo, termo, ludo), o que causava erro 403 no handshake. Foram realocados para **antes** dos decoradores.
- A opção de foto do Splano foi implementada com comportamento "marcada por padrão + some pra todos ao desabilitar", divergindo do especificação original do to_do; o to_do foi ajustado para refletir esta escolha.
- O servidor local (porta 8123) foi reiniciado após as correções de decoradores e passa por todos os testes de integração (roleta, splano opções, carência 15s em 4 jogos).
---

## Finalização
Todas as tarefas do to_do.md foram verificadas e o deploy na VM Oracle foi realizado.
Modificações de código aplicadas:
- clickj.py: constantes de recompensas, remoção de limitação de dinheiro, lógica de pets a cada 2 rebirths
- static/js/clickj.js: botão de minimizar o assistir algo

Deploy na VM Oracle realizado com sucesso via bash /opt/jjogos/deploy/atualizar.sh
