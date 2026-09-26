// "Assistir Algo" — painel que fica ao lado (ou embaixo, no celular) de um
// jogo offline, pra acompanhar uma transmissão ou sala multi-tela sem sair
// do jogo. Reaproveita o mesmo protocolo de viewer (/ws/tela/{sala}) e as
// funções de conexão de tela.js (ligarViewerMulti, processarMsgTile etc.) —
// que já são genéricas por-tile — só que num dicionário próprio
// (assistirTiles) pra não se misturar com a sala multi-tela "de verdade".

var assistirTiles = {};
var assistirMultiCodigo = null;
var assistirMultiPoll = null;

// ---------------------------------------------------------------------------
// Botão flutuante — só aparece em jogos offline (não durante partidas online
// nem durante uma luta do ClickJ).
// ---------------------------------------------------------------------------

function assistirTelaQualifica() {
  var ativa = document.querySelector(".tela.ativa");
  if (!ativa) return false;
  switch (ativa.id) {
    case "tela-jogo": return typeof sudokuOnlineAtivo !== "undefined" && !sudokuOnlineAtivo;
    case "tela-velha": return typeof velhaModo !== "undefined" && velhaModo === "maquina";
    case "tela-campo": return typeof campoOnlineAtivo !== "undefined" && !campoOnlineAtivo;
    case "tela-termo": return typeof termoOnlineAtivo !== "undefined" && !termoOnlineAtivo;
    case "tela-clickj": return true;
    default: return false;
  }
}

function atualizarBotaoAssistirAlgo() {
  var btn = document.querySelector("#btn-assistir-algo");
  if (!btn) return;
  var qualifica = assistirTelaQualifica();
  if (!qualifica) {
    if (document.body.classList.contains("assistir-ativo")) assistirFecharPainel();
    btn.style.display = "none";
    return;
  }
  btn.style.display = document.body.classList.contains("assistir-ativo") ? "none" : "";
}

// ---------------------------------------------------------------------------
// Abrir/fechar o painel
// ---------------------------------------------------------------------------

function assistirAbrirPainel() {
  document.body.classList.add("assistir-ativo");
  document.querySelector("#btn-assistir-algo").style.display = "none";
  assistirMostrarLista();
  assistirCarregarListas();
}

function assistirFecharPainel() {
  assistirEncerrarTudo();
  document.body.classList.remove("assistir-ativo");
  atualizarBotaoAssistirAlgo();
}

function assistirMostrarLista() {
  assistirEncerrarTudo();
  document.querySelector("#assistir-lista").style.display = "";
  document.querySelector("#assistir-conteudo").style.display = "none";
}

function assistirMostrarConteudo() {
  document.querySelector("#assistir-lista").style.display = "none";
  document.querySelector("#assistir-conteudo").style.display = "";
}

// ---------------------------------------------------------------------------
// Lista de salas públicas + entrar por código
// ---------------------------------------------------------------------------

function assistirLinhaHtml(sala, nome, avatar, cosmeticos, nomeUsuarioAlvo, subtitulo) {
  return (
    '<div class="sala-item assistir-linha" data-sala="' + escapeHtml(sala) + '">' +
      '<div class="sala-item-info">' +
        avatarSalaHtml(avatar, nome, cosmeticos, nomeUsuarioAlvo) +
        "<span><strong>" + nickHtml(nome || "?", cosmeticos, nomeUsuarioAlvo) + "</strong>" +
        "<small>" + subtitulo + "</small></span>" +
      "</div>" +
    "</div>"
  );
}

async function assistirCarregarListas() {
  var elT = document.querySelector("#assistir-lista-transmissoes");
  var elM = document.querySelector("#assistir-lista-multi");
  try {
    var r1 = await fetch("./tela/transmissoes");
    var d1 = await r1.json();
    var lista = d1.transmissoes || [];
    elT.innerHTML = lista.length ? lista.map(function (t) {
      return assistirLinhaHtml(t.sala, t.nick, t.avatar, t.cosmeticos, t.host_nome,
        t.resolucao + " · " + t.fps + "fps · 📷 " + t.espectadores + "/9");
    }).join("") : '<p class="vazio">Nenhuma transmissão pública agora.</p>';
    elT.querySelectorAll(".assistir-linha").forEach(function (el, i) {
      el.addEventListener("click", function () { assistirAbrirTransmissao(lista[i]); });
    });
  } catch (e) {
    elT.innerHTML = '<p class="vazio">Erro ao carregar transmissões.</p>';
  }
  try {
    var r2 = await fetch("./multitela/salas");
    var d2 = await r2.json();
    var listaM = d2.salas || [];
    elM.innerHTML = listaM.length ? listaM.map(function (s) {
      return assistirLinhaHtml(s.sala, s.nome || s.dono_nick, s.dono_avatar, null, null,
        (s.total_membros || 0) + " pessoas · " + (s.total_lives || 0) + "/" + (s.max_lives || 8) + " telas");
    }).join("") : '<p class="vazio">Nenhuma sala multi-tela pública agora.</p>';
    elM.querySelectorAll(".assistir-linha").forEach(function (el, i) {
      el.addEventListener("click", function () { assistirAbrirMulti(listaM[i].sala); });
    });
  } catch (e) {
    elM.innerHTML = '<p class="vazio">Erro ao carregar salas multi-tela.</p>';
  }
}

async function assistirEntrarCodigo() {
  var input = document.querySelector("#assistir-codigo-input");
  var erro = document.querySelector("#assistir-lista-erro");
  var codigo = (input.value || "").trim().toLowerCase();
  erro.style.display = "none";
  if (!codigo) return;
  try {
    var r1 = await fetch("./tela/sala/" + encodeURIComponent(codigo));
    if (r1.ok) { assistirAbrirTransmissao(await r1.json()); input.value = ""; return; }
  } catch (e) { /* tenta multi-tela abaixo */ }
  try {
    var r2 = await fetch("./multitela/sala/" + encodeURIComponent(codigo));
    if (r2.ok) { assistirAbrirMulti(codigo); input.value = ""; return; }
  } catch (e) { /* mostra erro abaixo */ }
  erro.textContent = "Nenhuma sala (transmissão ou multi-tela) com esse código.";
  erro.style.display = "";
}

// ---------------------------------------------------------------------------
// Tile — reaproveita ligarViewerMulti/abrirWsViewerMulti/processarMsgTile
// (tela.js), que já operam só sobre o objeto "tile" recebido.
// ---------------------------------------------------------------------------

function assistirCriarTile(sala, info, comFocar) {
  var el = document.createElement("div");
  el.className = "assistir-tile";

  var media = document.createElement("div");
  media.className = "assistir-tile-media";
  var canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  media.appendChild(canvas);
  var video = document.createElement("video");
  video.playsInline = true;
  video.autoplay = true;
  video.muted = true;
  video.style.display = "none";
  media.appendChild(video);
  var placeholder = document.createElement("div");
  placeholder.className = "assistir-tile-placeholder";
  placeholder.textContent = "Conectando...";
  media.appendChild(placeholder);

  var ctrls = document.createElement("div");
  ctrls.className = "assistir-tile-ctrls";
  var btnVol = document.createElement("button");
  btnVol.type = "button";
  btnVol.title = "Volume (começa mudo)";
  btnVol.textContent = "🔇";
  var volSlider = document.createElement("input");
  volSlider.type = "range";
  volSlider.min = "0";
  volSlider.max = "100";
  volSlider.value = "80";
  volSlider.className = "assistir-tile-volume";
  ctrls.appendChild(btnVol);
  ctrls.appendChild(volSlider);
  var btnFocar = null;
  if (comFocar) {
    btnFocar = document.createElement("button");
    btnFocar.type = "button";
    btnFocar.title = "Focar essa tela";
    btnFocar.textContent = "⛶";
    ctrls.appendChild(btnFocar);
  }
  media.appendChild(ctrls);

  var rodape = document.createElement("div");
  rodape.className = "assistir-tile-rodape";
  rodape.innerHTML = avatarSalaHtml(info.avatar, info.nick, info.cosmeticos, info.nome) +
    "<strong>" + nickHtml(info.nick || "Anônimo", info.cosmeticos, info.nome) + "</strong>";
  if (!comFocar) {
    var btnSair = document.createElement("button");
    btnSair.type = "button";
    btnSair.className = "assistir-tile-sair";
    btnSair.textContent = "Sair";
    btnSair.addEventListener("click", assistirMostrarListaEAtualizar);
    rodape.appendChild(btnSair);
  }

  el.appendChild(media);
  el.appendChild(rodape);

  var tile = {
    sala: sala, el: el, canvas: canvas, video: video, placeholder: placeholder,
    independente: true, live: info,
    assistindo: false, oculta: false, mudo: true, volume: 0.8,
    ws: null, pc: null, decoder: null, audioDecoder: null, audioCtx: null, gain: null,
    partes: {}, temKey: false, codec: "vp8", resolucao: "720p",
    tentativas: 0, abriu: false, relay: dentroDaActivity(),
    ofertaTimer: null, audioCfg: { sr: 0, ch: 0 }, audioChave: true, redeTimer: null,
  };
  assistirTiles[sala] = tile;

  function aplicarVolume() {
    var vol = tile.mudo ? 0 : tile.volume;
    if (tile.gain) tile.gain.gain.value = vol;
    tile.video.muted = tile.mudo;
    tile.video.volume = tile.volume;
    btnVol.textContent = tile.mudo ? "🔇" : (tile.volume <= 0 ? "🔈" : "🔊");
    if (!tile.mudo && tile.audioCtx && tile.audioCtx.state === "suspended") {
      tile.audioCtx.resume().catch(function () {});
    }
  }
  btnVol.addEventListener("click", function () { tile.mudo = !tile.mudo; aplicarVolume(); });
  volSlider.addEventListener("input", function () {
    tile.volume = Math.max(0, Math.min(1, parseInt(volSlider.value, 10) / 100));
    if (tile.mudo && tile.volume > 0) tile.mudo = false;
    aplicarVolume();
  });
  if (btnFocar) {
    btnFocar.addEventListener("click", function () {
      var container = document.querySelector("#assistir-tiles");
      var jaFocada = el.classList.contains("focada");
      container.querySelectorAll(".assistir-tile.focada").forEach(function (t) { t.classList.remove("focada"); });
      if (!jaFocada) {
        el.classList.add("focada");
        container.classList.add("tem-foco");
      } else {
        container.classList.remove("tem-foco");
      }
    });
  }

  document.querySelector("#assistir-tiles").appendChild(el);
  ligarViewerMulti(tile);
  return tile;
}

function assistirEncerrarTile(tile) {
  desligarViewerMulti(tile);
  if (tile.el && tile.el.parentNode) tile.el.parentNode.removeChild(tile.el);
  delete assistirTiles[tile.sala];
}

function assistirEncerrarTudo() {
  clearInterval(assistirMultiPoll);
  assistirMultiPoll = null;
  assistirMultiCodigo = null;
  Object.keys(assistirTiles).forEach(function (sala) { assistirEncerrarTile(assistirTiles[sala]); });
  var cont = document.querySelector("#assistir-tiles");
  if (cont) { cont.innerHTML = ""; cont.classList.remove("tem-foco"); }
}

function assistirMostrarListaEAtualizar() {
  assistirMostrarLista();
  assistirCarregarListas();
}

// ---------------------------------------------------------------------------
// Transmissão única
// ---------------------------------------------------------------------------

function assistirAbrirTransmissao(info) {
  assistirEncerrarTudo();
  assistirMostrarConteudo();
  assistirCriarTile(info.sala, info, false);
}

// ---------------------------------------------------------------------------
// Sala multi-tela — cada "live" é assistida como uma transmissão comum.
// ---------------------------------------------------------------------------

async function assistirAbrirMulti(codigo) {
  assistirEncerrarTudo();
  assistirMostrarConteudo();
  assistirMultiCodigo = codigo;
  await assistirAtualizarMulti();
  assistirMultiPoll = setInterval(assistirAtualizarMulti, 8000);
}

async function assistirAtualizarMulti() {
  if (!assistirMultiCodigo) return;
  try {
    var resp = await fetch("./multitela/sala/" + encodeURIComponent(assistirMultiCodigo));
    if (!resp.ok) { assistirMostrarListaEAtualizar(); return; }
    var dados = await resp.json();
    var lives = dados.lives || [];
    var salasAtuais = lives.map(function (l) { return l.sala; });
    Object.keys(assistirTiles).forEach(function (sala) {
      if (salasAtuais.indexOf(sala) === -1) assistirEncerrarTile(assistirTiles[sala]);
    });
    lives.forEach(function (live) {
      if (!assistirTiles[live.sala]) assistirCriarTile(live.sala, live, true);
    });
    if (!lives.length) {
      var cont = document.querySelector("#assistir-tiles");
      if (cont && !cont.querySelector(".vazio")) cont.innerHTML = '<p class="vazio">Ninguém transmitindo nessa sala agora.</p>';
    } else {
      var vazio = document.querySelector("#assistir-tiles .vazio");
      if (vazio) vazio.remove();
    }
  } catch (e) { /* mantém o que já está na tela até a próxima tentativa */ }
}

// ---------------------------------------------------------------------------

(function () {
  var btn = document.querySelector("#btn-assistir-algo");
  if (btn) btn.addEventListener("click", assistirAbrirPainel);
  document.querySelector("#assistir-fechar").addEventListener("click", assistirFecharPainel);
  document.querySelector("#assistir-voltar-lista").addEventListener("click", assistirMostrarListaEAtualizar);
  document.querySelector("#assistir-codigo-ir").addEventListener("click", assistirEntrarCodigo);
  document.querySelector("#assistir-codigo-input").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") assistirEntrarCodigo();
  });
  setInterval(atualizarBotaoAssistirAlgo, 1000);
})();
