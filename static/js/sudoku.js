// Sudoku — solo e online (grade 9x9).

let jogoId = null;
let gradeAtual = [];
let dificuldadeAtual = "facil";
let tempoInicial = 0;
let intervaloCronometro = null;


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

const elementoRecordes = document.querySelector("#lista-recordes");



function mostrarMensagem(texto, tipo = "") {
  elementoMensagem.textContent = texto;
  elementoMensagem.className = "mensagem " + tipo;
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
  jogoIniciarTimer();
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
  carregarHistorico();}


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
      registro.innerHTML = linhaRecordeHtml(medallas[i] || "", recorde, escapeHtml(recorde.nome || ""), formatarTempo(recorde.tempo_segundos));
      marcarPerfilEl(registro, recorde.nome);
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
        modo: sudokuOnlineAtivo ? "multiplayer" : "solo",
      }),
    });
    carregarRecordes(dificuldadeAtual);
    jogoRegistrarTempo(sudokuOnlineAtivo ? "sudoku_online" : "sudoku_solo", true);
    if (typeof atualizarMoedasHeader === "function") atualizarMoedasHeader();
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


function atualizarPlacarTimesSudoku() {
  var placar = document.querySelector("#placar-times-sudoku");
  if (placar) placar.style.display = sudokuOnlineAtivo ? "" : "none";
  var js = sudokuUltimosJogadores || [];
  var p1 = js[0] || {};
  var p2 = js[1] || {};
  var a = { nick: p1.nick || "Aguardando...", nome: p1.nome, avatar: p1.avatar, cosmeticos: p1.cosmeticos, gol: sudokuPlacar.p1 || 0 };
  var b = { nick: p2.nick || "Aguardando...", nome: p2.nome, avatar: p2.avatar, cosmeticos: p2.cosmeticos, gol: sudokuPlacar.p2 || 0 };
  preencherAvatarPlacar(document.querySelector("#placar-sudoku-avatar-p1"), a.nick, a.avatar, a.cosmeticos, a.nome);
  preencherAvatarPlacar(document.querySelector("#placar-sudoku-avatar-p2"), b.nick, b.avatar, b.cosmeticos, b.nome);
  var n1 = document.querySelector("#placar-sudoku-nick-p1");
  var n2 = document.querySelector("#placar-sudoku-nick-p2");
  var g1 = document.querySelector("#placar-sudoku-gol-p1");
  var g2 = document.querySelector("#placar-sudoku-gol-p2");
  if (n1) { n1.textContent = a.nick; aplicarCorNickEl(n1, a.cosmeticos, a.nome); }
  if (n2) { n2.textContent = b.nick; aplicarCorNickEl(n2, b.cosmeticos, b.nome); }
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

var sudokuDerrotaRegistrada = false;

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
        if (d.vencedor_rodada && d.vencedor_rodada !== sudokuSlot && !sudokuDerrotaRegistrada) {
          sudokuDerrotaRegistrada = true;
          jogoRegistrarTempo("sudoku_online", false);
        }
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
      sudokuDerrotaRegistrada = false;
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
        avatarSalaHtml(s.lider_avatar, s.lider, s.lider_cosmeticos) +
        "<span><strong" + corNickAtributoHtml(s.lider_cosmeticos) + ">" + escapeHtml(s.lider || "?") + "</strong>" +
        "<small>" + escapeHtml(s.sala) + " · " + (nomesDificuldade[s.dificuldade] || s.dificuldade) +
        " · " + (s.fase === "esperando" ? "Aguardando" : "Em jogo") + "</small></span></div>" +
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


carregarHistorico();

