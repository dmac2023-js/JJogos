// Termo — solo e 1x1 online.

function renderizarSalasTermo(salas) {
  var container = document.querySelector("#salas-termo-ativas-conteudo");
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
      avatarSalaHtml(s.lider_avatar, s.lider, s.lider_cosmeticos) +
      "<span><strong" + corNickAtributoHtml(s.lider_cosmeticos) + ">" + escapeHtml(s.lider || "?") + "</strong>" +
      "<small>" + escapeHtml(s.sala) + " · " + (NOMES_TERMO_DIFICULDADE[s.dificuldade] || s.dificuldade) +
      " · " + (s.fase === "esperando" ? "Aguardando" : "Em jogo") + "</small></span></div>" +
      '<span class="sala-item-jogadores">' + s.jogadores + "/2</span>";
    item.addEventListener("click", function () { entrarSalaTermo(s.sala); });
    container.appendChild(item);
  });
}


function cartaoPerfilTermo(porDificuldade) {
  var card = criarCartaoPerfil("Termo");
  var chaves = Object.keys(porDificuldade || {});
  if (chaves.length === 0) {
    card.innerHTML += '<p class="perfil-vazio">Ainda sem vitórias registradas.</p>';
    return card;
  }
  ["facil", "medio", "dificil"].forEach(function (dif) {
    var r = porDificuldade[dif];
    if (!r) return;
    var rotulo = NOMES_TERMO_DIFICULDADE[dif] || dif;
    var valor = r.vitorias + " vitória" + (r.vitorias === 1 ? "" : "s");
    if (r.melhor_tempo) valor += " · melhor " + r.melhor_tempo + " tent.";
    adicionarLinhaPerfil(card, rotulo, valor);
  });
  return card;
}


// ---------------------------------------------------------------------------
// Termo — solo e 1x1 online (mesma palavra em privado, teclado virtual)
// ---------------------------------------------------------------------------
var NOMES_TERMO_DIFICULDADE = { facil: "Termo", medio: "Dueto", dificil: "Quarteto" };
var TERMO_LINHAS_TECLADO = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
var TERMO_PRIORIDADE = { ausente: 0, presente: 1, certo: 2 };

var termoModo = null; // "solo" | "online"
var termoDificuldade = "facil";
var termoJogoId = null;
var termoTamanho = 5;
var termoTabuleirosQtd = 1;
var termoMaxTentativas = 6;
var termoTentativasUsadas = 0;
var termoLinhaAtual = "";
var termoResolvidos = [];
var termoTecladoStatus = {};
var termoTeclasEl = {};
var termoCelulas = [];
var termoFinalizado = false;
var termoVenceu = false;

var termoOnlineAtivo = false;
var termoWs = null;
var termoPingTimer = null;
var termoSala = null;
var termoSlot = null;
var termoFase = null;
var termoPlacar = { p1: 0, p2: 0 };
var termoJogadoresOnline = [];
var termoLobbyDificuldade = "medio";
var termoRevancheDe = null;

function termoNormalizarClient(s) {
  return String(s == null ? "" : s)
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/[^A-Z]/g, "");
}

function termoMsg(texto, tipo) {
  var el = document.querySelector("#mensagem-termo");
  if (!el) return;
  el.textContent = texto;
  el.className = "mensagem" + (tipo ? " " + tipo : "");
}

function termoMostrarBotao(sel, on) {
  var el = document.querySelector(sel);
  if (el) el.style.display = on ? "" : "none";
}

function termoAtualizarContador() {
  var el = document.querySelector("#termo-tentativas-label");
  if (el) el.textContent = termoTentativasUsadas + "/" + termoMaxTentativas;
}

function termoMontarTabuleiros() {
  var container = document.querySelector("#termo-tabuleiros");
  container.innerHTML = "";
  termoCelulas = [];
  for (var b = 0; b < termoTabuleirosQtd; b++) {
    var tab = document.createElement("div");
    tab.className = "termo-tabuleiro";
    var linhasEl = [];
    for (var r = 0; r < termoMaxTentativas; r++) {
      var linha = document.createElement("div");
      linha.className = "termo-linha";
      var cols = [];
      for (var c = 0; c < termoTamanho; c++) {
        var cel = document.createElement("span");
        cel.className = "termo-celula";
        linha.appendChild(cel);
        cols.push(cel);
      }
      tab.appendChild(linha);
      linhasEl.push(cols);
    }
    container.appendChild(tab);
    termoCelulas.push(linhasEl);
  }
}

function termoMontarTeclado() {
  var container = document.querySelector("#termo-teclado");
  container.innerHTML = "";
  termoTeclasEl = {};
  TERMO_LINHAS_TECLADO.forEach(function (linhaLetras, i) {
    var linha = document.createElement("div");
    linha.className = "termo-teclado-linha";
    if (i === 2) {
      var enter = document.createElement("button");
      enter.type = "button";
      enter.className = "termo-tecla enter";
      enter.textContent = "OK";
      enter.addEventListener("click", termoEnviar);
      linha.appendChild(enter);
    }
    linhaLetras.split("").forEach(function (letra) {
      var tecla = document.createElement("button");
      tecla.type = "button";
      tecla.className = "termo-tecla";
      tecla.textContent = letra;
      tecla.addEventListener("click", function () { termoDigitarLetra(letra); });
      linha.appendChild(tecla);
      termoTeclasEl[letra] = tecla;
    });
    if (i === 2) {
      var back = document.createElement("button");
      back.type = "button";
      back.className = "termo-tecla back";
      back.textContent = "⌫";
      back.addEventListener("click", termoApagar);
      linha.appendChild(back);
    }
    container.appendChild(linha);
  });
}

function termoRenderLinhaAtual() {
  for (var b = 0; b < termoTabuleirosQtd; b++) {
    var cols = termoCelulas[b] && termoCelulas[b][termoTentativasUsadas];
    if (!cols) continue;
    for (var c = 0; c < termoTamanho; c++) {
      cols[c].textContent = termoLinhaAtual[c] || "";
      cols[c].classList.toggle("atual", c === termoLinhaAtual.length && termoLinhaAtual.length < termoTamanho);
    }
  }
}

function termoRenderTeclado() {
  Object.keys(termoTeclasEl).forEach(function (letra) {
    var el = termoTeclasEl[letra];
    el.classList.remove("certo", "presente", "ausente");
    var st = termoTecladoStatus[letra];
    if (st) el.classList.add(st);
  });
}

function termoDigitarLetra(letra) {
  if (termoFinalizado || termoFase === "esperando" || termoFase === "contagem") return;
  if (termoLinhaAtual.length >= termoTamanho) return;
  termoLinhaAtual += letra;
  termoRenderLinhaAtual();
}

function termoApagar() {
  if (termoFinalizado) return;
  termoLinhaAtual = termoLinhaAtual.slice(0, -1);
  termoRenderLinhaAtual();
}

document.addEventListener("keydown", function (e) {
  var tela = document.querySelector("#tela-termo");
  if (!tela || !tela.classList.contains("ativa")) return;
  if (document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  if (e.key === "Enter") { termoEnviar(); return; }
  if (e.key === "Backspace") { termoApagar(); return; }
  var normalizada = termoNormalizarClient(e.key);
  if (normalizada.length === 1) termoDigitarLetra(normalizada);
});

function termoIniciarEstadoTabuleiro() {
  termoTentativasUsadas = 0;
  termoLinhaAtual = "";
  termoResolvidos = new Array(termoTabuleirosQtd).fill(false);
  termoTecladoStatus = {};
  termoFinalizado = false;
  termoVenceu = false;
  termoMontarTabuleiros();
  termoMontarTeclado();
  termoAtualizarContador();
}

async function iniciarTermoSolo(dificuldade) {
  termoModo = "solo";
  termoOnlineAtivo = false;
  termoDificuldade = dificuldade;
  jogoIniciarTimer();
  document.querySelector("#voltar-termo").dataset.tela = "tela-dificuldade-termo";
  document.querySelector("#termo-sala-bar").style.display = "none";
  document.querySelector("#termo-oponente-status").style.display = "none";
  document.querySelector("#termo-online-acoes").style.display = "none";
  document.querySelector("#termo-solo-acoes").style.display = "none";
  document.querySelector("#termo-dificuldade-atual").textContent = NOMES_TERMO_DIFICULDADE[dificuldade];
  mostrarTela(document.querySelector("#tela-termo"));
  termoMsg("Carregando...", "");
  carregarRankingTermo();
  try {
    var resp = await fetch("./termo/novo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dificuldade: dificuldade }),
    });
    var dados = await resp.json();
    if (!resp.ok) throw new Error(dados.detail || "Não foi possível criar a partida.");
    termoJogoId = dados.jogo_id;
    termoTamanho = dados.tamanho;
    termoTabuleirosQtd = dados.tabuleiros;
    termoMaxTentativas = dados.max_tentativas;
    termoFase = "jogando";
    termoIniciarEstadoTabuleiro();
    termoMsg("Digite uma palavra de " + termoTamanho + " letras.", "");
  } catch (erro) {
    termoMsg(erro.message, "erro");
  }
}

async function termoEnviar() {
  if (termoFinalizado) return;
  if (termoLinhaAtual.length !== termoTamanho) {
    termoMsg("A palavra precisa ter " + termoTamanho + " letras.", "erro");
    return;
  }
  if (termoOnlineAtivo) {
    if (termoFase !== "jogando") return;
    if (termoWs && termoWs.readyState === WebSocket.OPEN) {
      termoWs.send(JSON.stringify({ tipo: "tentar", palpite: termoLinhaAtual }));
    }
    return;
  }
  try {
    var resp = await fetch("./termo/tentar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jogo_id: termoJogoId, palpite: termoLinhaAtual }),
    });
    var dados = await resp.json();
    if (!resp.ok) {
      termoMsg(dados.detail || "Palavra inválida.", "erro");
      return;
    }
    termoAplicarResultado(dados);
  } catch (erro) {
    termoMsg("Erro ao enviar a tentativa.", "erro");
  }
}

function termoAplicarResultado(dados) {
  var linha = termoTentativasUsadas;
  for (var b = 0; b < termoTabuleirosQtd; b++) {
    var cols = termoCelulas[b] && termoCelulas[b][linha];
    var resultado = dados.resultados[b];
    if (!cols || !resultado) continue;
    for (var c = 0; c < termoTamanho; c++) {
      cols[c].textContent = dados.palpite[c];
      cols[c].classList.remove("atual");
      cols[c].classList.add(resultado[c]);
    }
  }

  for (var i = 0; i < termoTamanho; i++) {
    var letra = dados.palpite[i];
    var melhor = "ausente";
    for (var b2 = 0; b2 < termoTabuleirosQtd; b2++) {
      var st = dados.resultados[b2][i];
      if (TERMO_PRIORIDADE[st] > TERMO_PRIORIDADE[melhor]) melhor = st;
    }
    var atual = termoTecladoStatus[letra];
    if (!atual || TERMO_PRIORIDADE[melhor] > TERMO_PRIORIDADE[atual]) {
      termoTecladoStatus[letra] = melhor;
    }
  }
  termoRenderTeclado();

  termoTentativasUsadas = dados.tentativas_usadas;
  termoResolvidos = dados.resolvidos;
  termoLinhaAtual = "";
  termoAtualizarContador();

  if (dados.completo) {
    termoFinalizado = true;
    termoVenceu = dados.venceu;
    if (termoOnlineAtivo) {
      termoFinalizarOnline(dados);
    } else {
      termoFinalizarSolo(dados);
    }
  } else {
    termoMsg("Continue tentando!", "");
  }
}

function termoFinalizarSolo(dados) {
  if (termoVenceu) {
    termoMsg("🎉 Você acertou! " + termoTentativasUsadas + "/" + termoMaxTentativas + " tentativas.", "sucesso");
    termoRegistrarVitoria();
    registrarHistoricoGeral(NOMES_TERMO_DIFICULDADE[termoDificuldade],
      termoTentativasUsadas + "/" + termoMaxTentativas + " tentativas");
  } else {
    var reveladas = (dados.palavras || []).join(", ");
    termoMsg("Suas tentativas acabaram. Era: " + reveladas, "erro");
  }
  document.querySelector("#termo-solo-acoes").style.display = "flex";
}

async function termoRegistrarVitoria() {
  try {
    await garantirIdentidade();
    if (ehAnonimoNick(nomeExibicao())) return;
    await fetch("./termo/recordes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dificuldade: termoDificuldade,
        nome: nomeUsuario(),
        nick: nomeExibicao(),
        tentativas: termoTentativasUsadas,
        avatar: avatarAtual(),
      }),
    });
    carregarRankingTermo();
    jogoRegistrarTempo();
    atualizarMoedasHeader();
  } catch (e) { /* ignore */ }
}

async function carregarRankingTermo() {
  var container = document.querySelector("#lista-ranking-termo");
  if (!container) return;
  try {
    var resp = await fetch("./termo/ranking?dificuldade=" + termoDificuldade);
    var dados = await resp.json();
    var lista = dados.ranking || [];
    if (lista.length === 0) {
      container.innerHTML = '<p class="vazio">Nenhum recorde ainda.</p>';
      return;
    }
    container.innerHTML = "";
    var medalhas = ["🥇", "🥈", "🥉"];
    lista.forEach(function (r, i) {
      var el = document.createElement("div");
      el.className = "registro-recorde";
      var avatarHtml = r.avatar
        ? '<img class="recorde-avatar" src="' + escapeHtml(r.avatar) + '" alt="" />'
        : '<span class="recorde-avatar placeholder">' + escapeHtml((r.nick || "?").charAt(0).toUpperCase()) + '</span>';
      el.innerHTML =
        '<span class="recorde-posicao">' + (medalhas[i] || "") + '</span>' + avatarHtml +
        '<span class="recorde-info"><strong>' + escapeHtml(r.nick) + '</strong>' +
        '<small>' + r.vitorias + ' vitória' + (r.vitorias === 1 ? '' : 's') + '</small></span>' +
        '<span class="recorde-tempo">' + (r.melhor_tempo ? r.melhor_tempo + ' tent.' : '') + '</span>';
      container.appendChild(el);
    });
  } catch (e) {
    container.innerHTML = '<p class="vazio">Erro ao carregar recordes.</p>';
  }
}

// ---------------------------------------------------------------------------
// Termo online — lobby, sala e WS
// ---------------------------------------------------------------------------

async function carregarSalasTermo() {
  var container = document.querySelector("#salas-termo-ativas-conteudo");
  if (!container) return;
  try {
    var res = await fetch("./termo/salas");
    var dados = await res.json();
    renderizarSalasTermo(dados.salas || []);
  } catch (e) {
    container.innerHTML = '<p class="vazio">Erro ao carregar salas.</p>';
  }
}

function termoFecharWs() {
  clearInterval(termoPingTimer);
  termoPingTimer = null;
  if (termoWs) {
    try { termoWs.close(); } catch (e) { /* ignore */ }
    termoWs = null;
  }
}

function termoFechar(motivo) {
  termoFecharWs();
  termoOnlineAtivo = false;
  termoSala = null;
  termoSlot = null;
  termoFase = null;
  termoFinalizado = true;
  if (motivo) termoMsg(motivo, "erro");
}

async function criarSalaTermo() {
  await garantirIdentidade();
  if (dentroDaActivity() && !usuarioDiscord) {
    termoMsg("Não consegui identificar seu Discord. Recarregue (Ctrl+F5) e tente de novo.", "erro");
    return;
  }
  var codigo = (document.querySelector("#termo-codigo-sala").value || "").trim().toLowerCase();
  var publica = !!document.querySelector("#termo-sala-publica").checked;
  try {
    var res = await fetch("./termo/sala/novo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codigo: codigo || null,
        publica: publica,
        dificuldade: termoLobbyDificuldade,
        nome: nomeUsuario(),
        nick: nomeExibicao(),
        avatar: avatarAtual(),
      }),
    });
    var dados = await res.json();
    if (!res.ok) throw new Error(dados.detail || "Erro ao criar sala.");
    termoDificuldade = dados.dificuldade || termoLobbyDificuldade;
    prepararTelaTermoOnline(dados.sala);
    conectarWsTermo(dados.sala);
    if (discordSdkGlobal && publica) {
      try {
        await discordSdkGlobal.commands.shareLink({
          message: "Bora jogar Termo! Sala: " + dados.sala,
          custom_id: "termo-" + dados.sala,
        });
      } catch (e) { /* cancelado */ }
    }
  } catch (erro) {
    termoMsg(erro.message, "erro");
  }
}

async function entrarSalaTermo(codigo) {
  codigo = (codigo || "").trim().toLowerCase();
  if (!codigo) {
    termoMsg("Digite o código da sala.", "erro");
    return;
  }
  await garantirIdentidade();
  if (dentroDaActivity() && !usuarioDiscord) {
    termoMsg("Não consegui identificar seu Discord. Recarregue (Ctrl+F5) e tente de novo.", "erro");
    return;
  }
  prepararTelaTermoOnline(codigo);
  termoMsg("Entrando na sala " + codigo + "...", "");
  conectarWsTermo(codigo);
}

function prepararTelaTermoOnline(sala) {
  termoModo = "online";
  termoOnlineAtivo = true;
  termoSala = sala;
  termoPlacar = { p1: 0, p2: 0 };
  termoFinalizado = false;
  termoRevancheDe = null;
  document.querySelector("#voltar-termo").dataset.tela = "tela-lobby-termo";
  document.querySelector("#termo-sala-bar").style.display = "flex";
  document.querySelector("#termo-sala-codigo").textContent = sala;
  document.querySelector("#termo-oponente-status").style.display = "flex";
  document.querySelector("#termo-oponente-status").textContent = "Aguardando oponente...";
  document.querySelector("#termo-solo-acoes").style.display = "none";
  document.querySelector("#termo-online-acoes").style.display = "flex";
  termoMostrarBotao("#termo-pedir-revanche", false);
  termoMostrarBotao("#termo-responder-sim", false);
  termoMostrarBotao("#termo-responder-nao", false);
  termoMostrarBotao("#termo-parar", true);
  document.querySelector("#termo-tabuleiros").innerHTML = "";
  document.querySelector("#termo-teclado").innerHTML = "";
  document.querySelector("#termo-dificuldade-atual").textContent = NOMES_TERMO_DIFICULDADE[termoLobbyDificuldade];
  mostrarTela(document.querySelector("#tela-termo"));
  carregarRankingTermo();
}

function conectarWsTermo(sala) {
  termoFecharWs();
  var nome = nomeUsuario();
  var nick = nomeExibicao();
  var avatar = avatarAtual() || "";
  var protocolo = location.protocol === "https:" ? "wss:" : "ws:";
  var url = protocolo + "//" + location.host + "/ws/termo/" + encodeURIComponent(sala) +
    "?nome=" + encodeURIComponent(nome) +
    "&nick=" + encodeURIComponent(nick) +
    "&avatar=" + encodeURIComponent(avatar);
  termoWs = new WebSocket(url);
  termoPingTimer = setInterval(function () {
    if (termoWs && termoWs.readyState === WebSocket.OPEN) {
      termoWs.send(JSON.stringify({ tipo: "ping" }));
    }
  }, 20000);
  termoWs.onmessage = function (evento) {
    try {
      processarMensagemTermo(JSON.parse(evento.data));
    } catch (e) {
      console.error("termo ws:", e);
    }
  };
  termoWs.onclose = function () {
    clearInterval(termoPingTimer);
    if (termoOnlineAtivo) termoMsg("Conexão perdida.", "erro");
  };
  termoWs.onerror = function () {};
}

function termoAtualizarStatusOponente() {
  var el = document.querySelector("#termo-oponente-status");
  if (!el) return;
  var outroSlot = termoSlot === "p1" ? "p2" : "p1";
  var outro = (termoJogadoresOnline || []).find(function (j) { return j.slot === outroSlot; });
  if (!outro || !outro.conectado) {
    el.textContent = "Aguardando oponente...";
    return;
  }
  if (outro.completou) {
    el.textContent = (outro.nick || "Oponente") + (outro.venceu ? " já acertou a palavra." : " já usou todas as tentativas.");
  } else {
    el.textContent = (outro.nick || "Oponente") + " está jogando (" + (outro.tentativas_usadas || 0) + "/" + termoMaxTentativas + ")";
  }
}

function processarMensagemTermo(dados) {
  switch (dados.tipo) {
    case "erro":
      termoMsg(dados.mensagem || "Erro.", "erro");
      if (dados.mensagem === "Sala cheia." || dados.mensagem === "Sala não encontrada.") {
        termoOnlineAtivo = false;
        setTimeout(function () { mostrarTela(document.querySelector("#tela-lobby-termo")); }, 1200);
      }
      break;
    case "estado_termo":
      termoSlot = dados.meu_slot;
      termoFase = dados.fase;
      termoDificuldade = dados.dificuldade || termoDificuldade;
      termoTamanho = dados.tamanho || termoTamanho;
      termoTabuleirosQtd = dados.tabuleiros || termoTabuleirosQtd;
      termoMaxTentativas = dados.max_tentativas || termoMaxTentativas;
      termoPlacar = dados.placar || termoPlacar;
      termoJogadoresOnline = dados.jogadores || [];
      document.querySelector("#termo-dificuldade-atual").textContent = NOMES_TERMO_DIFICULDADE[termoDificuldade];
      termoAtualizarStatusOponente();
      if (dados.fase === "esperando") {
        termoMsg("Aguardando o oponente... Sala: " + dados.sala, "sucesso");
      } else if (dados.fase === "jogando") {
        if (!termoCelulas.length) termoIniciarEstadoTabuleiro();
        termoMsg("Jogo em andamento!", "");
      }
      break;
    case "contagem":
      termoFase = "contagem";
      termoMsg(dados.n > 0 ? "Começa em " + dados.n + "..." : "Valendo!", dados.n > 0 ? "" : "sucesso");
      break;
    case "inicio_termo":
      termoFase = "jogando";
      jogoIniciarTimer();
      termoTamanho = dados.tamanho;
      termoTabuleirosQtd = dados.tabuleiros;
      termoMaxTentativas = dados.max_tentativas;
      termoDificuldade = dados.dificuldade || termoDificuldade;
      termoSlot = dados.meu_slot || termoSlot;
      document.querySelector("#termo-dificuldade-atual").textContent = NOMES_TERMO_DIFICULDADE[termoDificuldade];
      termoIniciarEstadoTabuleiro();
      termoMsg("Digite uma palavra de " + termoTamanho + " letras. Boa sorte!", "sucesso");
      termoMostrarBotao("#termo-pedir-revanche", false);
      termoMostrarBotao("#termo-responder-sim", false);
      termoMostrarBotao("#termo-responder-nao", false);
      termoMostrarBotao("#termo-parar", true);
      break;
    case "erro_palpite":
      termoMsg(dados.mensagem || "Palavra inválida.", "erro");
      break;
    case "resultado_termo":
      termoAplicarResultado(dados);
      break;
    case "progresso_termo": {
      var outroP = termoJogadoresOnline.find(function (j) { return j.slot === dados.slot; });
      if (outroP) outroP.tentativas_usadas = dados.tentativas_usadas;
      termoAtualizarStatusOponente();
      break;
    }
    case "adversario_terminou":
      termoJogadoresOnline = dados.jogadores || termoJogadoresOnline;
      termoPlacar = dados.placar || termoPlacar;
      termoAtualizarStatusOponente();
      if (dados.desistencia) {
        // Oponente saiu no meio da partida: quem ficou vence por W.O.
        termoFinalizado = true;
        termoVenceu = true;
        termoMsg(dados.mensagem || "Oponente saiu. Você venceu!", "sucesso");
        termoMostrarBotao("#termo-pedir-revanche", false);
        termoMostrarBotao("#termo-parar", true);
      } else if (!termoFinalizado) {
        termoMsg((dados.nick || "O oponente") +
          (dados.venceu ? " já acertou a palavra. Continue tentando!" : " usou todas as tentativas."), "");
      }
      break;
    case "ambos_acabaram": {
      termoFinalizado = true;
      termoPlacar = dados.placar || termoPlacar;
      termoJogadoresOnline = dados.jogadores || termoJogadoresOnline;
      var euVenci = termoVenceu;
      var palavrasTexto = (dados.palavras || []).join(", ");
      if (euVenci) {
        termoMsg("🎉 Você acertou! Palavra(s): " + palavrasTexto, "sucesso");
      } else {
        termoMsg("Suas tentativas acabaram. Palavra(s): " + palavrasTexto, "erro");
      }
      jogoRegistrarTempo();
      atualizarMoedasHeader();
      termoMostrarBotao("#termo-pedir-revanche", true);
      break;
    }
    case "revanche_pedida":
      termoRevancheDe = dados.por_slot;
      termoMsg((dados.por || "Oponente") + " quer jogar de novo...", "");
      if (dados.por_slot !== termoSlot) {
        termoMostrarBotao("#termo-responder-sim", true);
        termoMostrarBotao("#termo-responder-nao", true);
      }
      termoMostrarBotao("#termo-pedir-revanche", false);
      break;
    case "revanche_aceita":
      termoMsg("Nova rodada! Preparando...", "sucesso");
      termoMostrarBotao("#termo-responder-sim", false);
      termoMostrarBotao("#termo-responder-nao", false);
      termoMostrarBotao("#termo-pedir-revanche", false);
      break;
    case "revanche_recusada":
      termoFechar("Sala encerrada.");
      mostrarTela(document.querySelector("#tela-lobby-termo"));
      break;
    case "sala_termo_encerrada":
      termoFechar(dados.motivo && dados.motivo !== "parou" ? "Sala encerrada: " + dados.motivo : null);
      break;
    case "pong":
      break;
    default:
      break;
  }
}

function termoFinalizarOnline() {
  // A UI final é tratada em "ambos_acabaram"; aqui só trava novas tentativas
  // até o servidor confirmar que os dois terminaram.
  termoMsg(termoVenceu ? "Você acertou! Aguardando o oponente terminar..." : "Suas tentativas acabaram. Aguardando o oponente...", "");
}

document.querySelector("#jogo-termo").addEventListener("click", function () {
  mostrarTela(document.querySelector("#tela-modo-termo"));
});

document.querySelectorAll("#tela-modo-termo .botao-modo").forEach(function (botao) {
  botao.addEventListener("click", function () {
    var modo = botao.dataset.modo;
    if (modo === "termo-solo") {
      mostrarTela(document.querySelector("#tela-dificuldade-termo"));
    } else if (modo === "termo-multiplayer") {
      mostrarTela(document.querySelector("#tela-lobby-termo"));
      carregarSalasTermo();
      conectarLobbyWs();
    }
  });
});

document.querySelectorAll("#tela-dificuldade-termo .botao-dificuldade").forEach(function (botao) {
  botao.addEventListener("click", function () {
    iniciarTermoSolo(botao.dataset.dificuldade);
  });
});

document.querySelectorAll(".termo-lobby-dificuldade").forEach(function (botao) {
  botao.addEventListener("click", function () {
    termoLobbyDificuldade = botao.dataset.dificuldade;
    document.querySelectorAll(".termo-lobby-dificuldade").forEach(function (b) {
      b.classList.toggle("selecionada", b === botao);
    });
  });
});

document.querySelector("#criar-sala-termo").addEventListener("click", criarSalaTermo);
document.querySelector("#entrar-sala-termo").addEventListener("click", function () {
  entrarSalaTermo(document.querySelector("#termo-codigo-sala").value);
});
document.querySelector("#copiar-codigo-termo").addEventListener("click", function () {
  var codigo = document.querySelector("#termo-sala-codigo").textContent || "";
  var btn = this;
  navigator.clipboard.writeText(codigo).then(function () {
    btn.textContent = "Copiado!";
    btn.classList.add("copiado");
    setTimeout(function () {
      btn.textContent = "Copiar";
      btn.classList.remove("copiado");
    }, 2000);
  }).catch(function () { /* ignore */ });
});
document.querySelector("#termo-jogar-de-novo").addEventListener("click", function () {
  iniciarTermoSolo(termoDificuldade);
});
document.querySelector("#termo-pedir-revanche").addEventListener("click", function () {
  if (termoWs && termoWs.readyState === WebSocket.OPEN) {
    termoWs.send(JSON.stringify({ tipo: "pedir_revanche" }));
    termoMsg("Convite para jogar de novo enviado...", "");
    termoMostrarBotao("#termo-pedir-revanche", false);
  }
});
document.querySelector("#termo-responder-sim").addEventListener("click", function () {
  if (termoWs && termoWs.readyState === WebSocket.OPEN) {
    termoWs.send(JSON.stringify({ tipo: "responder_revanche", aceitar: true }));
    termoMostrarBotao("#termo-responder-sim", false);
    termoMostrarBotao("#termo-responder-nao", false);
  }
});
document.querySelector("#termo-responder-nao").addEventListener("click", function () {
  if (termoWs && termoWs.readyState === WebSocket.OPEN) {
    termoWs.send(JSON.stringify({ tipo: "responder_revanche", aceitar: false }));
    termoMostrarBotao("#termo-responder-sim", false);
    termoMostrarBotao("#termo-responder-nao", false);
  }
});
document.querySelector("#termo-parar").addEventListener("click", function () {
  if (termoWs && termoWs.readyState === WebSocket.OPEN) {
    try { termoWs.send(JSON.stringify({ tipo: "sair" })); } catch (e) { /* ignore */ }
  }
  termoFechar(null);
  carregarSalasTermo();
  mostrarTela(document.querySelector("#tela-lobby-termo"));
});

