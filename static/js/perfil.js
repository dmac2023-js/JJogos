// Perfil — identidade, recordes agregados (por jogo) e histórico recente.

// Perfil — identidade, recordes agregados e histórico recente
// ---------------------------------------------------------------------------
async function abrirPerfil() {
  mostrarTela(document.querySelector("#tela-perfil"));
  await garantirIdentidade();
  if (typeof atualizarMoedasHeader === "function") await atualizarMoedasHeader();
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
  // Aplica a cor do nick equipada
  var nomeSpan = alvo.querySelector(".perfil-nome");
  if (nomeSpan && typeof aplicarCorEmElemento === "function" && typeof minhaCarteira !== "undefined") {
    aplicarCorEmElemento(nomeSpan, minhaCarteira.equipado && minhaCarteira.equipado.cor_nick);
  }
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
    alvo.appendChild(cartaoPerfilTermo(dados.termo || {}));
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


