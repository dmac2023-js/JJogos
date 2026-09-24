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
// Identidade Discord (site OAuth + Activity SDK) — evita "Anônimo" por corrida
// ---------------------------------------------------------------------------
var conexaoDiscordPromise = null;

function escapeHtml(texto) {
  return String(texto == null ? "" : texto)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function nomeExibicao() {
  if (!usuarioDiscord) return "Anônimo";
  return usuarioDiscord.global_name || usuarioDiscord.username;
}

function nomeUsuario() {
  return usuarioDiscord ? usuarioDiscord.username : "Anônimo";
}

function avatarAtual() {
  if (!usuarioDiscord) return null;
  try { return avatarUrlDiscord(usuarioDiscord); } catch (e) { return null; }
}

/** Espera a identidade (OAuth no site, SDK na Activity) antes de criar sala.
 *  Timeout curto: na Activity o SDK pode demorar — nunca trava o botão. */
async function garantirIdentidade() {
  if (usuarioDiscord) return usuarioDiscord;
  try {
    var cru = localStorage.getItem("usuario-discord");
    if (cru) {
      await Promise.race([
        restaurarSessaoDiscord(),
        new Promise(function (r) { setTimeout(r, 1200); }),
      ]);
      if (usuarioDiscord) return usuarioDiscord;
    }
  } catch (e) { /* ignore */ }
  if (dentroDaActivity()) {
    // OAuth completo (authorize+token+@me) pode levar ~2-4s — dá tempo real.
    for (var i = 0; i < 3 && !usuarioDiscord; i++) {
      try {
        await Promise.race([
          conectarAoDiscord(),
          new Promise(function (r) { setTimeout(r, 4000); }),
        ]);
      } catch (e) { /* segue sem identidade */ }
      if (!usuarioDiscord) {
        await new Promise(function (r) { setTimeout(r, 250); });
      }
    }
  }
  return usuarioDiscord;
}

// ---------------------------------------------------------------------------
// Navegação entre telas
// ---------------------------------------------------------------------------
function mostrarTela(tela) {
  todasTelas.forEach((item) => item.classList.remove("ativa"));
  tela.classList.add("ativa");
  if (!tela || tela.id !== "tela-transmissao") {
    document.body.classList.remove("modo-cheia-transmissao");
  }
  // Sai da multi se o usuário navegar para outra tela sem usar o botão Sair.
  // (sairSalaMulti limpa os flags ANTES de chamar mostrarTela de novo.)
  if (multiNaTela && tela && tela.id !== "tela-multitela") {
    multiNaTela = false;
    sairSalaMulti();
  }
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
  registrarHistoricoGeral("Sudoku", nomesDificuldade[dificuldadeAtual] + " · " + formatarTempo(tempoAtual()));
}

// ---------------------------------------------------------------------------
// Perfil — histórico recente unificado (todos os jogos)
// ---------------------------------------------------------------------------
function registrarHistoricoGeral(jogo, detalhe) {
  try {
    const lista = JSON.parse(localStorage.getItem("jj-historico-geral") || "[]");
    lista.unshift({ jogo: jogo, detalhe: detalhe, data: new Date().toLocaleDateString("pt-BR") });
    localStorage.setItem("jj-historico-geral", JSON.stringify(lista.slice(0, 20)));
  } catch (e) { /* ignore */ }
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
      var avatarHtml = recorde.avatar
        ? '<img class="recorde-avatar" src="' + escapeHtml(recorde.avatar) + '" alt="" />'
        : '<span class="recorde-avatar placeholder">' + escapeHtml((recorde.nick || "?").charAt(0).toUpperCase()) + '</span>';
      registro.innerHTML =
        '<span class="recorde-posicao">' + (medallas[i] || "") + "</span>" +
        avatarHtml +
        '<span class="recorde-info"><strong>' + escapeHtml(recorde.nick) + "</strong>" +
        "<small>" + escapeHtml(recorde.nome || "") + "</small></span>" +
        '<span class="recorde-tempo">' + formatarTempo(recorde.tempo_segundos) + "</span>";
      elementoRecordes.appendChild(registro);
    });
  } catch (erro) {
    elementoRecordes.innerHTML = '<p class="vazio">Erro ao carregar recordes.</p>';
  }
}

async function salvarRecorde() {
  await garantirIdentidade();
  const nome = nomeUsuario();
  const nick = nomeExibicao();
  const avatar = avatarAtual();

  try {
    await fetch("./sudoku/recordes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dificuldade: dificuldadeAtual,
        nome: nome,
        nick: nick,
        avatar: avatar,
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
      if (sudokuOnlineAtivo && sudokuWs && sudokuWs.readyState === WebSocket.OPEN && !sudokuTerminou) {
        // Corrida online: avisa a sala o tempo (progresso continua oculto).
        sudokuTerminou = true;
        try {
          sudokuWs.send(JSON.stringify({ tipo: "concluiu", tempo: tempoAtual() }));
        } catch (e) { /* ignore */ }
        mostrarMensagem("Você terminou em " + formatarTempo(tempoAtual()) + "! Aguardando o oponente...", "sucesso");
        mostrarBotao("#sudoku-pedir-revanche", true);
        mostrarBotao("#sudoku-parar", true);
      } else if (!sudokuOnlineAtivo) {
        salvarHistorico();
        salvarRecorde();
        mostrarMensagem(dados.mensagem + " Tempo: " + formatarTempo(tempoAtual()) + ".", "sucesso");
      } else {
        mostrarMensagem(dados.mensagem + " Tempo: " + formatarTempo(tempoAtual()) + ".", "sucesso");
      }
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
let velhaPlacar = { X: 0, O: 0 };
let velhaJogadores = { X: { nick: "—", avatar: null }, O: { nick: "—", avatar: null } };
let velhaRecordSalvo = false;

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
  velhaRecordSalvo = false;
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
  var placar = document.querySelector("#placar-times-velha");
  if (placar) placar.style.display = "none";
}

function mostrarPlacarVelha(visivel) {
  var placar = document.querySelector("#placar-times-velha");
  if (placar) placar.style.display = visivel ? "" : "none";
}

function atualizarPlacarVelha() {
  mostrarPlacarVelha(velhaModo !== null);
  preencherAvatarPlacar(
    document.querySelector("#placar-velha-avatar-x"),
    velhaJogadores.X.nick, velhaJogadores.X.avatar);
  preencherAvatarPlacar(
    document.querySelector("#placar-velha-avatar-o"),
    velhaJogadores.O.nick, velhaJogadores.O.avatar);
  var nx = document.querySelector("#placar-velha-nick-x");
  var no = document.querySelector("#placar-velha-nick-o");
  var gx = document.querySelector("#placar-velha-gol-x");
  var go = document.querySelector("#placar-velha-gol-o");
  if (nx) nx.textContent = velhaJogadores.X.nick || "Aguardando...";
  if (no) no.textContent = velhaJogadores.O.nick || "Aguardando...";
  if (gx) gx.textContent = String(velhaPlacar.X || 0);
  if (go) go.textContent = String(velhaPlacar.O || 0);
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
    } else if (dados.tipo === "salas_multi") {
      renderizarSalasMulti(dados.salas || []);
    } else if (dados.tipo === "multi_removida") {
      carregarSalasMulti();
    } else if (dados.tipo === "salas_ludo") {
      renderizarSalasLudo(dados.salas || []);
    } else if (dados.tipo === "salas_campo") {
      renderizarSalasCampo(dados.salas || []);
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
  await garantirIdentidade();
  velhaModo = "maquina";
  velhaDificuldade = dificuldade;
  carregarRankingVelha();
  velhaMinhaPeca = "X";
  velhaEspectador = false;
  velhaPlacar = { X: 0, O: 0 };
  velhaJogadores = {
    X: { nick: nomeExibicao() !== "Anônimo" ? nomeExibicao() : "Você", avatar: avatarAtual() },
    O: { nick: "Máquina", avatar: null },
  };
  mostrarTela(telaVelha);
  esconderCodigoSala();
  mostrarPlacarVelha(true);
  atualizarPlacarVelha();
  atualizarVelhaMensagem("Carregando...");
  document.querySelector("#reiniciar-velha").style.display = "";
  document.querySelector("#sair-sala-velha").style.display = "none";
  document.querySelector("#espectadores-bar").style.display = "none";

  var nome = nomeUsuario();
  var nick = nomeExibicao();

  try {
    var res = await fetch("./velha/novo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modo: "maquina", dificuldade: dificuldade, nome: nome, nick: nick, avatar: avatarAtual() }),
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
    if (dados.placar) velhaPlacar = dados.placar;
    if (velhaModo) atualizarPlacarVelha();
    desenharTabuleiro(velhaTabuleiro);
    atualizarVelhaVez();

    if (!dados.jogo_ativo) {
      document.querySelector("#reiniciar-velha").style.display = "";
      if (dados.resultado === "empate") {
        atualizarVelhaMensagem("Empate!", "");
      } else if (dados.resultado === velhaMinhaPeca) {
        atualizarVelhaMensagem("Você venceu! Parabéns!", "sucesso");
        salvarRecordVelha();
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
  if (velhaRecordSalvo) return;
  if (velhaEspectador) return;
  await garantirIdentidade();
  // Anônimo não entra em rankings.
  if (ehAnonimoNick(nomeExibicao())) return;
  velhaRecordSalvo = true;
  var nome = nomeUsuario();
  var nick = nomeExibicao();
  var avatar = avatarAtual();
  var dif = velhaModo === "maquina" ? (velhaDificuldade || "facil") : "facil";
  try {
    await fetch("./velha/recordes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dificuldade: dif, nome: nome, nick: nick, avatar: avatar }),
    });
    carregarRankingVelha();
    registrarHistoricoGeral("Jogo da Velha", "Vitória · " + nomesDificuldade[dif]);
  } catch (e) { /* ignore */ }
}

function ehAnonimoNick(nick) {
  var n = (nick || "").trim().toLowerCase();
  return n === "anônimo" || n === "anonimo";
}

async function carregarRankingVelha() {
  var container = document.querySelector("#lista-ranking-velha");
  if (!container) return;
  try {
    var dif = velhaDificuldade || "facil";
    var res = await fetch("./velha/ranking?dificuldade=" + encodeURIComponent(dif));
    var dados = await res.json();
    var lista = dados.ranking || [];
    var medallas = ["\uD83E\uDD47", "\uD83E\uDD48", "\uD83E\uDD49"];
    var titulo = container.parentElement && container.parentElement.querySelector("h2");
    if (titulo) {
      titulo.textContent = "Top 3 vitórias — " + (campoNomeDif[dif] || dif);
    }
    if (!lista.length) {
      container.innerHTML = '<p class="vazio">Nenhuma vitória ainda.</p>';
      return;
    }
    container.innerHTML = "";
    lista.slice(0, 3).forEach(function (r, i) {
      var img = r.avatar
        ? '<img class="recorde-avatar" src="' + escapeHtml(r.avatar) + '" alt="" />'
        : '<span class="recorde-avatar placeholder">' + escapeHtml((r.nick || "?").charAt(0).toUpperCase()) + '</span>';
      var el = document.createElement("div");
      el.className = "registro-recorde";
      el.innerHTML =
        '<span class="recorde-posicao">' + (medallas[i] || (i + 1)) + "</span>" +
        img +
        '<span class="recorde-info"><strong>' + escapeHtml(r.nick) + "</strong>" +
        "<small>" + escapeHtml(r.nome || "") + "</small></span>" +
        '<span class="recorde-tempo">' + (r.vitorias || 0) + "v</span>";
      container.appendChild(el);
    });
  } catch (e) {
    container.innerHTML = '<p class="vazio">Erro ao carregar ranking.</p>';
  }
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
  var avatar = avatarAtual();
  if (avatar) params += "&avatar=" + encodeURIComponent(avatar);

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
      if (dados.placar) velhaPlacar = dados.placar;
      if (dados.jogador_x || dados.avatar_x) {
        velhaJogadores.X = { nick: dados.jogador_x || velhaJogadores.X.nick, avatar: dados.avatar_x || velhaJogadores.X.avatar };
      }
      if (dados.jogador_o || dados.avatar_o) {
        velhaJogadores.O = { nick: dados.jogador_o || velhaJogadores.O.nick, avatar: dados.avatar_o || velhaJogadores.O.avatar };
      }
      if (velhaModo) atualizarPlacarVelha();
      desenharTabuleiro(velhaTabuleiro);
      atualizarVelhaVez();
      if (!dados.jogo_ativo && dados.resultado && dados.resultado !== "empate"
          && velhaModo === "multiplayer" && !velhaEspectador
          && dados.resultado === velhaMinhaPeca) {
        salvarRecordVelha();
      }
      break;

    case "inicio":
      velhaRecordSalvo = false;
      esconderCodigoSala();
      var comeca = dados.quem_comeca === velhaMinhaPeca ? "você" : dados.quem_comeca;
      atualizarVelhaMensagem(
        dados.jogador_x + " (X) vs " + dados.jogador_o + " (O) — " + comeca + " começa!"
      );
      document.querySelector("#reiniciar-velha").style.display = "none";
      if (dados.jogador_x) velhaJogadores.X = { nick: dados.jogador_x, avatar: dados.avatar_x || null };
      if (dados.jogador_o) velhaJogadores.O = { nick: dados.jogador_o, avatar: dados.avatar_o || null };
      atualizarPlacarVelha();
      break;

    case "esperando":
      velhaMinhaPeca = dados.minha_peca;
      atualizarVelhaMensagem(dados.mensagem);
      vezLabel.textContent = "Você é " + velhaMinhaPeca;
      vezLabel.className = "indicador-vez " + velhaMinhaPeca.toLowerCase();
      if (velhaMinhaPeca === "X" && velhaJogadores) {
        velhaJogadores.X = { nick: nomeExibicao() !== "Anônimo" ? nomeExibicao() : "Você", avatar: avatarAtual() };
      } else if (velhaMinhaPeca === "O") {
        velhaJogadores.O = { nick: nomeExibicao() !== "Anônimo" ? nomeExibicao() : "Você", avatar: avatarAtual() };
      }
      atualizarPlacarVelha();
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

    case "vitoria_desistencia":
      // Oponente saiu: vitória para quem ficou; sala desfaz em seguida.
      velhaTabuleiro._ativo = false;
      velhaTabuleiro._resultado = dados.vencedor || null;
      atualizarVelhaVez();
      if (dados.vencedor && dados.vencedor === velhaMinhaPeca && !velhaEspectador) {
        atualizarVelhaMensagem(dados.mensagem || "Oponente saiu. Você venceu!", "sucesso");
        salvarRecordVelha();
      } else if (dados.vencedor && velhaMinhaPeca && dados.vencedor !== velhaMinhaPeca) {
        atualizarVelhaMensagem(dados.mensagem || "Oponente saiu.", "erro");
      } else {
        atualizarVelhaMensagem(dados.mensagem || "Oponente saiu.", "");
      }
      mostrarPlacarVelha(true);
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
  await garantirIdentidade();
  var nome = nomeUsuario();
  var nick = nomeExibicao();
  var avatar = avatarAtual();
  var codigo = (document.querySelector("#velha-codigo-sala").value || "").trim().toLowerCase();
  var publica = !!document.querySelector("#velha-sala-publica").checked;

  try {
    var res = await fetch("./velha/novo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modo: "multiplayer",
        nome: nome,
        nick: nick,
        avatar: avatar,
        codigo: codigo || null,
        publica: publica,
      }),
    });
    var dados = await res.json();
    if (!res.ok) throw new Error(dados.detail || "Erro ao criar sala.");

    velhaModo = "multiplayer";
    velhaDificuldade = "facil";
    carregarRankingVelha();
    velhaReconnectAttempts = 0;
    velhaSala = dados.sala;
    velhaPlacar = { X: 0, O: 0 };
    velhaJogadores = { X: { nick: nick, avatar: avatar }, O: { nick: "Aguardando...", avatar: null } };
    mostrarTela(telaVelha);
    mostrarCodigoSala(dados.sala);
    atualizarPlacarVelha();
    atualizarVelhaMensagem("Aguardando oponente...");
    vezLabel.textContent = "Aguardando...";
    vezLabel.className = "indicador-vez";
    document.querySelector("#reiniciar-velha").style.display = "none";
    document.querySelector("#sair-sala-velha").style.display = "";
    document.querySelector("#espectadores-bar").style.display = "none";
    limparTabuleiro();

    conectarWsVelha(dados.sala, nome, nick, false);
  } catch (erro) {
    atualizarVelhaMensagem(erro.message, "erro");
  }
}

async function entrarSalaVelha(codigo) {
  await garantirIdentidade();
  var nome = nomeUsuario();
  var nick = nomeExibicao();

    velhaModo = "multiplayer";
    velhaDificuldade = "facil";
    carregarRankingVelha();
    velhaReconnectAttempts = 0;
    velhaPlacar = { X: 0, O: 0 };
    velhaJogadores = { X: { nick: "—", avatar: null }, O: { nick: "—", avatar: null } };
    mostrarTela(telaVelha);
    esconderCodigoSala();
    atualizarPlacarVelha();
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

document.querySelector("#entrar-sala-velha").addEventListener("click", function () {
  var codigo = document.querySelector("#velha-codigo-sala").value.trim();
  if (codigo) entrarSalaVelha(codigo);
});

document.querySelector("#velha-codigo-sala").addEventListener("keydown", function (e) {
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
  velhaSala = null;
  velhaModo = null;
  mostrarTela(telaLobbyVelha);
  carregarRankingVelha();
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
  carregarSalasSudoku();
});

document.querySelectorAll("#tela-dificuldade .botao-dificuldade").forEach(function (botao) {
  botao.addEventListener("click", function () {
    // Solo: encerra uma eventual sala online aberta.
    if (sudokuOnlineAtivo) {
      if (sudokuWs && sudokuWs.readyState === WebSocket.OPEN) {
        try { sudokuWs.send(JSON.stringify({ tipo: "sair" })); } catch (e) { /* ignore */ }
      }
      fecharSudokuOnline(null);
    }
    iniciarSudoku(botao.dataset.dificuldade);
  });
});

document.querySelector("#jogo-velha").addEventListener("click", function () {
  mostrarTela(telaModoVelha);
});

document.querySelector("#jogo-ludo").addEventListener("click", function () {
  mostrarTela(telaLobbyLudo);
  carregarSalasLudo();
  conectarLobbyWs();
});

// ---------------------------------------------------------------------------
// Ludo online — estado, tabuleiro, WS
// ---------------------------------------------------------------------------
const telaLobbyLudo = document.querySelector("#tela-lobby-ludo");
const telaLudo = document.querySelector("#tela-ludo");
const LUDO_TRACK = [
  [6,1],[6,2],[6,3],[6,4],[6,5],
  [5,6],[4,6],[3,6],[2,6],[1,6],[0,6],
  [0,7],
  [0,8],
  [1,8],[2,8],[3,8],[4,8],[5,8],
  [6,9],[6,10],[6,11],[6,12],[6,13],[6,14],
  [7,14],
  [8,14],
  [8,13],[8,12],[8,11],[8,10],[8,9],
  [9,8],[10,8],[11,8],[12,8],[13,8],[14,8],
  [14,7],
  [14,6],
  [13,6],[12,6],[11,6],[10,6],[9,6],
  [8,5],[8,4],[8,3],[8,2],[8,1],[8,0],
  [7,0],
  [6,0]
];
const LUDO_OFFSETS = { vermelho: 0, verde: 13, amarelo: 26, azul: 39 };
const LUDO_SEGURAS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const LUDO_HOME = {
  vermelho: [[7,1],[7,2],[7,3],[7,4],[7,5]],
  verde: [[1,7],[2,7],[3,7],[4,7],[5,7]],
  amarelo: [[7,13],[7,12],[7,11],[7,10],[7,9]],
  azul: [[13,7],[12,7],[11,7],[10,7],[9,7]]
};
const LUDO_BASES = {
  vermelho: [[1,1],[1,3],[3,1],[3,3]],
  verde: [[1,11],[1,13],[3,11],[3,13]],
  amarelo: [[11,11],[11,13],[13,11],[13,13]],
  azul: [[11,1],[11,3],[13,1],[13,3]]
};
const LUDO_CORES = ["vermelho", "verde", "amarelo", "azul"];

var ludoWs = null;
var ludoSala = null;
var ludoSlot = null;
var ludoEstado = null;
var ludoPingTimer = null;
var ludoAtivo = false;
var ludoTabuleiroMontado = false;
var ludoCelulas = {};
var ludoPecaEls = {};
var ludoPecaPos = {};
var ludoAnimando = false;
var ludoAnimToken = 0;

function ludoMsg(texto, tipo) {
  var el = document.querySelector("#mensagem-ludo");
  if (el) {
    el.textContent = texto || "";
    el.className = "mensagem " + (tipo || "");
  }
}

function ludoMsgLobby(texto, tipo) {
  var el = document.querySelector("#mensagem-ludo-lobby");
  if (el) {
    el.textContent = texto || "";
    el.className = "mensagem " + (tipo || "");
  }
}

function ludoFechar(motivo) {
  ludoAtivo = false;
  clearInterval(ludoPingTimer);
  ludoPingTimer = null;
  ludoAnimToken++;
  ludoAnimando = false;
  ludoPecaEls = {};
  ludoPecaPos = {};
  if (ludoWs) {
    try { ludoWs.close(); } catch (e) {}
    ludoWs = null;
  }
  ludoSala = null;
  ludoSlot = null;
  ludoEstado = null;
  ludoTabuleiroMontado = false;
  var tab = document.querySelector("#ludo-tabuleiro");
  if (tab) tab.innerHTML = "";
  var bar = document.querySelector("#ludo-sala-bar");
  if (bar) bar.style.display = "none";
  var lab = document.querySelector("#ludo-codigo-label");
  if (lab) lab.style.display = "none";
  if (motivo) ludoMsg(motivo, "erro");
}

function ludoMontarTabuleiro() {
  var tab = document.querySelector("#ludo-tabuleiro");
  if (!tab || ludoTabuleiroMontado) return;
  tab.innerHTML = "";
  ludoCelulas = {};
  ludoPecaEls = {};
  ludoPecaPos = {};
  var trackSet = new Set(LUDO_TRACK.map(function (c) { return c[0] + "," + c[1]; }));
  var safeSet = new Set();
  LUDO_TRACK.forEach(function (c, i) {
    if (LUDO_SEGURAS.has(i)) safeSet.add(c[0] + "," + c[1]);
  });
  var casaMap = {};
  LUDO_CORES.forEach(function (cor) {
    LUDO_HOME[cor].forEach(function (c) { casaMap[c[0] + "," + c[1]] = cor; });
  });
  var baseMap = {};
  LUDO_CORES.forEach(function (cor) {
    var r0 = cor === "vermelho" || cor === "verde" ? 0 : 9;
    var r1 = cor === "vermelho" || cor === "verde" ? 5 : 14;
    var c0 = cor === "vermelho" || cor === "azul" ? 0 : 9;
    var c1 = cor === "vermelho" || cor === "azul" ? 5 : 14;
    for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) baseMap[r + "," + c] = cor;
  });
  var starts = {};
  LUDO_TRACK.forEach(function (c, i) {
    if (i === 0) starts[c[0] + "," + c[1]] = "vermelho";
    if (i === 13) starts[c[0] + "," + c[1]] = "verde";
    if (i === 26) starts[c[0] + "," + c[1]] = "amarelo";
    if (i === 39) starts[c[0] + "," + c[1]] = "azul";
  });

  for (var r = 0; r < 15; r++) {
    for (var c = 0; c < 15; c++) {
      var key = r + "," + c;
      var d = document.createElement("div");
      d.className = "ludo-celula";
      d.dataset.r = r;
      d.dataset.c = c;
      if (r >= 6 && r <= 8 && c >= 6 && c <= 8) {
        d.classList.add("centro");
      } else if (casaMap[key]) {
        d.classList.add("trilha", "casa-" + casaMap[key]);
      } else if (trackSet.has(key)) {
        d.classList.add("trilha");
        if (safeSet.has(key)) d.classList.add("segura");
        if (starts[key]) {
          d.classList.add("casa-" + starts[key]);
          var s = document.createElement("span");
          s.className = "inicio-marcador";
          s.textContent = "▶";
          d.appendChild(s);
        }
      } else if (baseMap[key]) {
        d.classList.add("base-" + baseMap[key]);
      }
      tab.appendChild(d);
      ludoCelulas[key] = d;
    }
  }
  var overlay = document.createElement("div");
  overlay.className = "ludo-pecas-overlay";
  overlay.id = "ludo-pecas-overlay";
  tab.appendChild(overlay);
  ludoTabuleiroMontado = true;
}

function ludoPecaXY(cor, pos, idx) {
  if (pos === -1) {
    var base = LUDO_BASES[cor] || LUDO_BASES.vermelho;
    return base[idx || 0] || base[0];
  }
  if (pos >= 0 && pos <= 51) {
    var abs = (LUDO_OFFSETS[cor] + pos) % 52;
    return LUDO_TRACK[abs];
  }
  if (pos >= 52 && pos <= 56) {
    var home = LUDO_HOME[cor];
    return home[pos - 52];
  }
  if (pos === 57) return [7, 7];
  return null;
}

function ludoCellPct(xy) {
  var size = 100 / 15;
  return {
    left: (xy[1] + 0.14) * size,
    top: (xy[0] + 0.14) * size,
  };
}

function ludoCaminhoAnim(cor, de, ate) {
  var passos = [];
  if (ate == null || de == null || ate === de) return passos;
  if (ate < de || ate === -1 || de === -1) {
    var xy = ludoPecaXY(cor, ate, 0);
    if (xy) passos.push(xy);
    return passos;
  }
  for (var p = de + 1; p <= ate; p++) {
    var xy2 = ludoPecaXY(cor, p, 0);
    if (xy2) passos.push(xy2);
  }
  return passos;
}

function ludoSleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function ludoMontarPeao(j, idx, pos, xy, n) {
  var peao = document.createElement("button");
  peao.type = "button";
  peao.className = "ludo-peao " + j.cor;
  if (pos === -1) {
    peao.style.transform = "none";
  } else if (n === 1) peao.classList.add("pilha-offset1");
  if (n === 2 && pos !== -1) peao.classList.add("pilha-offset2");
  if (n >= 3 && pos !== -1) peao.classList.add("pilha-offset3");
  peao.title = (j.nick || "") + " · peça " + (idx + 1);
  peao.dataset.slot = j.slot;
  peao.dataset.idx = String(idx);
  var pct = ludoCellPct(xy);
  peao.style.left = pct.left + "%";
  peao.style.top = pct.top + "%";
  return peao;
}

function ludoAplicarClique(peao, j, idx, opcoes, minhaVez) {
  peao.onclick = null;
  if (minhaVez && j.slot === ludoSlot && opcoes.indexOf(idx) !== -1) {
    peao.classList.add("opcao");
    peao.disabled = false;
    peao.onclick = function () {
      if (ludoWs && ludoWs.readyState === WebSocket.OPEN) {
        ludoWs.send(JSON.stringify({ tipo: "mover", peao: idx }));
      }
    };
  } else {
    peao.disabled = true;
  }
}

function ludoDesenharPecas() {
  if (!ludoEstado || !ludoEstado.jogadores) return;
  var overlay = document.querySelector("#ludo-pecas-overlay");
  if (!overlay) return;
  var opcoes = ludoEstado.opcoes || [];
  var minhaVez = ludoEstado.fase === "jogando" && ludoEstado.vez === ludoSlot &&
    ludoEstado.dado_ja_rolado;
  var pilha = {};
  var desejado = {};
  // Cancela animação em voo antes de redesenhar.
  ludoAnimToken++;
  ludoAnimando = false;

  ludoEstado.jogadores.forEach(function (j) {
    if (!j.cor || !j.pecas) return;
    j.pecas.forEach(function (pos, idx) {
      var xy = ludoPecaXY(j.cor, pos, idx);
      if (!xy) return;
      var key = xy[0] + "," + xy[1];
      var n = pilha[key] || 0;
      pilha[key] = n + 1;
      var pkey = j.slot + ":" + idx;
      desejado[pkey] = { j: j, idx: idx, pos: pos, xy: xy, n: n };
    });
  });

  Object.keys(ludoPecaEls).forEach(function (pkey) {
    if (!desejado[pkey]) {
      var el = ludoPecaEls[pkey];
      if (el && el.parentNode) el.parentNode.removeChild(el);
      delete ludoPecaEls[pkey];
      delete ludoPecaPos[pkey];
    }
  });

  var anims = [];
  Object.keys(desejado).forEach(function (pkey) {
    var info = desejado[pkey];
    var el = ludoPecaEls[pkey];
    var posAnt = ludoPecaPos[pkey];
    if (!el || !el.parentNode) {
      el = ludoMontarPeao(info.j, info.idx, info.pos, info.xy, info.n);
      ludoAplicarClique(el, info.j, info.idx, opcoes, minhaVez);
      overlay.appendChild(el);
      ludoPecaEls[pkey] = el;
      ludoPecaPos[pkey] = info.pos;
      return;
    }
    el.className = "ludo-peao " + info.j.cor;
    el.classList.remove("animando");
    if (info.pos === -1) {
      el.style.transform = "none";
    } else if (info.n === 1) {
      el.classList.add("pilha-offset1");
    } else if (info.n === 2) {
      el.classList.add("pilha-offset2");
    } else if (info.n >= 3) {
      el.classList.add("pilha-offset3");
    }
    el.title = (info.j.nick || "") + " · peça " + (info.idx + 1);
    ludoAplicarClique(el, info.j, info.idx, opcoes, minhaVez);

    var mudou = posAnt !== undefined && posAnt !== info.pos;
    if (!mudou) {
      var pct0 = ludoCellPct(info.xy);
      el.style.left = pct0.left + "%";
      el.style.top = pct0.top + "%";
      ludoPecaPos[pkey] = info.pos;
      return;
    }
    var caminho = ludoCaminhoAnim(info.j.cor, posAnt, info.pos);
    ludoPecaPos[pkey] = info.pos;
    if (caminho.length >= 1 && caminho.length <= 6 && info.pos !== -1) {
      anims.push({ el: el, caminho: caminho, pkey: pkey, pos: info.pos });
    } else {
      var pct1 = ludoCellPct(info.xy);
      el.style.left = pct1.left + "%";
      el.style.top = pct1.top + "%";
    }
  });

  if (anims.length) {
    var token = ludoAnimToken;
    ludoAnimando = true;
    Promise.all(anims.map(function (a) {
      return (async function () {
        a.el.classList.add("animando");
        for (var i = 0; i < a.caminho.length; i++) {
          if (token !== ludoAnimToken) return;
          var pct = ludoCellPct(a.caminho[i]);
          a.el.style.left = pct.left + "%";
          a.el.style.top = pct.top + "%";
          await ludoSleep(110);
        }
        if (token === ludoAnimToken) {
          a.el.classList.remove("animando");
        }
      })();
    })).then(function () {
      if (token === ludoAnimToken) ludoAnimando = false;
    });
  }
}

function ludoRenderJogadores() {
  var box = document.querySelector("#ludo-jogadores");
  if (!box) return;
  box.innerHTML = "";
  var js = (ludoEstado && ludoEstado.jogadores) || [];
  if (!js.length) {
    box.innerHTML = '<span class="vazio">Nenhum jogador ainda.</span>';
    return;
  }
  js.forEach(function (j) {
    var div = document.createElement("div");
    div.className = "ludo-jogador cor-" + (j.cor || "azul");
    if (ludoEstado.vez === j.slot && ludoEstado.fase === "jogando") div.classList.add("ativo");
    var avatarHtml = j.avatar
      ? '<img src="' + escapeHtml(j.avatar) + '" alt="" />'
      : '<span class="ini">' + escapeHtml((j.nick || "?").charAt(0).toUpperCase()) + "</span>";
    var status = !j.conectado ? " · off" : (j.venceu ? " · venceu" : "");
    div.innerHTML = avatarHtml +
      '<span class="cor-bolinha ' + (j.cor || "") + '"></span>' +
      "<strong>" + escapeHtml(j.nick || "—") + status + "</strong>";
    box.appendChild(div);
  });
}

function preencherAvatarPlacarLudo(el, nick, avatar) {
  if (!el) return;
  if (avatar) {
    el.innerHTML = '<img src="' + escapeHtml(avatar) + '" alt="" />';
  } else {
    el.textContent = (nick || "?").charAt(0).toUpperCase();
  }
}

function ludoRenderPlacar() {
  var box = document.querySelector("#placar-times-ludo");
  if (!box || !ludoEstado) return;
  box.style.display = "";
  var placar = ludoEstado.placar || {};
  var js = ludoEstado.jogadores || [];
  ["p1", "p2", "p3", "p4"].forEach(function (slot, i) {
    var j = null;
    js.forEach(function (x) { if (x.slot === slot) j = x; });
    preencherAvatarPlacarLudo(
      document.querySelector("#placar-ludo-avatar-" + slot),
      j ? j.nick : "?", j ? j.avatar : null);
    var nick = document.querySelector("#placar-ludo-nick-" + slot);
    var gol = document.querySelector("#placar-ludo-gol-" + slot);
    if (nick) nick.textContent = j ? j.nick : "—";
    if (gol) gol.textContent = String(placar[slot] || 0);
    var lado = box.querySelector('.placar-lado[data-slot="' + slot + '"]');
    if (lado) lado.style.display = j ? "" : "none";
    var x = lado ? lado.nextElementSibling : null;
    if (x && x.classList && x.classList.contains("placar-x")) {
      var prox = lado ? lado.nextElementSibling.nextElementSibling : null;
      x.style.display = (j && prox && prox.style.display !== "none") ? "" : "none";
    }
  });
}

async function carregarRankingLudo() {
  var container = document.querySelector("#lista-ranking-ludo");
  if (!container) return;
  try {
    var res = await fetch("./ludo/ranking");
    var dados = await res.json();
    var lista = dados.ranking || [];
    var medallas = ["\uD83E\uDD47", "\uD83E\uDD48", "\uD83E\uDD49"];
    if (!lista.length) {
      container.innerHTML = '<p class="vazio">Nenhuma vitória ainda.</p>';
      return;
    }
    container.innerHTML = "";
    lista.slice(0, 3).forEach(function (r, i) {
      var img = r.avatar
        ? '<img class="recorde-avatar" src="' + escapeHtml(r.avatar) + '" alt="" />'
        : '<span class="recorde-avatar placeholder">' + escapeHtml((r.nick || "?").charAt(0).toUpperCase()) + '</span>';
      var el = document.createElement("div");
      el.className = "registro-recorde";
      el.innerHTML =
        '<span class="recorde-posicao">' + (medallas[i] || (i + 1)) + "</span>" +
        img +
        '<span class="recorde-info"><strong>' + escapeHtml(r.nick) + "</strong>" +
        "<small>" + escapeHtml(r.nome || "") + "</small></span>" +
        '<span class="recorde-tempo">' + (r.vitorias || 0) + "v</span>";
      container.appendChild(el);
    });
  } catch (e) {
    container.innerHTML = '<p class="vazio">Erro ao carregar ranking.</p>';
  }
}

function ludoAtualizarUI() {
  if (!ludoEstado) return;
  ludoMontarTabuleiro();
  var bar = document.querySelector("#ludo-sala-bar");
  var cod = document.querySelector("#ludo-sala-codigo");
  if (bar && ludoSala) {
    bar.style.display = "flex";
    if (cod) cod.textContent = ludoSala;
  }
  ludoRenderJogadores();
  ludoRenderPlacar();
  ludoDesenharPecas();

  var dadoEl = document.querySelector("#ludo-dado");
  var btn = document.querySelector("#ludo-rolar");
  var btnIni = document.querySelector("#ludo-iniciar");
  var dica = document.querySelector("#ludo-dica");
  var vezL = document.querySelector("#ludo-vez-label");

  var vezJog = null;
  (ludoEstado.jogadores || []).forEach(function (j) {
    if (j.slot === ludoEstado.vez) vezJog = j;
  });

  if (dadoEl) {
    if (ludoEstado.dado) {
      dadoEl.textContent = String(ludoEstado.dado);
      dadoEl.classList.remove("vazio");
    } else {
      dadoEl.textContent = "?";
      dadoEl.classList.add("vazio");
    }
  }

  var minhaVez = ludoEstado.fase === "jogando" && ludoEstado.vez === ludoSlot;
  if (btn) {
    if (minhaVez && !ludoEstado.dado_ja_rolado) {
      btn.style.display = "";
      btn.disabled = false;
      btn.textContent = "Rolar dado";
    } else if (minhaVez) {
      btn.style.display = "";
      btn.disabled = true;
      btn.textContent = ludoEstado.dado_ja_rolado ? "Mova a peça" : "Aguardar";
    } else {
      btn.style.display = "none";
      btn.disabled = true;
    }
  }
  if (btnIni) {
    if (ludoEstado.pode_iniciar) {
      btnIni.style.display = "";
      btnIni.disabled = false;
      btnIni.textContent = ludoEstado.fase === "fim" ? "Jogar de novo" : "Iniciar";
    } else {
      btnIni.style.display = "none";
      btnIni.disabled = true;
    }
  }
  if (dica) {
    if (ludoEstado.fase === "esperando") {
      dica.textContent = ludoEstado.pode_iniciar
        ? "Toque em Iniciar para começar."
        : "Aguardando jogadores (mín. 2)…";
    } else if (ludoEstado.fase === "contagem") dica.textContent = "Começando…";
    else if (ludoEstado.fase === "fim") {
      dica.textContent = ludoEstado.pode_iniciar ? "Toque em Jogar de novo." : "Fim de jogo.";
    } else if (minhaVez && ludoEstado.dado_ja_rolado) dica.textContent = "Clique em uma peça destacada.";
    else if (minhaVez) dica.textContent = "Toque em rolar dado.";
    else dica.textContent = "Vez de " + ((vezJog && vezJog.nick) || "—") + ".";
  }
  if (vezL) {
    if (ludoEstado.fase === "esperando") vezL.textContent = "Aguardando…";
    else if (ludoEstado.fase === "contagem") vezL.textContent = "Contagem…";
    else if (ludoEstado.fase === "fim") {
      var v = null;
      (ludoEstado.jogadores || []).forEach(function (j) {
        if (j.slot === ludoEstado.vencedor) v = j;
      });
      vezL.textContent = v ? (v.nick + " venceu!") : "Fim";
    } else if (minhaVez) vezL.textContent = "Sua vez!";
    else vezL.textContent = "Vez: " + ((vezJog && vezJog.nick) || "—");
  }

  var msgEl = document.querySelector("#mensagem-ludo");
  if (msgEl) {
    if (ludoEstado.ultimo_evento && ludoEstado.ultimo_evento.texto) {
      ludoMsg(ludoEstado.ultimo_evento.texto, ludoEstado.fase === "fim" ? "sucesso" : "");
    } else if (ludoEstado.fase === "esperando") {
      var n = (ludoEstado.jogadores || []).length;
      var cn = ludoEstado.conectados || n;
      ludoMsg("Sala " + ludoSala + " — " + cn + "/4 conectados. Compartilhe o código!", "");
    }
  }
}

function processarMensagemLudo(d) {
  switch (d.tipo) {
    case "erro":
      ludoFechar(d.mensagem || "Erro na sala.");
      mostrarTela(telaLobbyLudo);
      carregarSalasLudo();
      break;
    case "estado_ludo":
      ludoEstado = d;
      if (d.meu_slot) ludoSlot = d.meu_slot;
      if (d.sala) ludoSala = d.sala;
      ludoAtivo = true;
      ludoAtualizarUI();
      if (d.fase === "esperando" || d.fase === "contagem" || d.fase === "jogando" || d.fase === "fim") {
        if (telaLudo && !telaLudo.classList.contains("ativa")) mostrarTela(telaLudo);
      }
      if (d.fase === "fim") carregarRankingLudo();
      // Só 1 movimento possível e já rolou o dado → move sozinho.
      if (d.fase === "jogando" && d.vez === ludoSlot && d.dado_ja_rolado &&
          (d.opcoes || []).length === 1 && ludoWs && ludoWs.readyState === WebSocket.OPEN) {
        var unico = d.opcoes[0];
        setTimeout(function () {
          if (ludoWs && ludoWs.readyState === WebSocket.OPEN) {
            ludoWs.send(JSON.stringify({ tipo: "mover", peao: unico }));
          }
        }, 450);
      }
      break;
    case "contagem":
      if (d.n > 0) ludoMsg("Começa em " + d.n + "...", "");
      else ludoMsg("Vai!", "sucesso");
      break;
    case "erro_jogada":
      ludoMsg(d.mensagem || "Jogada inválida.", "erro");
      break;
    case "sala_ludo_encerrada":
      ludoFechar(d.motivo === "lider_saiu" || d.motivo === "lider_desconectou"
        ? "A sala foi encerrada." : "Sala encerrada.");
      mostrarTela(telaLobbyLudo);
      carregarSalasLudo();
      break;
    case "pong":
      break;
  }
}

function conectarLudoWs(sala) {
  if (ludoWs) {
    try { ludoWs.close(); } catch (e) {}
  }
  var nome = nomeUsuario();
  var nick = nomeExibicao();
  var avatar = avatarAtual() || "";
  var protocolo = location.protocol === "https:" ? "wss:" : "ws:";
  var url = protocolo + "//" + location.host + "/ws/ludo/" + encodeURIComponent(sala) +
    "?nome=" + encodeURIComponent(nome) +
    "&nick=" + encodeURIComponent(nick) +
    (avatar ? "&avatar=" + encodeURIComponent(avatar) : "");

  var ws = new WebSocket(url);
  ludoWs = ws;
  ludoSala = sala;
  ludoAtivo = true;
  var recebeu = false;

  clearInterval(ludoPingTimer);
  ludoPingTimer = setInterval(function () {
    if (ludoWs && ludoWs.readyState === WebSocket.OPEN) {
      ludoWs.send(JSON.stringify({ tipo: "ping" }));
    }
  }, 20000);

  ws.onmessage = function (ev) {
    if (typeof ev.data !== "string") return;
    try {
      recebeu = true;
      processarMensagemLudo(JSON.parse(ev.data));
    } catch (e) { console.warn(e); }
  };
  ws.onclose = function () {
    if (!recebeu && ludoAtivo && ludoSala === sala) {
      ludoFechar("Não consegui entrar na sala " + sala + ". Recarregue (Ctrl+F5).");
      mostrarTela(telaLobbyLudo);
      carregarSalasLudo();
    }
  };
  ws.onerror = function () {};
}

async function criarSalaLudo() {
  await garantirIdentidade();
  if (dentroDaActivity() && !usuarioDiscord) {
    ludoMsgLobby("Não consegui identificar seu Discord. Recarregue (Ctrl+F5).", "erro");
    return;
  }
  var codigo = (document.querySelector("#ludo-codigo-sala").value || "").trim().toLowerCase();
  var publica = !!document.querySelector("#ludo-sala-publica").checked;
  try {
    var res = await fetch("./ludo/sala/novo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codigo: codigo || null,
        publica: publica,
        nome: nomeUsuario(),
        nick: nomeExibicao(),
        avatar: avatarAtual(),
      }),
    });
    var dados = await res.json();
    if (!res.ok) throw new Error(dados.detail || "Erro ao criar sala.");
    ludoMsgLobby("", "");
    mostrarTela(telaLudo);
    ludoMsg("Entrando na sala " + dados.sala + "...", "");
    carregarRankingLudo();
    conectarLudoWs(dados.sala);
  } catch (erro) {
    ludoMsgLobby(erro.message, "erro");
  }
}

async function entrarSalaLudo(codigo) {
  codigo = (codigo || "").trim().toLowerCase();
  if (!codigo) {
    ludoMsgLobby("Digite o código da sala.", "erro");
    return;
  }
  await garantirIdentidade();
  if (dentroDaActivity() && !usuarioDiscord) {
    ludoMsgLobby("Não consegui identificar seu Discord. Recarregue (Ctrl+F5).", "erro");
    return;
  }
  ludoMsgLobby("", "");
  mostrarTela(telaLudo);
  ludoMsg("Entrando na sala " + codigo + "...", "");
  carregarRankingLudo();
  conectarLudoWs(codigo);
}

async function carregarSalasLudo() {
  var container = document.querySelector("#salas-ludo-conteudo");
  if (!container) return;
  try {
    var res = await fetch("./ludo/salas");
    var dados = await res.json();
    renderizarSalasLudo(dados.salas || []);
  } catch (e) {
    container.innerHTML = '<p class="vazio">Erro ao carregar salas.</p>';
  }
}

function renderizarSalasLudo(salas) {
  var container = document.querySelector("#salas-ludo-conteudo");
  if (!container) return;
  container.innerHTML = "";
  if (!salas || !salas.length) {
    container.innerHTML = '<p class="vazio">Nenhuma sala pública.</p>';
    return;
  }
  salas.forEach(function (s) {
    var item = document.createElement("div");
    item.className = "sala-item";
    item.innerHTML =
      '<div class="sala-item-info">' +
      "<strong>" + escapeHtml(s.lider || "?") + "</strong>" +
      "<small>" + escapeHtml(s.sala) + " · " +
      (s.fase === "esperando" ? "Aguardando" : s.fase === "fim" ? "Encerrado" : "Em jogo") +
      "</small></div>" +
      '<span class="sala-item-jogadores">' + s.jogadores + "/4</span>";
    item.addEventListener("click", function () {
      entrarSalaLudo(s.sala);
    });
    container.appendChild(item);
  });
}

document.querySelector("#criar-sala-ludo").addEventListener("click", criarSalaLudo);
document.querySelector("#atualizar-salas-ludo").addEventListener("click", carregarSalasLudo);
document.querySelector("#entrar-sala-ludo").addEventListener("click", function () {
  entrarSalaLudo(document.querySelector("#ludo-codigo-sala").value);
});
document.querySelector("#ludo-codigo-sala").addEventListener("keydown", function (e) {
  if (e.key === "Enter") entrarSalaLudo(this.value);
});
document.querySelector("#ludo-rolar").addEventListener("click", function () {
  if (ludoWs && ludoWs.readyState === WebSocket.OPEN) {
    ludoWs.send(JSON.stringify({ tipo: "rolar" }));
  }
});
document.querySelector("#ludo-iniciar").addEventListener("click", function () {
  if (ludoWs && ludoWs.readyState === WebSocket.OPEN) {
    ludoWs.send(JSON.stringify({ tipo: "iniciar" }));
  }
});
document.querySelector("#copiar-codigo-ludo").addEventListener("click", function () {
  var codigo = (document.querySelector("#ludo-sala-codigo").textContent || "").trim();
  if (!codigo || !navigator.clipboard) return;
  navigator.clipboard.writeText(codigo).then(function () {
    var btn = document.querySelector("#copiar-codigo-ludo");
    btn.textContent = "Copiado!";
    btn.classList.add("copiado");
    setTimeout(function () {
      btn.textContent = "Copiar";
      btn.classList.remove("copiado");
    }, 2000);
  });
});
document.querySelector("#voltar-ludo").addEventListener("click", function () {
  if (ludoWs && ludoWs.readyState === WebSocket.OPEN) {
    try { ludoWs.send(JSON.stringify({ tipo: "sair" })); } catch (e) {}
  }
  ludoFechar(null);
  carregarSalasLudo();
});

document.querySelectorAll(".botao-modo").forEach(function (botao) {
  botao.addEventListener("click", function () {
    var modo = botao.dataset.modo;
    if (modo === "maquina") {
      mostrarTela(telaDificuldadeVelha);
    } else if (modo === "multiplayer") {
      mostrarTela(telaLobbyVelha);
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
    // Sair da velha pela seta precisa fechar a sala no servidor.
    if (botao.id === "voltar-velha" && velhaModo === "multiplayer" && velhaSala) {
      localStorage.removeItem("velha-reconnect");
      esconderCodigoSala();
      if (velhaWs && velhaWs.readyState === WebSocket.OPEN) {
        try { velhaWs.send(JSON.stringify({ tipo: "sair" })); } catch (e) { /* ignore */ }
      }
      if (velhaWs) {
        velhaWs.close();
        velhaWs = null;
      }
      velhaSala = null;
      velhaModo = null;
    }
    // Sair do sudoku online (tela-jogo → voltar) encerra a sala.
    if (sudokuOnlineAtivo && botao.dataset.tela === "tela-dificuldade") {
      if (sudokuWs && sudokuWs.readyState === WebSocket.OPEN) {
        try { sudokuWs.send(JSON.stringify({ tipo: "sair" })); } catch (e) { /* ignore */ }
      }
      fecharSudokuOnline(null);
      carregarSalasSudoku();
    }
    // Sair do campo online pela seta.
    if (campoOnlineAtivo && botao.dataset.tela === "tela-modo-campo") {
      campoFechar(null);
      carregarSalasCampo();
    }
    var telaId = botao.dataset.tela;
    mostrarTela(document.querySelector("#" + telaId));
    if (telaId === "tela-lobby-velha" || telaId === "tela-modo-velha") {
      carregarRankingVelha();
    }
    if (telaId === "tela-modo-campo" || telaId === "tela-lobby-campo") {
      carregarRankingCampo();
      carregarSalasCampo();
    }
  });
});

carregarRankingVelha();

document.querySelector("#verificar").addEventListener("click", verificarResposta);
document.querySelector("#reiniciar").addEventListener("click", function () {
  iniciarSudoku(dificuldadeAtual);
});

// ---------------------------------------------------------------------------
// Sudoku online — salas, WS, countdown, placar, revanche
// ---------------------------------------------------------------------------
var sudokuOnlineAtivo = false;
var sudokuWs = null;
var sudokuSala = null;
var sudokuSlot = null;
var sudokuFase = null;
var sudokuPlacar = { p1: 0, p2: 0 };
var sudokuUltimosJogadores = [];
var sudokuMeuTempo = 0;
var sudokuTerminou = false;
var sudokuPingTimer = null;

function sudokuOnlineBar(visivel) {
  var bar = document.querySelector("#sudoku-online-bar");
  var acoes = document.querySelector("#sudoku-online-acoes");
  var placar = document.querySelector("#placar-times-sudoku");
  if (bar) bar.style.display = visivel ? "" : "none";
  if (acoes) acoes.style.display = visivel ? "" : "none";
  if (placar) placar.style.display = visivel ? "" : "none";
}

function sudokuStatus(texto) {
  var el = document.querySelector("#sudoku-online-status");
  if (el) el.textContent = texto || "";
}

function preencherAvatarPlacar(el, nick, avatar) {
  if (!el) return;
  if (avatar) {
    el.innerHTML = '<img src="' + escapeHtml(avatar) + '" alt="" />';
  } else {
    el.textContent = (nick || "?").charAt(0).toUpperCase();
  }
}

function atualizarPlacarTimesSudoku() {
  var placar = document.querySelector("#placar-times-sudoku");
  if (placar) placar.style.display = sudokuOnlineAtivo ? "" : "none";
  var js = sudokuUltimosJogadores || [];
  var p1 = js[0] || {};
  var p2 = js[1] || {};
  var a = { nick: p1.nick || "Aguardando...", avatar: p1.avatar, gol: sudokuPlacar.p1 || 0 };
  var b = { nick: p2.nick || "Aguardando...", avatar: p2.avatar, gol: sudokuPlacar.p2 || 0 };
  preencherAvatarPlacar(document.querySelector("#placar-sudoku-avatar-p1"), a.nick, a.avatar);
  preencherAvatarPlacar(document.querySelector("#placar-sudoku-avatar-p2"), b.nick, b.avatar);
  var n1 = document.querySelector("#placar-sudoku-nick-p1");
  var n2 = document.querySelector("#placar-sudoku-nick-p2");
  var g1 = document.querySelector("#placar-sudoku-gol-p1");
  var g2 = document.querySelector("#placar-sudoku-gol-p2");
  if (n1) n1.textContent = a.nick;
  if (n2) n2.textContent = b.nick;
  if (g1) g1.textContent = String(a.gol);
  if (g2) g2.textContent = String(b.gol);
}

function sudokuPlacarTexto() {
  atualizarPlacarTimesSudoku();
}

function mostrarBotao(sel, on) {
  var el = document.querySelector(sel);
  if (el) el.style.display = on ? "" : "none";
}

function fecharSudokuOnline(motivo) {
  sudokuOnlineAtivo = false;
  clearInterval(sudokuPingTimer);
  sudokuPingTimer = null;
  if (sudokuWs) {
    try { sudokuWs.close(); } catch (e) { /* ignore */ }
    sudokuWs = null;
  }
  sudokuSala = null;
  sudokuSlot = null;
  sudokuFase = null;
  sudokuTerminou = false;
  sudokuUltimosJogadores = [];
  sudokuOnlineBar(false);
  mostrarBotao("#sudoku-pedir-revanche", false);
  mostrarBotao("#sudoku-responder-sim", false);
  mostrarBotao("#sudoku-responder-nao", false);
  mostrarBotao("#sudoku-parar", false);
  if (motivo) mostrarMensagem(motivo, "erro");
}

function conectarWsSudoku(sala) {
  if (sudokuWs) {
    try { sudokuWs.close(); } catch (e) { /* ignore */ }
  }
  var nome = nomeUsuario();
  var nick = nomeExibicao();
  var avatar = avatarAtual() || "";
  var protocolo = location.protocol === "https:" ? "wss:" : "ws:";
  var url = protocolo + "//" + location.host + "/ws/sudoku/" + encodeURIComponent(sala) +
    "?nome=" + encodeURIComponent(nome) +
    "&nick=" + encodeURIComponent(nick) +
    (avatar ? "&avatar=" + encodeURIComponent(avatar) : "");

  var ws = new WebSocket(url);
  sudokuWs = ws;
  sudokuSala = sala;
  var recebeuEstado = false;

  clearInterval(sudokuPingTimer);
  sudokuPingTimer = setInterval(function () {
    if (sudokuWs && sudokuWs.readyState === WebSocket.OPEN) {
      sudokuWs.send(JSON.stringify({ tipo: "ping" }));
    }
  }, 20000);

  ws.onmessage = function (ev) {
    if (typeof ev.data !== "string") return;
    try {
      recebeuEstado = true;
      processarMensagemSudoku(JSON.parse(ev.data));
    } catch (e) { console.warn(e); }
  };
  ws.onclose = function () {
    // 403/erro de rota: nunca chegou estado — não deixa "Entrando..." eterno.
    if (!recebeuEstado && sudokuOnlineAtivo && sudokuSala === sala) {
      fecharSudokuOnline("Não consegui entrar na sala " + sala + ". Recarregue (Ctrl+F5) e tente de novo.");
      mostrarTela(telaDificuldade);
    }
  };
  ws.onerror = function () {};
}

function processarMensagemSudoku(d) {
  switch (d.tipo) {
    case "erro":
      fecharSudokuOnline(d.mensagem || "Erro na sala.");
      mostrarTela(telaDificuldade);
      break;

    case "estado_sudoku":
      sudokuPlacar = d.placar || sudokuPlacar;
      sudokuUltimosJogadores = d.jogadores || [];
      sudokuPlacarTexto();
      sudokuFase = d.fase;
      if (d.meu_slot) sudokuSlot = d.meu_slot;
      if (d.sala) {
        document.querySelector("#sudoku-online-codigo").textContent = d.sala;
      }
      if (d.fase === "esperando") {
        sudokuStatus(d.meu_slot === "p1" ? "Aguardando oponente..." : "Aguardando...");
        mostrarMensagem("Aguardando o outro jogador...", "");
      } else if (d.fase === "jogando") {
        sudokuStatus("Jogando!");
      } else if (d.fase === "fim" || d.fase === "parcial") {
        if (d.vencedor_rodada) {
          var nick = "";
          var outro = d.jogadores ? (d.jogadores[0].slot === d.vencedor_rodada ? d.jogadores[0] : d.jogadores[1]) : null;
          if (outro) nick = outro.nick;
          var t = (d.tempos_rodada || {})[d.vencedor_rodada] || 0;
          mostrarMensagem(nick + " venceu e terminou em " + formatarTempo(t) + ".", "sucesso");
          sudokuStatus(nick + " venceu");
        }
      }
      // botões pós-rodada
      if (d.fase === "parcial" || (d.vencedor_rodada && !d.todos)) {
        // perdeu mas ainda pode terminar ou pedir revanche
        if (!sudokuTerminou) {
          mostrarBotao("#sudoku-pedir-revanche", true);
          mostrarBotao("#sudoku-parar", true);
        }
      }
      if (d.revanche_de && d.revanche_de !== sudokuSlot) {
        mostrarBotao("#sudoku-responder-sim", true);
        mostrarBotao("#sudoku-responder-nao", true);
      }
      break;

    case "contagem":
      sudokuOnlineAtivo = true;
      sudokuFase = "contagem";
      if (d.n > 0) {
        mostrarMensagem("Começa em " + d.n + "...", "");
        sudokuStatus("Contagem: " + d.n);
      } else {
        mostrarMensagem("Vai!", "sucesso");
        sudokuStatus("Vai!");
      }
      // zera o cronômetro visual; jogo real começa no "inicio_sudoku"
      clearInterval(intervaloCronometro);
      elementoCronometro.textContent = "00:00";
      sudokuTerminou = false;
      mostrarBotao("#sudoku-pedir-revanche", false);
      mostrarBotao("#sudoku-responder-sim", false);
      mostrarBotao("#sudoku-responder-nao", false);
      mostrarBotao("#sudoku-parar", false);
      break;

    case "inicio_sudoku":
      sudokuOnlineAtivo = true;
      sudokuFase = "jogando";
      sudokuTerminou = false;
      jogoId = d.jogo_id;
      dificuldadeAtual = d.dificuldade;
      document.querySelector("#dificuldade-atual").textContent = nomesDificuldade[d.dificuldade] || d.dificuldade;
      desenharGrade(d.grade);
      mostrarMensagem("Mesmo puzzle para os dois — progresso do oponente fica oculto.", "");
      sudokuStatus("Jogando!");
      iniciarCronometro();
      // carrega recordes do painel lateral
      carregarRecordes(d.dificuldade);
      break;

    case "vencedor_rodada":
      sudokuPlacar = d.placar || sudokuPlacar;
      if (d.jogadores) sudokuUltimosJogadores = d.jogadores;
      sudokuPlacarTexto();
      if (d.desistencia) {
        // Oponente saiu: vitória para quem ficou; sala desfaz em seguida.
        if (d.slot === sudokuSlot) {
          pararCronometro();
          sudokuTerminou = true;
          mostrarMensagem(d.mensagem || "Oponente saiu. Você venceu!", "sucesso");
          sudokuStatus("Você venceu!");
        } else {
          mostrarMensagem(d.mensagem || "Oponente saiu.", "");
          sudokuStatus((d.nick || "Oponente") + " venceu");
        }
        break;
      }
      if (d.slot === sudokuSlot) {
        pararCronometro();
        sudokuTerminou = true;
        salvarHistorico();
        salvarRecorde();
        mostrarMensagem("Você venceu e terminou em " + formatarTempo(d.tempo) + "!", "sucesso");
        sudokuStatus("Você venceu!");
        mostrarBotao("#sudoku-pedir-revanche", false);
        mostrarBotao("#sudoku-parar", true);
      } else {
        mostrarMensagem(d.nick + " venceu e terminou em " + formatarTempo(d.tempo) + ".", "sucesso");
        sudokuStatus(d.nick + " venceu");
        if (!sudokuTerminou) {
          mostrarBotao("#sudoku-pedir-revanche", true);
          mostrarBotao("#sudoku-parar", true);
        }
      }
      break;

    case "ambos_acabaram":
      sudokuPlacar = d.placar || sudokuPlacar;
      sudokuPlacarTexto();
      mostrarMensagem("Os dois terminaram. Placar " +
        (sudokuPlacar.p1) + " × " + (sudokuPlacar.p2) + ".", "sucesso");
      break;

    case "revanche_pedida":
      sudokuPlacar = d.placar || sudokuPlacar;
      sudokuPlacarTexto();
      mostrarMensagem(d.por + " pediu revanche (" +
        (sudokuPlacar.p1) + "×" + (sudokuPlacar.p2) + "). Aceitar?", "");
      if (d.por_slot && d.por_slot !== sudokuSlot) {
        mostrarBotao("#sudoku-responder-sim", true);
        mostrarBotao("#sudoku-responder-nao", true);
        mostrarBotao("#sudoku-pedir-revanche", false);
      }
      break;

    case "revanche_aceita":
      mostrarMensagem("Revanche aceita! Nova rodada...", "sucesso");
      mostrarBotao("#sudoku-responder-sim", false);
      mostrarBotao("#sudoku-responder-nao", false);
      mostrarBotao("#sudoku-pedir-revanche", false);
      mostrarBotao("#sudoku-parar", false);
      sudokuTerminou = false;
      break;

    case "revanche_recusada":
      fecharSudokuOnline("Revanche recusada. Sala encerrada.");
      mostrarTela(telaDificuldade);
      break;

    case "sala_sudoku_encerrada":
      if (d.motivo === "oponente_desistiu" || d.motivo === "lider_desconectou") {
        // Vitória já foi mostrada via vencedor_rodada — só sai da sala.
        fecharSudokuOnline("");
      } else {
        fecharSudokuOnline(d.motivo === "lider_saiu" || d.motivo === "lider_desconectou"
          ? "O líder saiu. A sala foi encerrada."
          : "A sala foi encerrada.");
      }
      mostrarTela(telaDificuldade);
      carregarSalasSudoku();
      break;

    case "pongs":
      break;
  }
}

async function criarSalaSudoku() {
  await garantirIdentidade();
  if (dentroDaActivity() && !usuarioDiscord) {
    mostrarMensagem("Não consegui identificar seu Discord. Recarregue (Ctrl+F5) e tente de novo.", "erro");
    return;
  }
  var codigo = (document.querySelector("#sudoku-codigo-sala").value || "").trim().toLowerCase();
  var publica = !!document.querySelector("#sudoku-sala-publica").checked;
  var difSel = document.querySelector("#sudoku-dificuldade-online .botao-preset.selecionado");
  var dif = (difSel && difSel.dataset.dif) || "facil";

  try {
    var res = await fetch("./sudoku/sala/novo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codigo: codigo || null,
        publica: publica,
        dificuldade: dif,
        nome: nomeUsuario(),
        nick: nomeExibicao(),
        avatar: avatarAtual(),
      }),
    });
    var dados = await res.json();
    if (!res.ok) throw new Error(dados.detail || "Erro ao criar sala.");

    sudokuOnlineAtivo = true;
    sudokuSala = dados.sala;
    document.querySelector("#sudoku-online-codigo").textContent = dados.sala;
    sudokuPlacar = { p1: 0, p2: 0 };
    sudokuUltimosJogadores = [];
    sudokuOnlineBar(true);
    atualizarPlacarTimesSudoku();
    mostrarMensagem("Sala criada: " + dados.sala + ". Aguardando oponente...", "sucesso");
    sudokuStatus("Aguardando oponente...");
    // se não escolheu dificuldade explícita, assume a atual
    mostrarTela(telaJogo);
    mostrarMensagem("Sala " + dados.sala + " — aguardando oponente...", "sucesso");
    conectarWsSudoku(dados.sala);

    if (discordSdkGlobal && publica) {
      try {
        await discordSdkGlobal.commands.shareLink({
          message: "Bora jogar Sudoku online! Sala: " + dados.sala,
          custom_id: "sudoku-" + dados.sala,
        });
      } catch (e) { /* cancelado */ }
    }
  } catch (erro) {
    mostrarMensagem(erro.message, "erro");
  }
}

async function entrarSalaSudoku(codigo) {
  codigo = (codigo || "").trim().toLowerCase();
  if (!codigo) {
    mostrarMensagem("Digite o código da sala.", "erro");
    return;
  }
  await garantirIdentidade();
  if (dentroDaActivity() && !usuarioDiscord) {
    mostrarMensagem("Não consegui identificar seu Discord. Recarregue (Ctrl+F5) e tente de novo.", "erro");
    return;
  }
  try {
    // valida sala existente via listagem (públicas) ou tenta WS direto (privadas)
    sudokuOnlineAtivo = true;
    document.querySelector("#sudoku-online-codigo").textContent = codigo;
    sudokuPlacar = { p1: 0, p2: 0 };
    sudokuUltimosJogadores = [];
    sudokuOnlineBar(true);
    atualizarPlacarTimesSudoku();
    mostrarTela(telaJogo);
    mostrarMensagem("Entrando na sala " + codigo + "...", "");
    sudokuStatus("Entrando...");
    conectarWsSudoku(codigo);
  } catch (erro) {
    fecharSudokuOnline(erro.message);
  }
}

async function carregarSalasSudoku() {
  var container = document.querySelector("#salas-sudoku-conteudo");
  if (!container) return;
  try {
    var res = await fetch("./sudoku/salas");
    var dados = await res.json();
    var lista = dados.salas || [];
    container.innerHTML = "";
    if (!lista.length) {
      container.innerHTML = '<p class="vazio">Nenhuma sala pública.</p>';
      return;
    }
    lista.forEach(function (s) {
      var item = document.createElement("div");
      item.className = "sala-item";
      item.innerHTML =
        '<div class="sala-item-info">' +
        "<strong>" + escapeHtml(s.lider || "?") + "</strong>" +
        "<small>" + escapeHtml(s.sala) + " · " + (nomesDificuldade[s.dificuldade] || s.dificuldade) +
        " · " + (s.fase === "esperando" ? "Aguardando" : "Em jogo") + "</small></div>" +
        '<span class="sala-item-jogadores">' + s.jogadores + "/2</span>";
      item.addEventListener("click", function () {
        entrarSalaSudoku(s.sala);
      });
      container.appendChild(item);
    });
  } catch (e) {
    container.innerHTML = '<p class="vazio">Erro ao carregar salas.</p>';
  }
}

// Botões da UI online
document.querySelector("#criar-sala-sudoku").addEventListener("click", function () {
  criarSalaSudoku();
});
document.querySelector("#entrar-sala-sudoku").addEventListener("click", function () {
  entrarSalaSudoku(document.querySelector("#sudoku-codigo-sala").value);
});
document.querySelectorAll("#sudoku-dificuldade-online .botao-preset").forEach(function (b) {
  b.addEventListener("click", function () {
    document.querySelectorAll("#sudoku-dificuldade-online .botao-preset").forEach(function (x) {
      x.classList.remove("selecionado");
    });
    b.classList.add("selecionado");
  });
});
document.querySelector("#sudoku-codigo-sala").addEventListener("keydown", function (e) {
  if (e.key === "Enter") entrarSalaSudoku(this.value);
});
document.querySelector("#sudoku-pedir-revanche").addEventListener("click", function () {
  if (sudokuWs && sudokuWs.readyState === WebSocket.OPEN) {
    sudokuWs.send(JSON.stringify({ tipo: "pedir_revanche" }));
    mostrarMensagem("Revanche pedida ao oponente...", "");
    mostrarBotao("#sudoku-pedir-revanche", false);
  }
});
document.querySelector("#sudoku-responder-sim").addEventListener("click", function () {
  if (sudokuWs && sudokuWs.readyState === WebSocket.OPEN) {
    sudokuWs.send(JSON.stringify({ tipo: "responder_revanche", aceitar: true }));
    mostrarBotao("#sudoku-responder-sim", false);
    mostrarBotao("#sudoku-responder-nao", false);
  }
});
document.querySelector("#sudoku-responder-nao").addEventListener("click", function () {
  if (sudokuWs && sudokuWs.readyState === WebSocket.OPEN) {
    sudokuWs.send(JSON.stringify({ tipo: "responder_revanche", aceitar: false }));
    mostrarBotao("#sudoku-responder-sim", false);
    mostrarBotao("#sudoku-responder-nao", false);
  }
});
document.querySelector("#sudoku-parar").addEventListener("click", function () {
  if (sudokuWs && sudokuWs.readyState === WebSocket.OPEN) {
    sudokuWs.send(JSON.stringify({ tipo: "parar" }));
  }
  fecharSudokuOnline("Você parou. Sala encerrada.");
});

// ---------------------------------------------------------------------------
// Discord — conexão
// ---------------------------------------------------------------------------
async function conectarAoDiscord() {
  if (conexaoDiscordPromise) return conexaoDiscordPromise;
  conexaoDiscordPromise = (async function () {
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

      var autenticou = false;
      try {
        // Fluxo correto da Activity: authorize -> code -> /token -> access_token
        // -> authenticate({access_token}) -> user. authenticate() sem token
        // retorna sem user e deixava o header em "sem login".
        var authz = await discordSdkGlobal.commands.authorize({
          client_id: configuracao.application_id,
          response_type: "code",
          state: "",
          prompt: "none",
          scope: ["identify", "applications.commands"],
        });
        var codigo = authz && authz.code;
        if (!codigo) throw new Error("authorize não retornou code");

        var resTroca = await fetch("./token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: codigo, activity: true }),
        });
        var token = await resTroca.json();
        if (!resTroca.ok) throw new Error(token.detail || "Falha ao trocar o code.");

        var me = await fetch("https://discord.com/api/users/@me", {
          headers: { Authorization: "Bearer " + token.access_token },
        });
        if (!me.ok) throw new Error("Falha ao obter o perfil (@me).");
        var user = await me.json();
        if (!user || !user.id) throw new Error("@me sem user.");

        usuarioDiscord = user;
        autenticou = true;
        try {
          await discordSdkGlobal.commands.authenticate({ access_token: token.access_token });
        } catch (eAuth) {
          console.warn("SDK authenticate (com token) falhou (ok se @me ok):", eAuth);
        }
        salvarSessaoDiscord({
          user: user,
          access_token: token.access_token,
          refresh_token: token.refresh_token,
          obtido_em: Date.now(),
        });
        console.log("Discord user identified:", user.username);
      } catch (e) {
        console.warn("Não foi possível autenticar:", e);
        // limpa a promise para permitir retry (garantirIdentidade chama de novo)
        conexaoDiscordPromise = null;
      }

      if (autenticou) {
        elementoStatus.textContent = "Conectado ao Discord";
        elementoStatus.classList.add("conectado");
      } else {
        elementoStatus.textContent = "Discord (sem login)";
        elementoStatus.classList.remove("conectado");
      }
      renderAuth();
    } catch (erro) {
      console.warn("A conex\u00e3o com o Discord n\u00e3o foi conclu\u00edda:", erro);
      conexaoDiscordPromise = null;
    }
  })();
  return conexaoDiscordPromise;
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
// "tela" = getDisplayMedia; "tela_legado" = getUserMedia(screen); "camera" = celular sem tela.
var telaFonte = "tela";
var cameraFacing = "environment";
var telaOfertaTimer = null;
// Relay de vídeo (Activity não suporta WebRTC — docs do Discord).
var telaModoRelay = false;
var telaRelayTimer = null;
var telaRelayTotal = 0;
var relayFrameOk = false;
var relayEncoder = null;
var relayAtivo = false;
var relayDrawTimer = null;
var relayForcarKey = false;
var relayDecoder = null;
var relayProntoEnviado = false;
var relayHostOk = false;
var relayEncoderVisibilityListener = null;
var relayTemKey = false;
var relayQuadros = 0;
var relayRxEnviado = false;
var relayPartes = {};
var relayCfgOk = false;
var relaySemOutput = 0;
var ultimoErroRelay = "";
var relayCodecAtual = "vp8";
var relayDecoderFallbackTentado = false;

// Áudio do relay (Activity não tem WebRTC): Opus via WebCodecs.
var relayAudioEncoder = null;
var relayAudioReader = null;
var relayAudioLoopAtivo = false;
var relayAudioDecoder = null;
var relayAudioCtx = null;
var relayAudioGain = null;
var relayAudioProxima = 0;
var relayAudioCfgOk = false;
var relayAudioMudoHost = false;
var relayAudioSr = 48000;
var relayAudioCh = 2;
var relayAudioChavePendente = true;
var relayAudioCfgDecoder = { sr: 0, ch: 0 };

// Sala multi-tela: várias lives simultâneas (720p30 fixo, máx. 8).
var multiSala = null;
var multiWs = null;
var multiPingTimer = null;
var multiEstado = null;
var multiTiles = {}; // sala_live -> contexto do tile
var multiHostSala = null; // live que ESTE cliente está transmitindo
var multiNaTela = false;

// Painel único de criação (hub).
var formTipoSala = "publica"; // publica | privada
var formModoTela = "normal";  // normal | multi

function logRelayDiag(etapa, extra) {
  var msg = { tipo: "relay_diag", etapa: etapa };
  if (extra) {
    if (extra.msg) msg.msg = String(extra.msg).slice(0, 200);
    if (typeof extra.quadros === "number") msg.quadros = extra.quadros;
    if (typeof extra.k === "number") msg.k = extra.k;
    if (typeof extra.bytes === "number") msg.bytes = extra.bytes;
    if (extra.state) msg.state = String(extra.state);
  }
  enviarTela(msg);
}

// Diagnóstico único do viewer da Activity: pergunta ao servidor o estado
// real da sala em vez de adivinhar.
async function diagnosticarRelaySemVideo() {
  if (!telaModoRelay || relayFrameOk || !telaSala) return;
  var codigo = telaSala;
  if (relayQuadros > 0) {
    // Quadros chegam no JS — o problema é decode/desenho, não a rede.
    logRelayDiag("sem_video", { quadros: relayQuadros, msg: ultimoErroRelay || ("cfg=" + relayCfgOk) });
    mensagemTransmissao(
      "Recebi " + relayQuadros + " quadros, mas o vídeo não abriu" +
      (ultimoErroRelay ? " (" + ultimoErroRelay + ")" : "") +
      ". Recarregue a Activity (Ctrl+F5).", "erro");
    return;
  }
  try {
    var res = await fetch("./tela/sala/" + encodeURIComponent(codigo));
    if (res.status === 404) {
      mensagemTransmissao("A transmissão foi encerrada (sala " + codigo + ").", "erro");
      return;
    }
    var info = await res.json();
    if (info.host_conectado === false) {
      mensagemTransmissao("Quem transmite NÃO está conectado (sala " + codigo +
        "). Feche e reabra a transmissão no navegador (Ctrl+F5).", "erro");
    } else {
      mensagemTransmissao("Quem transmite está online mas não enviou vídeo (sala " + codigo +
        "). Peça para ele Ctrl+F5 na aba de transmissão e transmitir de novo.", "erro");
    }
  } catch (e) {
    mensagemTransmissao("Sem resposta do servidor para a sala " + codigo + ".", "erro");
  }
}

// Bitrates altos = imagem nítida. O relay fragmenta em 12KB, então dá pra ir alto.
var TELA_PRESETS = {
  "480p": { largura: 854, altura: 480, bitrate: 2500000 },
  "720p": { largura: 1280, altura: 720, bitrate: 6000000 },
  "1080p": { largura: 1920, altura: 1080, bitrate: 12000000 },
};
var RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

var telaCompartilhar = document.querySelector("#tela-compartilhar");
var telaTransmissaoEl = document.querySelector("#tela-transmissao");
var mensagemTelaEl = document.querySelector("#mensagem-tela");
var mensagemTransmissaoEl = document.querySelector("#mensagem-transmissao");
var videoTransmissaoEl = document.querySelector("#video-transmissao");
var canvasRelayEl = document.querySelector("#canvas-relay");
var controlesTransmissaoEl = document.querySelector("#controles-transmissao");
var btnMudoEl = document.querySelector("#btn-mudo-transmissao");
var volumeEl = document.querySelector("#volume-transmissao");

// Estado de áudio/volume compartilhado host+viewer.
var audioMudo = false;
var volumeLocal = 1;
var telaAudioMuted = false;

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
  return telaFps === 60 ? Math.round(base * 1.5) : base;
}

// Relay: prefere fluidez (pouco fps/delay) sobre bitrate máximo — o proxy do
// Discord engasga com ~8 Mbps de JSON base64 e aí o vídeo "trava".
function bitrateRelay() {
  if (multiSala) return 5000000; // multi-tela 720p30: um pouco mais de bits p/ fps estável
  var base = TELA_PRESETS[telaResolucao].bitrate;
  var teto = telaResolucao === "1080p" ? 6000000
    : telaResolucao === "720p" ? 4500000 : 2500000;
  var b = Math.min(base, teto);
  // 60fps usa o MESMO budget (não multiplica) — mais bits = mais fila/delay.
  return b;
}

function atualizarAvisoUpload() {
  if (formModoTela === "multi") {
    document.querySelector("#aviso-upload").textContent =
      "Multi-tela: até 8 telas na mesma sala, 720p 30fps fixo.";
    return;
  }
  var mbpsPorEspectador = bitrateEfetivo() / 1000000;
  var total = (mbpsPorEspectador * 9).toFixed(1);
  document.querySelector("#aviso-upload").textContent =
    "Vídeo direto entre você e cada espectador (P2P). Com 9 espectadores, seu upload chega a ~" +
    total + " Mbps (" + mbpsPorEspectador.toFixed(1) + " Mbps por pessoa). Para muita gente, prefira 720p 30fps.";
}

function codigoCustomValido(obrigatorio) {
  var el = document.querySelector("#codigo-custom-input");
  var codigoCustom = ((el && el.value) || "").trim().toLowerCase();
  if (!codigoCustom) {
    if (obrigatorio) return { erro: "Sala privada: digite um código para as pessoas entrarem." };
    return { codigo: null };
  }
  if (!/^[a-z0-9_-]{3,16}$/.test(codigoCustom)) {
    return { erro: "Código da sala: use de 3 a 16 caracteres (letras, números, - ou _)." };
  }
  return { codigo: codigoCustom };
}

function aplicarFormularioCriacao() {
  var multi = formModoTela === "multi";
  var privada = formTipoSala === "privada";
  var q = document.querySelector("#bloco-qualidade");
  var nota = document.querySelector("#nota-multi");
  var cod = document.querySelector("#grupo-codigo-sala");
  var entrar = document.querySelector("#entrar-multi-bloco");
  var audio = document.querySelector("#grupo-audio");
  var btn = document.querySelector("#iniciar-transmissao");
  if (q) q.style.display = multi ? "none" : "";
  if (nota) nota.style.display = multi ? "" : "none";
  if (cod) cod.style.display = privada ? "" : "none";
  if (entrar) entrar.style.display = multi ? "" : "none";
  if (audio) audio.style.display = "";
  if (btn) btn.textContent = multi ? "Criar sala multi-tela" : "Iniciar transmissão";
  atualizarAvisoUpload();
  if (multi) carregarSalasMulti();
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
  if (multiSala || formModoTela === "multi") return; // multi-tela: 720p30 fixo
  telaResolucao = valor;
  ["#preset-resolucao", "#live-resolucao"].forEach(function (sel) {
    document.querySelectorAll(sel + " .botao-preset").forEach(function (b) {
      b.classList.toggle("selecionado", b.dataset.resolucao === valor);
    });
  });
  atualizarAvisoUpload();
  mostrarBadgeQualidade(telaResolucao, telaFps, null);
  if (telaEhHost && telaStream) {
    aplicarQualidadeNosViewers();
    mensagemTransmissao("Qualidade alterada: " + telaResolucao + " " + telaFps + "fps.", "sucesso");
    reiniciarEncoderRelaySeAtivo();
  }
}

function definirFps(valor) {
  if (multiSala || formModoTela === "multi") return; // multi-tela: 720p30 fixo
  telaFps = valor;
  ["#preset-fps", "#live-fps"].forEach(function (sel) {
    document.querySelectorAll(sel + " .botao-preset").forEach(function (b) {
      b.classList.toggle("selecionado", parseInt(b.dataset.fps, 10) === valor);
    });
  });
  atualizarAvisoUpload();
  mostrarBadgeQualidade(telaResolucao, telaFps, null);
  if (telaEhHost && telaStream) {
    // Não applyConstraints no meio da captura (congela a track no Chrome).
    // O timer do encoder lê telaFps ao vivo; só reconfigura/reinicia o encoder.
    aplicarQualidadeNosViewers();
    mensagemTransmissao("Qualidade alterada: " + telaResolucao + " " + telaFps + "fps.", "sucesso");
    reiniciarEncoderRelaySeAtivo();
  }
}

// Pede nova captura (o seletor do navegador permite trocar o programa/janela;
// no celular troca a câmera frente/verso) e troca a track ao vivo.
async function trocarJanelaTela() {
  if (!telaEhHost || !telaStream) return;
  if (telaFonte === "camera") {
    cameraFacing = cameraFacing === "environment" ? "user" : "environment";
  }
  var querAudio = true;
  var chkAudio = document.querySelector("#capturar-audio-tela");
  if (chkAudio) querAudio = !!chkAudio.checked;
  var novo;
  try {
    novo = await capturarMidiaTransmissao(querAudio);
  } catch (e) {
    mensagemTransmissao("Troca cancelada.");
    return;
  }

  var novaTrack = novo.getVideoTracks()[0];
  var novaAudio = novo.getAudioTracks()[0];
  var antiga = telaStream;
  var trocas = [];

  Object.keys(telaPeers).forEach(function (id) {
    telaPeers[id].getSenders().forEach(function (sender) {
      if (sender.track && sender.track.kind === "video") {
        var p = sender.replaceTrack(novaTrack);
        if (p && p.then) trocas.push(p);
      } else if (sender.track && sender.track.kind === "audio" && novaAudio) {
        var pa = sender.replaceTrack(novaAudio);
        if (pa && pa.then) trocas.push(pa);
      }
    });
  });

  function concluir() {
    antiga.getTracks().forEach(function (t) { t.stop(); });
    telaStream = novo;
    videoTransmissaoEl.srcObject = novo;
    if (novaAudio) {
      novaAudio.enabled = !audioMudo;
      iniciarEncoderAudioRelay();
    }
    novaTrack.addEventListener("ended", function () {
      encerrarTransmissao(false);
      mensagemTela("Transmissão encerrada: você parou a captura de tela.", "erro");
    });
    aplicarQualidadeNosViewers();
    var btnTrocar = document.querySelector("#trocar-janela");
    if (btnTrocar) {
      btnTrocar.textContent = telaFonte === "camera"
        ? "Trocar câmera (frente/verso)"
        : "Trocar programa/janela da transmissão";
    }
    mensagemTransmissao(
      "Fonte trocada (" + rotuloFonteCaptura() + "). Qualidade " + telaResolucao + " " + telaFps + "fps.",
      "sucesso");
  }

  if (trocas.length === 0) {
    concluir();
  } else {
    Promise.all(trocas).then(concluir).catch(function (erro) {
      console.warn("replaceTrack falhou, recriando conexões:", erro);
      concluir();
      Object.keys(telaPeers).forEach(function (id) {
        criarPeerParaViewer(id);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Compartilhar Tela - relay de vídeo por WebSocket (para a Activity)
// O Discord não suporta WebRTC dentro da Activity; o host codifica VP8 com
// WebCodecs e o servidor repassa os quadros binários até o canvas do viewer.
// ---------------------------------------------------------------------------
function iniciarDecoderRelay(resolucao, codec) {
  pararDecoderRelay();
  relayCodecAtual = codec || relayCodecAtual || "vp8";
  relayDecoderFallbackTentado = false;
  var dims = { "480p": [854, 480], "720p": [1280, 720], "1080p": [1920, 1080] }[resolucao] || [1280, 720];
  var canvas = document.querySelector("#canvas-relay");
  canvas.width = dims[0];
  canvas.height = dims[1];
  canvas.style.display = "";
  relayQuadros = 0;
  relayRxEnviado = false;
  relayPartes = {};
  relayCfgOk = false;
  relaySemOutput = 0;
  ultimoErroRelay = "";
  iniciarDecoderAudioRelay(relayAudioSr, relayAudioCh);
  relayAudioChavePendente = true;
  mostrarBadgeQualidade(resolucao, null, relayCodecAtual);
  if (typeof VideoDecoder === "undefined") {
    ultimoErroRelay = "sem VideoDecoder";
    logRelayDiag("sem_videodecoder");
    mensagemTransmissao("Seu cliente não suporta o modo de vídeo compatível.", "erro");
    return;
  }
  var ctx = canvas.getContext("2d", { alpha: false });
  var desenhados = 0;
  var errosDecoder = 0;
  relayTemKey = false;
  relayDecoder = new VideoDecoder({
    output: function (frame) {
      try {
        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
        desenhados++;
        relaySemOutput = 0;
        if (desenhados === 1) {
          relayFrameOk = true;
          clearTimeout(telaRelayTimer);
          logRelayDiag("desenhou", { quadros: relayQuadros });
          mensagemTransmissao("Recebendo vídeo de quem transmite.", "sucesso");
        }
      } catch (e) {
        ultimoErroRelay = "draw: " + e.message;
        logRelayDiag("draw_erro", { msg: e.message });
      }
      try { frame.close(); } catch (e2) { /* ignore */ }
    },
    error: function (e) {
      var texto = String(e && e.message ? e.message : e);
      ultimoErroRelay = texto;
      logRelayDiag("decoder_error", { msg: texto, quadros: relayQuadros, codec: relayCodecAtual });
      if (relayDecoder && relayDecoder.state !== "closed") {
        try { relayDecoder.close(); } catch (err) { /* ignore */ }
      }
      relayDecoder = null;
      relayTemKey = false;
      errosDecoder++;
      if (errosDecoder > 3) {
        mensagemTransmissao("Falha ao decodificar o vídeo (" +
          texto + "). Recarregue a Activity.", "erro");
        return;
      }
      // Config inválida (ex.: H.264 não suportado no viewer) → tenta VP8 1x.
      if (!relayDecoderFallbackTentado && relayCodecAtual !== "vp8") {
        relayDecoderFallbackTentado = true;
        relayCodecAtual = "vp8";
        logRelayDiag("decoder_fallback_vp8", { antes: texto });
        iniciarDecoderRelay(resolucao, "vp8");
        mensagemTransmissao("Codec do transmissor incompatível — tentando VP8...", "");
        return;
      }
      iniciarDecoderRelay(resolucao, relayCodecAtual);
      ultimoErroRelay = texto;
      // Não sobrescreve com "aguardando" — deixa o erro visível.
      mensagemTransmissao("Vídeo chegou mas falhou ao decodificar (" +
        texto + "). Tentando de novo...", "erro");
    },
  });

  // isConfigSupported ANTES de configure — senão lança "Unsupported configuration".
  var candidatos = [];
  if (relayCodecAtual === "h264") {
    candidatos.push("avc1.42001f");
    candidatos.push("vp8");
  } else {
    candidatos.push("vp8");
    candidatos.push("avc1.42001f");
  }

  function tentarCfg(lista) {
    if (!lista.length || !relayDecoder) {
      logRelayDiag("configure_sem_codec");
      mensagemTransmissao("Nenhum codec de vídeo suportado neste cliente.", "erro");
      return;
    }
    var codecStr = lista[0];
    var resto = lista.slice(1);
    var cfgDec = { codec: codecStr, optimizeForLatency: true };
    var promessa = (typeof VideoDecoder.isConfigSupported === "function")
      ? VideoDecoder.isConfigSupported(cfgDec)
      : Promise.resolve({ supported: true });

    promessa.then(function (sup) {
      if (!relayDecoder) return;
      if (sup && sup.supported === false) {
        logRelayDiag("decoder_nao_suportado", { codec: codecStr });
        tentarCfg(resto);
        return;
      }
      try {
        relayDecoder.configure(cfgDec);
        relayCfgOk = relayDecoder.state === "configured";
        relayCodecAtual = (codecStr.indexOf("avc") === 0) ? "h264" : "vp8";
        logRelayDiag("decoder_cfg", { state: relayDecoder.state, codec: codecStr, ok: relayCfgOk });
        if (!relayCfgOk) tentarCfg(resto);
      } catch (err) {
        logRelayDiag("configure_erro", { msg: err.message, codec: codecStr });
        tentarCfg(resto);
      }
    }).catch(function () {
      if (!relayDecoder) return;
      try {
        relayDecoder.configure(cfgDec);
        relayCfgOk = relayDecoder.state === "configured";
        logRelayDiag("decoder_cfg", { state: relayDecoder.state, codec: codecStr, via: "catch" });
      } catch (err) {
        logRelayDiag("configure_erro", { msg: err.message, codec: codecStr });
        tentarCfg(resto);
      }
    });
  }

  tentarCfg(candidatos);
}

function pararDecoderRelay() {
  relayTemKey = false;
  if (relayDecoder) {
    try { if (relayDecoder.state !== "closed") relayDecoder.close(); } catch (e) { /* ignore */ }
    relayDecoder = null;
  }
  pararDecoderAudioRelay();
}

// ---------------------------------------------------------------------------
// Áudio no relay: host codifica Opus → JSON base64 → servidor → viewer
// ---------------------------------------------------------------------------
function iniciarEncoderAudioRelay() {
  pararEncoderAudioRelay();
  if (!telaEhHost || !telaStream) return;
  var track = telaStream.getAudioTracks()[0];
  if (!track) {
    logRelayDiag("audio_sem_track");
    return;
  }
  if (typeof MediaStreamTrackProcessor === "undefined" || typeof AudioEncoder === "undefined") {
    logRelayDiag("sem_audio_encoder");
    return;
  }
  try {
    var proc = new MediaStreamTrackProcessor({ track: track });
    relayAudioReader = proc.readable.getReader();
  } catch (e) {
    logRelayDiag("audio_processor_erro", { msg: e.message });
    return;
  }
  var cfgFeita = false;
  relayAudioLoopAtivo = true;
  relayAudioEncoder = new AudioEncoder({
    output: function (chunk) {
      try {
        if (!telaWs || telaWs.readyState !== WebSocket.OPEN) return;
        if (relayAudioMudoHost) return;
        var bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        var s = "";
        for (var i = 0; i < bytes.length; i += 0x8000) {
          s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        enviarTela({
          tipo: "audio",
          t: chunk.timestamp,
          k: chunk.type === "key" ? 1 : 0,
          sr: relayAudioSr,
          ch: relayAudioCh,
          d: btoa(s),
        });
      } catch (e) { /* ignore */ }
    },
    error: function (e) {
      logRelayDiag("audio_enc_erro", { msg: e && e.message ? e.message : e });
    },
  });
  (async function pump() {
    while (relayAudioLoopAtivo && relayAudioReader) {
      try {
        var r = await relayAudioReader.read();
        if (r.done) break;
        var frame = r.value;
        if (!cfgFeita && relayAudioEncoder) {
          // Trava em 48k/estéreo quando o track permite — decoder fixo neles.
          relayAudioSr = frame.sampleRate || 48000;
          relayAudioCh = Math.min(2, Math.max(1, frame.numberOfChannels || 1));
          relayAudioEncoder.configure({
            codec: "opus",
            sampleRate: relayAudioSr,
            numberOfChannels: relayAudioCh,
            bitrate: 64000,
          });
          cfgFeita = true;
          relayAudioCfgOk = true;
          relayAudioChavePendente = true;
          logRelayDiag("audio_enc_cfg", {
            state: relayAudioEncoder.state,
            sr: relayAudioSr,
            ch: relayAudioCh,
          });
        }
        if (relayAudioEncoder && relayAudioEncoder.state === "configured"
            && relayAudioEncoder.encodeQueueSize < 20
            && !relayAudioMudoHost) {
          relayAudioEncoder.encode(frame);
        }
        if (frame.close) frame.close();
      } catch (e) {
        break;
      }
    }
  })();
}

function pararEncoderAudioRelay() {
  relayAudioLoopAtivo = false;
  if (relayAudioReader) {
    try { relayAudioReader.cancel(); } catch (e) { /* ignore */ }
    relayAudioReader = null;
  }
  if (relayAudioEncoder) {
    try { if (relayAudioEncoder.state !== "closed") relayAudioEncoder.close(); } catch (e) { /* ignore */ }
    relayAudioEncoder = null;
  }
}

function iniciarDecoderAudioRelay(sr, ch) {
  pararDecoderAudioRelay();
  if (typeof AudioDecoder === "undefined" || typeof AudioContext === "undefined") {
    logRelayDiag("sem_audio_decoder");
    return;
  }
  var taxa = sr || 48000;
  var canais = ch || 2;
  try {
    var relayAudioCtxTry = null;
    try {
      relayAudioCtxTry = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    } catch (eCtx) {
      try {
        relayAudioCtxTry = new AudioContext({ latencyHint: "interactive" });
      } catch (eCtx2) {
        relayAudioCtxTry = new AudioContext();
      }
    }
    relayAudioCtx = relayAudioCtxTry;
    relayAudioGain = relayAudioCtx.createGain();
    relayAudioGain.gain.value = audioMudo ? 0 : volumeLocal;
    relayAudioGain.connect(relayAudioCtx.destination);
    relayAudioProxima = 0;
    relayAudioDecoder = new AudioDecoder({
      output: function (frame) {
        try {
          if (!relayAudioCtx || !relayAudioGain) { frame.close(); return; }
          if (relayAudioCtx.state === "suspended") {
            relayAudioCtx.resume().catch(function () {});
          }
          var canaisF = frame.numberOfChannels;
          var n = frame.numberOfFrames;
          var ab = relayAudioCtx.createBuffer(canaisF, n, frame.sampleRate);
          for (var c = 0; c < canaisF; c++) {
            var plane = new Float32Array(n);
            frame.copyTo(plane, { planeIndex: c, format: "f32-planar" });
            ab.copyToChannel(plane, c);
          }
          var src = relayAudioCtx.createBufferSource();
          src.buffer = ab;
          src.connect(relayAudioGain);
          var agora = relayAudioCtx.currentTime;
          if (relayAudioProxima < agora || relayAudioProxima > agora + 0.5) {
            relayAudioProxima = agora + 0.02;
          }
          src.start(relayAudioProxima);
          relayAudioProxima += n / frame.sampleRate;
        } catch (e) { /* ignore */ }
        try { frame.close(); } catch (e2) { /* ignore */ }
      },
      error: function (e) {
        logRelayDiag("audio_dec_erro", { msg: e && e.message ? e.message : e });
      },
    });
    relayAudioDecoder.configure({ codec: "opus", sampleRate: taxa, numberOfChannels: canais });
    relayAudioCfgOk = true;
    relayAudioCfgDecoder = { sr: taxa, ch: canais };
    logRelayDiag("audio_dec_cfg", { state: relayAudioDecoder.state, sr: taxa, ch: canais });
  } catch (e) {
    logRelayDiag("audio_dec_init_erro", { msg: e.message });
  }
}

function pararDecoderAudioRelay() {
  relayAudioCfgOk = false;
  relayAudioCfgDecoder = { sr: 0, ch: 0 };
  if (relayAudioDecoder) {
    try { if (relayAudioDecoder.state !== "closed") relayAudioDecoder.close(); } catch (e) { /* ignore */ }
    relayAudioDecoder = null;
  }
  if (relayAudioCtx) {
    try { relayAudioCtx.close(); } catch (e) { /* ignore */ }
    relayAudioCtx = null;
    relayAudioGain = null;
  }
}

function receberAudioRelay(dados) {
  if (!telaModoRelay || telaEhHost || !dados || !dados.d) return;
  var sr = parseInt(dados.sr, 10) || 48000;
  var ch = parseInt(dados.ch, 10) || 2;
  if (relayAudioDecoder
      && relayAudioDecoder.state !== "closed"
      && (relayAudioCfgDecoder.sr !== sr || relayAudioCfgDecoder.ch !== ch)) {
    iniciarDecoderAudioRelay(sr, ch);
  }
  if (!relayAudioDecoder || relayAudioDecoder.state === "closed") {
    iniciarDecoderAudioRelay(sr, ch);
    if (!relayAudioDecoder || relayAudioDecoder.state === "closed") return;
  }
  if (relayAudioCtx && relayAudioCtx.state === "suspended") {
    relayAudioCtx.resume().catch(function () {});
  }
  try {
    var bin = atob(dados.d);
    var payload = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) payload[i] = bin.charCodeAt(i);
    if (relayAudioDecoder.decodeQueueSize > 40) return;
    var tipo = "delta";
    if (dados.k) {
      tipo = "key";
    } else if (relayAudioChavePendente) {
      tipo = "key";
      relayAudioChavePendente = false;
    }
    relayAudioDecoder.decode(new EncodedAudioChunk({
      type: tipo,
      timestamp: dados.t || 0,
      data: payload,
    }));
  } catch (e) {
    logRelayDiag("audio_rx_erro", { msg: e.message });
  }
}

function desbloquearAudioRelay() {
  if (relayAudioCtx && relayAudioCtx.state === "suspended") {
    relayAudioCtx.resume().then(function () {
      logRelayDiag("audio_ctx_resumed");
    }).catch(function () {});
  }
}
document.addEventListener("pointerdown", desbloquearAudioRelay, { passive: true });
document.addEventListener("keydown", desbloquearAudioRelay);

function aplicarVolumeLocal() {
  videoTransmissaoEl.volume = volumeLocal;
  if (relayAudioGain) relayAudioGain.gain.value = audioMudo ? 0 : volumeLocal;
  desbloquearAudioRelay();
  // Host: mudo no envio (track) — preview local NUNCA toca (eco).
  if (telaEhHost && telaStream) {
    var tr = telaStream.getAudioTracks()[0];
    if (tr) tr.enabled = !audioMudo;
    relayAudioMudoHost = audioMudo;
    videoTransmissaoEl.muted = true;
    if (hostOffVideo) hostOffVideo.muted = true;
    var tileHost = multiTiles[telaSala] || multiTiles[multiHostSala];
    if (tileHost && tileHost.preview) tileHost.preview.muted = true;
  }
  // Viewer WebRTC: mudo no elemento.
  if (!telaEhHost && !telaModoRelay) {
    videoTransmissaoEl.muted = audioMudo;
  }
}

function definirTamanhoVideo(tam) {
  var classes = ["tam-p", "tam-m", "tam-g", "tam-full"];
  [videoTransmissaoEl, canvasRelayEl].forEach(function (el) {
    if (!el) return;
    classes.forEach(function (c) { el.classList.remove(c); });
    el.classList.add("tam-" + tam);
  });
  document.querySelectorAll("#tamanho-video .botao-preset").forEach(function (b) {
    b.classList.toggle("selecionado", b.dataset.tam === tam);
  });
  // Tela cheia ocupa a Activity inteira (esconde header/footer/controles fixos).
  if (tam === "full") {
    document.body.classList.add("modo-cheia-transmissao");
    agendarEsconderControles();
  } else {
    document.body.classList.remove("modo-cheia-transmissao");
    cancelarEsconderControles();
    if (controlesTransmissaoEl) controlesTransmissaoEl.classList.remove("oculto");
  }
  try { localStorage.setItem("jj_tela_tam", tam); } catch (e) { /* ignore */ }
}

// Auto-hide dos controles P/M/G na tela cheia (estilo YouTube).
var controlesHideTimer = null;
function agendarEsconderControles() {
  if (!controlesTransmissaoEl) return;
  controlesTransmissaoEl.classList.remove("oculto");
  clearTimeout(controlesHideTimer);
  controlesHideTimer = setTimeout(function () {
    if (document.body.classList.contains("modo-cheia-transmissao")) {
      controlesTransmissaoEl.classList.add("oculto");
    }
  }, 2500);
}
function cancelarEsconderControles() {
  clearTimeout(controlesHideTimer);
  controlesHideTimer = null;
}
document.addEventListener("mousemove", function () {
  if (document.body.classList.contains("modo-cheia-transmissao")) agendarEsconderControles();
});
document.addEventListener("touchstart", function () {
  if (document.body.classList.contains("modo-cheia-transmissao")) agendarEsconderControles();
});

function receberRelay(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 5) return;
  var dv = new DataView(buffer);
  decodificarRelayFrame(dv.getUint8(0) === 1, dv.getUint32(1), new Uint8Array(buffer, 5));
}

function decodificarRelayFrame(ehKey, timestamp, payload) {
  if (!relayDecoder || relayDecoder.state === "closed") {
    if (!relayDecoder) logRelayDiag("decode_sem_decoder", { quadros: relayQuadros });
    return;
  }
  if (!payload || payload.byteLength < 1) return;
  // VP8 exige keyframe para começar (viewer pode entrar no meio do GOP).
  if (!ehKey && !relayTemKey) return;
  if (ehKey) relayTemKey = true;
  var maxDecodeRelay = multiSala ? 12 : 30;
  if (relayDecoder.decodeQueueSize > maxDecodeRelay && !ehKey) return;
  relayQuadros++;
  if (!relayRxEnviado) {
    relayRxEnviado = true;
    enviarTela({ tipo: "quadro_rx" });
    logRelayDiag("primeiro_decode", {
      k: ehKey ? 1 : 0, bytes: payload.byteLength, quadros: relayQuadros
    });
  }
  try {
    // WebCodecs exige EncodedVideoChunk — objeto literal lança TypeError.
    var chunk = new EncodedVideoChunk({
      type: ehKey ? "key" : "delta",
      timestamp: timestamp,
      data: payload,
    });
    relayDecoder.decode(chunk);
    relaySemOutput++;
    // Envia N decodes sem output do decoder → problema de decode.
    if (relaySemOutput === 30 && !relayFrameOk) {
      logRelayDiag("sem_output", { quadros: relayQuadros, state: relayDecoder.state });
    }
  } catch (e) {
    ultimoErroRelay = "decode: " + e.message;
    relayTemKey = false;
    logRelayDiag("decode_erro", { msg: e.message, k: ehKey ? 1 : 0, quadros: relayQuadros });
  }
  if (!relayFrameOk) {
    clearTimeout(telaRelayTimer);
    telaRelayTimer = setTimeout(function () {
      if (!relayFrameOk && telaModoRelay) {
        diagnosticarRelaySemVideo();
      }
    }, 8000);
  }
}

// Monta quadro fragmentado (proxy do Discord cai com mensagem única grande).
function montarQuadroRelay(dados) {
  if (!dados || !dados.d) return;
  if (!dados.n || dados.n <= 1) {
    processarParteRelay(dados.t, dados);
    return;
  }
  var t = dados.t;
  var buf = relayPartes[t];
  if (!buf) {
    buf = relayPartes[t] = { k: dados.k, n: dados.n, recebidas: 0, partes: [] };
  }
  if (buf.partes[dados.i]) return;
  buf.partes[dados.i] = dados.d;
  buf.recebidas++;
  if (buf.recebidas >= buf.n) {
    delete relayPartes[t];
    processarParteRelay(t, { k: buf.k, d: buf.partes.join("") });
  }
}

function processarParteRelay(t, dados) {
  try {
    var bin = atob(dados.d);
    var payload = new Uint8Array(bin.length);
    for (var qi = 0; qi < bin.length; qi++) payload[qi] = bin.charCodeAt(qi);
    decodificarRelayFrame(dados.k === 1, t >>> 0, payload);
  } catch (e) {
    console.warn("quadro relay:", e);
  }
}

async function iniciarEncoderRelay() {
  if (relayAtivo || !telaEhHost) return;
  if (!telaStream) {
    enviarTela({ tipo: "relay_erro", mensagem: "Captura de tela indisponível no transmissor." });
    return;
  }
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") {
    enviarTela({ tipo: "relay_erro", mensagem: "Navegador de quem transmite não tem WebCodecs." });
    return;
  }
  relayAtivo = true;
  var preset = TELA_PRESETS[telaResolucao];

  var canvas = document.createElement("canvas");
  canvas.width = preset.largura;
  canvas.height = preset.altura;
  var ctx = canvas.getContext("2d", { alpha: false });

  var video = hostVideoEncoder();
  var tsUs = 0;
  var ultimoKey = 0;
  var ticksSemVideo = 0;
  var inicioSemChunk = performance.now();
  var saidasRecebidas = 0;

  relayEncoder = new VideoEncoder({
    output: function (chunk) {
      try {
        saidasRecebidas++;
        if (!telaWs || telaWs.readyState !== WebSocket.OPEN) return;
        var dados = new Uint8Array(chunk.byteLength);
        chunk.copyTo(dados);
        // O proxy do Discord NÃO repassa frame binário no WS da Activity —
        // manda como JSON base64 em partes de ~12KB (mensagem única grande cai).
        var s = "";
        for (var i = 0; i < dados.length; i += 0x8000) {
          s += String.fromCharCode.apply(null, dados.subarray(i, i + 0x8000));
        }
        var b64 = btoa(s);
        var k = chunk.type === "key" ? 1 : 0;
        var t = chunk.timestamp;
        var TAM = 12000;
        if (b64.length <= TAM) {
          enviarTela({ tipo: "quadro", k: k, t: t, d: b64 });
        } else {
          var n = Math.ceil(b64.length / TAM);
          for (var pi = 0; pi < n; pi++) {
            enviarTela({
              tipo: "quadro", k: k, t: t, n: n, i: pi,
              d: b64.slice(pi * TAM, (pi + 1) * TAM),
            });
          }
        }
        if (!relayProntoEnviado) {
          relayProntoEnviado = true;
          enviarTela({ tipo: "relay_pronto", codec: relayCodecAtual });
        }
      } catch (e) {
        enviarTela({ tipo: "relay_erro", mensagem: "Falha ao enviar quadro do encoder: " + e.message });
        pararEncoderRelay();
      }
    },
    error: function (e) {
      console.warn("Encoder relay:", e);
      enviarTela({ tipo: "relay_erro", mensagem: String(e && e.message ? e.message : e) });
      pararEncoderRelay();
    },
  });

  // Prefere VP8 no relay: o viewer da Activity nem sempre tem H.264 em WebCodecs.
  // (H.264 quebrava com "Unsupported configuration" no decoder.)
  relayCodecAtual = "vp8";
  enviarTela({ tipo: "relay_codec", codec: "vp8" });
  logRelayDiag("encoder_codec", { codec: "vp8" });

  function cfgEncoder(w, h) {
    return {
      codec: "vp8",
      width: w,
      height: h,
      framerate: telaFps,
      bitrate: bitrateRelay(),
      latencyMode: "realtime",
    };
  }

  try {
    relayEncoder.configure(cfgEncoder(canvas.width, canvas.height));
  } catch (e) {
    // contentHint/latencyMode podem não existir — reconfigura sem.
    try {
      relayEncoder.configure({
        codec: "vp8",
        width: canvas.width,
        height: canvas.height,
        framerate: telaFps,
        bitrate: bitrateRelay(),
      });
    } catch (e2) {
      enviarTela({ tipo: "relay_erro", mensagem: "Falha ao configurar encoder: " + e2.message });
      pararEncoderRelay();
      return;
    }
  }

  // Aba em segundo plano: Chrome pausa/throttla timers — reforça o play e
  // força keyframe ao voltar para a frente.
  function aoVoltarAba() {
    if (!document.hidden && relayAtivo && video) {
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
      relayForcarKey = true;
    }
  }
  document.addEventListener("visibilitychange", aoVoltarAba);
  relayEncoderVisibilityListener = aoVoltarAba;

  // setTimeout recursivo: lê telaFps ao vivo e não acumula atraso como setInterval.
  var relayDrawRodando = false;
  function agendarDraw() {
    if (!relayAtivo || relayDrawRodando) return;
    relayDrawRodando = true;
    var intervalo = Math.max(16, Math.floor(1000 / telaFps));
    relayDrawTimer = setTimeout(function () {
      relayDrawRodando = false;
      if (!relayAtivo || !relayEncoder || relayEncoder.state === "closed") return;
      // Multi: reavalia a fonte (tile.preview pode só existir depois do grid).
      if (multiSala) {
        var fonte = hostVideoEncoder();
        if (fonte && fonte !== video) video = fonte;
      }
      if (video && video.paused) {
        var p = video.play();
        if (p && p.catch) p.catch(function () {});
      }
      if (!video || video.readyState < 2 || !video.videoWidth) {
        ticksSemVideo++;
        if (ticksSemVideo === 300) { // ~10s mesmo com timer throttado
          enviarTela({ tipo: "relay_erro", mensagem: "O vídeo da captura não carregou no transmissor (readyState=" +
            (video ? video.readyState : "nulo") + ", escondido=" + document.hidden + "). Ctrl+F5 e transmita de novo." });
          pararEncoderRelay();
        }
        agendarDraw();
        return;
      }
      ticksSemVideo = 0;
      // Fila maior = menos frames descartados em picos (qualidade/fps).
      // Multi: fila > 6 começa a atrasar — descarta antes (menos delay).
      var maxFila = multiSala ? 6 : 4;
      if (relayEncoder.encodeQueueSize > maxFila) {
        agendarDraw();
        return;
      }
      var frame;
      try {
        // Usa o tamanho REAL do vídeo capturado (não força upscale do preset).
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          var vw = video.videoWidth || canvas.width;
          var vh = video.videoHeight || canvas.height;
          // Limita ao preset (não manda acima do combinado).
          var maxW = preset.largura;
          var maxH = preset.altura;
          var escala = Math.min(1, maxW / vw, maxH / vh);
          canvas.width = Math.round(vw * escala);
          canvas.height = Math.round(vh * escala);
          if (relayEncoder.state === "configured") {
            // Reconfigura o encoder com a resolução real.
            relayEncoder.configure(cfgEncoder(canvas.width, canvas.height));
          }
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        frame = new VideoFrame(canvas, { timestamp: tsUs });
      } catch (e) {
        enviarTela({ tipo: "relay_erro", mensagem: "Falha ao capturar quadro: " + e.message });
        pararEncoderRelay();
        return;
      }
      tsUs += Math.round(1000000 / telaFps);
      var agora = performance.now();
      // Keyframe: multi 500ms (join rápido + menos delay acumulado no GOP),
      // single 1s (economiza bitrate).
      var intervaloKey = multiSala ? 500 : 1000;
      var forcar = relayForcarKey || (agora - ultimoKey) >= intervaloKey;
      if (forcar) { ultimoKey = agora; relayForcarKey = false; }
      try {
        relayEncoder.encode(frame, { keyFrame: forcar });
      } catch (e) {
        enviarTela({ tipo: "relay_erro", mensagem: "encode() falhou: " + e.message });
        frame.close();
        pararEncoderRelay();
        return;
      }
      frame.close();
      if (!relayProntoEnviado && (performance.now() - inicioSemChunk) > 6000) {
        enviarTela({ tipo: "relay_erro", mensagem: "Encoder sem chunk em 6s (saidas=" + saidasRecebidas +
          ", estado=" + relayEncoder.state + ", escondido=" + document.hidden + ")." });
        pararEncoderRelay();
        return;
      }
      agendarDraw();
    }, intervalo);
  }
  agendarDraw();
}

// Vídeo do host na multi-tela: a seção #tela-transmissao fica escondida.
// Prefere o preview visível do tile; senão usa um <video> minúsculo ON-SCREEN
// (left:-9999px pode não ser pintado pelo compositor → fps cai / atraso sobe).
var hostOffVideo = null;
function hostVideoEncoder() {
  if (multiSala && telaEhHost && telaStream) {
    var tileHost = multiTiles[telaSala] || multiTiles[multiHostSala];
    if (tileHost && tileHost.preview && tileHost.preview.srcObject === telaStream) {
      if (tileHost.preview.paused) {
        var pr0 = tileHost.preview.play();
        if (pr0 && pr0.catch) pr0.catch(function () {});
      }
      if (hostOffVideo && hostOffVideo.srcObject) hostOffVideo.srcObject = null;
      return tileHost.preview;
    }
    if (!hostOffVideo) {
      hostOffVideo = document.createElement("video");
      hostOffVideo.autoplay = true;
      hostOffVideo.muted = true;
      hostOffVideo.playsInline = true;
      hostOffVideo.setAttribute("playsinline", "");
      hostOffVideo.style.cssText =
        "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.02;pointer-events:none;z-index:1;";
      document.body.appendChild(hostOffVideo);
    }
    if (hostOffVideo.srcObject !== telaStream) hostOffVideo.srcObject = telaStream;
    if (hostOffVideo.paused) {
      var pr = hostOffVideo.play();
      if (pr && pr.catch) pr.catch(function () {});
    }
    return hostOffVideo;
  }
  if (hostOffVideo && hostOffVideo.srcObject) hostOffVideo.srcObject = null;
  return videoTransmissaoEl;
}

function pararEncoderRelay() {
  relayAtivo = false;
  relayProntoEnviado = false;
  clearTimeout(relayDrawTimer);
  clearInterval(relayDrawTimer);
  relayDrawTimer = null;
  if (relayEncoderVisibilityListener) {
    document.removeEventListener("visibilitychange", relayEncoderVisibilityListener);
    relayEncoderVisibilityListener = null;
  }
  if (relayEncoder) {
    try { if (relayEncoder.state !== "closed") relayEncoder.close(); } catch (e) { /* ignore */ }
    relayEncoder = null;
  }
  pararEncoderAudioRelay();
}

function reiniciarEncoderRelaySeAtivo() {
  if (relayAtivo) {
    pararEncoderRelay();
    if (telaRelayTotal > 0) {
      iniciarEncoderRelay().catch(function (e) {
        console.warn("Encoder relay:", e);
        enviarTela({ tipo: "relay_erro", mensagem: String(e) });
      });
      iniciarEncoderAudioRelay();
    }
  }
}

// ---------------------------------------------------------------------------
// Compartilhar Tela - hub
// ---------------------------------------------------------------------------
function abrirTelaCompartilhar() {
  mostrarTela(telaCompartilhar);
  mensagemTela("");
  var naActivity = dentroDaActivity();
  var celular = ehMobile();
  // Celular não transmite: nenhum browser mobile tem getDisplayMedia.
  document.querySelector("#tela-aviso-navegador").style.display = (naActivity && !celular) ? "" : "none";
  var painel = document.querySelector("#painel-criar");
  if (painel) painel.style.display = (naActivity || celular) ? "none" : "";
  document.querySelector("#abrir-navegador-tela").style.display = "";
  var avisoMobile = document.querySelector("#tela-aviso-mobile");
  if (avisoMobile) {
    avisoMobile.style.display = celular ? "" : "none";
  }

  // Lista sempre visível: salas públicas + da call (se houver instância).
  document.querySelector("#lista-transmissoes").style.display = "";
  document.querySelector("#atualizar-transmissoes").style.display = "";
  document.querySelector("#assistir-titulo-lista").style.display = "";
  document.querySelector("#assistir-titulo-lista").textContent = "Transmissões públicas";

  aplicarFormularioCriacao();
  atualizarAvisoUpload();
  carregarTransmissoes();
  carregarSalasMulti();
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
    try {
      var resMulti = await fetch("./multitela/salas");
      var dadosMulti = await resMulti.json();
      (dadosMulti.salas || []).forEach(function (s) {
        lista.push({
          multi: true,
          sala: s.sala,
          nick: s.dono_nick || "Anônimo",
          avatar: s.dono_avatar || null,
          publica: true,
          resolucao: "720p",
          fps: 30,
          espectadores: s.total_membros || 0,
          nome: s.nome,
          lives: s.total_lives || 0,
        });
      });
    } catch (eMulti) { /* lista multi é opcional */ }
    container.innerHTML = "";

    if (lista.length === 0) {
      container.innerHTML = '<p class="vazio">Nenhuma transmissão ativa.</p>';
      return;
    }

    lista.forEach(function (t) {
      var item = document.createElement("div");
      item.className = "sala-item";
      var avatarHtml = t.avatar
        ? '<img class="sala-item-avatar" src="' + escapeHtml(t.avatar) + '" alt="" />'
        : '<span class="sala-item-avatar sala-item-avatar-inicial">' + escapeHtml((t.nick || "?").charAt(0).toUpperCase()) + "</span>";
      item.innerHTML =
        '<div class="sala-item-info">' +
        avatarHtml +
        "<span><strong>" + escapeHtml(t.multi ? (t.nome || t.nick) : t.nick) + "</strong>" +
        (t.multi ? ' <span class="etiqueta-publica">multi-tela</span>' : "") +
        (t.publica && !t.multi ? ' <span class="etiqueta-publica">pública</span>' : "") +
        "<small>" + t.resolucao + " &middot; " + t.fps + " fps &middot; sala " + escapeHtml(t.sala) +
        (t.multi ? " &middot; " + (t.lives || 0) + "/8 telas" : "") + "</small></span>" +
        "</div>" +
        '<span class="sala-item-jogadores">&#128247; ' + t.espectadores + (t.multi ? "" : "/9") + "</span>";
      item.addEventListener("click", function () {
        if (t.multi) entrarSalaMulti(t.sala);
        else assistirTransmissao(t.sala);
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
function ehMobile() {
  var ua = navigator.userAgent || "";
  if (/Android|iPhone|iPad|iPod|Mobile|Silk/i.test(ua)) return true;
  return navigator.maxTouchPoints > 1 && Math.min(window.innerWidth, window.innerHeight) < 900;
}

function suportaCapturaTela() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

async function opcoesCapturaVideo() {
  var preset = TELA_PRESETS[telaResolucao];
  // max 60 desde o início: trocar 30→60 ao vivo não pede nova captura.
  return {
    width: { ideal: preset.largura },
    height: { ideal: preset.altura },
    frameRate: { ideal: telaFps, max: 60 },
  };
}

function podeCapturarMidia() {
  if (navigator.mediaDevices && (navigator.mediaDevices.getDisplayMedia || navigator.mediaDevices.getUserMedia)) {
    return true;
  }
  return !!(navigator.webkitGetUserMedia || navigator.getUserMedia || navigator.mozGetUserMedia);
}

function gumLegado(constraints) {
  return new Promise(function (resolve, reject) {
    var fn = navigator.mediaDevices && navigator.mediaDevices.getUserMedia
      ? null
      : (navigator.webkitGetUserMedia || navigator.getUserMedia || navigator.mozGetUserMedia);
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia(constraints).then(resolve, reject);
      return;
    }
    if (!fn) {
      reject(new Error("SEU_NAVEGADOR_SEM_CAPTURE"));
      return;
    }
    fn.call(navigator, constraints, resolve, reject);
  });
}

async function capturarMidiaTransmissao(querAudio) {
  var video = await opcoesCapturaVideo();
  var semDisplay = !suportaCapturaTela();

  // 1) Tenta Screen Capture API em qualquer dispositivo (desktop e mobile).
  // No Chrome Android/iOS o picker pode não existir → cai no fallback câmera.
  if (suportaCapturaTela()) {
    try {
      var opcoes = {
        video: video,
        // Tela inteira: permite "Share system audio" (usuário pode marcar).
        systemAudio: "include",
        // NÃO usar windowAudio:"window" — no Chrome 143+ vira "exclude" e
        // MATA o áudio ao compartilhar janela. Default oferece áudio normal.
      };
      opcoes.audio = querAudio ? {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      } : false;
      telaFonte = "tela";
      var streamDisplay = await navigator.mediaDevices.getDisplayMedia(opcoes);
      try {
        var st = streamDisplay.getVideoTracks()[0] &&
          streamDisplay.getVideoTracks()[0].getSettings
          ? streamDisplay.getVideoTracks()[0].getSettings() : {};
        logRelayDiag("display_capture", {
          surface: st.displaySurface || "?",
          temAudio: streamDisplay.getAudioTracks().length > 0,
        });
      } catch (eSt) { /* settings é best-effort */ }
      return streamDisplay;
    } catch (e) {
      if (e && (e.name === "NotAllowedError" || e.name === "AbortError")) {
        // Mobile: sem picker de tela → tenta câmera em vez de abortar.
        if (!ehMobile()) throw e;
        logRelayDiag("displaymedia_negado_mobile", { msg: e && e.message });
      } else {
        logRelayDiag("displaymedia_falhou", { msg: e && e.message });
      }
    }
  }

  if (!podeCapturarMidia()) {
    if (!window.isSecureContext) {
      throw new Error("INSEGURO");
    }
    throw new Error("SEU_NAVEGADOR_SEM_CAPTURE");
  }

  // 2) Firefox — screen via getUserMedia legado.
  if (telaFonte !== "camera") {
    try {
      telaFonte = "tela_legado";
      return await gumLegado({
        video: Object.assign({ mediaSource: "screen" }, video),
        audio: querAudio ? {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        } : false,
      });
    } catch (e) {
      if (e && e.name === "NotAllowedError" && !ehMobile()) throw e;
      logRelayDiag("screen_legado_falhou", { msg: e && e.message });
    }
  }

  // 3) Tela indisponível/negada → câmera (frente/verso).
  telaFonte = "camera";
  if (semDisplay || ehMobile()) {
    logRelayDiag("fallback_camera_mobile", { semDisplay: semDisplay });
  }
  try {
    return await gumLegado({
      video: Object.assign({ facingMode: { ideal: cameraFacing } }, video),
      audio: querAudio ? {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      } : false,
    });
  } catch (e) {
    if (e && e.message === "SEU_NAVEGADOR_SEM_CAPTURE") throw e;
    if (e && e.name === "NotAllowedError") throw e;
    // Último recurso: constraints mínimos (câmera traseira simples).
    try {
      return await gumLegado({
        video: { facingMode: "environment" },
        audio: false,
      });
    } catch (e2) {
      throw e;
    }
  }
}

function rotuloFonteCaptura() {
  if (telaFonte === "camera") return "câmera do celular";
  if (telaFonte === "tela_legado") return "tela";
  return "tela";
}

async function iniciarTransmissaoTela() {
  // Celular não tem captura de tela em navegador → bloqueia transmissão.
  if (ehMobile()) {
    mensagemTela("Celulares não conseguem transmitir — use o computador. No celular você ainda pode assistir às transmissões.", "erro");
    return;
  }
  // Painel em modo multi sem sala ainda → cria a sala e depois compartilha.
  if (formModoTela === "multi" && !multiSala) {
    await iniciarCriacaoMultiPainel();
    return;
  }
  if (!podeCapturarMidia()) {
    if (!window.isSecureContext) {
      mensagemTela("Abra o site em https:// para usar câmera/tela. No Discord, use o app ou navegador seguro.", "erro");
    } else {
      mensagemTela(
        "Seu navegador não permite câmera nem captura de tela. " +
        "Tente Chrome/Edge no computador, ou no celular abra em https:// com permissão de câmera.",
        "erro");
      if (/Android|iPhone|iPad/i.test(navigator.userAgent || "")) {
        var btnNav = document.querySelector("#btn-abrir-navegador");
        if (!btnNav) {
          btnNav = document.createElement("button");
          btnNav.id = "btn-abrir-navegador";
          btnNav.className = "botao";
          btnNav.style.marginTop = "10px";
          btnNav.textContent = "Abrir no navegador do celular";
          btnNav.addEventListener("click", function () {
            window.open(location.href, "_blank");
          });
          var barra = document.querySelector("#controles-transmissao") ||
            document.querySelector("#mensagem-transmissao");
          if (barra && barra.parentNode) barra.parentNode.insertBefore(btnNav, barra.nextSibling);
        }
      }
    }
    return;
  }

  var valCod = codigoCustomValido(formTipoSala === "privada");
  if (valCod.erro) {
    mensagemTela(valCod.erro, "erro");
    return;
  }
  var codigoCustom = valCod.codigo;

  var querAudio = true;
  var chkAudio = document.querySelector("#capturar-audio-tela");
  if (chkAudio) querAudio = !!chkAudio.checked;

  try {
    telaStream = await capturarMidiaTransmissao(querAudio);
  } catch (e) {
    if (e && e.message === "INSEGURO") {
      avisoTela("Abra em https:// — o navegador bloqueia câmera/tela fora de conexão segura.", "erro");
    } else if (e && e.message === "SEU_NAVEGADOR_SEM_CAPTURE") {
      avisoTela(
        "Este navegador não liberou câmera nem tela. No celular, permita a câmera nas permissões do site " +
        "(ícone de cadeado → Câmera → Permitir) e tente de novo.",
        "erro");
    } else if (e && e.name === "NotAllowedError") {
      avisoTela("Permissão negada. Autorize a câmera/tela nas permissões do site e tente de novo.", "erro");
    } else if (e && e.name === "NotReadableError") {
      avisoTela("A câmera está em uso por outro app. Feche o outro app e tente de novo.", "erro");
    } else if (e && e.name === "OverconstrainedError") {
      avisoTela("Não consegui abrir a câmera com essa qualidade. Tente de novo.", "erro");
    } else {
      avisoTela("Captura cancelada ou falhou: " + (e && e.message ? e.message : "erro desconhecido"), "erro");
    }
    return;
  }

  // Tela indisponível/negada → câmera: avisa o usuário (pós-falha).
  if (telaFonte === "camera" && ehMobile()) {
    avisoTela("Seu navegador não permitiu capturar a tela — transmitindo pela câmera (frente/verso).", "");
  }

  // Prefer fluidez sobre nitidez (menos delay no relay/multi).
  var trVidCap = telaStream.getVideoTracks()[0];
  if (trVidCap && "contentHint" in trVidCap) trVidCap.contentHint = "motion";

  // Avisa se o Chrome não devolveu áudio (usuário não marcou a opção).
  if (querAudio && !telaStream.getAudioTracks().length) {
    if (telaFonte === "camera") {
      avisoTela(
        "Microfone não capturado: permita o microfone no celular/navegador.", "erro");
    } else {
      avisoTela(
        "Áudio não capturado: no seletor do Chrome, marque \"Compartilhar áudio\" " +
        "(aba: \"Share tab audio\"; tela: \"Share system audio\"). " +
        "Em janela, use a aba se não houver opção de áudio. " +
        "Você pode recapturar com Trocar janela depois.", "erro");
    }
  }

  await garantirIdentidade();
  var nick = nomeExibicao();
  var avatar = avatarAtual();
  var instancia = compartilharInstanciaAtual() || null;
  var publica = formTipoSala === "publica";
  if (multiSala) {
    // Multi-tela: qualidade travada em 720p30, sala só da multi.
    telaResolucao = "720p";
    telaFps = 30;
    publica = false;
  }

  try {
    var res = await fetch("./tela/novo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instancia: instancia,
        nick: nick,
        avatar: avatar,
        resolucao: telaResolucao,
        fps: telaFps,
        codigo: multiSala ? null : codigoCustom,
        publica: publica,
        multi: multiSala || null,
      }),
    });
    var dados = await res.json();
    if (!res.ok) throw new Error(dados.detail || "Erro ao criar transmissão.");
    telaSala = dados.sala;
  } catch (e) {
    telaStream.getTracks().forEach(function (t) { t.stop(); });
    telaStream = null;
    avisoTela(e.message, "erro");
    return;
  }

  telaEhHost = true;
  configurarTelaTransmissaoHost();
  conectarWsTela(true);

  // Se o usuário parar a captura pelo botão do próprio navegador, encerra tudo.
  telaStream.getVideoTracks()[0].addEventListener("ended", function () {
    encerrarTransmissao(false);
    avisoTela("Transmissão encerrada: você parou a captura de tela.", "erro");
  });
}

function avisoTela(texto, tipo) {
  if (multiNaTela) {
    mensagemMulti(texto, tipo);
    return;
  }
  mensagemTela(texto, tipo);
}

function configurarTelaTransmissaoHost() {
  if (multiSala) {
    // Na multi-tela o host fica no grid; qualidade fixa 720p30.
    multiHostSala = telaSala;
    telaResolucao = "720p";
    telaFps = 30;
    var btnAb = document.querySelector("#multi-abrir-tela");
    var btnFe = document.querySelector("#multi-fechar-tela");
    var btnVo = document.querySelector("#multi-voltar-assistir");
    if (btnAb) btnAb.style.display = "none";
    if (btnFe) btnFe.style.display = "";
    if (btnVo) btnVo.style.display = "none";
    var q = document.querySelector("#transmissao-qualidade");
    if (q) q.classList.add("bloqueada");
    mensagemMulti("Sua tela está na sala (" + rotuloFonteCaptura() + ") · 720p 30fps.", "sucesso");
    videoTransmissaoEl.style.display = "none";
    canvasRelayEl.style.display = "none";
    videoTransmissaoEl.muted = true; // eco: host nunca ouve a própria captura
    videoTransmissaoEl.srcObject = telaStream;
    var trAudioHostM = telaStream.getAudioTracks()[0];
    if (trAudioHostM) trAudioHostM.enabled = !audioMudo;
    hostVideoEncoder();
    iniciarEncoderAudioRelay();
    aplicarVolumeLocal();
    if (multiNaTela && !multiTiles[telaSala]) {
      criarTileMulti({ sala: telaSala, eu: true, nick: nomeExibicao() });
    }
    // Host não pode assistir a própria live (eco).
    if (multiTiles[telaSala]) desligarViewerMulti(multiTiles[telaSala]);
    return;
  }
  mostrarTela(telaTransmissaoEl);
  var fonte = rotuloFonteCaptura();
  mensagemTransmissao(
    "Você está transmitindo (" + fonte + ") em " + telaResolucao + " " + telaFps + "fps.",
    "sucesso");
  mostrarBadgeQualidade(telaResolucao, telaFps, relayCodecAtual);
  document.querySelector("#transmissao-papel").textContent = "Transmitindo";
  document.querySelector("#transmissao-codigo-valor").textContent = telaSala;
  document.querySelector("#transmissao-codigo-display").style.display = "";
  document.querySelector("#transmissao-viewers-contador").textContent = "0";
  document.querySelector("#transmissao-viewers-bar").style.display = "";
  document.querySelector("#encerrar-transmissao").style.display = "";
  document.querySelector("#parar-assistir").style.display = "none";
  document.querySelector("#transmissao-qualidade").style.display = "";
  var btnTrocar = document.querySelector("#trocar-janela");
  if (btnTrocar) {
    btnTrocar.textContent = telaFonte === "camera"
      ? "Trocar câmera (frente/verso)"
      : "Trocar programa/janela da transmissão";
  }
  controlesTransmissaoEl.style.display = "flex";
  btnMudoEl.title = "Mudo do que você está enviando";
  document.querySelectorAll("#live-resolucao .botao-preset").forEach(function (b) {
    b.classList.toggle("selecionado", b.dataset.resolucao === telaResolucao);
  });
  document.querySelectorAll("#live-fps .botao-preset").forEach(function (b) {
    b.classList.toggle("selecionado", parseInt(b.dataset.fps, 10) === telaFps);
  });
  videoTransmissaoEl.style.display = "";
  canvasRelayEl.style.display = "none";
  // Preview do host mudo por padrão (evita eco); botão controla o envio.
  videoTransmissaoEl.muted = true;
  videoTransmissaoEl.volume = volumeLocal;
  videoTransmissaoEl.srcObject = telaStream;
  var trAudioHost = telaStream.getAudioTracks()[0];
  if (trAudioHost) trAudioHost.enabled = !audioMudo;
  iniciarEncoderAudioRelay();
  aplicarVolumeLocal();
  var p = videoTransmissaoEl.play();
  if (p && p.catch) p.catch(function () { /* autoplay pode exigir gesto — silencioso */ });
}

function criarPeerParaViewer(viewerId) {
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
      }
    }
  };

  pc.createOffer()
    .then(function (oferta) { return pc.setLocalDescription(oferta); })
    .then(function () {
      enviarTela({ tipo: "oferta", viewer_id: viewerId, dados: pc.localDescription.sdp });
    })
    .catch(function (e) { console.warn("Falha ao criar oferta:", e); });
}

function encerrarTransmissao(silencioso) {
  limparConexaoTela();
  telaSala = null;
  if (telaEhHost && telaStream) {
    telaStream.getTracks().forEach(function (t) { t.stop(); });
  }
  telaStream = null;
  telaEhHost = false;
  if (hostOffVideo) hostOffVideo.srcObject = null;
  videoTransmissaoEl.srcObject = null;
  document.querySelector("#transmissao-codigo-display").style.display = "none";
  document.querySelector("#transmissao-viewers-bar").style.display = "none";
  document.querySelector("#transmissao-qualidade").style.display = "none";
  document.querySelector("#transmissao-qualidade").classList.remove("bloqueada");
  controlesTransmissaoEl.style.display = "none";
  var badgeOff = document.querySelector("#qualidade-badge");
  if (badgeOff) badgeOff.style.display = "none";
  if (multiSala) {
    multiHostSala = null;
    var btnAb = document.querySelector("#multi-abrir-tela");
    var btnFe = document.querySelector("#multi-fechar-tela");
    var btnVo = document.querySelector("#multi-voltar-assistir");
    if (btnAb) btnAb.style.display = "";
    if (btnFe) btnFe.style.display = "none";
    if (btnVo) btnVo.style.display = multiNaTela ? "" : "none";
    if (multiNaTela) {
      mensagemMulti("Sua tela foi encerrada. Você pode assistir às outras telas.", "");
      atualizarMultiEstado(multiEstado);
    }
    if (!silencioso && !multiNaTela) {
      mostrarTela(telaCompartilhar);
      carregarTransmissoes();
    }
    return;
  }
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
    if (res.status === 404) {
      // Pode ser código de sala multi-tela.
      var resMulti = await fetch("./multitela/sala/" + encodeURIComponent(codigo));
      if (resMulti.ok) {
        entrarSalaMulti(codigo);
        return;
      }
      throw new Error("Transmissão não encontrada.");
    }
    if (!res.ok) throw new Error("Transmissão não encontrada.");
  } catch (e) {
    mensagemTela(e.message === "Failed to fetch" ? "Erro de conexão." : e.message, "erro");
    return;
  }

  // Quem acabou de criar a transmissão não deve entrar como viewer (eco).
  if (telaEhHost && telaSala === codigo) {
    mensagemTela("Você é quem está transmitendo nesta sala.", "erro");
    return;
  }

  telaEhHost = false;
  telaSala = codigo;
  telaModoRelay = dentroDaActivity();
  relayFrameOk = false;
  mostrarTela(telaTransmissaoEl);
  mensagemTransmissao("Conectando à transmissão...");
  document.querySelector("#transmissao-papel").textContent = "Assistindo";
  document.querySelector("#transmissao-codigo-display").style.display = "none";
  document.querySelector("#transmissao-viewers-bar").style.display = "none";
  document.querySelector("#encerrar-transmissao").style.display = "none";
  document.querySelector("#parar-assistir").style.display = "";
  document.querySelector("#transmissao-qualidade").style.display = "none";
  controlesTransmissaoEl.style.display = "flex";
  videoTransmissaoEl.style.display = telaModoRelay ? "none" : "";
  canvasRelayEl.style.display = telaModoRelay ? "" : "none";
  videoTransmissaoEl.srcObject = null;
  videoTransmissaoEl.muted = audioMudo;
  videoTransmissaoEl.volume = volumeLocal;
  var badge = document.querySelector("#qualidade-badge");
  if (badge) badge.style.display = "none";
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
    videoTransmissaoEl.muted = audioMudo;
    videoTransmissaoEl.volume = volumeLocal;
    var promessa = videoTransmissaoEl.play();
    if (promessa && promessa.then) {
      promessa.then(function () {
        if (multiNaTela && telaEhHost) return;
        mensagemTransmissao("Recebendo vídeo de quem transmite.", "sucesso");
      }).catch(function () {
        if (multiNaTela && telaEhHost) return;
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
  var avatar = avatarAtual() || "";
  var logado = usuarioDiscord ? "1" : "0";
  var protocolo = location.protocol === "https:" ? "wss:" : "ws:";
  var url = protocolo + "//" + location.host + "/ws/tela/" + encodeURIComponent(telaSala) +
    "?papel=" + (host ? "host" : "viewer") + "&nick=" + encodeURIComponent(nick) +
    "&avatar=" + encodeURIComponent(avatar) +
    "&logado=" + logado +
    (!host && telaModoRelay ? "&transporte=relay" : "");

  var ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
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
    if (typeof evento.data !== "string") {
      if (!host) receberRelay(evento.data);
      return;
    }
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
      if (multiNaTela) {
        avisoTela(telaAbriu
          ? "Conexão com o servidor foi encerrada."
          : "Não foi possível conectar ao servidor. Tente novamente.", "erro");
      } else {
        mensagemTela(telaAbriu
          ? "Conexão com o servidor foi encerrada."
          : "Não foi possível conectar ao servidor. Tente novamente.", "erro");
        mostrarTela(telaCompartilhar);
        carregarTransmissoes();
      }
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

function mostrarBadgeQualidade(res, fps, codec) {
  var el = document.querySelector("#qualidade-badge");
  if (!el) return;
  if (res) telaResolucao = res;
  if (typeof fps === "number" && fps > 0) telaFps = fps;
  if (codec) relayCodecAtual = codec;
  el.textContent = telaResolucao + " · " + telaFps + " fps · " + String(relayCodecAtual || "vp8").toUpperCase();
  el.style.display = "";
  document.querySelectorAll("#live-resolucao .botao-preset").forEach(function (b) {
    b.classList.toggle("selecionado", b.dataset.resolucao === telaResolucao);
  });
  document.querySelectorAll("#live-fps .botao-preset").forEach(function (b) {
    b.classList.toggle("selecionado", parseInt(b.dataset.fps, 10) === telaFps);
  });
}

function processarMensagemTela(dados) {
  switch (dados.tipo) {
    case "entrada_ok":
      mostrarBadgeQualidade(dados.resolucao, dados.fps, dados.codec || relayCodecAtual);
      mensagemTransmissao("Conectado a " + dados.nick + " (" + dados.resolucao + " " + dados.fps + "fps). Aguardando vídeo...", "sucesso");
      clearTimeout(telaOfertaTimer);
      clearTimeout(telaRelayTimer);
      relayFrameOk = false;
      relayHostOk = dados.host_conectado === true;
      if (dados.codec) relayCodecAtual = dados.codec;
      if (telaModoRelay) {
        iniciarDecoderRelay(dados.resolucao, dados.codec || relayCodecAtual);
        telaRelayTimer = setTimeout(diagnosticarRelaySemVideo, 15000);
      } else if (!telaEhHost) {
        telaOfertaTimer = setTimeout(async function () {
          if (telaEhHost || !telaSala || telaPeerViewer || telaModoRelay) return;
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
    case "host_conectado":
      if (!telaEhHost && telaModoRelay) {
        relayHostOk = true;
        mensagemTransmissao("Quem transmite conectou — recebendo vídeo...", "sucesso");
        if (!relayFrameOk) {
          clearTimeout(telaRelayTimer);
          telaRelayTimer = setTimeout(diagnosticarRelaySemVideo, 15000);
        }
      }
      break;
    case "relay_total":
      telaRelayTotal = dados.total || 0;
      if (telaEhHost) {
        if (telaRelayTotal > 0) {
          relayForcarKey = true;
          if (!relayAtivo) {
            iniciarEncoderRelay().catch(function (e) {
              console.warn("Encoder relay:", e);
              enviarTela({ tipo: "relay_erro", mensagem: String(e) });
            });
          }
          iniciarEncoderAudioRelay();
        } else if (relayAtivo) {
          pararEncoderRelay();
        }
      }
      break;
    case "quadro":
      // Vídeo do relay em JSON base64 (proxy do Discord não repassa binário).
      if (telaModoRelay && !telaEhHost && dados.d) {
        montarQuadroRelay(dados);
      }
      break;
    case "audio":
      // Áudio Opus do relay em JSON base64.
      if (telaModoRelay && !telaEhHost) {
        receberAudioRelay(dados);
      }
      break;
    case "relay_codec":
      if (dados.codec) {
        relayCodecAtual = dados.codec;
        mostrarBadgeQualidade(null, null, dados.codec);
        if (telaModoRelay && !telaEhHost) {
          // Recria decoder com o codec/resolução da sala (não o default local).
          iniciarDecoderRelay(telaResolucao || "720p", dados.codec);
        }
      }
      break;
    case "config":
      // Líder mudou qualidade ao vivo — espectador atualiza badge/canvas.
      mostrarBadgeQualidade(dados.resolucao, dados.fps, null);
      if (telaModoRelay && !telaEhHost && dados.resolucao) {
        iniciarDecoderRelay(dados.resolucao, relayCodecAtual);
      }
      if (!telaEhHost) {
        mensagemTransmissao(
          "Qualidade da transmissão: " + telaResolucao + " " + telaFps + "fps.",
          "sucesso");
      }
      break;
    case "relay_pronto":
      if (telaModoRelay && !relayFrameOk) {
        // Não sobrescreve erro de decoder já mostrado.
        if (!ultimoErroRelay) {
          mensagemTransmissao("Transmitindo via relay — aguardando os primeiros quadros...", "sucesso");
        }
        clearTimeout(telaRelayTimer);
        telaRelayTimer = setTimeout(function () {
          if (!relayFrameOk && telaModoRelay) {
            diagnosticarRelaySemVideo();
          }
        }, 15000);
      }
      break;
    case "relay_erro":
      if (telaModoRelay) {
        clearTimeout(telaRelayTimer);
        mensagemTransmissao(dados.mensagem || "Quem transmite teve um erro no encoder.", "erro");
      }
      break;
    case "viewers_total":
    case "viewers_lista":
      if (telaEhHost) {
        document.querySelector("#transmissao-viewers-contador").textContent = String(dados.total || 0);
        var barEl = document.querySelector("#transmissao-viewers-bar");
        var listaEl = document.querySelector("#transmissao-viewers-lista");
        if (listaEl && dados.viewers) {
          listaEl.innerHTML = "";
          dados.viewers.forEach(function (v) {
            var chip = document.createElement("span");
            chip.className = "viewer-chip" + (v.logado ? " logado" : " anon");
            chip.title = v.logado ? (v.nick + " (Discord)") : (v.nick + " (site)");
            if (v.avatar) {
              var img = document.createElement("img");
              img.src = v.avatar;
              img.alt = "";
              chip.appendChild(img);
            } else {
              var ini = document.createElement("span");
              ini.className = "viewer-inicial";
              ini.textContent = (v.nick || "?").charAt(0).toUpperCase();
              chip.appendChild(ini);
            }
            var nome = document.createElement("small");
            nome.textContent = v.logado ? v.nick : (v.nick === "Anônimo" ? "Anônimo" : v.nick);
            chip.appendChild(nome);
            if (telaEhHost && v.id) {
              var btnX = document.createElement("button");
              btnX.type = "button";
              btnX.className = "viewer-expulsar";
              btnX.title = "Expulsar";
              btnX.textContent = "×";
              btnX.addEventListener("click", function () {
                enviarTela({ tipo: "expulsar_viewer", viewer_id: v.id });
              });
              chip.appendChild(btnX);
            }
            listaEl.appendChild(chip);
          });
        }
        if (barEl) barEl.style.display = "";
      }
      break;
    case "expulso":
      encerrarViewerTela(dados.mensagem || "Você foi expulso da sala.");
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
      if (multiNaTela) break;
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
        avisoTela(dados.mensagem, "erro");
        if (!multiNaTela) {
          mensagemTela(dados.mensagem, "erro");
          mostrarTela(telaCompartilhar);
          carregarTransmissoes();
        }
      } else {
        encerrarViewerTela(dados.mensagem);
      }
      break;
  }
}

function limparConexaoTela() {
  clearTimeout(telaOfertaTimer);
  clearTimeout(telaRelayTimer);
  relayFrameOk = false;
  relayHostOk = false;
  pararDecoderRelay();
  pararEncoderRelay();
  pararEncoderAudioRelay();
  pararDecoderAudioRelay();
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

document.querySelectorAll("#op-tipo-sala .botao-preset").forEach(function (botao) {
  botao.addEventListener("click", function () {
    formTipoSala = botao.dataset.tipo === "privada" ? "privada" : "publica";
    document.querySelectorAll("#op-tipo-sala .botao-preset").forEach(function (b) {
      b.classList.toggle("selecionado", b === botao);
    });
    aplicarFormularioCriacao();
  });
});

document.querySelectorAll("#op-modo-tela .botao-preset").forEach(function (botao) {
  botao.addEventListener("click", function () {
    formModoTela = botao.dataset.modo === "multi" ? "multi" : "normal";
    document.querySelectorAll("#op-modo-tela .botao-preset").forEach(function (b) {
      b.classList.toggle("selecionado", b === botao);
    });
    aplicarFormularioCriacao();
  });
});

document.querySelector("#trocar-janela").addEventListener("click", trocarJanelaTela);

// Controles de volume/mudo (host e viewer).
if (btnMudoEl) {
  btnMudoEl.addEventListener("click", function () {
    audioMudo = !audioMudo;
    btnMudoEl.textContent = audioMudo ? "🔇" : "🔊";
    btnMudoEl.classList.toggle("selecionado", audioMudo);
    aplicarVolumeLocal();
  });
}
if (volumeEl) {
  volumeEl.addEventListener("input", function () {
    volumeLocal = Math.max(0, Math.min(1, parseInt(volumeEl.value, 10) / 100));
    aplicarVolumeLocal();
  });
}
document.querySelectorAll("#tamanho-video .botao-preset").forEach(function (botao) {
  botao.addEventListener("click", function () {
    definirTamanhoVideo(botao.dataset.tam);
  });
});
// Restaura tamanho salvo.
try {
  var tamSalvo = localStorage.getItem("jj_tela_tam");
  if (tamSalvo) definirTamanhoVideo(tamSalvo);
} catch (e) { /* ignore */ }

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
// Sala multi-tela — listeners de UI
// ---------------------------------------------------------------------------
document.querySelector("#entrar-multi-codigo").addEventListener("click", function () {
  entrarSalaMulti(document.querySelector("#codigo-multi-input").value);
});

document.querySelector("#codigo-multi-input").addEventListener("keydown", function (e) {
  if (e.key === "Enter") entrarSalaMulti(this.value);
});

document.querySelector("#sair-sala-multi").addEventListener("click", sairSalaMulti);
document.querySelector("#sair-multi-topo").addEventListener("click", sairSalaMulti);

document.querySelector("#multi-abrir-tela").addEventListener("click", function () {
  if (!multiNaTela) return;
  iniciarTransmissaoTela();
});

document.querySelector("#multi-fechar-tela").addEventListener("click", function () {
  encerrarTransmissao(false);
});

document.querySelector("#multi-voltar-assistir").addEventListener("click", function () {
  var btnVo = document.querySelector("#multi-voltar-assistir");
  if (btnVo) btnVo.style.display = "none";
  mensagemMulti("Assistindo às outras telas...", "");
  Object.keys(multiTiles).forEach(function (sala) {
    var t = multiTiles[sala];
    if (!t || t.eu || t.oculta || t.assistindo) return;
    ligarViewerMulti(t);
  });
});

document.querySelector("#copiar-codigo-multi").addEventListener("click", function () {
  var botao = this;
  if (navigator.clipboard && multiSala) {
    navigator.clipboard.writeText(multiSala).then(function () {
      botao.textContent = "Copiado!";
      setTimeout(function () { botao.textContent = "Copiar"; }, 2000);
    });
  }
});

document.addEventListener("keydown", function (e) {
  if (e.key !== "Escape") return;
  var cheia = document.querySelector(".multi-tile.cheia");
  if (cheia) {
    cheia.classList.remove("cheia");
    var b = cheia.querySelector(".multi-tile-ctrls button:last-child");
    if (b) b.textContent = "⛶";
  }
});

// ---------------------------------------------------------------------------
// Sala multi-tela: várias lives 720p30, grid com volume/cheia/minimizar
// ---------------------------------------------------------------------------
function mensagemMulti(texto, tipo) {
  var el = document.querySelector("#mensagem-multi");
  if (!el) return;
  el.textContent = texto || "";
  el.className = "mensagem" + (tipo ? " " + tipo : "");
}

async function carregarSalasMulti() {
  try {
    var res = await fetch("./multitela/salas");
    var dados = await res.json();
    renderizarSalasMulti(dados.salas || []);
  } catch (e) {
    console.warn("salas multi:", e);
  }
}

function renderizarSalasMulti(salas) {
  var container = document.querySelector("#lista-salas-multi");
  if (!container) return;
  container.innerHTML = "";
  if (!salas || !salas.length) {
    container.innerHTML = '<p class="vazio">Nenhuma sala multi-tela pública.</p>';
    return;
  }
  salas.forEach(function (s) {
    var item = document.createElement("div");
    item.className = "sala-item";
    var avatarHtml = s.dono_avatar
      ? '<img class="sala-item-avatar" src="' + escapeHtml(s.dono_avatar) + '" alt="" />'
      : '<span class="sala-item-inicial">' + escapeHtml((s.dono_nick || "?").charAt(0).toUpperCase()) + "</span>";
    item.innerHTML =
      avatarHtml +
      '<div class="sala-item-info">' +
      "<strong>" + escapeHtml(s.nome || ("Sala de " + (s.dono_nick || "Anônimo"))) + "</strong>" +
      "<small>Código " + escapeHtml(s.sala) + " · " + (s.total_lives || 0) + "/" + (s.max_lives || 8) + " telas · " +
      (s.total_membros || 0) + " na sala</small></div>";
    var btn = document.createElement("button");
    btn.className = "botao";
    btn.textContent = "Entrar";
    btn.addEventListener("click", function () { entrarSalaMulti(s.sala); });
    item.appendChild(btn);
    container.appendChild(item);
  });
}

async function criarSalaMulti(opts) {
  opts = opts || {};
  try {
    await garantirIdentidade();
    var body = {
      publica: opts.publica !== false,
      nick: nomeExibicao(),
      avatar: avatarAtual() || null,
    };
    if (opts.codigo) body.codigo = opts.codigo;
    var res = await fetch("./multitela/novo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    var dados = await res.json();
    if (!res.ok) throw new Error(dados.detail || "Erro ao criar a sala multi-tela.");
    await entrarSalaMulti(dados.sala);
    if (opts.iniciarAgora) {
      // Painel "Criar sala multi-tela": entra e já compartilha a tela.
      // multiSala já setado → iniciarTransmissaoTela não volta para o form.
      setTimeout(function () {
        formModoTela = "multi";
        iniciarTransmissaoTela().catch(function (e) {
          console.warn("share multi:", e);
        });
      }, 400);
    }
    return dados.sala;
  } catch (e) {
    mensagemTela(e.message, "erro");
    if (multiNaTela) mensagemMulti(e.message, "erro");
    return null;
  }
}

async function iniciarCriacaoMultiPainel() {
  var valCod = codigoCustomValido(formTipoSala === "privada");
  if (valCod.erro) {
    mensagemTela(valCod.erro, "erro");
    return;
  }
  if (multiSala) {
    // Já está numa multi: só compartilha a tela.
    await iniciarTransmissaoTela();
    return;
  }
  await criarSalaMulti({
    publica: formTipoSala === "publica",
    codigo: valCod.codigo,
    iniciarAgora: true,
  });
}

function entrarSalaMulti(codigo) {
  codigo = (codigo || "").trim().toLowerCase();
  if (!codigo) {
    mensagemTela("Digite o código da multi-tela.", "erro");
    return;
  }

  // Sai de qualquer transmissão single-player antes de entrar na multi.
  if (telaEhHost) encerrarTransmissao(true);
  else if (telaSala) pararDeAssistir();

  multiSala = codigo;
  multiNaTela = true;
  multiHostSala = null;
  document.querySelector("#multi-nome-sala").textContent = "Sala multi-tela";
  document.querySelector("#multi-codigo-sala").textContent = codigo;
  var btnAb = document.querySelector("#multi-abrir-tela");
  var btnFe = document.querySelector("#multi-fechar-tela");
  var btnVo = document.querySelector("#multi-voltar-assistir");
  if (btnAb) { btnAb.style.display = ""; btnAb.disabled = false; btnAb.textContent = "Compartilhar minha tela"; }
  if (btnFe) btnFe.style.display = "none";
  if (btnVo) btnVo.style.display = "none";
  var listaMembros = document.querySelector("#multi-membros-lista");
  if (listaMembros) listaMembros.innerHTML = "";
  var q = document.querySelector("#transmissao-qualidade");
  if (q) q.classList.add("bloqueada");
  telaResolucao = "720p";
  telaFps = 30;
  limparTilesMulti();
  // multiNaTela já true — mostrarTela não dispara sairSalaMulti.
  mostrarTela(document.querySelector("#tela-multitela"));
  mensagemMulti("Conectando à sala multi-tela...");
  conectarMultiWs();
}

function sairSalaMulti() {
  if (!multiNaTela && !multiSala) return;
  if (telaEhHost) encerrarTransmissao(true);
  limparTilesMulti();
  if (multiWs) {
    try { multiWs.send(JSON.stringify({ tipo: "sair" })); } catch (e) { /* ignore */ }
    var ws = multiWs;
    multiWs = null;
    ws.onclose = null;
    try { ws.close(); } catch (e2) { /* ignore */ }
  }
  clearInterval(multiPingTimer);
  multiPingTimer = null;
  multiNaTela = false;
  multiSala = null;
  multiEstado = null;
  multiHostSala = null;
  var q = document.querySelector("#transmissao-qualidade");
  if (q) q.classList.remove("bloqueada");
  var btnVo = document.querySelector("#multi-voltar-assistir");
  if (btnVo) btnVo.style.display = "none";
  var listaMembros = document.querySelector("#multi-membros-lista");
  if (listaMembros) listaMembros.innerHTML = "";
  mensagemMulti("");
  // multiNaTela já false — não reentra no if de sair do mostrarTela.
  mostrarTela(telaCompartilhar);
  carregarTransmissoes();
  carregarSalasMulti();
}

function conectarMultiWs() {
  if (multiWs) {
    var antigo = multiWs;
    multiWs = null;
    antigo.onclose = null;
    try { antigo.close(); } catch (e) { /* ignore */ }
  }
  clearInterval(multiPingTimer);

  var nick = usuarioDiscord ? (usuarioDiscord.global_name || usuarioDiscord.username) : (nomeExibicao() || "Anônimo");
  var avatar = avatarAtual() || "";
  var logado = usuarioDiscord ? "1" : "0";
  var protocolo = location.protocol === "https:" ? "wss:" : "ws:";
  var url = protocolo + "//" + location.host + "/ws/multitela/" + encodeURIComponent(multiSala) +
    "?nick=" + encodeURIComponent(nick) +
    "&avatar=" + encodeURIComponent(avatar) +
    "&logado=" + logado;

  var ws = new WebSocket(url);
  multiWs = ws;

  multiPingTimer = setInterval(function () {
    if (multiWs && multiWs.readyState === WebSocket.OPEN) {
      multiWs.send(JSON.stringify({ tipo: "ping" }));
    }
  }, 20000);

  ws.onmessage = function (evento) {
    try {
      processarMultiMensagem(JSON.parse(evento.data));
    } catch (e) {
      console.error("Erro multi:", e);
    }
  };

  ws.onclose = function () {
    if (ws !== multiWs) return;
    if (!multiNaTela) return;
    mensagemMulti("Conexão perdida. Reconectando...", "erro");
    setTimeout(function () {
      if (multiNaTela && multiSala) conectarMultiWs();
    }, 2000);
  };

  ws.onerror = function () {};
}

function processarMultiMensagem(dados) {
  switch (dados.tipo) {
    case "multi_estado":
      atualizarMultiEstado(dados);
      break;
    case "multi_encerrada":
      mensagemMulti("A sala multi-tela foi encerrada" +
        (dados.motivo ? " (" + dados.motivo + ")." : "."), "erro");
      setTimeout(function () {
        if (multiNaTela) sairSalaMulti();
      }, 1800);
      break;
    case "erro":
      mensagemMulti(dados.mensagem || "Erro na sala multi-tela.", "erro");
      if (dados.mensagem && dados.mensagem.indexOf("não encontrada") !== -1) {
        setTimeout(function () { if (multiNaTela) sairSalaMulti(); }, 1800);
      }
      break;
    default:
      break;
  }
}

function atualizarMultiEstado(estado) {
  multiEstado = estado;
  if (!multiNaTela) return;

  var nome = estado.nome || ("Sala de " + (estado.dono_nick || "Anônimo"));
  document.querySelector("#multi-nome-sala").textContent = nome + " - Código";
  document.querySelector("#multi-codigo-sala").textContent = estado.sala || multiSala || "";
  document.querySelector("#multi-membros-total").textContent = String(estado.total_membros || 0);

  // Membros (foto + nick) sob "x/8 na sala".
  var lista = document.querySelector("#multi-membros-lista");
  if (lista) {
    lista.innerHTML = "";
    var membros = estado.membros || [];
    if (membros.length) {
      membros.forEach(function (m) {
        var chip = document.createElement("span");
        chip.className = "multi-membro" + (m.logado ? "" : " anonimo");
        chip.innerHTML = avatarOuIni(m.nick || "Anônimo", m.avatar) +
          "<strong>" + escapeHtml(m.nick || "Anônimo") + "</strong>" +
          (m.logado ? "" : '<span class="etiqueta">anônimo</span>');
        if (!m.conectado) chip.style.opacity = "0.55";
        lista.appendChild(chip);
      });
    }
  }

  var lives = estado.lives || [];
  var btnAb = document.querySelector("#multi-abrir-tela");
  if (btnAb && !multiHostSala) {
    var cheia = (estado.total_lives || 0) >= (estado.max_lives || 8);
    btnAb.disabled = cheia;
    btnAb.textContent = cheia
      ? "Telas cheias (" + (estado.max_lives || 8) + ")"
      : "Compartilhar minha tela";
  }

  var alvo = {};
  lives.forEach(function (l) { alvo[l.sala] = l; });
  // Tile do host local: mantém mesmo antes do host_ws entrar no lives.
  if (multiHostSala) {
    if (!alvo[multiHostSala]) {
      alvo[multiHostSala] = {
        sala: multiHostSala,
        nick: nomeExibicao(),
        avatar: avatarAtual() || null,
      };
    }
    alvo[multiHostSala].eu = true;
  }

  // Remove tiles de lives que sumiram (nunca o tile do host local).
  Object.keys(multiTiles).forEach(function (sala) {
    if (sala === multiHostSala) return;
    if (!alvo[sala]) removerTileMulti(sala);
  });

  // Cria/atualiza tiles.
  Object.keys(alvo).forEach(function (sala) {
    if (!multiTiles[sala]) criarTileMulti(alvo[sala]);
    else atualizarDadosTile(multiTiles[sala], alvo[sala]);
  });
}

function limparTilesMulti() {
  Object.keys(multiTiles).forEach(function (sala) {
    removerTileMulti(sala);
  });
}

function removerTileMulti(sala) {
  var tile = multiTiles[sala];
  if (!tile) return;
  desligarViewerMulti(tile);
  if (tile.el && tile.el.parentNode) tile.el.parentNode.removeChild(tile.el);
  delete multiTiles[sala];
}

function avatarOuIni(nick, avatar) {
  if (avatar) {
    return '<img src="' + escapeHtml(avatar) + '" alt="" onerror="this.outerHTML=\'<span class=&quot;ini&quot;>' +
      escapeHtml((nick || "?").charAt(0).toUpperCase()) + '</span>\'" />';
  }
  return '<span class="ini">' + escapeHtml((nick || "?").charAt(0).toUpperCase()) + "</span>";
}

function criarTileMulti(live) {
  var sala = live.sala;
  var ehEu = !!live.eu || sala === multiHostSala;
  var nick = ehEu ? (nomeExibicao() || "Você") : (live.nick || "Anônimo");
  var avatar = ehEu ? avatarAtual() : live.avatar;

  var el = document.createElement("div");
  el.className = "multi-tile" + (ehEu ? " multi-tile-eu" : "");
  el.dataset.sala = sala;

  var media = document.createElement("div");
  media.className = "multi-tile-media";

  var canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  media.appendChild(canvas);

  var video = null;
  if (!dentroDaActivity() && !ehEu) {
    video = document.createElement("video");
    video.playsInline = true;
    video.autoplay = true;
    video.muted = true;
    video.style.display = "none";
    media.appendChild(video);
  }

  var placeholder = document.createElement("div");
  placeholder.className = "multi-tile-placeholder";
  placeholder.textContent = ehEu
    ? "Você está transmitindo"
    : "Clique para assistir";
  media.appendChild(placeholder);

  var ctrls = document.createElement("div");
  ctrls.className = "multi-tile-ctrls";

  var btnVol = document.createElement("button");
  btnVol.type = "button";
  btnVol.title = "Volume (começa mudo)";
  btnVol.textContent = "🔇";

  var volSlider = document.createElement("input");
  volSlider.type = "range";
  volSlider.min = "0";
  volSlider.max = "100";
  volSlider.value = "80";
  volSlider.className = "multi-tile-volume";
  volSlider.title = "Volume desta transmissão";

  var btnOcultar = document.createElement("button");
  btnOcultar.type = "button";
  btnOcultar.title = "Não exibir / reassistir";
  btnOcultar.textContent = "👁";

  var btnMini = document.createElement("button");
  btnMini.type = "button";
  btnMini.title = "Minimizar";
  btnMini.textContent = "▁";

  var btnCheia = document.createElement("button");
  btnCheia.type = "button";
  btnCheia.title = "Tela cheia";
  btnCheia.textContent = "⛶";

  ctrls.appendChild(btnVol);
  if (!ehEu) ctrls.appendChild(volSlider);
  ctrls.appendChild(btnOcultar);
  ctrls.appendChild(btnMini);
  ctrls.appendChild(btnCheia);
  media.appendChild(ctrls);

  var rodape = document.createElement("div");
  rodape.className = "multi-tile-rodape";
  rodape.innerHTML = avatarOuIni(nick, avatar) +
    "<strong>" + escapeHtml(nick) + "</strong>" +
    (ehEu ? '<span class="etiqueta-eu">Você</span>' : "");

  var btnVoltar = document.createElement("button");
  btnVoltar.type = "button";
  btnVoltar.className = "multi-tile-voltar";
  btnVoltar.textContent = "Voltar a assistir";
  btnVoltar.style.display = "none";
  rodape.appendChild(btnVoltar);

  el.appendChild(media);
  el.appendChild(rodape);
  document.querySelector("#multi-grid").appendChild(el);

  var tile = {
    sala: sala,
    eu: ehEu,
    nick: nick,
    el: el,
    canvas: canvas,
    video: video,
    placeholder: placeholder,
    btnVol: btnVol,
    volSlider: volSlider,
    btnOcultar: btnOcultar,
    btnMini: btnMini,
    btnCheia: btnCheia,
    btnVoltar: btnVoltar,
    live: live,
    assistindo: false,
    oculta: false,
    mudo: true,
    volume: 0.8,
    ws: null,
    pc: null,
    decoder: null,
    audioDecoder: null,
    audioCtx: null,
    gain: null,
    partes: {},
    temKey: false,
    codec: "vp8",
    resolucao: live.resolucao || "720p",
    tentativas: 0,
    abriu: false,
    relay: dentroDaActivity(),
    ofertaTimer: null,
    audioCfg: { sr: 0, ch: 0 },
    audioChave: true,
    redeTimer: null,
  };
  multiTiles[sala] = tile;

  function atualizarVoltarTile() {
    // Mostra "Voltar a assistir" no rodapé quando o vídeo está fechado (_).
    var fechado = el.classList.contains("minimizado") || tile.oculta ||
      (!tile.assistindo && !ehEu && !tile.eu);
    btnVoltar.style.display = fechado ? "" : "none";
  }
  tile.atualizarVoltar = atualizarVoltarTile;

  btnVoltar.addEventListener("click", function (ev) {
    ev.stopPropagation();
    el.classList.remove("minimizado");
    btnMini.textContent = "▁";
    if (tile.oculta) {
      tile.oculta = false;
      el.classList.remove("oculta");
      btnOcultar.textContent = "👁";
    }
    if (!tile.eu && !tile.assistindo) ligarViewerMulti(tile);
    if (tile.eu && tile.preview) {
      var pr = tile.preview.play();
      if (pr && pr.catch) pr.catch(function () {});
    }
    atualizarVoltarTile();
  });

  btnMini.addEventListener("click", function () {
    el.classList.toggle("minimizado");
    btnMini.textContent = el.classList.contains("minimizado") ? "▔" : "▁";
    if (el.classList.contains("cheia")) {
      el.classList.remove("cheia");
      btnCheia.textContent = "⛶";
    }
    atualizarVoltarTile();
  });

  // Host: preview local no próprio tile (mudo).
  if (ehEu && telaStream) {
    canvas.style.display = "none";
    var prev = document.createElement("video");
    prev.autoplay = true;
    prev.muted = true; // eco: preview local sempre mudo
    prev.playsInline = true;
    prev.srcObject = telaStream;
    prev.style.display = "block";
    prev.style.width = "100%";
    prev.style.height = "100%";
    prev.style.objectFit = "contain";
    prev.style.background = "#000";
    media.insertBefore(prev, placeholder);
    tile.preview = prev;
    var pp = prev.play();
    if (pp && pp.catch) pp.catch(function () {});
    placeholder.textContent = "Transmitindo 720p 30fps";
    btnVol.disabled = true;
    btnOcultar.disabled = true;
    // Fonte do encoder: preview visível no grid (off-screen pode não pintar).
    if (relayAtivo || multiSala) hostVideoEncoder();
    return tile;
  }

  if (ehEu) {
    return tile;
  }

  // Auto-assiste lives (mutadas). Clique no media também religa se oculto.
  media.addEventListener("click", function (ev) {
    if (ev.target === btnVol || ev.target === btnOcultar ||
        ev.target === btnMini || ev.target === btnCheia ||
        ev.target === btnVoltar) return;
    if (tile.oculta) {
      tile.oculta = false;
      el.classList.remove("oculta");
      btnOcultar.textContent = "👁";
      ligarViewerMulti(tile);
    } else if (!tile.assistindo) {
      ligarViewerMulti(tile);
    }
    atualizarVoltarTile();
  });

  function aplicarVolumeTile() {
    var vol = tile.mudo ? 0 : tile.volume;
    if (tile.gain) tile.gain.gain.value = vol;
    if (tile.video) {
      tile.video.muted = tile.mudo;
      tile.video.volume = tile.volume;
    }
    btnVol.textContent = tile.mudo ? "🔇" : (tile.volume <= 0 ? "🔈" : "🔊");
    if (!tile.mudo && tile.audioCtx && tile.audioCtx.state === "suspended") {
      tile.audioCtx.resume().catch(function () {});
    }
  }
  tile.aplicarVolume = aplicarVolumeTile;

  btnVol.addEventListener("click", function (ev) {
    ev.stopPropagation();
    tile.mudo = !tile.mudo;
    aplicarVolumeTile();
  });

  volSlider.addEventListener("input", function (ev) {
    ev.stopPropagation();
    tile.volume = Math.max(0, Math.min(1, parseInt(volSlider.value, 10) / 100));
    if (tile.mudo && tile.volume > 0) tile.mudo = false;
    aplicarVolumeTile();
  });
  volSlider.addEventListener("click", function (ev) { ev.stopPropagation(); });

  btnOcultar.addEventListener("click", function () {
    if (tile.oculta) {
      tile.oculta = false;
      el.classList.remove("oculta");
      btnOcultar.textContent = "👁";
      ligarViewerMulti(tile);
    } else {
      tile.oculta = true;
      el.classList.add("oculta");
      btnOcultar.textContent = "🙈";
      desligarViewerMulti(tile);
    }
    atualizarVoltarTile();
  });

  btnCheia.addEventListener("click", function (ev) {
    ev.stopPropagation();
    var cheiaAgora = el.classList.contains("cheia");
    document.querySelectorAll(".multi-tile.cheia").forEach(function (t) {
      t.classList.remove("cheia");
      var b = t.querySelector(".multi-tile-ctrls button:last-child");
      if (b) b.textContent = "⛶";
    });
    if (!cheiaAgora) {
      el.classList.add("cheia");
      el.classList.remove("minimizado");
      btnCheia.textContent = "✕";
      btnMini.textContent = "▁";
      atualizarVoltarTile();
    }
  });

  ligarViewerMulti(tile);
  atualizarVoltarTile();
  return tile;
}

function atualizarDadosTile(tile, live) {
  tile.live = live;
  if (tile.eu) return;
  var nick = live.nick || "Anônimo";
  var forte = tile.el.querySelector(".multi-tile-rodape strong");
  if (forte) forte.textContent = nick;
}

function enviarMulti(obj) {
  if (multiWs && multiWs.readyState === WebSocket.OPEN) {
    multiWs.send(JSON.stringify(obj));
  }
}

function enviarTile(tile, obj) {
  if (tile.ws && tile.ws.readyState === WebSocket.OPEN) {
    tile.ws.send(JSON.stringify(obj));
  }
}

function desligarViewerMulti(tile) {
  tile.assistindo = false;
  clearTimeout(tile.ofertaTimer);
  clearInterval(tile.redeTimer);
  tile.redeTimer = null;
  if (tile.ws) {
    var ws = tile.ws;
    tile.ws = null;
    ws.onclose = null;
    ws.onmessage = null;
    try { ws.close(); } catch (e) { /* ignore */ }
  }
  if (tile.pc) {
    try { tile.pc.close(); } catch (e) { /* ignore */ }
    tile.pc = null;
  }
  if (tile.decoder && tile.decoder.state !== "closed") {
    try { tile.decoder.close(); } catch (e) { /* ignore */ }
  }
  tile.decoder = null;
  if (tile.audioDecoder && tile.audioDecoder.state !== "closed") {
    try { tile.audioDecoder.close(); } catch (e) { /* ignore */ }
  }
  tile.audioDecoder = null;
  if (tile.audioCtx) {
    try { tile.audioCtx.close(); } catch (e) { /* ignore */ }
  }
  tile.audioCtx = null;
  tile.gain = null;
  tile.partes = {};
  tile.temKey = false;
  tile.abriu = false;
  tile.tentativas = 0;
  if (tile.video) tile.video.srcObject = null;
  var ctx = tile.canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, tile.canvas.width, tile.canvas.height);
  if (!tile.oculta) tile.placeholder.textContent = "Clique para assistir";
  if (tile.atualizarVoltar) tile.atualizarVoltar();
}

function ligarViewerMulti(tile) {
  if (tile.eu || tile.assistindo || !multiNaTela) return;
  // Eco: o host nunca abre viewer da própria live.
  if (tile.sala === multiHostSala || tile.sala === telaSala) return;
  tile.assistindo = true;
  tile.tentativas = 0;
  tile.relay = dentroDaActivity();
  tile.placeholder.textContent = "Conectando...";
  abrirWsViewerMulti(tile);
  if (tile.atualizarVoltar) tile.atualizarVoltar();
}

function abrirWsViewerMulti(tile) {
  var nick = usuarioDiscord ? (usuarioDiscord.global_name || usuarioDiscord.username) : (nomeExibicao() || "Anônimo");
  var avatar = avatarAtual() || "";
  var logado = usuarioDiscord ? "1" : "0";
  var protocolo = location.protocol === "https:" ? "wss:" : "ws:";
  var url = protocolo + "//" + location.host + "/ws/tela/" + encodeURIComponent(tile.sala) +
    "?papel=viewer" +
    "&nick=" + encodeURIComponent(nick) +
    "&avatar=" + encodeURIComponent(avatar) +
    "&logado=" + logado +
    (tile.relay ? "&transporte=relay" : "");

  var ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  tile.ws = ws;
  tile.abriu = false;

  ws.onopen = function () {
    tile.abriu = true;
    tile.tentativas = 0;
    tile.placeholder.textContent = "Aguardando vídeo...";
  };

  ws.onmessage = function (evento) {
    if (typeof evento.data !== "string") {
      if (tile.relay) receberRelayTile(tile, evento.data);
      return;
    }
    try {
      processarMsgTile(tile, JSON.parse(evento.data));
    } catch (e) {
      console.warn("msg tile:", e);
    }
  };

  ws.onclose = function () {
    if (ws !== tile.ws) return;
    tile.ws = null;
    tile.assistindo = false;
    if (!multiNaTela || tile.oculta || !multiTiles[tile.sala]) return;
    if (!tile.abriu && tile.tentativas < 3) {
      tile.tentativas++;
      tile.placeholder.textContent = "Reconectando... (" + tile.tentativas + "/3)";
      setTimeout(function () {
        if (multiTiles[tile.sala] && !tile.oculta) ligarViewerMulti(tile);
      }, 1500 * tile.tentativas);
      return;
    }
    tile.placeholder.textContent = "Conexão perdida — clique para reassistir";
  };

  ws.onerror = function () {};
}

function processarMsgTile(tile, dados) {
  switch (dados.tipo) {
    case "entrada_ok":
      tile.resolucao = dados.resolucao || "720p";
      if (dados.codec) tile.codec = dados.codec;
      tile.placeholder.textContent = "Aguardando vídeo...";
      if (tile.relay) {
        iniciarDecoderTile(tile, tile.resolucao, tile.codec);
        clearTimeout(tile.ofertaTimer);
        tile.ofertaTimer = setTimeout(function () {
          if (tile.assistindo && tile.placeholder.textContent.indexOf("vídeo") === -1 &&
              tile.placeholder.textContent.indexOf("Recebendo") === -1) {
            tile.placeholder.textContent = "Host sem vídeo ainda — clique para reassistir";
          }
        }, 12000);
      }
      break;
    case "host_conectado":
      // WebRTC: host avisa; oferta vem em seguida.
      break;
    case "quadro":
      if (tile.relay && dados.d) montarQuadroTile(tile, dados);
      break;
    case "audio":
      if (tile.relay) receberAudioTile(tile, dados);
      break;
    case "relay_codec":
      if (dados.codec) {
        tile.codec = dados.codec;
        if (tile.relay && tile.assistindo) iniciarDecoderTile(tile, tile.resolucao, tile.codec);
      }
      break;
    case "config":
      if (tile.relay && dados.resolucao) {
        iniciarDecoderTile(tile, dados.resolucao, tile.codec);
      }
      break;
    case "oferta":
      if (!tile.relay) processarOfertaTile(tile, dados.dados);
      break;
    case "resposta":
      if (tile.pc) tile.pc.setRemoteDescription({ type: "answer", sdp: dados.dados }).catch(function () {});
      break;
    case "ice":
      if (tile.pc) tile.pc.addIceCandidate(dados.dados).catch(function () {});
      break;
    case "aguardando_host":
      tile.placeholder.textContent = "Aguardando quem transmite conectar...";
      break;
    case "transmissao_encerrada":
      desligarViewerMulti(tile);
      tile.placeholder.textContent = "Live encerrada — clique para reassistir se voltar";
      break;
    case "erro":
      tile.placeholder.textContent = dados.mensagem || "Erro na live";
      break;
    default:
      break;
  }
}

function processarOfertaTile(tile, sdp) {
  if (tile.pc) {
    try { tile.pc.close(); } catch (e) { /* ignore */ }
  }
  var pc = new RTCPeerConnection(RTC_CONFIG);
  tile.pc = pc;

  pc.ontrack = function (evento) {
    if (!tile.video) return;
    tile.video.srcObject = evento.streams[0];
    tile.video.muted = tile.mudo;
    tile.video.volume = tile.volume;
    // Fluidez: prefer motion (menos latência de encode WebRTC).
    (evento.track ? [evento.track] : []).forEach(function (tr) {
      if (tr && "contentHint" in tr) tr.contentHint = "motion";
    });
    tile.placeholder.style.display = "none";
    tile.canvas.style.display = "none";
    tile.video.style.display = "";
    var p = tile.video.play();
    if (p && p.catch) p.catch(function () {});
  };

  pc.onicecandidate = function (evento) {
    if (evento.candidate) {
      enviarTile(tile, { tipo: "ice", dados: evento.candidate.toJSON() });
    }
  };

  pc.setRemoteDescription({ type: "offer", sdp: sdp })
    .then(function () { return pc.createAnswer(); })
    .then(function (resposta) { return pc.setLocalDescription(resposta); })
    .then(function () {
      enviarTile(tile, { tipo: "resposta", dados: pc.localDescription.sdp });
      tile.placeholder.textContent = "Recebendo vídeo...";
    })
    .catch(function () {
      tile.placeholder.textContent = "Falha ao conectar P2P nesta live.";
    });
}

function iniciarDecoderTile(tile, resolucao, codec) {
  if (tile.decoder && tile.decoder.state !== "closed") {
    try { tile.decoder.close(); } catch (e) { /* ignore */ }
  }
  tile.decoder = null;
  tile.temKey = false;
  tile.partes = {};
  var dims = { "480p": [854, 480], "720p": [1280, 720], "1080p": [1920, 1080] }[resolucao] || [1280, 720];
  tile.canvas.width = dims[0];
  tile.canvas.height = dims[1];
  if (typeof VideoDecoder === "undefined") {
    tile.placeholder.textContent = "Seu navegador não suporta o modo de vídeo da multi-tela.";
    return;
  }
  var ctx = tile.canvas.getContext("2d", { alpha: false });
  tile.decoder = new VideoDecoder({
    output: function (frame) {
      try {
        ctx.drawImage(frame, 0, 0, tile.canvas.width, tile.canvas.height);
        if (!tile.oculta) {
          tile.placeholder.style.display = "none";
          tile.canvas.style.display = "block";
          if (tile.preview) tile.preview.style.display = "none";
        }
      } catch (e) { /* ignore */ }
      try { frame.close(); } catch (e2) { /* ignore */ }
    },
    error: function () {
      if (tile.decoder && tile.decoder.state !== "closed") {
        try { tile.decoder.close(); } catch (e) { /* ignore */ }
      }
      tile.decoder = null;
      tile.temKey = false;
      if (tile.codec !== "vp8") {
        tile.codec = "vp8";
        iniciarDecoderTile(tile, resolucao, "vp8");
      }
    },
  });
  var alvo = codec === "h264" ? ["avc1.42001f", "vp8"] : ["vp8", "avc1.42001f"];
  function tentar(lista) {
    if (!lista.length || !tile.decoder) return;
    var codecStr = lista[0];
    var resto = lista.slice(1);
    var cfg = { codec: codecStr, optimizeForLatency: true };
    var promessa = (typeof VideoDecoder.isConfigSupported === "function")
      ? VideoDecoder.isConfigSupported(cfg)
      : Promise.resolve({ supported: true });
    promessa.then(function (sup) {
      if (!tile.decoder) return;
      if (sup && sup.supported === false) { tentar(resto); return; }
      try {
        tile.decoder.configure(cfg);
        if (tile.decoder.state !== "configured") tentar(resto);
      } catch (e) { tentar(resto); }
    }).catch(function () {
      if (!tile.decoder) return;
      try { tile.decoder.configure(cfg); } catch (e) { tentar(resto); }
    });
  }
  tentar(alvo);
  iniciarDecoderAudioTile(tile, 48000, 2);
}

function receberRelayTile(tile, buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 5) return;
  var dv = new DataView(buffer);
  decodificarRelayFrameTile(tile, dv.getUint8(0) === 1, dv.getUint32(1), new Uint8Array(buffer, 5));
}

function montarQuadroTile(tile, dados) {
  if (!dados || !dados.d) return;
  if (!dados.n || dados.n <= 1) {
    processarParteRelayTile(tile, dados.t, dados);
    return;
  }
  var t = dados.t;
  var buf = tile.partes[t];
  if (!buf) buf = tile.partes[t] = { k: dados.k, n: dados.n, recebidas: 0, partes: [] };
  if (buf.partes[dados.i]) return;
  buf.partes[dados.i] = dados.d;
  buf.recebidas++;
  if (buf.recebidas >= buf.n) {
    delete tile.partes[t];
    processarParteRelayTile(tile, t, { k: buf.k, d: buf.partes.join("") });
  }
}

function processarParteRelayTile(tile, t, dados) {
  try {
    var bin = atob(dados.d);
    var payload = new Uint8Array(bin.length);
    for (var qi = 0; qi < bin.length; qi++) payload[qi] = bin.charCodeAt(qi);
    decodificarRelayFrameTile(tile, dados.k === 1, t >>> 0, payload);
  } catch (e) { /* ignore */ }
}

function decodificarRelayFrameTile(tile, ehKey, timestamp, payload) {
  if (!tile.decoder || tile.decoder.state === "closed") return;
  if (!payload || payload.byteLength < 1) return;
  if (!ehKey && !tile.temKey) return;
  if (ehKey) tile.temKey = true;
  // Fila de decode: multi usa limiar menor (menos delay); single mantém 30.
  var maxDecode = multiSala ? 12 : 30;
  if (tile.decoder.decodeQueueSize > maxDecode && !ehKey) return;
  try {
    tile.decoder.decode(new EncodedVideoChunk({
      type: ehKey ? "key" : "delta",
      timestamp: timestamp,
      data: payload,
    }));
  } catch (e) {
    tile.temKey = false;
  }
}

function iniciarDecoderAudioTile(tile, sr, ch) {
  if (tile.audioDecoder && tile.audioDecoder.state !== "closed") {
    try { tile.audioDecoder.close(); } catch (e) { /* ignore */ }
  }
  tile.audioDecoder = null;
  if (typeof AudioDecoder === "undefined" || typeof AudioContext === "undefined") return;
  if (!tile.audioCtx) {
    try {
      tile.audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    } catch (e) {
      try {
        tile.audioCtx = new AudioContext({ latencyHint: "interactive" });
      } catch (e2) {
        tile.audioCtx = new AudioContext();
      }
    }
    tile.gain = tile.audioCtx.createGain();
    tile.gain.gain.value = tile.mudo ? 0 : tile.volume;
    tile.gain.connect(tile.audioCtx.destination);
  }
  tile.audioCfg = { sr: sr || 48000, ch: ch || 2 };
  tile.audioChave = true;
  var proxima = 0;
  tile.audioDecoder = new AudioDecoder({
    output: function (frame) {
      try {
        if (!tile.audioCtx || !tile.gain) { frame.close(); return; }
        if (tile.audioCtx.state === "suspended") tile.audioCtx.resume().catch(function () {});
        var n = frame.numberOfFrames;
        var ab = tile.audioCtx.createBuffer(frame.numberOfChannels, n, frame.sampleRate);
        for (var c = 0; c < frame.numberOfChannels; c++) {
          var plane = new Float32Array(n);
          frame.copyTo(plane, { planeIndex: c, format: "f32-planar" });
          ab.copyToChannel(plane, c);
        }
        var src = tile.audioCtx.createBufferSource();
        src.buffer = ab;
        src.connect(tile.gain);
        var agora = tile.audioCtx.currentTime;
        if (proxima < agora || proxima > agora + 0.5) proxima = agora + 0.02;
        src.start(proxima);
        proxima += n / frame.sampleRate;
      } catch (e) { /* ignore */ }
      try { frame.close(); } catch (e2) { /* ignore */ }
    },
    error: function () { tile.audioDecoder = null; },
  });
  try {
    tile.audioDecoder.configure({ codec: "opus", sampleRate: tile.audioCfg.sr, numberOfChannels: tile.audioCfg.ch });
  } catch (e) { /* ignore */ }
}

function receberAudioTile(tile, dados) {
  if (!dados || !dados.d) return;
  if (!tile.audioCtx || !tile.audioDecoder || tile.audioDecoder.state === "closed") {
    iniciarDecoderAudioTile(tile, parseInt(dados.sr, 10) || 48000, parseInt(dados.ch, 10) || 2);
  }
  if (!tile.audioDecoder || tile.audioDecoder.state === "closed") return;
  var sr = parseInt(dados.sr, 10) || tile.audioCfg.sr;
  var ch = parseInt(dados.ch, 10) || tile.audioCfg.ch;
  if (sr !== tile.audioCfg.sr || ch !== tile.audioCfg.ch) {
    iniciarDecoderAudioTile(tile, sr, ch);
    if (!tile.audioDecoder || tile.audioDecoder.state === "closed") return;
  }
  if (tile.audioCtx && tile.audioCtx.state === "suspended") {
    tile.audioCtx.resume().catch(function () {});
  }
  try {
    var bin = atob(dados.d);
    var payload = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) payload[i] = bin.charCodeAt(i);
    if (tile.audioDecoder.decodeQueueSize > 40) return;
    var tipo = "delta";
    if (dados.k) tipo = "key";
    else if (tile.audioChave) { tipo = "key"; tile.audioChave = false; }
    tile.audioDecoder.decode(new EncodedAudioChunk({
      type: tipo,
      timestamp: dados.t || 0,
      data: payload,
    }));
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Perfil — identidade, recordes agregados e histórico recente
// ---------------------------------------------------------------------------
async function abrirPerfil() {
  mostrarTela(document.querySelector("#tela-perfil"));
  await garantirIdentidade();
  renderPerfilIdentidade();
  renderPerfilHistorico();
  await renderPerfilRecordes();
}

function renderPerfilIdentidade() {
  var alvo = document.querySelector("#perfil-identidade");
  if (!alvo) return;
  var nick = nomeExibicao();
  var logado = !!usuarioDiscord;
  var avatarHtml = logado
    ? '<img src="' + escapeHtml(avatarAtual()) + '" alt="" />'
    : escapeHtml((nick || "?").charAt(0).toUpperCase());
  alvo.innerHTML =
    '<span class="perfil-avatar">' + avatarHtml + "</span>" +
    "<span><span class=\"perfil-nome\">" + escapeHtml(nick) + "</span>" +
    '<div class="perfil-sub">' +
    (logado
      ? "Conectado com Discord"
      : "Modo navegador — entre com Discord para registrar recordes") +
    "</div></span>";
}

function renderPerfilHistorico() {
  var alvo = document.querySelector("#perfil-historico");
  if (!alvo) return;
  var lista = [];
  try { lista = JSON.parse(localStorage.getItem("jj-historico-geral") || "[]"); } catch (e) { /* ignore */ }
  if (lista.length === 0) {
    alvo.innerHTML = '<p class="vazio">Nenhuma partida concluída ainda neste navegador.</p>';
    return;
  }
  alvo.innerHTML = "";
  lista.forEach(function (item) {
    var linha = document.createElement("div");
    linha.className = "registro";
    linha.innerHTML =
      "<span>" + escapeHtml(item.jogo) + " &middot; " + escapeHtml(item.data) + "</span>" +
      "<strong>" + escapeHtml(item.detalhe) + "</strong>";
    alvo.appendChild(linha);
  });
}

async function renderPerfilRecordes() {
  var alvo = document.querySelector("#perfil-recordes");
  if (!alvo) return;
  if (!usuarioDiscord) {
    alvo.innerHTML = '<p class="perfil-vazio">Entre com Discord para ver seus recordes registrados no ranking de cada jogo.</p>';
    return;
  }
  alvo.innerHTML = '<p class="perfil-vazio">Carregando recordes...</p>';
  try {
    var params = "nome=" + encodeURIComponent(nomeUsuario()) + "&nick=" + encodeURIComponent(nomeExibicao());
    var resposta = await fetch("./perfil/recordes?" + params);
    var dados = await resposta.json();
    alvo.innerHTML = "";
    alvo.appendChild(cartaoPerfilSudoku(dados.sudoku || {}));
    alvo.appendChild(cartaoPerfilVitorias("Jogo da Velha", dados.velha || {}));
    alvo.appendChild(cartaoPerfilCampoMinado(dados.campo_minado || {}));
    alvo.appendChild(cartaoPerfilLudo(dados.ludo));
  } catch (e) {
    alvo.innerHTML = '<p class="perfil-vazio">Não foi possível carregar os recordes agora.</p>';
  }
}

function criarCartaoPerfil(titulo) {
  var card = document.createElement("div");
  card.className = "perfil-jogo-card";
  card.innerHTML = "<h3>" + escapeHtml(titulo) + "</h3>";
  return card;
}

function adicionarLinhaPerfil(card, rotulo, valor) {
  var linha = document.createElement("div");
  linha.className = "perfil-linha";
  linha.innerHTML = "<span>" + escapeHtml(rotulo) + "</span><strong>" + escapeHtml(valor) + "</strong>";
  card.appendChild(linha);
}

function cartaoPerfilSudoku(porDificuldade) {
  var card = criarCartaoPerfil("Sudoku");
  var chaves = Object.keys(porDificuldade);
  if (chaves.length === 0) {
    card.innerHTML += '<p class="perfil-vazio">Ainda sem recorde salvo.</p>';
    return card;
  }
  ["facil", "medio", "dificil"].forEach(function (dif) {
    var r = porDificuldade[dif];
    if (r) adicionarLinhaPerfil(card, nomesDificuldade[dif], formatarTempo(r.tempo_segundos));
  });
  return card;
}

function cartaoPerfilVitorias(titulo, porDificuldade) {
  var card = criarCartaoPerfil(titulo);
  var chaves = Object.keys(porDificuldade);
  if (chaves.length === 0) {
    card.innerHTML += '<p class="perfil-vazio">Ainda sem vitórias registradas.</p>';
    return card;
  }
  ["facil", "medio", "dificil", "geral"].forEach(function (dif) {
    var r = porDificuldade[dif];
    if (!r) return;
    var rotulo = nomesDificuldade[dif] || "Geral";
    var valor = r.vitorias + " vitória" + (r.vitorias === 1 ? "" : "s");
    if (r.melhor_tempo) valor += " · " + formatarTempo(r.melhor_tempo);
    adicionarLinhaPerfil(card, rotulo, valor);
  });
  return card;
}

function cartaoPerfilCampoMinado(dados) {
  var card = criarCartaoPerfil("Campo Minado");
  var tempos = dados.tempos || {};
  var vitorias = dados.vitorias || {};
  var temAlgo = false;
  ["facil", "medio", "dificil"].forEach(function (dif) {
    var partes = [];
    if (vitorias[dif]) partes.push(vitorias[dif].vitorias + " vitória" + (vitorias[dif].vitorias === 1 ? "" : "s"));
    if (tempos[dif]) partes.push("melhor " + formatarTempo(tempos[dif].tempo_segundos));
    if (partes.length) {
      temAlgo = true;
      adicionarLinhaPerfil(card, nomesDificuldade[dif], partes.join(" · "));
    }
  });
  if (!temAlgo) card.innerHTML += '<p class="perfil-vazio">Ainda sem recorde salvo.</p>';
  return card;
}

function cartaoPerfilLudo(ludo) {
  var card = criarCartaoPerfil("Ludo");
  if (!ludo) {
    card.innerHTML += '<p class="perfil-vazio">Ainda sem vitórias registradas.</p>';
    return card;
  }
  adicionarLinhaPerfil(card, "Vitórias", String(ludo.vitorias));
  return card;
}

function irParaMulti() {
  if (!multiNaTela || !multiSala) return;
  mostrarTela(document.querySelector("#tela-multitela"));
}

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
document.querySelector("#btn-perfil").addEventListener("click", abrirPerfil);

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------
window.addEventListener("error", function (e) {
  console.error("Erro global:", e.message, e.filename, e.lineno);
});

window.addEventListener("unhandledrejection", function (e) {
  console.error("Promise rejeitada:", e.reason);
});

// ---------------------------------------------------------------------------
// Campo Minado — solo + online 1x1
// ---------------------------------------------------------------------------
var campoOnlineAtivo = false;
var campoWs = null;
var campoSala = null;
var campoSlot = null;
var campoFase = null;
var campoModo = "solo"; // solo | online
var campoDificuldade = "facil";
var campoLinhas = 10;
var campoColunas = 10;
var campoBombasTotais = 12;
var campoMinas = null;
var campoNums = null;
var campoReveladas = {};
var campoBandeiras = {};
var campoAcabou = false;
var campoCelEls = [];
var campoPrimeiroClique = false;
var campoTimer = null;
var campoInicioMs = 0;
var campoPingTimer = null;
var campoPlacar = { p1: 0, p2: 0 };
var campoJogadores = [];
var campoVencedor = null;
var campoTempoFinal = 0;
var campoHoldTimer = null;
var campoHoldIdx = -1;
var campoHoldAtivou = false;

const CAMPO_DIM_JS = {
  facil: { l: 10, c: 10, b: 12 },
  medio: { l: 18, c: 18, b: 45 },
  dificil: { l: 24, c: 24, b: 90 },
};
const campoNomeDif = { facil: "Fácil", medio: "Médio", dificil: "Difícil" };

function campoMsg(texto, tipo) {
  var el = document.querySelector("#mensagem-campo");
  if (!el) return;
  el.textContent = texto || "";
  el.className = "mensagem " + (tipo || "");
}

function campoLobbyMsg(texto, tipo) {
  var el = document.querySelector("#mensagem-campo-lobby");
  if (!el) return;
  el.textContent = texto || "";
  el.className = "mensagem " + (tipo || "");
}

function campoMostrarBotao(sel, on) {
  var el = document.querySelector(sel);
  if (el) el.style.display = on ? "" : "none";
}

function campoPararTimer() {
  clearInterval(campoTimer);
  campoTimer = null;
}

function campoIniciarTimer() {
  campoPararTimer();
  campoInicioMs = Date.now();
  var el = document.querySelector("#campo-cronometro");
  if (el) el.textContent = "00:00";
  campoTimer = setInterval(function () {
    var seg = Math.floor((Date.now() - campoInicioMs) / 1000);
    if (el) el.textContent = formatarTempo(seg);
  }, 250);
}

function campoTempoSeg() {
  if (!campoInicioMs) return 0;
  return Math.max(0, Math.floor((Date.now() - campoInicioMs) / 1000));
}

function campoAtualizarStatus(reveladas, seguras, bandeiras) {
  var br = document.querySelector("#campo-bombas-restantes");
  var bd = document.querySelector("#campo-bandeiras");
  var pr = document.querySelector("#campo-progresso");
  var sg = document.querySelector("#campo-seguras");
  var bandQtd = Object.keys(campoBandeiras).length;
  if (bandeiras != null) bandQtd = bandeiras;
  if (br) br.textContent = String(Math.max(0, campoBombasTotais - bandQtd));
  if (bd) bd.textContent = String(bandQtd);
  var ab = reveladas != null ? reveladas : Object.keys(campoReveladas).length;
  var seg = seguras != null ? seguras : (campoLinhas * campoColunas - campoBombasTotais);
  if (pr) pr.textContent = String(ab);
  if (sg) sg.textContent = String(seg);
}

function campoMontarTabuleiro() {
  var board = document.querySelector("#tabuleiro-campo");
  if (!board) return;
  board.innerHTML = "";
  board.style.gridTemplateColumns = "repeat(" + campoColunas + ", 1fr)";
  campoCelEls = new Array(campoLinhas * campoColunas);
  var frag = document.createDocumentFragment();
  for (var i = 0; i < campoLinhas * campoColunas; i++) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "campo-cel";
    btn.dataset.idx = String(i);
    btn.setAttribute("aria-label", "Célula " + (i + 1));
    campoCelEls[i] = btn;
    frag.appendChild(btn);
  }
  board.appendChild(frag);
  campoAtualizarStatus(0, campoLinhas * campoColunas - campoBombasTotais, 0);
}

function campoPintarCelula(i, estado, valor) {
  var el = campoCelEls[i];
  if (!el) return;
  el.className = "campo-cel";
  el.textContent = "";
  if (estado === "aberta") {
    el.classList.add("aberta");
    if (valor > 0) {
      el.classList.add("n" + valor);
      el.textContent = String(valor);
    }
  } else if (estado === "bandeira") {
    el.classList.add("bandeira");
  } else if (estado === "bomba") {
    el.classList.add("bomba", "aberta");
  } else if (estado === "perigo") {
    el.classList.add("perigo", "aberta");
  }
}

function campoGerarSolo() {
  var dim = CAMPO_DIM_JS[campoDificuldade] || CAMPO_DIM_JS.facil;
  campoLinhas = dim.l;
  campoColunas = dim.c;
  campoBombasTotais = dim.b;
  var total = campoLinhas * campoColunas;
  var minas = new Set();
  while (minas.size < campoBombasTotais) {
    minas.add(Math.floor(Math.random() * total));
  }
  campoMinas = Array.from(minas).sort(function (a, b) { return a - b; });
  campoNums = new Array(total).fill(0);
  for (var i = 0; i < total; i++) {
    if (minas.has(i)) { campoNums[i] = -1; continue; }
    var r = Math.floor(i / campoColunas);
    var c = i % campoColunas;
    var n = 0;
    for (var dr = -1; dr <= 1; dr++) {
      for (var dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        var rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < campoLinhas && cc >= 0 && cc < campoColunas) {
          if (minas.has(rr * campoColunas + cc)) n++;
        }
      }
    }
    campoNums[i] = n;
  }
}

function campoMoverMinas(primeiro) {
  if (!campoMinas) return;
  var total = campoLinhas * campoColunas;
  var proibido = new Set();
  var r0 = Math.floor(primeiro / campoColunas);
  var c0 = primeiro % campoColunas;
  for (var dr = -1; dr <= 1; dr++) {
    for (var dc = -1; dc <= 1; dc++) {
      var rr = r0 + dr, cc = c0 + dc;
      if (rr >= 0 && rr < campoLinhas && cc >= 0 && cc < campoColunas) {
        proibido.add(rr * campoColunas + cc);
      }
    }
  }
  var conjunto = new Set(campoMinas);
  proibido.forEach(function (i) { conjunto.delete(i); });
  for (var i = 0; i < total && conjunto.size < campoBombasTotais; i++) {
    if (!conjunto.has(i) && !proibido.has(i)) conjunto.add(i);
  }
  campoMinas = Array.from(conjunto).sort(function (a, b) { return a - b; });
  campoNums = new Array(total).fill(0);
  var minas = new Set(campoMinas);
  for (var j = 0; j < total; j++) {
    if (minas.has(j)) { campoNums[j] = -1; continue; }
    var r = Math.floor(j / campoColunas);
    var c = j % campoColunas;
    var n = 0;
    for (var dr2 = -1; dr2 <= 1; dr2++) {
      for (var dc2 = -1; dc2 <= 1; dc2++) {
        if (!dr2 && !dc2) continue;
        var r2 = r + dr2, c2 = c + dc2;
        if (r2 >= 0 && r2 < campoLinhas && c2 >= 0 && c2 < campoColunas) {
          if (minas.has(r2 * campoColunas + c2)) n++;
        }
      }
    }
    campoNums[j] = n;
  }
}

function campoFlood(inicio) {
  var out = [];
  var visit = new Set();
  var fila = [inicio];
  var minas = new Set(campoMinas || []);
  while (fila.length) {
    var i = fila.pop();
    if (visit.has(i)) continue;
    visit.add(i);
    if (minas.has(i)) continue;
    out.push(i);
    if (campoNums[i] !== 0) continue;
    var r = Math.floor(i / campoColunas);
    var c = i % campoColunas;
    for (var dr = -1; dr <= 1; dr++) {
      for (var dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        var rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < campoLinhas && cc >= 0 && cc < campoColunas) {
          var j = rr * campoColunas + cc;
          if (!visit.has(j)) fila.push(j);
        }
      }
    }
  }
  return out;
}

function campoRevelarSolo(idx) {
  if (campoAcabou) return;
  if (campoReveladas[idx] || campoBandeiras[idx]) return;
  if (!campoPrimeiroClique) {
    campoPrimeiroClique = true;
    campoGerarSolo();
    campoMoverMinas(idx);
    campoIniciarTimer();
  }
  if ((campoMinas || []).indexOf(idx) >= 0) {
    campoDerrotaSolo(idx);
    return;
  }
  var abertas = campoFlood(idx);
  for (var k = 0; k < abertas.length; k++) {
    var i = abertas[k];
    if (campoReveladas[i]) continue;
    campoReveladas[i] = true;
    campoPintarCelula(i, "aberta", campoNums[i]);
  }
  var total = campoLinhas * campoColunas;
  var seguras = total - campoBombasTotais;
  var abertasQtd = Object.keys(campoReveladas).length;
  campoAtualizarStatus(abertasQtd, seguras, null);
  if (abertasQtd >= seguras) campoVitoriaSolo();
}

function campoDerrotaSolo(idx) {
  campoAcabou = true;
  campoPararTimer();
  for (var m = 0; m < (campoMinas || []).length; m++) {
    campoPintarCelula(campoMinas[m], "bomba", -1);
  }
  campoPintarCelula(idx, "perigo", -1);
  campoMsg("💥 Você acertou uma bomba! Tempo: " + formatarTempo(campoTempoSeg()), "erro");
  campoMostrarBotao("#campo-reiniciar", true);
}

async function campoVitoriaSolo() {
  campoAcabou = true;
  campoPararTimer();
  campoTempoFinal = campoTempoSeg();
  for (var m = 0; m < (campoMinas || []).length; m++) {
    if (!campoReveladas[campoMinas[m]] && !campoBandeiras[campoMinas[m]]) {
      campoPintarCelula(campoMinas[m], "bandeira", -1);
    }
  }
  campoMsg("✅ Vitória! Tempo: " + formatarTempo(campoTempoFinal), "sucesso");
  campoMostrarBotao("#campo-reiniciar", true);
  try {
    await garantirIdentidade();
    await fetch("./campo/recordes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dificuldade: campoDificuldade,
        nome: nomeUsuario(),
        nick: nomeExibicao(),
        tempo_segundos: campoTempoFinal,
        avatar: avatarAtual(),
      }),
    });
    carregarRankingCampo();
    registrarHistoricoGeral("Campo Minado", "Vitória · " + formatarTempo(campoTempoFinal));
  } catch (e) { /* ignore */ }
}

function campoToggleBandeiraSolo(idx) {
  if (campoAcabou || campoReveladas[idx]) return;
  if (campoBandeiras[idx]) {
    delete campoBandeiras[idx];
    campoPintarCelula(idx, "coberta", 0);
  } else {
    campoBandeiras[idx] = true;
    campoPintarCelula(idx, "bandeira", 0);
  }
  campoAtualizarStatus(null, null, null);
}

function iniciarCampoSolo(dificuldade) {
  campoModo = "solo";
  campoOnlineAtivo = false;
  campoFecharWs();
  campoDificuldade = dificuldade || "facil";
  campoReveladas = {};
  campoBandeiras = {};
  campoAcabou = false;
  campoPrimeiroClique = false;
  campoInicioMs = 0;
  campoMinas = null;
  campoNums = null;
  campoVencedor = null;
  campoTempoFinal = 0;
  campoPararTimer();
  var dim = CAMPO_DIM_JS[campoDificuldade] || CAMPO_DIM_JS.facil;
  campoLinhas = dim.l;
  campoColunas = dim.c;
  campoBombasTotais = dim.b;
  var difL = document.querySelector("#campo-dificuldade-label");
  if (difL) difL.textContent = campoNomeDif[campoDificuldade] || campoDificuldade;
  document.querySelector("#campo-sala-bar").style.display = "none";
  document.querySelector("#placar-times-campo").style.display = "none";
  campoMostrarBotao("#campo-reiniciar", false);
  campoMostrarBotao("#campo-pedir-revanche", false);
  campoMostrarBotao("#campo-responder-sim", false);
  campoMostrarBotao("#campo-responder-nao", false);
  campoMostrarBotao("#campo-sair-sala", false);
  document.querySelector("#campo-status-bar").style.display = "flex";
  campoMontarTabuleiro();
  var cron = document.querySelector("#campo-cronometro");
  if (cron) cron.textContent = "00:00";
  campoMsg("Toque nas células. Botão direito / pressão longa = bandeira.", "");
  mostrarTela(document.querySelector("#tela-campo"));
  carregarRankingCampo();
}

function campoFecharWs() {
  campoPararTimer();
  clearInterval(campoPingTimer);
  campoPingTimer = null;
  if (campoWs) {
    try { campoWs.close(); } catch (e) { /* ignore */ }
    campoWs = null;
  }
}

function campoFechar(motivo) {
  campoFecharWs();
  campoOnlineAtivo = false;
  campoSala = null;
  campoSlot = null;
  campoFase = null;
  campoAcabou = true;
  campoPararTimer();
  if (motivo) campoMsg(motivo, "erro");
}

async function criarSalaCampo() {
  await garantirIdentidade();
  if (dentroDaActivity() && !usuarioDiscord) {
    campoLobbyMsg("Não consegui identificar seu Discord. Recarregue (Ctrl+F5) e tente de novo.", "erro");
    return;
  }
  var codigo = (document.querySelector("#campo-codigo-sala").value || "").trim().toLowerCase();
  var publica = !!document.querySelector("#campo-sala-publica").checked;
  var difSel = document.querySelector("#campo-dificuldade-online .botao-preset.selecionado");
  var dif = (difSel && difSel.dataset.dif) || "facil";
  try {
    var res = await fetch("./campo/sala/novo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codigo: codigo || null,
        publica: publica,
        dificuldade: dif,
        nome: nomeUsuario(),
        nick: nomeExibicao(),
        avatar: avatarAtual(),
      }),
    });
    var dados = await res.json();
    if (!res.ok) throw new Error(dados.detail || "Erro ao criar sala.");
    campoOnlineAtivo = true;
    campoSala = dados.sala;
    campoDificuldade = dados.dificuldade || dif;
    campoPlacar = { p1: 0, p2: 0 };
    campoLobbyMsg("Sala criada: " + dados.sala + ".", "sucesso");
    prepararTelaCampoOnline(dados.sala);
    conectarWsCampo(dados.sala);
    if (discordSdkGlobal && publica) {
      try {
        await discordSdkGlobal.commands.shareLink({
          message: "Bora jogar Campo Minado! Sala: " + dados.sala,
          custom_id: "campo-" + dados.sala,
        });
      } catch (e) { /* cancelado */ }
    }
  } catch (erro) {
    campoLobbyMsg(erro.message, "erro");
  }
}

async function entrarSalaCampo(codigo) {
  codigo = (codigo || "").trim().toLowerCase();
  if (!codigo) {
    campoLobbyMsg("Digite o código da sala.", "erro");
    return;
  }
  await garantirIdentidade();
  if (dentroDaActivity() && !usuarioDiscord) {
    campoLobbyMsg("Não consegui identificar seu Discord. Recarregue (Ctrl+F5) e tente de novo.", "erro");
    return;
  }
  campoOnlineAtivo = true;
  campoPlacar = { p1: 0, p2: 0 };
  prepararTelaCampoOnline(codigo);
  campoMsg("Entrando na sala " + codigo + "...", "");
  conectarWsCampo(codigo);
}

function prepararTelaCampoOnline(sala) {
  campoSala = sala;
  campoModo = "online";
  campoAcabou = false;
  campoReveladas = {};
  campoBandeiras = {};
  campoPrimeiroClique = true;
  campoMinas = null;
  campoNums = null;
  campoVencedor = null;
  campoPararTimer();
  var bar = document.querySelector("#campo-sala-bar");
  var cod = document.querySelector("#campo-sala-codigo");
  if (bar) bar.style.display = "flex";
  if (cod) cod.textContent = sala;
  document.querySelector("#placar-times-campo").style.display = "flex";
  document.querySelector("#campo-status-bar").style.display = "flex";
  campoMostrarBotao("#campo-reiniciar", false);
  campoMostrarBotao("#campo-pedir-revanche", false);
  campoMostrarBotao("#campo-responder-sim", false);
  campoMostrarBotao("#campo-responder-nao", false);
  campoMostrarBotao("#campo-sair-sala", true);
  var difL = document.querySelector("#campo-dificuldade-label");
  if (difL) difL.textContent = campoNomeDif[campoDificuldade] || campoDificuldade;
  var dim = CAMPO_DIM_JS[campoDificuldade] || CAMPO_DIM_JS.facil;
  campoLinhas = dim.l;
  campoColunas = dim.c;
  campoBombasTotais = dim.b;
  campoMontarTabuleiro();
  var cron = document.querySelector("#campo-cronometro");
  if (cron) cron.textContent = "00:00";
  mostrarTela(document.querySelector("#tela-campo"));
  carregarRankingCampo();
}

async function carregarSalasCampo() {
  var container = document.querySelector("#salas-campo-conteudo");
  if (!container) return;
  try {
    var res = await fetch("./campo/salas");
    var dados = await res.json();
    var lista = dados.salas || [];
    container.innerHTML = "";
    if (!lista.length) {
      container.innerHTML = '<p class="vazio">Nenhuma sala pública.</p>';
      return;
    }
    lista.forEach(function (s) {
      var item = document.createElement("div");
      item.className = "sala-item";
      item.innerHTML =
        '<div class="sala-item-info">' +
        "<strong>" + escapeHtml(s.lider || "?") + "</strong>" +
        "<small>" + escapeHtml(s.sala) + " · " + (campoNomeDif[s.dificuldade] || s.dificuldade) +
        " · " + (s.fase === "esperando" ? "Aguardando" : "Em jogo") + "</small></div>" +
        '<span class="sala-item-jogadores">' + s.jogadores + "/2</span>";
      item.addEventListener("click", function () {
        entrarSalaCampo(s.sala);
      });
      container.appendChild(item);
    });
  } catch (e) {
    container.innerHTML = '<p class="vazio">Erro ao carregar salas.</p>';
  }
}

function renderizarSalasCampo(salas) {
  var container = document.querySelector("#salas-campo-conteudo");
  if (!container) return;
  if (!salas || !salas.length) {
    container.innerHTML = '<p class="vazio">Nenhuma sala pública.</p>';
    return;
  }
  container.innerHTML = "";
  salas.forEach(function (s) {
    var item = document.createElement("div");
    item.className = "sala-item";
    item.innerHTML =
      '<div class="sala-item-info">' +
      "<strong>" + escapeHtml(s.lider || "?") + "</strong>" +
      "<small>" + escapeHtml(s.sala) + " · " + (campoNomeDif[s.dificuldade] || s.dificuldade) + "</small></div>" +
      '<span class="sala-item-jogadores">' + s.jogadores + "/2</span>";
    item.addEventListener("click", function () { entrarSalaCampo(s.sala); });
    container.appendChild(item);
  });
}

function conectarWsCampo(sala) {
  campoFecharWs();
  var nome = nomeUsuario();
  var nick = nomeExibicao();
  var avatar = avatarAtual() || "";
  var protocolo = location.protocol === "https:" ? "wss:" : "ws:";
  var url = protocolo + "//" + location.host + "/ws/campo/" + encodeURIComponent(sala) +
    "?nome=" + encodeURIComponent(nome) +
    "&nick=" + encodeURIComponent(nick) +
    "&avatar=" + encodeURIComponent(avatar);
  campoWs = new WebSocket(url);
  campoPingTimer = setInterval(function () {
    if (campoWs && campoWs.readyState === WebSocket.OPEN) {
      campoWs.send(JSON.stringify({ tipo: "ping" }));
    }
  }, 20000);
  campoWs.onmessage = function (evento) {
    try {
      processarMensagemCampo(JSON.parse(evento.data));
    } catch (e) {
      console.error("campo ws:", e);
    }
  };
  campoWs.onclose = function () {
    clearInterval(campoPingTimer);
    if (campoOnlineAtivo) campoMsg("Conexão perdida.", "erro");
  };
  campoWs.onerror = function () {};
}

function campoRenderPlacar(jogadores, placar) {
  if (placar) campoPlacar = placar;
  if (jogadores) campoJogadores = jogadores;
  var p1 = (campoJogadores || [])[0] || {};
  var p2 = (campoJogadores || [])[1] || {};
  ["p1", "p2"].forEach(function (slot, i) {
    var j = i === 0 ? p1 : p2;
    var av = document.querySelector("#placar-campo-avatar-" + slot);
    var nk = document.querySelector("#placar-campo-nick-" + slot);
    var gl = document.querySelector("#placar-campo-gol-" + slot);
    if (nk) nk.textContent = j.nick || "—";
    if (gl) gl.textContent = String((campoPlacar || {})[slot] || 0);
    if (av) {
      if (j.avatar) {
        av.innerHTML = '<img src="' + escapeHtml(j.avatar) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />';
      } else {
        av.textContent = (j.nick || "?").charAt(0).toUpperCase();
      }
    }
  });
}

function processarMensagemCampo(dados) {
  switch (dados.tipo) {
    case "erro":
      campoMsg(dados.mensagem || "Erro.", "erro");
      if (dados.mensagem === "Sala cheia." || dados.mensagem === "Sala não encontrada.") {
        campoOnlineAtivo = false;
        setTimeout(function () { mostrarTela(document.querySelector("#tela-lobby-campo")); }, 1200);
      }
      break;
    case "estado_campo":
      campoFase = dados.fase;
      campoDificuldade = dados.dificuldade || campoDificuldade;
      campoPlacar = dados.placar || campoPlacar;
      campoJogadores = dados.jogadores || [];
      campoSlot = dados.meu_slot;
      if (dados.linhas) {
        campoLinhas = dados.linhas;
        campoColunas = dados.colunas;
        campoBombasTotais = dados.bombas;
      }
      campoRenderPlacar(campoJogadores, campoPlacar);
      if (dados.fase === "esperando") {
        campoMsg("Aguardando o oponente... Sala: " + dados.sala, "sucesso");
        campoAcabou = false;
        document.querySelector("#campo-status-bar").style.display = "flex";
        campoMostrarBotao("#campo-sair-sala", true);
        campoMostrarBotao("#campo-reiniciar", false);
        campoMostrarBotao("#campo-pedir-revanche", false);
        campoMostrarBotao("#campo-responder-sim", false);
        campoMostrarBotao("#campo-responder-nao", false);
        var bar = document.querySelector("#campo-sala-bar");
        if (bar) bar.style.display = "flex";
        var cod = document.querySelector("#campo-sala-codigo");
        if (cod) cod.textContent = dados.sala;
        document.querySelector("#placar-times-campo").style.display = "flex";
        var difL = document.querySelector("#campo-dificuldade-label");
        if (difL) difL.textContent = campoNomeDif[campoDificuldade] || campoDificuldade;
        var dim = CAMPO_DIM_JS[campoDificuldade] || CAMPO_DIM_JS.facil;
        campoLinhas = dim.l;
        campoColunas = dim.c;
        campoBombasTotais = dim.b;
        if (!campoCelEls.length || campoCelEls.length !== campoLinhas * campoColunas) {
          campoMontarTabuleiro();
        }
      } else if (dados.fase === "jogando") {
        campoMsg("Jogo em andamento!", "");
      }
      break;
    case "contagem":
      campoFase = "contagem";
      if (dados.n > 0) {
        campoMsg("Começa em " + dados.n + "...", "");
      } else {
        campoMsg("Valendo!", "sucesso");
      }
      break;
    case "inicio_campo":
      campoFase = "jogando";
      campoDificuldade = dados.dificuldade || campoDificuldade;
      campoLinhas = dados.linhas || 10;
      campoColunas = dados.colunas || 10;
      campoBombasTotais = dados.bombas || 12;
      campoSlot = dados.meu_slot || campoSlot;
      campoReveladas = {};
      campoBandeiras = {};
      campoAcabou = false;
      campoPrimeiroClique = true;
      campoMinas = null;
      campoNums = null;
      campoVencedor = null;
      campoPararTimer();
      campoIniciarTimer();
      var difL2 = document.querySelector("#campo-dificuldade-label");
      if (difL2) difL2.textContent = campoNomeDif[campoDificuldade] || campoDificuldade;
      campoMontarTabuleiro();
      campoMsg("Corra! Quem revelar tudo primeiro vence.", "sucesso");
      campoMostrarBotao("#campo-reiniciar", false);
      campoMostrarBotao("#campo-pedir-revanche", false);
      campoMostrarBotao("#campo-responder-sim", false);
      campoMostrarBotao("#campo-responder-nao", false);
      campoMostrarBotao("#campo-sair-sala", true);
      break;
    case "revelado":
      if (dados.nums && !campoNums) {
        // precisa nums para flood local — se servidor mandar só novas, aplica
      }
      if (dados.celulas) {
        dados.celulas.forEach(function (i) {
          campoReveladas[i] = true;
          var n = dados.nums ? dados.nums[String(i)] : 0;
          campoPintarCelula(i, "aberta", n == null ? 0 : n);
        });
      }
      campoAtualizarStatus(dados.reveladas_total, dados.seguras, null);
      break;
    case "marcado":
      if (dados.slot === campoSlot) {
        campoBandeiras = {};
        (dados.bandeiras || []).forEach(function (i) { campoBandeiras[i] = true; });
        campoReDesenharBandeiras();
        campoAtualizarStatus(null, null, dados.bandeiras_qtd);
      }
      break;
    case "voce_perdeu":
      campoAcabou = true;
      campoPararTimer();
      if (dados.minas) {
        campoMinas = dados.minas;
        (dados.minas || []).forEach(function (m) {
          if (!campoReveladas[m]) campoPintarCelula(m, "bomba", -1);
        });
      }
      if (dados.idx != null) campoPintarCelula(dados.idx, "perigo", -1);
      campoMsg("💥 Você acertou uma bomba!", "erro");
      campoMostrarBotao("#campo-pedir-revanche", true);
      break;
    case "progresso_campo":
      campoRenderPlacar(dados.jogadores, campoPlacar);
      break;
    case "vencedor_rodada":
      campoAcabou = true;
      campoPararTimer();
      campoVencedor = dados.slot;
      campoTempoFinal = dados.tempo || 0;
      campoPlacar = dados.placar || campoPlacar;
      campoRenderPlacar(dados.jogadores, campoPlacar);
      if (dados.minas) {
        campoMinas = dados.minas;
        (dados.minas || []).forEach(function (m) {
          if (!campoReveladas[m]) campoPintarCelula(m, "bandeira", -1);
        });
      }
      if (dados.desistencia) {
        campoMsg(dados.mensagem || "Oponente saiu. Você venceu!", "sucesso");
      } else if (dados.slot === campoSlot) {
        campoMsg("✅ Você venceu! Tempo: " + formatarTempo(dados.tempo || 0), "sucesso");
      } else {
        campoMsg("❌ " + (dados.nick || "Oponente") + " venceu em " + formatarTempo(dados.tempo || 0) + ".", "erro");
      }
      campoMostrarBotao("#campo-pedir-revanche", true);
      campoMostrarBotao("#campo-reiniciar", false);
      carregarRankingCampo();
      break;
    case "ambos_perderam":
      campoAcabou = true;
      campoPararTimer();
      campoPlacar = dados.placar || campoPlacar;
      campoRenderPlacar(dados.jogadores, campoPlacar);
      if (dados.minas) {
        campoMinas = dados.minas;
        (dados.minas || []).forEach(function (m) {
          if (!campoReveladas[m]) campoPintarCelula(m, "bomba", -1);
        });
      }
      campoMsg("💣 Ambos erraram. Empate!", "erro");
      campoMostrarBotao("#campo-pedir-revanche", true);
      break;
    case "revanche_pedida":
      campoMsg((dados.por || "Oponente") + " pediu revanche...", "");
      campoMostrarBotao("#campo-responder-sim", true);
      campoMostrarBotao("#campo-responder-nao", true);
      break;
    case "revanche_aceita":
      campoMsg("Revanche! Preparando...", "sucesso");
      campoMostrarBotao("#campo-responder-sim", false);
      campoMostrarBotao("#campo-responder-nao", false);
      campoMostrarBotao("#campo-pedir-revanche", false);
      break;
    case "revanche_recusada":
      campoFechar("Revanche recusada. Sala encerrada.");
      mostrarTela(document.querySelector("#tela-lobby-campo"));
      break;
    case "sala_campo_encerrada":
      campoFechar(null);
      if (dados.motivo && dados.motivo !== "parou") {
        campoMsg("Sala encerrada: " + dados.motivo, "erro");
      }
      break;
    case "pong":
      break;
    default:
      break;
  }
}

function campoReDesenharBandeiras() {
  for (var i = 0; i < campoCelEls.length; i++) {
    if (campoReveladas[i]) continue;
    if (campoBandeiras[i]) campoPintarCelula(i, "bandeira", 0);
    else campoPintarCelula(i, "coberta", 0);
  }
}

function campoCliqueRevelar(idx) {
  if (campoAcabou) return;
  if (campoReveladas[idx] || campoBandeiras[idx]) return;
  if (campoModo === "online") {
    if (campoFase !== "jogando") return;
    if (campoWs && campoWs.readyState === WebSocket.OPEN) {
      campoWs.send(JSON.stringify({ tipo: "revelar", idx: idx }));
    }
    return;
  }
  campoRevelarSolo(idx);
}

function campoCliqueBandeira(idx) {
  if (campoAcabou) return;
  if (campoReveladas[idx]) return;
  if (campoModo === "online") {
    if (campoFase !== "jogando") return;
    if (campoWs && campoWs.readyState === WebSocket.OPEN) {
      campoWs.send(JSON.stringify({ tipo: "marcar", idx: idx }));
    }
    return;
  }
  campoToggleBandeiraSolo(idx);
}

function campoEhTouch(ev) {
  return ev.pointerType === "touch" || ev.pointerType === "pen" ||
    (window.navigator && window.navigator.maxTouchPoints > 0 && ev.pointerType !== "mouse");
}

function campoMontarEventos() {
  var board = document.querySelector("#tabuleiro-campo");
  if (!board || board.dataset.campoOk) return;
  board.dataset.campoOk = "1";

  board.addEventListener("contextmenu", function (ev) {
    var cel = ev.target.closest(".campo-cel");
    if (!cel) return;
    ev.preventDefault();
    campoCliqueBandeira(parseInt(cel.dataset.idx, 10));
  });

  board.addEventListener("pointerdown", function (ev) {
    var cel = ev.target.closest(".campo-cel");
    if (!cel) return;
    var idx = parseInt(cel.dataset.idx, 10);
    if (campoEhTouch(ev)) {
      ev.preventDefault();
      campoHoldIdx = idx;
      campoHoldAtivou = false;
      clearTimeout(campoHoldTimer);
      campoHoldTimer = setTimeout(function () {
        campoHoldAtivou = true;
        campoCliqueBandeira(idx);
      }, 450);
    }
  });

  board.addEventListener("pointerup", function (ev) {
    var cel = ev.target.closest(".campo-cel");
    if (!cel) return;
    var idx = parseInt(cel.dataset.idx, 10);
    clearTimeout(campoHoldTimer);
    if (campoEhTouch(ev)) {
      ev.preventDefault();
      if (!campoHoldAtivou && campoHoldIdx === idx) {
        campoCliqueRevelar(idx);
      }
      campoHoldIdx = -1;
      campoHoldAtivou = false;
      return;
    }
    if (ev.button === 2) return;
    if (ev.button === 0 || ev.buttons === 0) {
      if (ev.detail >= 2) return;
      campoCliqueRevelar(idx);
    }
  });

  board.addEventListener("pointercancel", function () {
    clearTimeout(campoHoldTimer);
    campoHoldIdx = -1;
    campoHoldAtivou = false;
  });

  board.addEventListener("pointerleave", function () {
    clearTimeout(campoHoldTimer);
  });

  // Desktop: clique esquerdo via click (evita double-fire com pointerup)
  board.addEventListener("click", function (ev) {
    var cel = ev.target.closest(".campo-cel");
    if (!cel) return;
    if (campoEhTouch(ev)) return;
    // pointerup já tratou mouse — só fallback se pointer não disparou
  });
}

async function carregarRankingCampo() {
  var container = document.querySelector("#lista-ranking-campo");
  if (!container) return;
  try {
    var dif = campoDificuldade || "facil";
    var res = await fetch("./campo/ranking?dificuldade=" + encodeURIComponent(dif));
    var dados = await res.json();
    var lista = dados.ranking || [];
    var medallas = ["🥇", "🥈", "🥉"];
    var titulo = container.parentElement && container.parentElement.querySelector("h2");
    if (titulo) {
      titulo.textContent = "Top 3 vitórias — " + (campoNomeDif[dif] || dif);
    }
    if (!lista.length) {
      container.innerHTML = '<p class="vazio">Nenhuma vitória ainda.</p>';
      return;
    }
    container.innerHTML = "";
    lista.slice(0, 3).forEach(function (r, i) {
      var img = r.avatar
        ? '<img class="recorde-avatar" src="' + escapeHtml(r.avatar) + '" alt="" />'
        : '<span class="recorde-avatar placeholder">' + escapeHtml((r.nick || "?").charAt(0).toUpperCase()) + "</span>";
      var tempo = r.melhor_tempo ? formatarTempo(r.melhor_tempo) : "—";
      var el = document.createElement("div");
      el.className = "registro-recorde campo-top";
      el.innerHTML =
        '<span class="recorde-posicao">' + (medallas[i] || (i + 1)) + "</span>" +
        img +
        '<span class="recorde-info"><strong>' + escapeHtml(r.nick) + "</strong>" +
        '<span class="recorde-vert">' +
        '<span class="vitorias-linha">' + (r.vitorias || 0) + " vitórias</span>" +
        '<span class="tempo-linha">' + tempo + "</span>" +
        "</span></span>";
      container.appendChild(el);
    });
  } catch (e) {
    container.innerHTML = '<p class="vazio">Erro ao carregar ranking.</p>';
  }
}

// Navegação Campo Minado
document.querySelector("#jogo-campo").addEventListener("click", function () {
  mostrarTela(document.querySelector("#tela-modo-campo"));
  carregarRankingCampo();
});

document.querySelectorAll("[data-modo-campo]").forEach(function (botao) {
  botao.addEventListener("click", function () {
    var modo = botao.dataset.modoCampo;
    if (modo === "solo") {
      mostrarTela(document.querySelector("#tela-dificuldade-campo"));
    } else if (modo === "online") {
      mostrarTela(document.querySelector("#tela-lobby-campo"));
      carregarSalasCampo();
      conectarLobbyWs();
    }
  });
});

document.querySelectorAll("[data-dificuldade-campo]").forEach(function (botao) {
  botao.addEventListener("click", function () {
    iniciarCampoSolo(botao.dataset.dificuldadeCampo);
  });
});

document.querySelectorAll("#campo-dificuldade-online .botao-preset").forEach(function (b) {
  b.addEventListener("click", function () {
    document.querySelectorAll("#campo-dificuldade-online .botao-preset").forEach(function (x) {
      x.classList.remove("selecionado");
    });
    b.classList.add("selecionado");
  });
});

document.querySelector("#criar-sala-campo").addEventListener("click", criarSalaCampo);
document.querySelector("#entrar-sala-campo").addEventListener("click", function () {
  entrarSalaCampo(document.querySelector("#campo-codigo-sala").value);
});
document.querySelector("#campo-codigo-sala").addEventListener("keydown", function (e) {
  if (e.key === "Enter") entrarSalaCampo(this.value);
});
document.querySelector("#atualizar-salas-campo").addEventListener("click", carregarSalasCampo);

document.querySelector("#campo-reiniciar").addEventListener("click", function () {
  if (campoModo === "online") {
    if (campoWs && campoWs.readyState === WebSocket.OPEN) {
      campoWs.send(JSON.stringify({ tipo: "pedir_revanche" }));
      campoMsg("Revanche pedida...", "");
      campoMostrarBotao("#campo-reiniciar", false);
    }
  } else {
    iniciarCampoSolo(campoDificuldade);
  }
});
document.querySelector("#campo-pedir-revanche").addEventListener("click", function () {
  if (campoWs && campoWs.readyState === WebSocket.OPEN) {
    campoWs.send(JSON.stringify({ tipo: "pedir_revanche" }));
    campoMsg("Revanche pedida ao oponente...", "");
    campoMostrarBotao("#campo-pedir-revanche", false);
  }
});
document.querySelector("#campo-responder-sim").addEventListener("click", function () {
  if (campoWs && campoWs.readyState === WebSocket.OPEN) {
    campoWs.send(JSON.stringify({ tipo: "responder_revanche", aceitar: true }));
    campoMostrarBotao("#campo-responder-sim", false);
    campoMostrarBotao("#campo-responder-nao", false);
  }
});
document.querySelector("#campo-responder-nao").addEventListener("click", function () {
  if (campoWs && campoWs.readyState === WebSocket.OPEN) {
    campoWs.send(JSON.stringify({ tipo: "responder_revanche", aceitar: false }));
    campoMostrarBotao("#campo-responder-sim", false);
    campoMostrarBotao("#campo-responder-nao", false);
  }
});
document.querySelector("#campo-sair-sala").addEventListener("click", function () {
  if (campoWs && campoWs.readyState === WebSocket.OPEN) {
    try { campoWs.send(JSON.stringify({ tipo: "sair" })); } catch (e) { /* ignore */ }
  }
  campoFechar(null);
  carregarSalasCampo();
  mostrarTela(document.querySelector("#tela-lobby-campo"));
});
document.querySelector("#copiar-codigo-campo").addEventListener("click", function () {
  var codigo = (document.querySelector("#campo-sala-codigo").textContent || "").trim();
  if (!codigo || !navigator.clipboard) return;
  navigator.clipboard.writeText(codigo).then(function () {
    var btn = document.querySelector("#copiar-codigo-campo");
    btn.textContent = "Copiado!";
    btn.classList.add("copiado");
    setTimeout(function () {
      btn.textContent = "Copiar";
      btn.classList.remove("copiado");
    }, 2000);
  });
});

campoMontarEventos();
carregarRankingCampo();

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
  }).catch(function (e) {
    console.error("Init OAuth/deep-link falhou:", e);
    if (location.pathname !== "/") history.replaceState({}, "", "/");
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
        velhaDificuldade = "facil";
        carregarRankingVelha();
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
