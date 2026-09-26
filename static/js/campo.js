// Campo Minado — solo e 1x1 online.

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
    jogoRegistrarTempo("campo_solo", true);
    atualizarMoedasHeader();
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
  jogoIniciarTimer();
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
  jogoIniciarTimer();
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
        avatarSalaHtml(s.lider_avatar, s.lider, s.lider_cosmeticos) +
        "<span><strong" + corNickAtributoHtml(s.lider_cosmeticos) + ">" + escapeHtml(s.lider || "?") + "</strong>" +
        "<small>" + escapeHtml(s.sala) + " · " + (campoNomeDif[s.dificuldade] || s.dificuldade) +
        " · " + (s.fase === "esperando" ? "Aguardando" : "Em jogo") + "</small></span></div>" +
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
      avatarSalaHtml(s.lider_avatar, s.lider, s.lider_cosmeticos) +
      "<span><strong" + corNickAtributoHtml(s.lider_cosmeticos) + ">" + escapeHtml(s.lider || "?") + "</strong>" +
      "<small>" + escapeHtml(s.sala) + " · " + (campoNomeDif[s.dificuldade] || s.dificuldade) + "</small></span></div>" +
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
      jogoRegistrarTempo("campo_online", !!(dados.desistencia || dados.slot === campoSlot));
      atualizarMoedasHeader();
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


