// Ludo — online (até 4 jogadores).


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
      "<strong>" + nickHtml(j.nick || "—", j.cosmeticos) + status + "</strong>";
    marcarPerfilEl(div, j.nome);
    box.appendChild(div);
  });
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
    preencherAvatarPlacar(
      document.querySelector("#placar-ludo-avatar-" + slot),
      j ? j.nick : "?", j ? j.avatar : null, j && j.cosmeticos, j && j.nome);
    var nick = document.querySelector("#placar-ludo-nick-" + slot);
    var gol = document.querySelector("#placar-ludo-gol-" + slot);
    if (nick) { nick.textContent = j ? j.nick : "—"; aplicarCorNickEl(nick, j && j.cosmeticos, j && j.nome); }
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
      var el = document.createElement("div");
      el.className = "registro-recorde";
      el.innerHTML = linhaRecordeHtml(medallas[i] || (i + 1), r, escapeHtml(r.nome || ""), (r.vitorias || 0) + "v");
      marcarPerfilEl(el, r.nome);
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
      if (d.fase === "fim") {
        carregarRankingLudo();
        jogoRegistrarTempo("ludo", d.vencedor === ludoSlot);
        atualizarMoedasHeader();
      }
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

  jogoIniciarTimer();
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
      avatarSalaHtml(s.lider_avatar, s.lider, s.lider_cosmeticos) +
      "<span><strong" + corNickAtributoHtml(s.lider_cosmeticos) + ">" + escapeHtml(s.lider || "?") + "</strong>" +
      "<small>" + escapeHtml(s.sala) + " · " +
      (s.fase === "esperando" ? "Aguardando" : s.fase === "fim" ? "Encerrado" : "Em jogo") +
      "</small></span></div>" +
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

function cartaoPerfilLudo(ludo) {
  var card = criarCartaoPerfil("Ludo");
  if (!ludo) {
    card.innerHTML += '<p class="perfil-vazio">Ainda sem vitórias registradas.</p>';
    return card;
  }
  adicionarLinhaPerfil(card, "Vitórias", String(ludo.vitorias));
  return card;
}


