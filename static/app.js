// ---------------------------------------------------------------------------
// Estado global
// ---------------------------------------------------------------------------
let jogoId = null;
let gradeAtual = [];
let dificuldadeAtual = "facil";
let tempoInicial = 0;
let intervaloCronometro = null;
let usuarioDiscord = null;
let discordSdkGlobal = null;

// ---------------------------------------------------------------------------
// Sudoku — refs DOM
// ---------------------------------------------------------------------------
const telaJogos = document.querySelector("#tela-jogos");
const telaDificuldade = document.querySelector("#tela-dificuldade");
const telaJogo = document.querySelector("#tela-jogo");
const elementoGrade = document.querySelector("#grade");
const elementoMensagem = document.querySelector("#mensagem");
const elementoCronometro = document.querySelector("#cronometro");
const elementoHistorico = document.querySelector("#lista-historico");
const elementoStatus = document.querySelector("#status-discord");
const elementoRecordes = document.querySelector("#lista-recordes");

const todasTelas = document.querySelectorAll(".tela");
const nomesDificuldade = { facil: "Fácil", medio: "Médio", dificil: "Difícil" };

// ---------------------------------------------------------------------------
// Navegação entre telas
// ---------------------------------------------------------------------------
function mostrarTela(tela) {
  todasTelas.forEach((item) => item.classList.remove("ativa"));
  tela.classList.add("ativa");
}

function mostrarMensagem(texto, tipo = "") {
  elementoMensagem.textContent = texto;
  elementoMensagem.className = "mensagem " + tipo;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function formatarTempo(segundos) {
  const m = Math.floor(segundos / 60).toString().padStart(2, "0");
  const s = (segundos % 60).toString().padStart(2, "0");
  return m + ":" + s;
}

function tempoAtual() {
  return Math.floor((Date.now() - tempoInicial) / 1000);
}

// ---------------------------------------------------------------------------
// Cronômetro (Sudoku)
// ---------------------------------------------------------------------------
function iniciarCronometro() {
  clearInterval(intervaloCronometro);
  tempoInicial = Date.now();
  elementoCronometro.textContent = "00:00";
  intervaloCronometro = setInterval(function () {
    elementoCronometro.textContent = formatarTempo(tempoAtual());
  }, 1000);
}

function pararCronometro() {
  clearInterval(intervaloCronometro);
  intervaloCronometro = null;
}

// ---------------------------------------------------------------------------
// Sudoku — Grade
// ---------------------------------------------------------------------------
function desenharGrade(grade) {
  elementoGrade.innerHTML = "";
  gradeAtual = grade.map(function (linha) { return linha.slice(); });

  grade.forEach(function (linha, indiceLinha) {
    linha.forEach(function (numero, indiceColuna) {
      const celula = document.createElement("input");
      celula.className = "celula";
      celula.type = "text";
      celula.maxLength = 1;
      celula.pattern = "[1-9]";
      celula.autocomplete = "off";
      celula.inputMode = "numeric";
      celula.setAttribute("aria-label", "Linha " + (indiceLinha + 1) + ", coluna " + (indiceColuna + 1));

      if (numero !== 0) {
        celula.value = numero;
        celula.disabled = true;
        celula.classList.add("preenchida");
      }

      celula.addEventListener("input", function () {
        celula.value = celula.value.replace(/[^1-9]/g, "").slice(0, 1);
        const valor = Number(celula.value);
        gradeAtual[indiceLinha][indiceColuna] = valor >= 1 && valor <= 9 ? valor : 0;
        celula.classList.remove("erro");
      });

      elementoGrade.appendChild(celula);
    });
  });
}

async function iniciarSudoku(dificuldade) {
  dificuldadeAtual = dificuldade;
  document.querySelector("#dificuldade-atual").textContent = nomesDificuldade[dificuldade];
  mostrarTela(telaJogo);
  mostrarMensagem("Carregando Sudoku...");
  carregarRecordes(dificuldade);

  try {
    const resposta = await fetch("./sudoku/novo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dificuldade: dificuldade }),
    });
    const dados = await resposta.json();
    if (!resposta.ok) throw new Error(dados.detail || "Não foi possível criar a partida.");

    jogoId = dados.jogo_id;
    desenharGrade(dados.grade);
    mostrarMensagem("Preencha a grade com números de 1 a 9.");
    iniciarCronometro();
  } catch (erro) {
    mostrarMensagem(erro.message, "erro");
  }
}

function carregarHistorico() {
  const historico = JSON.parse(localStorage.getItem("historico-sudoku") || "[]");
  elementoHistorico.innerHTML = "";

  if (historico.length === 0) {
    elementoHistorico.innerHTML = '<p class="vazio">Nenhuma partida concluída ainda.</p>';
    return;
  }

  historico.forEach(function (partida) {
    const registro = document.createElement("div");
    registro.className = "registro";
    registro.innerHTML = "<span>" + nomesDificuldade[partida.dificuldade] + " &middot; " + partida.data + "</span><strong>" + partida.tempo + "</strong>";
    elementoHistorico.appendChild(registro);
  });
}

function salvarHistorico() {
  const historico = JSON.parse(localStorage.getItem("historico-sudoku") || "[]");
  historico.unshift({
    dificuldade: dificuldadeAtual,
    tempo: formatarTempo(tempoAtual()),
    data: new Date().toLocaleDateString("pt-BR"),
  });
  localStorage.setItem("historico-sudoku", JSON.stringify(historico.slice(0, 20)));
  carregarHistorico();
}

// ---------------------------------------------------------------------------
// Sudoku — Recordes
// ---------------------------------------------------------------------------
async function carregarRecordes(dificuldade) {
  try {
    const resposta = await fetch("./sudoku/recordes/" + dificuldade);
    const dados = await resposta.json();
    const lista = dados.recordes || [];
    elementoRecordes.innerHTML = "";

    if (lista.length === 0) {
      elementoRecordes.innerHTML = '<p class="vazio">Nenhum recorde ainda.</p>';
      return;
    }

    var medallas = ["\uD83E\uDD47", "\uD83E\uDD48", "\uD83E\uDD49"];
    lista.forEach(function (recorde, i) {
      const registro = document.createElement("div");
      registro.className = "registro-recorde";
      registro.innerHTML =
        '<span class="recorde-posicao">' + (medallas[i] || "") + "</span>" +
        '<span class="recorde-info"><strong>' + recorde.nick + "</strong>" +
        "<small>" + recorde.nome + "</small></span>" +
        '<span class="recorde-tempo">' + formatarTempo(recorde.tempo_segundos) + "</span>";
      elementoRecordes.appendChild(registro);
    });
  } catch (erro) {
    elementoRecordes.innerHTML = '<p class="vazio">Erro ao carregar recordes.</p>';
  }
}

async function salvarRecorde() {
  const nome = usuarioDiscord ? usuarioDiscord.username : "Anônimo";
  const nick = usuarioDiscord ? (usuarioDiscord.global_name || usuarioDiscord.username) : "Anônimo";

  try {
    await fetch("./sudoku/recordes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dificuldade: dificuldadeAtual,
        nome: nome,
        nick: nick,
        tempo_segundos: tempoAtual(),
      }),
    });
    carregarRecordes(dificuldadeAtual);
  } catch (erro) {
    console.warn("Erro ao salvar recorde:", erro);
  }
}

async function verificarResposta() {
  if (!jogoId) return;
  mostrarMensagem("Verificando...");

  try {
    const resposta = await fetch("./sudoku/verificar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jogo_id: jogoId, grade: gradeAtual }),
    });
    const dados = await resposta.json();
    if (!resposta.ok) throw new Error(dados.detail || "Não foi possível verificar.");

    document.querySelectorAll(".celula.erro").forEach(function (c) { c.classList.remove("erro"); });
    (dados.erros || []).forEach(function (ref) {
      const indice = ref[0] * 9 + ref[1];
      const celula = elementoGrade.children[indice];
      if (celula) celula.classList.add("erro");
    });

    if (dados.correto) {
      pararCronometro();
      salvarHistorico();
      salvarRecorde();
      mostrarMensagem(dados.mensagem + " Tempo: " + formatarTempo(tempoAtual()) + ".", "sucesso");
    } else {
      mostrarMensagem(dados.mensagem, "erro");
    }
  } catch (erro) {
    mostrarMensagem(erro.message, "erro");
  }
}

// ---------------------------------------------------------------------------
// Jogo da Velha — Estado
// ---------------------------------------------------------------------------
let velhaJogoId = null;
let velhaTabuleiro = ["", "", "", "", "", "", "", "", ""];
let velhaMinhaPeca = "X";
let velhaModo = null;
let velhaDificuldade = "facil";
let velhaWs = null;
let velhaSala = null;
let velhaEspectador = false;
let velhaDonoSaiu = false;
let velhaReconnectAttempts = 0;
const VELHA_MAX_RECONNECT = 5;
let velhaPingTimer = null;
let lobbyWs = null;
let lobbyPingTimer = null;

const telaModoVelha = document.querySelector("#tela-modo-velha");
const telaDificuldadeVelha = document.querySelector("#tela-dificuldade-velha");
const telaLobbyVelha = document.querySelector("#tela-lobby-velha");
const telaVelha = document.querySelector("#tela-velha");
const telaEspectarVelha = document.querySelector("#tela-espectar-velha");

const tabuleiroEl = document.querySelector("#tabuleiro-velha");
const casasEl = tabuleiroEl.querySelectorAll(".casa-velha");
const mensagemVelha = document.querySelector("#mensagem-velha");
const vezLabel = document.querySelector("#velha-vez-label");

// ---------------------------------------------------------------------------
// Jogo da Velha — Helpers
// ---------------------------------------------------------------------------
function desenharTabuleiro(tabuleiro) {
  var linhasVitoria = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  var casaVenceu = [];

  if (velhaTabuleiro._resultado) {
    for (var li = 0; li < linhasVitoria.length; li++) {
      var l = linhasVitoria[li];
      if (tabuleiro[l[0]] && tabuleiro[l[0]] === tabuleiro[l[1]] && tabuleiro[l[1]] === tabuleiro[l[2]]) {
        casaVenceu = l;
        break;
      }
    }
  }

  casasEl.forEach(function (casa, i) {
    casa.textContent = tabuleiro[i] || "";
    casa.className = "casa-velha";
    if (tabuleiro[i]) {
      casa.classList.add("preenchida");
      casa.classList.add(tabuleiro[i].toLowerCase());
    }
    if (casaVenceu.indexOf(i) !== -1) {
      casa.classList.add("venceu");
    }
    if (velhaEspectador || !velhaTabuleiro._ativo || tabuleiro[i]) {
      casa.classList.add("desabilitada");
    }
  });
}

function atualizarVelhaMensagem(texto, tipo) {
  mensagemVelha.textContent = texto;
  mensagemVelha.className = "mensagem" + (tipo ? " " + tipo : "");
}

function atualizarVelhaVez() {
  if (!velhaTabuleiro._ativo && velhaTabuleiro._resultado) {
    if (velhaTabuleiro._resultado === "empate") {
      vezLabel.textContent = "Empate!";
      vezLabel.className = "indicador-vez";
    } else if (velhaTabuleiro._resultado === velhaMinhaPeca) {
      vezLabel.textContent = "Você venceu!";
      vezLabel.className = "indicador-vez " + velhaMinhaPeca.toLowerCase();
    } else {
      vezLabel.textContent = "Você perdeu!";
      vezLabel.className = "indicador-vez " + velhaMinhaPeca.toLowerCase();
    }
    document.querySelector("#sair-sala-velha").style.display = "";
    return;
  }
  if (velhaTabuleiro._minhaVez) {
    vezLabel.textContent = "Sua vez (" + velhaMinhaPeca + ")";
    vezLabel.className = "indicador-vez " + velhaMinhaPeca.toLowerCase();
  } else {
    var oponente = velhaMinhaPeca === "X" ? "O" : "X";
    vezLabel.textContent = "Vez do oponente (" + oponente + ")";
    vezLabel.className = "indicador-vez " + oponente.toLowerCase();
  }
}

function limparTabuleiro() {
  velhaTabuleiro = ["", "", "", "", "", "", "", "", ""];
  velhaTabuleiro._ativo = true;
  velhaTabuleiro._resultado = null;
  velhaTabuleiro._minhaVez = true;
  desenharTabuleiro(velhaTabuleiro);
}

function mostrarCodigoSala(codigo) {
  var el = document.querySelector("#sala-codigo-display");
  var valor = document.querySelector("#sala-codigo-valor");
  valor.textContent = codigo;
  el.style.display = "";
}

function esconderCodigoSala() {
  document.querySelector("#sala-codigo-display").style.display = "none";
}

// ---------------------------------------------------------------------------
// Lobby WebSocket — salas em tempo real
// ---------------------------------------------------------------------------
function conectarLobbyWs() {
  if (lobbyWs && lobbyWs.readyState === WebSocket.OPEN) return;

  var protocolo = location.protocol === "https:" ? "wss:" : "ws:";
  var url = protocolo + "//" + location.host + "/ws/lobby";

  lobbyWs = new WebSocket(url);

  clearInterval(lobbyPingTimer);
  lobbyPingTimer = setInterval(function () {
    if (lobbyWs && lobbyWs.readyState === WebSocket.OPEN) {
      lobbyWs.send("ping");
    }
  }, 20000);

  lobbyWs.onmessage = function (evento) {
    var dados = JSON.parse(evento.data);
    if (dados.tipo === "salas_atualizadas") {
      renderizarSalasLobby(dados.salas);
      renderizarSalasEspectacao(dados.salas);
    }
  };

  lobbyWs.onclose = function () {
    clearInterval(lobbyPingTimer);
    setTimeout(conectarLobbyWs, 3000);
  };

  lobbyWs.onerror = function () {};
}

function renderizarSalasLobby(salas) {
  var container = document.querySelector("#salas-ativas-conteudo");
  if (!container) return;
  container.innerHTML = "";

  if (salas.length === 0) {
    container.innerHTML = '<p class="vazio">Nenhuma sala ativa.</p>';
    return;
  }

  salas.forEach(function (sala) {
    var item = document.createElement("div");
    item.className = "sala-item";
    item.innerHTML =
      '<div class="sala-item-info">' +
      "<strong>" + (sala.jogador_x || "?") + " vs " + (sala.jogador_o || "Aguardando") + "</strong>" +
      "<small>" + sala.sala + " · " + (sala.em_andamento ? "Em andamento" : "Vaga disponível") + "</small>" +
      "</div>" +
      '<span class="sala-item-jogadores">' + sala.jogadores + "/2</span>";
    item.addEventListener("click", function () {
      entrarSalaVelha(sala.sala);
    });
    container.appendChild(item);
  });
}

function renderizarSalasEspectacao(salas) {
  var container = document.querySelector("#lista-espectacao");
  if (!container) return;
  container.innerHTML = "";

  if (salas.length === 0) {
    container.innerHTML = '<p class="vazio">Nenhuma sala ativa no momento.</p>';
    return;
  }

  salas.forEach(function (sala) {
    var item = document.createElement("div");
    item.className = "sala-item";
    item.innerHTML =
      '<div class="sala-item-info">' +
      "<strong>" + (sala.jogador_x || "?") + " vs " + (sala.jogador_o || "Aguardando") + "</strong>" +
      "<small>" + (sala.em_andamento ? "Em andamento" : "Aguardando jogador") + "</small>" +
      "</div>" +
      '<span class="sala-item-jogadores">Espectadores: ' + sala.espectadores + "</span>";
    item.addEventListener("click", function () {
      var nome = usuarioDiscord ? usuarioDiscord.username : "Anônimo";
      var nick = usuarioDiscord ? (usuarioDiscord.global_name || usuarioDiscord.username) : "Anônimo";
      mostrarTela(telaVelha);
      esconderCodigoSala();
      limparTabuleiro();
      document.querySelector("#reiniciar-velha").style.display = "none";

      document.querySelector("#sair-sala-velha").style.display = "none";
      conectarWsVelha(sala.sala, nome, nick, true);
    });
    container.appendChild(item);
  });
}

// ---------------------------------------------------------------------------
// Jogo da Velha — vs Máquina
// ---------------------------------------------------------------------------
async function iniciarVelhaMaquina(dificuldade) {
  velhaModo = "maquina";
  velhaDificuldade = dificuldade;
  velhaMinhaPeca = "X";
  velhaEspectador = false;
  mostrarTela(telaVelha);
  esconderCodigoSala();
  atualizarVelhaMensagem("Carregando...");
  document.querySelector("#reiniciar-velha").style.display = "";
  document.querySelector("#sair-sala-velha").style.display = "none";
  document.querySelector("#espectadores-bar").style.display = "none";

  var nome = usuarioDiscord ? usuarioDiscord.username : "Anônimo";
  var nick = usuarioDiscord ? (usuarioDiscord.global_name || usuarioDiscord.username) : "Anônimo";

  try {
    var res = await fetch("./velha/novo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modo: "maquina", dificuldade: dificuldade, nome: nome, nick: nick }),
    });
    var dados = await res.json();
    if (!res.ok) throw new Error(dados.detail || "Erro ao criar jogo.");

    velhaJogoId = dados.jogo_id;
    velhaTabuleiro = dados.tabuleiro;
    velhaTabuleiro._ativo = true;
    velhaTabuleiro._resultado = null;
    velhaTabuleiro._minhaVez = true;
    desenharTabuleiro(velhaTabuleiro);
    atualizarVelhaMensagem("Faça sua jogada!");
    atualizarVelhaVez();
  } catch (erro) {
    atualizarVelhaMensagem(erro.message, "erro");
  }
}

async function jogarVelhaMaquina(posicao) {
  if (!velhaJogoId || !velhaTabuleiro._ativo || !velhaTabuleiro._minhaVez) return;
  if (velhaTabuleiro[posicao]) return;

  try {
    var res = await fetch("./velha/mover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jogo_id: velhaJogoId, posicao: posicao }),
    });
    var dados = await res.json();
    if (!res.ok) throw new Error(dados.detail || "Erro ao jogar.");

    velhaTabuleiro = dados.tabuleiro;
    velhaTabuleiro._ativo = dados.jogo_ativo;
    velhaTabuleiro._resultado = dados.resultado;
    velhaTabuleiro._minhaVez = dados.sua_vez;
    desenharTabuleiro(velhaTabuleiro);
    atualizarVelhaVez();

    if (!dados.jogo_ativo) {
      document.querySelector("#reiniciar-velha").style.display = "";
      if (dados.resultado === "empate") {
        atualizarVelhaMensagem("Empate!", "");
      } else if (dados.resultado === velhaMinhaPeca) {
        atualizarVelhaMensagem("Você venceu! Parabéns!", "sucesso");
      } else {
        atualizarVelhaMensagem("A máquina venceu!", "erro");
      }
    } else {
      atualizarVelhaMensagem("A máquina jogou. Sua vez!");
    }
  } catch (erro) {
    atualizarVelhaMensagem(erro.message, "erro");
  }
}

async function salvarRecordVelha() {
  if (velhaModo !== "multiplayer") return;
  var nome = usuarioDiscord ? usuarioDiscord.username : "Anônimo";
  var nick = usuarioDiscord ? (usuarioDiscord.global_name || usuarioDiscord.username) : "Anônimo";
  try {
    await fetch("./velha/recordes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dificuldade: velhaDificuldade, nome: nome, nick: nick }),
    });
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Jogo da Velha — WebSocket (multiplayer + espectar)
// ---------------------------------------------------------------------------
function conectarWsVelha(sala, nome, nick, espectador) {
  if (velhaWs) {
    velhaWs.close();
    velhaWs = null;
  }

  var params = "nome=" + encodeURIComponent(nome) + "&nick=" + encodeURIComponent(nick);
  if (espectador) params += "&espectador=true";

  var protocolo = location.protocol === "https:" ? "wss:" : "ws:";
  var url = protocolo + "//" + location.host + "/ws/velha/" + sala + "?" + params;

  velhaWs = new WebSocket(url);
  velhaSala = sala;
  velhaEspectador = espectador;

  clearInterval(velhaPingTimer);
  velhaPingTimer = setInterval(function () {
    if (velhaWs && velhaWs.readyState === WebSocket.OPEN) {
      velhaWs.send(JSON.stringify({ tipo: "ping" }));
    }
  }, 20000);

  if (!espectador) {
    localStorage.setItem("velha-reconnect", JSON.stringify({
      sala: sala, nome: nome, nick: nick
    }));
  }

  velhaWs.onmessage = function (evento) {
    try {
      var dados = JSON.parse(evento.data);
      processarMensagemVelha(dados);
    } catch (e) {
      console.error("Erro ao processar mensagem WS:", e);
    }
  };

  velhaWs.onclose = function (evento) {
    clearInterval(velhaPingTimer);
    console.warn("WebSocket fechado. code=" + evento.code + " reason=" + evento.reason + " wasClean=" + evento.wasClean);

    if (velhaDonoSaiu) {
      return;
    }

    if (evento.code === 1006 && !velhaEspectador && velhaReconnectAttempts < VELHA_MAX_RECONNECT) {
      var saved = localStorage.getItem("velha-reconnect");
      if (saved) {
        velhaReconnectAttempts++;
        var info = JSON.parse(saved);
        var delay = Math.min(1000 * Math.pow(2, velhaReconnectAttempts - 1), 8000);
        atualizarVelhaMensagem("Reconectando... (" + velhaReconnectAttempts + "/" + VELHA_MAX_RECONNECT + ")");
        vezLabel.textContent = "Reconectando...";
        vezLabel.className = "indicador-vez";
        setTimeout(function () {
          conectarWsVelha(info.sala, info.nome, info.nick, false);
        }, delay);
        return;
      }
    }

    if (!velhaEspectador) {
      localStorage.removeItem("velha-reconnect");
      atualizarVelhaMensagem("Conexão perdida. (code=" + evento.code + ")", "erro");
    }
  };

  velhaWs.onerror = function (evento) {
    console.error("WebSocket erro:", evento);
    atualizarVelhaMensagem("Erro de conexão.", "erro");
  };
}

function processarMensagemVelha(dados) {
  velhaReconnectAttempts = 0;
  switch (dados.tipo) {
    case "estado":
      velhaJogoId = dados.jogo_id;
      velhaTabuleiro = dados.tabuleiro;
      velhaTabuleiro._ativo = dados.jogo_ativo;
      velhaTabuleiro._resultado = dados.resultado;
      velhaTabuleiro._minhaVez = dados.sua_vez;
      if (!velhaEspectador) velhaMinhaPeca = dados.minha_peca;
      desenharTabuleiro(velhaTabuleiro);
      atualizarVelhaVez();
      break;

    case "inicio":
      esconderCodigoSala();
      var comeca = dados.quem_comeca === velhaMinhaPeca ? "você" : dados.quem_comeca;
      atualizarVelhaMensagem(
        dados.jogador_x + " (X) vs " + dados.jogador_o + " (O) — " + comeca + " começa!"
      );
      document.querySelector("#reiniciar-velha").style.display = "none";

      break;

    case "esperando":
      velhaMinhaPeca = dados.minha_peca;
      atualizarVelhaMensagem(dados.mensagem);
      vezLabel.textContent = "Você é " + velhaMinhaPeca;
      vezLabel.className = "indicador-vez " + velhaMinhaPeca.toLowerCase();
      break;

    case "oponente_saiu reiniciando":
      limparTabuleiro();
      mostrarCodigoSala(velhaSala);
      atualizarVelhaMensagem("Oponente saiu. Aguardando novo jogador...");
      vezLabel.textContent = "Aguardando...";
      vezLabel.className = "indicador-vez";
      document.querySelector("#reiniciar-velha").style.display = "none";
      document.querySelector("#espectadores-bar").style.display = "none";
      if (velhaMinhaPeca) {
        vezLabel.textContent = "Você é " + velhaMinhaPeca;
        vezLabel.className = "indicador-vez " + velhaMinhaPeca.toLowerCase();
      }
      break;

    case "oponente_desconectou":
      localStorage.removeItem("velha-reconnect");
      velhaReconnectAttempts = VELHA_MAX_RECONNECT;
      velhaDonoSaiu = !!dados.dono_saiu;
      limparTabuleiro();
      atualizarVelhaMensagem(dados.mensagem || "Sala encerrada.", "erro");
      vezLabel.textContent = "";
      vezLabel.className = "indicador-vez";
      document.querySelector("#reiniciar-velha").style.display = "none";
      document.querySelector("#espectadores-bar").style.display = "none";
      esconderCodigoSala();

      if (velhaDonoSaiu) {
        document.querySelector("#sair-sala-velha").style.display = "none";
        setTimeout(function () {
          velhaDonoSaiu = false;
          mostrarTela(telaLobbyVelha);
        }, 1500);
      } else {
        document.querySelector("#sair-sala-velha").style.display = "";
      }
      break;

    case "espectador_entrou":
      var el = document.querySelector("#espectadores-contador");
      el.textContent = dados.total;
      document.querySelector("#espectadores-bar").style.display = "";
      break;

    case "espectador_saiu":
      var contadorEl = document.querySelector("#espectadores-contador");
      if (contadorEl) {
        var atual = parseInt(contadorEl.textContent, 10) || 1;
        contadorEl.textContent = Math.max(0, atual - 1);
      }
      break;

    case "erro":
      localStorage.removeItem("velha-reconnect");
      velhaReconnectAttempts = VELHA_MAX_RECONNECT;
      atualizarVelhaMensagem(dados.mensagem, "erro");
      break;
  }
}

async function criarSalaVelha() {
  var nome = usuarioDiscord ? usuarioDiscord.username : "Anônimo";
  var nick = usuarioDiscord ? (usuarioDiscord.global_name || usuarioDiscord.username) : "Anônimo";

  try {
    var res = await fetch("./velha/novo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modo: "multiplayer", nome: nome, nick: nick }),
    });
    var dados = await res.json();
    if (!res.ok) throw new Error(dados.detail || "Erro ao criar sala.");

    velhaModo = "multiplayer";
    velhaReconnectAttempts = 0;
    velhaSala = dados.sala;
    mostrarTela(telaVelha);
    mostrarCodigoSala(dados.sala);
    atualizarVelhaMensagem("Aguardando oponente...");
    vezLabel.textContent = "Aguardando...";
    vezLabel.className = "indicador-vez";
    document.querySelector("#reiniciar-velha").style.display = "none";
    document.querySelector("#sair-sala-velha").style.display = "";
    document.querySelector("#espectadores-bar").style.display = "none";
    limparTabuleiro();

    conectarWsVelha(dados.sala, nome, nick, false);

    if (discordSdkGlobal) {
      try {
        await discordSdkGlobal.commands.shareLink({
          message: "Entra no Jogo da Velha! Sala: " + dados.sala,
          custom_id: "velha-" + dados.sala,
        });
      } catch (e) { /* user may cancel */ }
    }
  } catch (erro) {
    atualizarVelhaMensagem(erro.message, "erro");
  }
}

function entrarSalaVelha(codigo) {
  var nome = usuarioDiscord ? usuarioDiscord.username : "Anônimo";
  var nick = usuarioDiscord ? (usuarioDiscord.global_name || usuarioDiscord.username) : "Anônimo";

  velhaModo = "multiplayer";
  velhaReconnectAttempts = 0;
  mostrarTela(telaVelha);
  esconderCodigoSala();
  atualizarVelhaMensagem("Entrando na sala...");
  vezLabel.textContent = "Entrando...";
  vezLabel.className = "indicador-vez";
  document.querySelector("#reiniciar-velha").style.display = "none";
  document.querySelector("#sair-sala-velha").style.display = "";
  document.querySelector("#espectadores-bar").style.display = "none";
  limparTabuleiro();

  conectarWsVelha(codigo, nome, nick, false);
}

// ---------------------------------------------------------------------------
// Jogo da Velha — Event listeners
// ---------------------------------------------------------------------------
casasEl.forEach(function (casa) {
  casa.addEventListener("click", function () {
    var posicao = parseInt(casa.dataset.pos, 10);
    if (velhaEspectador) return;
    if (!velhaTabuleiro._ativo) return;
    if (velhaTabuleiro[posicao]) return;

    if (velhaModo === "maquina") {
      jogarVelhaMaquina(posicao);
    } else if (velhaModo === "multiplayer" && velhaWs && velhaWs.readyState === WebSocket.OPEN) {
      velhaWs.send(JSON.stringify({ tipo: "jogar", posicao: posicao }));
    }
  });
});

document.querySelector("#criar-sala-velha").addEventListener("click", criarSalaVelha);

document.querySelector("#entrar-sala-codigo").addEventListener("click", function () {
  var codigo = document.querySelector("#codigo-sala-input").value.trim();
  if (codigo) entrarSalaVelha(codigo);
});

document.querySelector("#codigo-sala-input").addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    var codigo = this.value.trim();
    if (codigo) entrarSalaVelha(codigo);
  }
});

document.querySelector("#reiniciar-velha").addEventListener("click", function () {
  if (velhaModo === "maquina") {
    iniciarVelhaMaquina(velhaDificuldade);
  }
});

document.querySelector("#sair-sala-velha").addEventListener("click", function () {
  localStorage.removeItem("velha-reconnect");
  esconderCodigoSala();
  if (velhaWs && velhaWs.readyState === WebSocket.OPEN) {
    velhaWs.send(JSON.stringify({ tipo: "sair" }));
  }
  if (velhaWs) {
    velhaWs.close();
    velhaWs = null;
  }
  mostrarTela(telaLobbyVelha);
});

document.querySelector("#copiar-codigo").addEventListener("click", function () {
  var codigo = document.querySelector("#sala-codigo-valor").textContent;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(codigo).then(function () {
      var btn = document.querySelector("#copiar-codigo");
      btn.textContent = "Copiado!";
      btn.classList.add("copiado");
      setTimeout(function () {
        btn.textContent = "Copiar";
        btn.classList.remove("copiado");
      }, 2000);
    });
  }
});

// ---------------------------------------------------------------------------
// Event listeners — navegação
// ---------------------------------------------------------------------------
document.querySelector("#jogo-sudoku").addEventListener("click", function () {
  mostrarTela(telaDificuldade);
});

document.querySelectorAll("#tela-dificuldade .botao-dificuldade").forEach(function (botao) {
  botao.addEventListener("click", function () {
    iniciarSudoku(botao.dataset.dificuldade);
  });
});

document.querySelector("#jogo-velha").addEventListener("click", function () {
  mostrarTela(telaModoVelha);
});

document.querySelectorAll(".botao-modo").forEach(function (botao) {
  botao.addEventListener("click", function () {
    var modo = botao.dataset.modo;
    if (modo === "maquina") {
      mostrarTela(telaDificuldadeVelha);
    } else if (modo === "multiplayer") {
      mostrarTela(telaLobbyVelha);
      carregarParticipantesDiscord();
      conectarLobbyWs();
    } else if (modo === "espectar") {
      mostrarTela(telaEspectarVelha);
      conectarLobbyWs();
    }
  });
});

document.querySelectorAll("#tela-dificuldade-velha .botao-dificuldade").forEach(function (botao) {
  botao.addEventListener("click", function () {
    iniciarVelhaMaquina(botao.dataset.dificuldade);
  });
});

document.querySelectorAll(".voltar").forEach(function (botao) {
  botao.addEventListener("click", function () {
    var telaId = botao.dataset.tela;
    mostrarTela(document.querySelector("#" + telaId));
  });
});

document.querySelector("#verificar").addEventListener("click", verificarResposta);
document.querySelector("#reiniciar").addEventListener("click", function () {
  iniciarSudoku(dificuldadeAtual);
});

document.querySelector("#fechar-popup-convite").addEventListener("click", function () {
  document.querySelector("#popup-convite").classList.remove("ativo");
});

// ---------------------------------------------------------------------------
// Discord — conexão e participantes
// ---------------------------------------------------------------------------
async function carregarParticipantesDiscord() {
  var container = document.querySelector("#lista-participantes");
  if (!discordSdkGlobal) {
    container.innerHTML = '<p class="vazio">Conecte-se ao Discord para ver participantes.</p>';
    return;
  }

  try {
    var participantes = await discordSdkGlobal.commands.getInstanceConnectedParticipants();
    var lista = participantes.participants || [];
    container.innerHTML = "";

    if (lista.length === 0) {
      container.innerHTML = '<p class="vazio">Nenhum participante encontrado.</p>';
      return;
    }

    lista.forEach(function (p) {
      if (p.id === usuarioDiscord?.id) return;
      var item = document.createElement("div");
      item.className = "participante";
      var iniciais = (p.global_name || p.username || "?").charAt(0).toUpperCase();
      item.innerHTML =
        '<div class="participante-avatar">' + iniciais + "</div>" +
        '<div class="participante-info"><strong>' + (p.global_name || p.username) + "</strong>" +
        "<small>@" + p.username + "</small></div>" +
        '<button class="botao-convidar" data-user-id="' + p.id + '" data-nick="' + (p.global_name || p.username) + '">Convidar</button>';
      container.appendChild(item);
    });

    container.querySelectorAll(".botao-convidar").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var userId = btn.dataset.userId;
        try {
          await discordSdkGlobal.commands.inviteUserEmbedded({
            user_id: userId,
            content: "Vem jogar Jogo da Velha comigo!",
          });
        } catch (e) {
          try {
            await discordSdkGlobal.commands.shareLink({
              message: "Entra no Jogo da Velha!",
              custom_id: "velha-invite",
            });
          } catch (e2) { /* ignore */ }
        }
      });
    });
  } catch (erro) {
    container.innerHTML = '<p class="vazio">Não foi possível carregar participantes.</p>';
  }
}

async function conectarAoDiscord() {
  try {
    var respostaConfiguracao = await fetch("./config");
    if (!respostaConfiguracao.ok) return;
    var configuracao = await respostaConfiguracao.json();
    if (!configuracao.application_id) return;

    var mod;
    try {
      mod = await import("/sdk/npm/@discord/embedded-app-sdk/+esm");
    } catch (importErr) {
      console.warn("SDK import failed (likely not in Discord iframe):", importErr);
      return;
    }

    var DiscordSDK = mod.DiscordSDK;
    discordSdkGlobal = new DiscordSDK(configuracao.application_id);
    await discordSdkGlobal.ready();

    try {
      var opcoes = await discordSdkGlobal.commands.authenticate();
      usuarioDiscord = opcoes.user || opcoes;
      console.log("Discord user identified:", usuarioDiscord.username);
    } catch (e) {
      console.warn("Não foi possível autenticar:", e);
    }

    elementoStatus.textContent = "Conectado ao Discord";
    elementoStatus.classList.add("conectado");
    renderAuth();
  } catch (erro) {
    console.warn("A conex\u00e3o com o Discord n\u00e3o foi conclu\u00edda:", erro);
  }
}

// ---------------------------------------------------------------------------
// Compartilhar Tela - estado e presets
// ---------------------------------------------------------------------------
var telaWs = null;
var telaPingTimer = null;
var telaSala = null;
var telaEhHost = false;
var telaStream = null;
var telaPeers = {}; // host: viewer_id -> RTCPeerConnection
var telaPeerViewer = null; // viewer: 1 conexão com o host
var telaResolucao = "720p";
var telaFps = 30;
var telaOfertaTimer = null;

var TELA_PRESETS = {
  "480p": { largura: 854, altura: 480, bitrate: 800000 },
  "720p": { largura: 1280, altura: 720, bitrate: 1800000 },
  "1080p": { largura: 1920, altura: 1080, bitrate: 3600000 },
};
var RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

var telaCompartilhar = document.querySelector("#tela-compartilhar");
var telaTransmissaoEl = document.querySelector("#tela-transmissao");
var mensagemTelaEl = document.querySelector("#mensagem-tela");
var mensagemTransmissaoEl = document.querySelector("#mensagem-transmissao");
var videoTransmissaoEl = document.querySelector("#video-transmissao");

function obterInstanciaParam() {
  var params = new URLSearchParams(location.search);
  // O Discord injeta o param instance_id no iframe da Activity.
  return params.get("instancia") || params.get("instance_id") || "";
}

// Origem REAL do app. Dentro da Activity o location.origin é o proxy do
// Discord (ex.: 123.discordsays.com) — links/redirects devem apontar o site.
function appOrigin() {
  if (/\.discordsays\.com$/i.test(location.hostname)) return "https://jogos7.onrender.com";
  return location.origin;
}

// True dentro da Activity (mesmo se o SDK falhar ao carregar).
function dentroDaActivity() {
  if (discordSdkGlobal) return true;
  var params = new URLSearchParams(location.search);
  return params.has("frame_id") || params.has("instance_id");
}

function compartilharInstanciaAtual() {
  if (obterInstanciaParam()) return obterInstanciaParam();
  if (discordSdkGlobal && discordSdkGlobal.instanceId) return discordSdkGlobal.instanceId;
  return "";
}

function mensagemTela(texto, tipo) {
  mensagemTelaEl.textContent = texto;
  mensagemTelaEl.className = "mensagem" + (tipo ? " " + tipo : "");
}

function mensagemTransmissao(texto, tipo) {
  mensagemTransmissaoEl.textContent = texto;
  mensagemTransmissaoEl.className = "mensagem" + (tipo ? " " + tipo : "");
}

function bitrateEfetivo() {
  var base = TELA_PRESETS[telaResolucao].bitrate;
  return telaFps === 60 ? Math.round(base * 1.6) : base;
}

function atualizarAvisoUpload() {
  var mbpsPorEspectador = bitrateEfetivo() / 1000000;
  var total = (mbpsPorEspectador * 9).toFixed(1);
  document.querySelector("#aviso-upload").textContent =
    "Vídeo direto entre você e cada espectador (P2P). Com 9 espectadores, seu upload chega a ~" +
    total + " Mbps (" + mbpsPorEspectador.toFixed(1) + " Mbps por pessoa). Para muita gente, prefira 720p 30fps.";
}

// ---------------------------------------------------------------------------
// Compartilhar Tela - qualidade ao vivo (escala/bitrate/fps por sender)
// ---------------------------------------------------------------------------
function escalaDePreset() {
  var preset = TELA_PRESETS[telaResolucao];
  var tr = telaStream ? telaStream.getVideoTracks()[0] : null;
  var s = tr && tr.getSettings ? tr.getSettings() : {};
  var altura = s.height || preset.altura;
  return Math.max(1, Math.round(altura / preset.altura));
}

function aplicarParamsSender(sender) {
  if (!sender || !sender.getParameters) return;
  var params = sender.getParameters();
  params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
  params.encodings[0].maxBitrate = bitrateEfetivo();
  params.encodings[0].maxFramerate = telaFps;
  params.encodings[0].scaleResolutionDownBy = escalaDePreset();
  var r = sender.setParameters(params);
  if (r && r.catch) r.catch(function () {});
}

function aplicarQualidadeNosViewers() {
  if (!telaEhHost || !telaStream) return;
  Object.keys(telaPeers).forEach(function (id) {
    telaPeers[id].getSenders().forEach(function (sender) {
      if (sender.track && sender.track.kind === "video") aplicarParamsSender(sender);
    });
  });
  enviarTela({ tipo: "config", resolucao: telaResolucao, fps: telaFps });
}

function definirResolucao(valor) {
  telaResolucao = valor;
  ["#preset-resolucao", "#live-resolucao"].forEach(function (sel) {
    document.querySelectorAll(sel + " .botao-preset").forEach(function (b) {
      b.classList.toggle("selecionado", b.dataset.resolucao === valor);
    });
  });
  atualizarAvisoUpload();
  if (telaEhHost && telaStream) {
    aplicarQualidadeNosViewers();
    mensagemTransmissao("Qualidade alterada: " + telaResolucao + " " + telaFps + "fps.", "sucesso");
  }
}

function definirFps(valor) {
  telaFps = valor;
  ["#preset-fps", "#live-fps"].forEach(function (sel) {
    document.querySelectorAll(sel + " .botao-preset").forEach(function (b) {
      b.classList.toggle("selecionado", parseInt(b.dataset.fps, 10) === valor);
    });
  });
  atualizarAvisoUpload();
  if (telaEhHost && telaStream) {
    aplicarQualidadeNosViewers();
    mensagemTransmissao("Qualidade alterada: " + telaResolucao + " " + telaFps + "fps.", "sucesso");
  }
}

// Pede nova captura (o seletor do navegador permite trocar o programa/janela)
// e troca a track ao vivo sem derrubar as conexões WebRTC.
async function trocarJanelaTela() {
  if (!telaEhHost || !telaStream) return;
  var preset = TELA_PRESETS[telaResolucao];
  var novo;
  try {
    novo = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: preset.largura },
        height: { ideal: preset.altura },
        frameRate: { ideal: telaFps, max: telaFps },
      },
      audio: false,
    });
  } catch (e) {
    mensagemTransmissao("Troca de programa/janela cancelada.");
    return;
  }

  var novaTrack = novo.getVideoTracks()[0];
  var antiga = telaStream;
  var trocas = [];

  Object.keys(telaPeers).forEach(function (id) {
    telaPeers[id].getSenders().forEach(function (sender) {
      if (sender.track && sender.track.kind === "video") {
        var p = sender.replaceTrack(novaTrack);
        if (p && p.then) trocas.push(p);
      }
    });
  });

  function concluir() {
    antiga.getTracks().forEach(function (t) { t.stop(); });
    telaStream = novo;
    videoTransmissaoEl.srcObject = novo;
    novaTrack.addEventListener("ended", function () {
      encerrarTransmissao(false);
      mensagemTela("Transmissão encerrada: você parou a captura de tela.", "erro");
    });
    aplicarQualidadeNosViewers();
    mensagemTransmissao("Programa/janela trocado. Qualidade " + telaResolucao + " " + telaFps + "fps.", "sucesso");
  }

  if (trocas.length === 0) {
    concluir();
  } else {
    Promise.all(trocas).then(concluir).catch(function (erro) {
      console.warn("replaceTrack falhou, recriando conexões:", erro);
      concluir();
      Object.keys(telaPeers).forEach(function (id) {
        criarPeerParaViewer(id, false);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Compartilhar Tela - hub
// ---------------------------------------------------------------------------
function abrirTelaCompartilhar() {
  mostrarTela(telaCompartilhar);
  mensagemTela("");
  var naActivity = dentroDaActivity();
  document.querySelector("#tela-aviso-navegador").style.display = naActivity ? "" : "none";
  document.querySelector("#tela-config-host").style.display = naActivity ? "none" : "";
  document.querySelector("#abrir-navegador-tela").style.display = "";

  // Lista é privada: só existe para quem tem a instância da call. Sem ela,
  // quem está fora entra apenas com o código.
  var temInstancia = !!compartilharInstanciaAtual();
  document.querySelector("#lista-transmissoes").style.display = temInstancia ? "" : "none";
  document.querySelector("#atualizar-transmissoes").style.display = temInstancia ? "" : "none";
  document.querySelector("#assistir-titulo-lista").style.display = temInstancia ? "" : "none";

  atualizarAvisoUpload();
  if (temInstancia) carregarTransmissoes();
  else document.querySelector("#lista-transmissoes").innerHTML = '<p class="vazio">Nenhuma transmissão ativa.</p>';
}

async function abrirNoNavegadorParaTransmitir() {
  // Sempre o site real: dentro da Activity location.origin é o proxy do
  // Discord (discordsays.com) e o WS do host pode não funcionar por lá.
  var url = appOrigin() + "/?transmitir=1";
  var instancia = compartilharInstanciaAtual();
  if (instancia) url += "&instancia=" + encodeURIComponent(instancia);

  if (discordSdkGlobal) {
    try {
      await discordSdkGlobal.commands.openExternalLink({ url: url });
      return;
    } catch (e) { /* fallback abaixo */ }
  }
  window.open(url, "_blank");
}

async function carregarTransmissoes() {
  var container = document.querySelector("#lista-transmissoes");
  var url = "./tela/transmissoes";
  var instancia = compartilharInstanciaAtual();
  if (instancia) url += "?instancia=" + encodeURIComponent(instancia);

  try {
    var res = await fetch(url);
    var dados = await res.json();
    var lista = dados.transmissoes || [];
    container.innerHTML = "";

    if (lista.length === 0) {
      container.innerHTML = '<p class="vazio">Nenhuma transmissão ativa.</p>';
      return;
    }

    lista.forEach(function (t) {
      var item = document.createElement("div");
      item.className = "sala-item";
      item.innerHTML =
        '<div class="sala-item-info">' +
        "<strong>" + t.nick + "</strong>" +
        "<small>" + t.resolucao + " &middot; " + t.fps + " fps &middot; sala " + t.sala + "</small>" +
        "</div>" +
        '<span class="sala-item-jogadores">&#128247; ' + t.espectadores + "/9</span>";
      item.addEventListener("click", function () {
        assistirTransmissao(t.sala);
      });
      container.appendChild(item);
    });
  } catch (e) {
    container.innerHTML = '<p class="vazio">Erro ao carregar transmissões.</p>';
  }
}

// ---------------------------------------------------------------------------
// Compartilhar Tela - host
// ---------------------------------------------------------------------------
async function iniciarTransmissaoTela() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    mensagemTela("Seu navegador não suporta captura de tela.", "erro");
    return;
  }

  var codigoCustom = (document.querySelector("#codigo-custom-input").value || "").trim().toLowerCase();
  if (codigoCustom && !/^[a-z0-9_-]{3,16}$/.test(codigoCustom)) {
    mensagemTela("Código da sala: use de 3 a 16 caracteres (letras, números, - ou _).", "erro");
    return;
  }

  var preset = TELA_PRESETS[telaResolucao];
  try {
    telaStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: preset.largura },
        height: { ideal: preset.altura },
        frameRate: { ideal: telaFps, max: telaFps },
      },
      audio: false,
    });
  } catch (e) {
    mensagemTela("Captura cancelada ou negada.", "erro");
    return;
  }

  var nick = usuarioDiscord ? (usuarioDiscord.global_name || usuarioDiscord.username) : "Anônimo";
  var instancia = compartilharInstanciaAtual() || null;

  try {
    var res = await fetch("./tela/novo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instancia: instancia, nick: nick, resolucao: telaResolucao, fps: telaFps, codigo: codigoCustom || null }),
    });
    var dados = await res.json();
    if (!res.ok) throw new Error(dados.detail || "Erro ao criar transmissão.");
    telaSala = dados.sala;
  } catch (e) {
    telaStream.getTracks().forEach(function (t) { t.stop(); });
    telaStream = null;
    mensagemTela(e.message, "erro");
    return;
  }

  telaEhHost = true;
  configurarTelaTransmissaoHost();
  conectarWsTela(true);

  // Se o usuário parar a captura pelo botão do próprio navegador, encerra tudo.
  telaStream.getVideoTracks()[0].addEventListener("ended", function () {
    encerrarTransmissao(false);
    mensagemTela("Transmissão encerrada: você parou a captura de tela.", "erro");
  });
}

function configurarTelaTransmissaoHost() {
  mostrarTela(telaTransmissaoEl);
  mensagemTransmissao("Você está transmitindo em " + telaResolucao + " " + telaFps + "fps.", "sucesso");
  document.querySelector("#transmissao-papel").textContent = "Transmitindo";
  document.querySelector("#transmissao-codigo-valor").textContent = telaSala;
  document.querySelector("#transmissao-codigo-display").style.display = "";
  document.querySelector("#transmissao-viewers-contador").textContent = "0";
  document.querySelector("#transmissao-viewers-bar").style.display = "";
  document.querySelector("#encerrar-transmissao").style.display = "";
  document.querySelector("#parar-assistir").style.display = "none";
  document.querySelector("#transmissao-qualidade").style.display = "";
  document.querySelectorAll("#live-resolucao .botao-preset").forEach(function (b) {
    b.classList.toggle("selecionado", b.dataset.resolucao === telaResolucao);
  });
  document.querySelectorAll("#live-fps .botao-preset").forEach(function (b) {
    b.classList.toggle("selecionado", parseInt(b.dataset.fps, 10) === telaFps);
  });
  videoTransmissaoEl.muted = true;
  videoTransmissaoEl.srcObject = telaStream;
}

function criarPeerParaViewer(viewerId, contaViewers) {
  if (telaPeers[viewerId]) {
    telaPeers[viewerId].close();
    delete telaPeers[viewerId];
  }

  var pc = new RTCPeerConnection(RTC_CONFIG);
  telaPeers[viewerId] = pc;

  telaStream.getTracks().forEach(function (track) {
    pc.addTrack(track, telaStream);
  });

  var sender = pc.getSenders().filter(function (s) { return s.track && s.track.kind === "video"; })[0];
  aplicarParamsSender(sender);

  pc.onicecandidate = function (evento) {
    if (evento.candidate) {
      enviarTela({ tipo: "ice", viewer_id: viewerId, dados: evento.candidate.toJSON() });
    }
  };

  pc.onconnectionstatechange = function () {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      if (telaPeers[viewerId]) {
        delete telaPeers[viewerId];
        atualizarContadorViewers(-1);
      }
    }
  };

  pc.createOffer()
    .then(function (oferta) { return pc.setLocalDescription(oferta); })
    .then(function () {
      enviarTela({ tipo: "oferta", viewer_id: viewerId, dados: pc.localDescription.sdp });
    })
    .catch(function (e) { console.warn("Falha ao criar oferta:", e); });

  if (contaViewers !== false) atualizarContadorViewers(1);
}

function atualizarContadorViewers(delta) {
  var el = document.querySelector("#transmissao-viewers-contador");
  var atual = parseInt(el.textContent, 10) || 0;
  el.textContent = Math.max(0, atual + delta);
}

function encerrarTransmissao(silencioso) {
  limparConexaoTela();
  telaSala = null;
  if (telaEhHost && telaStream) {
    telaStream.getTracks().forEach(function (t) { t.stop(); });
  }
  telaStream = null;
  telaEhHost = false;
  videoTransmissaoEl.srcObject = null;
  document.querySelector("#transmissao-codigo-display").style.display = "none";
  document.querySelector("#transmissao-viewers-bar").style.display = "none";
  document.querySelector("#transmissao-qualidade").style.display = "none";
  if (!silencioso) {
    mostrarTela(telaCompartilhar);
    carregarTransmissoes();
  }
}

// ---------------------------------------------------------------------------
// Compartilhar Tela - espectador
// ---------------------------------------------------------------------------
async function assistirTransmissao(codigo) {
  codigo = (codigo || "").trim();
  if (!codigo) return;

  try {
    var res = await fetch("./tela/sala/" + encodeURIComponent(codigo));
    if (!res.ok) throw new Error("Transmissão não encontrada.");
  } catch (e) {
    mensagemTela(e.message === "Failed to fetch" ? "Erro de conexão." : e.message, "erro");
    return;
  }

  telaEhHost = false;
  telaSala = codigo;
  mostrarTela(telaTransmissaoEl);
  mensagemTransmissao("Conectando à transmissão...");
  document.querySelector("#transmissao-papel").textContent = "Assistindo";
  document.querySelector("#transmissao-codigo-display").style.display = "none";
  document.querySelector("#transmissao-viewers-bar").style.display = "none";
  document.querySelector("#encerrar-transmissao").style.display = "none";
  document.querySelector("#parar-assistir").style.display = "";
  document.querySelector("#transmissao-qualidade").style.display = "none";
  videoTransmissaoEl.srcObject = null;
  conectarWsTela(false);
}

function processarOfertaHost(sdp) {
  clearTimeout(telaOfertaTimer);
  if (telaPeerViewer) {
    telaPeerViewer.close();
  }

  var pc = new RTCPeerConnection(RTC_CONFIG);
  telaPeerViewer = pc;

  pc.ontrack = function (evento) {
    videoTransmissaoEl.srcObject = evento.streams[0];
    var promessa = videoTransmissaoEl.play();
    if (promessa && promessa.then) {
      promessa.then(function () {
        mensagemTransmissao("Recebendo vídeo de quem transmite.", "sucesso");
      }).catch(function () {
        mensagemTransmissao("Vídeo recebido — clique no player para começar a assistir.");
      });
    }
  };

  pc.onicecandidate = function (evento) {
    if (evento.candidate) {
      enviarTela({ tipo: "ice", dados: evento.candidate.toJSON() });
    }
  };

  pc.onconnectionstatechange = function () {
    if (pc.connectionState === "failed") {
      mensagemTransmissao("Falha de conexão P2P com quem transmite.", "erro");
    }
  };

  pc.setRemoteDescription({ type: "offer", sdp: sdp })
    .then(function () { return pc.createAnswer(); })
    .then(function (resposta) { return pc.setLocalDescription(resposta); })
    .then(function () {
      enviarTela({ tipo: "resposta", dados: pc.localDescription.sdp });
    })
    .catch(function (e) {
      console.warn("Falha ao responder oferta:", e);
      mensagemTransmissao("Erro ao conectar na transmissão.", "erro");
    });
}

function pararDeAssistir() {
  limparConexaoTela();
  telaSala = null;
  telaEhHost = false;
  videoTransmissaoEl.srcObject = null;
  mostrarTela(telaCompartilhar);
  carregarTransmissoes();
}

// ---------------------------------------------------------------------------
// Compartilhar Tela - WebSocket de sinalização
// ---------------------------------------------------------------------------
var telaAbriu = false;
var telaTentativa = 1;
var TELA_MAX_TENTATIVAS = 3;

function enviarTela(obj) {
  if (telaWs && telaWs.readyState === WebSocket.OPEN) {
    telaWs.send(JSON.stringify(obj));
  }
}

function conectarWsTela(host, tentativa) {
  limparConexaoTela(); // não mexe em telaSala — quem chama já definiu a sala
  telaAbriu = false;
  telaTentativa = tentativa || 1;

  var nick = usuarioDiscord ? (usuarioDiscord.global_name || usuarioDiscord.username) : "Anônimo";
  var protocolo = location.protocol === "https:" ? "wss:" : "ws:";
  var url = protocolo + "//" + location.host + "/ws/tela/" + encodeURIComponent(telaSala) +
    "?papel=" + (host ? "host" : "viewer") + "&nick=" + encodeURIComponent(nick);

  var ws = new WebSocket(url);
  telaWs = ws;

  clearInterval(telaPingTimer);
  telaPingTimer = setInterval(function () {
    enviarTela({ tipo: "ping" });
  }, 20000);

  ws.onopen = function () {
    telaAbriu = true;
    if (telaTentativa > 1) {
      mensagemTransmissao(host ? "Reconectado ao servidor." : "Reconectado. Recebendo transmissão...", "sucesso");
    }
  };

  ws.onmessage = function (evento) {
    try {
      processarMensagemTela(JSON.parse(evento.data));
    } catch (e) {
      console.error("Erro ao processar mensagem da tela:", e);
    }
  };

  ws.onclose = function (evento) {
    if (ws !== telaWs) return; // conexão já substituída/desligada de propósito
    clearInterval(telaPingTimer);
    if (!telaSala) return;
    console.warn("WS tela fechado: code=" + evento.code + " abriu=" + telaAbriu);

    // Nunca chegou a abrir: pode ser instância acordando/proxy — tenta de novo.
    if (!telaAbriu && telaTentativa < TELA_MAX_TENTATIVAS) {
      mensagemTransmissao("Reconectando ao servidor... (" + telaTentativa + "/" + TELA_MAX_TENTATIVAS + ")");
      setTimeout(function () {
        if (telaSala) conectarWsTela(host, telaTentativa + 1);
      }, 1500 * telaTentativa);
      return;
    }

    if (host) {
      encerrarTransmissao(true);
      mensagemTela(telaAbriu
        ? "Conexão com o servidor foi encerrada."
        : "Não foi possível conectar ao servidor. Tente novamente.", "erro");
      mostrarTela(telaCompartilhar);
      carregarTransmissoes();
    } else {
      encerrarViewerTela(telaAbriu
        ? "Conexão com o servidor foi encerrada."
        : "Não foi possível conectar ao servidor. Tente novamente.");
    }
  };

  ws.onerror = function () {};
}

// Fecha a conexão do espectador mostrando o erro sem voltar de tela antes da
// hora (o onclose é ignorado porque limparConexaoTela desliga os handlers).
function encerrarViewerTela(mensagem) {
  limparConexaoTela();
  telaSala = null;
  telaEhHost = false;
  document.querySelector("#parar-assistir").style.display = "none";
  document.querySelector("#encerrar-transmissao").style.display = "none";
  if (mensagem) mensagemTransmissao(mensagem, "erro");
}

function processarMensagemTela(dados) {
  switch (dados.tipo) {
    case "entrada_ok":
      mensagemTransmissao("Conectado a " + dados.nick + " (" + dados.resolucao + " " + dados.fps + "fps). Aguardando vídeo...", "sucesso");
      clearTimeout(telaOfertaTimer);
      if (!telaEhHost) {
        telaOfertaTimer = setTimeout(async function () {
          if (telaEhHost || !telaSala || telaPeerViewer) return;
          var codigo = telaSala;
          try {
            var res = await fetch("./tela/sala/" + encodeURIComponent(codigo));
            if (res.status === 404) {
              encerrarViewerTela("A transmissão foi encerrada (sala " + codigo + ").");
              return;
            }
            var info = await res.json();
            if (info.host_conectado === false) {
              mensagemTransmissao("Quem transmite não está conectado ao servidor. Peça para ele abrir a transmissão de novo (sala " + codigo + ").", "erro");
            } else {
              mensagemTransmissao("Conectado ao servidor, mas o vídeo ainda não chegou. Confirme que quem transmite está transmitindo (sala " + codigo + ").", "erro");
            }
          } catch (e) {
            mensagemTransmissao("Conectado ao servidor, mas o vídeo ainda não chegou (sala " + codigo + ").", "erro");
          }
        }, 12000);
      }
      break;
    case "aguardando_host":
      mensagemTransmissao("Aguardando quem transmite conectar...");
      break;
    case "host_pronto":
      break;
    case "viewer_entrou":
      if (telaEhHost) criarPeerParaViewer(dados.viewer_id);
      break;
    case "viewer_saiu":
      if (telaEhHost && telaPeers[dados.viewer_id]) {
        telaPeers[dados.viewer_id].close();
        delete telaPeers[dados.viewer_id];
        atualizarContadorViewers(-1);
      }
      break;
    case "oferta":
      if (!telaEhHost) processarOfertaHost(dados.dados);
      break;
    case "resposta":
      if (telaEhHost && telaPeers[dados.viewer_id]) {
        telaPeers[dados.viewer_id].setRemoteDescription({ type: "answer", sdp: dados.dados })
          .catch(function (e) { console.warn("Falha ao aplicar resposta:", e); });
      }
      break;
    case "ice":
      if (telaEhHost && telaPeers[dados.viewer_id]) {
        telaPeers[dados.viewer_id].addIceCandidate(dados.dados).catch(function () {});
      } else if (!telaEhHost && telaPeerViewer) {
        telaPeerViewer.addIceCandidate(dados.dados).catch(function () {});
      }
      break;
    case "transmissao_encerrada":
      // O host saiu: a sala foi fechada — derruba o espectador.
      if (telaPeerViewer) {
        limparConexaoTela();
        telaPeerViewer = null;
      }
      videoTransmissaoEl.srcObject = null;
      mensagemTransmissao("A transmissão foi encerrada" +
        (dados.motivo === "host_saiu" ? ": quem transmitiu saiu." : "."), "erro");
      setTimeout(function () {
        telaSala = null;
        mostrarTela(telaCompartilhar);
        carregarTransmissoes();
      }, 2500);
      break;
    case "erro":
      // O servidor vai fechar a conexão: desliga os handlers ANTES para o
      // onclose não sobrescrever esta mensagem.
      if (telaEhHost) {
        encerrarTransmissao(true);
        mensagemTela(dados.mensagem, "erro");
        mostrarTela(telaCompartilhar);
        carregarTransmissoes();
      } else {
        encerrarViewerTela(dados.mensagem);
      }
      break;
  }
}

function limparConexaoTela() {
  clearTimeout(telaOfertaTimer);
  if (telaWs) {
    var ws = telaWs;
    telaWs = null;
    clearInterval(telaPingTimer);
    // Desliga os handlers ANTES de fechar: fechações propositais não devem
    // disparar a lógica de onclose (senão derrubam a nova conexão).
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try { ws.send(JSON.stringify({ tipo: "sair" })); } catch (e) { /* ignore */ }
    try { ws.close(); } catch (e) { /* ignore */ }
  }
  Object.keys(telaPeers).forEach(function (id) {
    telaPeers[id].close();
  });
  telaPeers = {};
  if (telaPeerViewer) {
    telaPeerViewer.close();
    telaPeerViewer = null;
  }
}

// ---------------------------------------------------------------------------
// Compartilhar Tela - event listeners
// ---------------------------------------------------------------------------
document.querySelector("#jogo-tela").addEventListener("click", abrirTelaCompartilhar);

document.querySelector("#abrir-navegador-tela").addEventListener("click", abrirNoNavegadorParaTransmitir);

document.querySelectorAll("#preset-resolucao .botao-preset, #live-resolucao .botao-preset").forEach(function (botao) {
  botao.addEventListener("click", function () {
    definirResolucao(botao.dataset.resolucao);
  });
});

document.querySelectorAll("#preset-fps .botao-preset, #live-fps .botao-preset").forEach(function (botao) {
  botao.addEventListener("click", function () {
    definirFps(parseInt(botao.dataset.fps, 10));
  });
});

document.querySelector("#iniciar-transmissao").addEventListener("click", iniciarTransmissaoTela);

document.querySelector("#trocar-janela").addEventListener("click", trocarJanelaTela);

// Atualiza a lista da call automaticamente enquanto a hub está aberta.
setInterval(function () {
  if (telaCompartilhar && telaCompartilhar.classList.contains("ativa") && compartilharInstanciaAtual()) {
    carregarTransmissoes();
  }
}, 10000);

document.querySelector("#atualizar-transmissoes").addEventListener("click", carregarTransmissoes);

document.querySelector("#assistir-codigo").addEventListener("click", function () {
  assistirTransmissao(document.querySelector("#codigo-tela-input").value);
});

document.querySelector("#codigo-tela-input").addEventListener("keydown", function (e) {
  if (e.key === "Enter") assistirTransmissao(this.value);
});

document.querySelector("#encerrar-transmissao").addEventListener("click", function () {
  encerrarTransmissao(false);
});

document.querySelector("#parar-assistir").addEventListener("click", pararDeAssistir);

document.querySelector("#copiar-link-tela").addEventListener("click", function () {
  var botao = this;
  if (navigator.clipboard && telaSala) {
    navigator.clipboard.writeText(location.origin + "/?sala=" + telaSala).then(function () {
      botao.textContent = "Link copiado!";
      setTimeout(function () { botao.textContent = "Copiar link"; }, 2000);
    });
  }
});

document.querySelector("#voltar-transmissao").addEventListener("click", function () {
  if (telaEhHost) {
    encerrarTransmissao(true);
  } else {
    pararDeAssistir();
  }
});

document.querySelector("#copiar-codigo-tela").addEventListener("click", function () {
  var botao = this;
  if (navigator.clipboard && telaSala) {
    navigator.clipboard.writeText(telaSala).then(function () {
      botao.textContent = "Copiado!";
      botao.classList.add("copiado");
      setTimeout(function () {
        botao.textContent = "Copiar";
        botao.classList.remove("copiado");
      }, 2000);
    });
  }
});

// ---------------------------------------------------------------------------
// Discord OAuth2 - login no site (modo navegador)
// ---------------------------------------------------------------------------
function estadoDiscord() {
  try {
    return JSON.parse(localStorage.getItem("usuario-discord") || "null");
  } catch (e) {
    return null;
  }
}

function salvarSessaoDiscord(sessao) {
  localStorage.setItem("usuario-discord", JSON.stringify(sessao));
  usuarioDiscord = sessao.user;
  renderAuth();
}

function limparSessaoDiscord() {
  localStorage.removeItem("usuario-discord");
  usuarioDiscord = null;
  renderAuth();
}

function avatarUrlDiscord(user) {
  if (user && user.avatar) {
    return "https://cdn.discordapp.com/avatars/" + user.id + "/" + user.avatar + ".png?size=64";
  }
  return "https://cdn.discordapp.com/embed/avatars/" + ((user ? parseInt(user.discriminator || "0", 10) : 0) % 6) + ".png";
}

function renderAuth() {
  var botaoLogin = document.querySelector("#btn-login-discord");
  var caixa = document.querySelector("#auth-usuario");
  if (!botaoLogin || !caixa) return;

  if (usuarioDiscord) {
    botaoLogin.style.display = "none";
    caixa.style.display = "";
    var avatar = document.querySelector("#auth-avatar");
    avatar.onerror = function () {
      this.onerror = null;
      this.src = "https://cdn.discordapp.com/embed/avatars/0.png";
    };
    avatar.src = avatarUrlDiscord(usuarioDiscord);
    document.querySelector("#auth-nome").textContent =
      usuarioDiscord.global_name || usuarioDiscord.username;
    // Na Activity a identidade vem do SDK — logout local não faria sentido.
    document.querySelector("#btn-logout-discord").style.display = dentroDaActivity() ? "none" : "";
  } else {
    caixa.style.display = "none";
    botaoLogin.style.display = dentroDaActivity() ? "none" : "";
  }
}

async function iniciarLoginDiscord() {
  try {
    var res = await fetch("./config");
    var config = await res.json();
    if (!config.application_id) throw new Error("application_id ausente.");

    var state = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : String(Math.random()).slice(2) + String(Math.random()).slice(2);
    sessionStorage.setItem("oauth-state", state);

    // redirect_uri canônico: precisa existir nos Redirects do portal e ser
    // idêntico no authorize E na troca do code pelo token.
    var redirect = config.redirect_uri || (appOrigin() + "/auth/callback");
    sessionStorage.setItem("oauth-redirect", redirect);

    var url = "https://discord.com/api/oauth2/authorize?" + new URLSearchParams({
      client_id: config.application_id,
      response_type: "code",
      redirect_uri: redirect,
      scope: "identify",
      state: state,
    });
    location.href = url;
  } catch (e) {
    console.warn("Falha ao iniciar login:", e);
    abrirTelaCompartilhar();
    mensagemTela("Não foi possível iniciar o login com o Discord.", "erro");
  }
}

async function processarCallbackOAuth() {
  var params = new URLSearchParams(location.search);
  var code = params.get("code");
  if (!code) return;

  var state = params.get("state");
  var guardado = sessionStorage.getItem("oauth-state");
  var redirectGuardado = sessionStorage.getItem("oauth-redirect") || (appOrigin() + "/auth/callback");
  sessionStorage.removeItem("oauth-state");
  sessionStorage.removeItem("oauth-redirect");
  history.replaceState({}, "", "/");

  if (!state || !guardado || state !== guardado) {
    console.warn("OAuth: state inválido.");
    abrirTelaCompartilhar();
    mensagemTela("Login cancelado (verificação de segurança falhou).", "erro");
    return;
  }

  try {
    var res = await fetch("./token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code, redirect_uri: redirectGuardado }),
    });
    var token = await res.json();
    if (!res.ok) throw new Error(token.detail || "Falha ao trocar o código.");

    var me = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: "Bearer " + token.access_token },
    });
    if (!me.ok) throw new Error("Falha ao obter o perfil.");
    var user = await me.json();

    salvarSessaoDiscord({
      user: user,
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      obtido_em: Date.now(),
    });
    console.log("Login Discord ok:", user.username);
  } catch (e) {
    console.warn("OAuth callback falhou:", e);
    abrirTelaCompartilhar();
    mensagemTela("Não foi possível concluir o login: " + e.message, "erro");
  }
}

async function restaurarSessaoDiscord() {
  var sessao = estadoDiscord();
  if (!sessao) return;

  // Tokens do Discord expiram em ~7 dias; renova a partir do 6º.
  var idade = Date.now() - (sessao.obtido_em || 0);
  if (sessao.refresh_token && idade > 6 * 24 * 60 * 60 * 1000) {
    try {
      var res = await fetch("./token/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: sessao.refresh_token }),
      });
      if (res.ok) {
        var novo = await res.json();
        sessao.access_token = novo.access_token || sessao.access_token;
        sessao.refresh_token = novo.refresh_token || sessao.refresh_token;
        sessao.obtido_em = Date.now();
        salvarSessaoDiscord(sessao);
      }
    } catch (e) { /* mantém a sessão atual */ }
  }

  usuarioDiscord = sessao.user;
  renderAuth();
}

document.querySelector("#btn-login-discord").addEventListener("click", iniciarLoginDiscord);
document.querySelector("#btn-logout-discord").addEventListener("click", limparSessaoDiscord);

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------
window.addEventListener("error", function (e) {
  console.error("Erro global:", e.message, e.filename, e.lineno);
});

window.addEventListener("unhandledrejection", function (e) {
  console.error("Promise rejeitada:", e.reason);
});

carregarHistorico();
conectarAoDiscord();

// Sessão OAuth + links diretos: ?transmitir=1&instancia=... (gerado pelo
// botão da Activity), ?sala=<codigo> (espectador) e /auth/callback?code=...
(function () {
  restaurarSessaoDiscord().then(function () {
    renderAuth();
    return processarCallbackOAuth();
  }).then(function () {
    var params = new URLSearchParams(location.search);
    var salaCompartilhada = params.get("sala");
    var querTransmitir = params.get("transmitir") === "1";

    if (salaCompartilhada) {
      abrirTelaCompartilhar();
      assistirTransmissao(salaCompartilhada);
    } else if (querTransmitir) {
      abrirTelaCompartilhar();
    }
  });
})();

// Auto-reconnect after Discord iframe reload
(function () {
  var saved = localStorage.getItem("velha-reconnect");
  if (saved) {
    try {
      var info = JSON.parse(saved);
      if (info.sala && info.nome && info.nick) {
        console.log("Auto-reconectando à sala:", info.sala);
        velhaModo = "multiplayer";
        mostrarTela(telaVelha);
        mostrarCodigoSala(info.sala);
        atualizarVelhaMensagem("Reconectando...");
        vezLabel.textContent = "Reconectando...";
        vezLabel.className = "indicador-vez";
        document.querySelector("#reiniciar-velha").style.display = "none";
        document.querySelector("#sair-sala-velha").style.display = "";
        document.querySelector("#espectadores-bar").style.display = "none";
        limparTabuleiro();
        velhaReconnectAttempts = 1;
        setTimeout(function () {
          conectarWsVelha(info.sala, info.nome, info.nick, false);
        }, 1500);
      }
    } catch (e) {
      localStorage.removeItem("velha-reconnect");
    }
  }
})();
