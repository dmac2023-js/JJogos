// Jogo da Velha — vs máquina, multiplayer e espectador.

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


carregarRankingVelha();

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


