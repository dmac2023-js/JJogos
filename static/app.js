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
let lobbyWs = null;

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

  lobbyWs.onmessage = function (evento) {
    var dados = JSON.parse(evento.data);
    if (dados.tipo === "salas_atualizadas") {
      renderizarSalasLobby(dados.salas);
      renderizarSalasEspectacao(dados.salas);
    }
  };

  lobbyWs.onclose = function () {
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

  velhaWs.onmessage = function (evento) {
    try {
      var dados = JSON.parse(evento.data);
      processarMensagemVelha(dados);
    } catch (e) {
      console.error("Erro ao processar mensagem WS:", e);
    }
  };

  velhaWs.onclose = function (evento) {
    console.warn("WebSocket fechado. code=" + evento.code + " reason=" + evento.reason + " wasClean=" + evento.wasClean);
    if (!velhaEspectador) {
      atualizarVelhaMensagem("Conexão perdida. (code=" + evento.code + ")", "erro");
    }
  };

  velhaWs.onerror = function (evento) {
    console.error("WebSocket erro:", evento);
    atualizarVelhaMensagem("Erro de conexão.", "erro");
  };
}

function processarMensagemVelha(dados) {
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
      limparTabuleiro();
      atualizarVelhaMensagem("Sala encerrada.", "erro");
      vezLabel.textContent = "";
      vezLabel.className = "indicador-vez";
      document.querySelector("#reiniciar-velha").style.display = "none";

      document.querySelector("#sair-sala-velha").style.display = "";
      document.querySelector("#espectadores-bar").style.display = "none";
      esconderCodigoSala();
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
      var opcoes = await discordSdkGlobal.commands.getUser({ id: discordSdkGlobal.applicationId });
      usuarioDiscord = opcoes;
    } catch (e) {
      try {
        var opcoes2 = await discordSdkGlobal.commands.authenticate();
        usuarioDiscord = opcoes2;
      } catch (e2) {
        console.warn("Não foi possível obter dados do usuário:", e2);
      }
    }

    elementoStatus.textContent = "Conectado ao Discord";
    elementoStatus.classList.add("conectado");
  } catch (erro) {
    console.warn("A conexão com o Discord não foi concluída:", erro);
  }
}

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
