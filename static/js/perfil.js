// Perfil — identidade, recordes agregados (por jogo) e histórico recente.

// Perfil — identidade, recordes agregados e histórico recente
// ---------------------------------------------------------------------------
async function abrirPerfil() {
  mostrarTela(document.querySelector("#tela-perfil"));
  await garantirIdentidade();
  if (typeof atualizarMoedasHeader === "function") await atualizarMoedasHeader();
  renderPerfilIdentidade();
  await renderPerfilEconomia();
  renderPerfilHistorico();
  await renderPerfilRecordes();
}

async function renderPerfilEconomia() {
  var missoes = document.querySelector("#perfil-missoes");
  var doacoes = document.querySelector("#perfil-doacoes");
  if (!usuarioDiscord || !missoes || !doacoes) return;
  try {
    var resp = await fetch("./economia/jogador?nome=" + encodeURIComponent(nomeUsuario()));
    var d = await resp.json();
    var estado = d.missoes || { itens: [] };
    renderMissoesPainel(estado);
    missoes.innerHTML = "<h3>Missões atuais</h3>" + (estado.itens || []).map(function (m, i) {
      var pronta = m.concluida === true;
      var acao = pronta && !m.recompensa_resgatada
        ? '<button type="button" class="botao-copiar missao-resgatar" data-resgatar-missao data-indice="' + i + '">Resgatar</button>'
        : (!pronta ? '<button type="button" class="botao-copiar" data-trocar-missao data-indice="' + i + '">Trocar (500)</button>' : '<span class="missao-resgatada">✓ Resgatada</span>');
      return '<div class="perfil-missao' + (pronta ? ' concluida' : '') + '"><span>' + (pronta ? '✅ ' : '') + escapeHtml(m.texto) + '<br><small>🪙 ' + m.recompensa.toLocaleString("pt-BR") + " · " + m.progresso + "/" + m.alvo + '</small></span>' + acao + '</div>';
    }).join("");
    var agora = Date.now() / 1000;
    function tempoDoacao(ts) {
      var n = Math.max(0, Math.floor(agora - Number(ts || agora)));
      if (n < 60) return "agora";
      if (n < 3600) return Math.floor(n / 60) + " min atrás";
      if (n < 86400) return Math.floor(n / 3600) + " h atrás";
      return Math.floor(n / 86400) + " dias atrás";
    }
    function doacaoLinha(x, enviou) {
      var nome = x.nick || (enviou ? x.para : x.de) || "Usuário";
      var avatar = x.avatar ? '<img class="perfil-doacao-foto" src="' + escapeHtml(x.avatar) + '" alt="" />' : '<span class="perfil-doacao-foto perfil-doacao-inicial">' + escapeHtml(nome.charAt(0).toUpperCase()) + '</span>';
      var deco = x.decoracao_imagem ? '<img class="perfil-doacao-decoracao" src="' + escapeHtml(x.decoracao_imagem) + '" alt="" />' : "";
      var nomeHtml = typeof nickHtml === "function" ? nickHtml(nome, { cor_nick: x.cor_nick, fonte_nick: x.fonte_nick }) : escapeHtml(nome);
      return '<div class="perfil-doacao-item"><span class="perfil-doacao-avatar">' + avatar + deco + '</span><span class="perfil-doacao-info"><strong>' + (enviou ? "Enviou para " : "Recebeu de ") + nomeHtml + '</strong><small><span class="loja-moeda-icone">🪙</span> ' + Number(x.quantidade || 0).toLocaleString("pt-BR") + ' moedas · ' + tempoDoacao(x.em) + '</small></span></div>';
    }
    var enviados = (d.historico_doacoes || []).map(function (x) { return doacaoLinha(x, true); });
    var recebidos = (d.historico_recebidos || []).map(function (x) { return doacaoLinha(x, false); });
    var hist = enviados.concat(recebidos).join("") || '<p class="perfil-vazio">Nenhuma movimentação de doação ainda.</p>';
    doacoes.innerHTML = "<h3>Histórico de doações</h3><div class=\"perfil-doacoes-lista\">" + hist + "</div>";
    missoes.querySelectorAll("[data-trocar-missao]").forEach(function (b) { b.addEventListener("click", async function () {
      var r = await fetch("./economia/missoes/trocar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nome: nomeUsuario(), indice: Number(b.dataset.indice) }) });
      var j = await r.json(); if (!r.ok) { alert(j.detail || "Não foi possível trocar."); return; } renderPerfilEconomia();
    }); });
    missoes.querySelectorAll("[data-resgatar-missao]").forEach(function (b) { b.addEventListener("click", async function () {
      var r = await fetch("./economia/missoes/resgatar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nome: nomeUsuario(), indice: Number(b.dataset.indice) }) });
      var j = await r.json(); if (!r.ok) { alert(j.detail || "Não foi possível resgatar."); return; }
      var badge = document.querySelector("#moedas-valor");
      if (badge && Number.isFinite(Number(j.saldo))) badge.textContent = Number(j.saldo).toLocaleString("pt-BR");
      if (typeof atualizarMoedasHeader === "function") await atualizarMoedasHeader();
      if (j.bonus) alert("Missões concluídas! Você recebeu o bônus de 1.000 moedas.");
      renderPerfilEconomia();
    }); });
  } catch (e) { missoes.innerHTML = ""; doacoes.innerHTML = ""; }
}

function renderMissoesPainel(estado) {
  var painel = document.querySelector("#missoes-painel-principal");
  if (!painel || !usuarioDiscord) return;
  painel.innerHTML = "<h3>🎯 Missões atuais</h3>" + (estado.itens || []).map(function (m, i) {
    var pronta = m.concluida === true;
    var acao = pronta && !m.recompensa_resgatada ? '<button type="button" class="botao-copiar missao-resgatar-principal" data-resgatar-missao data-indice="' + i + '">Resgatar</button>' : "";
    return '<div class="perfil-missao' + (pronta ? ' concluida' : '') + '"><span>' + (pronta ? '✅ ' : '') + escapeHtml(m.texto) + '<br><small>🪙 ' + m.recompensa.toLocaleString("pt-BR") + " · " + m.progresso + "/" + m.alvo + "</small></span>" + acao + "</div>";
  }).join("") + (estado.bonus_pago ? '<small>✅ Bônus de 1000 moedas já recebido.</small>' : '<small>Conclua as três e receba mais 1000 moedas.</small>');
  painel.querySelectorAll("[data-resgatar-missao]").forEach(function (b) { b.addEventListener("click", async function () {
    var r = await fetch("./economia/missoes/resgatar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nome: nomeUsuario(), indice: Number(b.dataset.indice) }) });
    var d = await r.json(); if (!r.ok) { alert(d.detail || "Não foi possível resgatar."); return; }
    var badge = document.querySelector("#moedas-valor");
    if (badge && Number.isFinite(Number(d.saldo))) badge.textContent = Number(d.saldo).toLocaleString("pt-BR");
    if (typeof atualizarMoedasHeader === "function") await atualizarMoedasHeader();
    if (d.bonus) alert("Missões concluídas! Você recebeu o bônus de 1.000 moedas.");
    atualizarPainelMissoes();
  }); });
}

async function atualizarPainelMissoes() {
  if (!usuarioDiscord) return;
  try {
    var resp = await fetch("./economia/jogador?nome=" + encodeURIComponent(nomeUsuario()));
    if (resp.ok) renderMissoesPainel((await resp.json()).missoes || { itens: [] });
  } catch (e) {}
}

function criarJogoRoletaPrincipal() {
  var jogos = document.querySelector("#tela-jogos");
  if (!jogos || document.querySelector("#jogo-roleta")) return;
  var botao = document.createElement("button");
  botao.id = "jogo-roleta"; botao.className = "cartao-jogo"; botao.style.marginTop = "12px";
  botao.innerHTML = '<span class="icone-jogo">🎡</span><span><strong>Roleta da Sorte</strong><small>Aposte moedas e tente multiplicar seu prêmio.</small></span><span class="seta">&rarr;</span>';
  botao.addEventListener("click", function () { abrirLoja().then(lojaMostrarSecaoRoleta); });
  jogos.appendChild(botao);
  ["jogo-splano", "jogo-clickj", "jogo-tela", "jogo-termo", "jogo-ludo", "jogo-velha", "jogo-sudoku", "jogo-campo", "jogo-roleta"].forEach(function (id) {
    var el = document.getElementById(id); if (el) jogos.appendChild(el);
  });
}

setTimeout(function () { criarJogoRoletaPrincipal(); atualizarPainelMissoes(); }, 500);

function renderPerfilIdentidade() {
  var alvo = document.querySelector("#perfil-identidade");
  if (!alvo) return;
  var nick = nomeExibicao();
  var logado = !!usuarioDiscord;
  var cosmeticos = logado ? minhasCosmeticosAtuais() : null;
  var avatarHtml = logado
    ? '<img src="' + escapeHtml(avatarAtual()) + '" alt="" />'
    : escapeHtml((nick || "?").charAt(0).toUpperCase());
  if (cosmeticos && cosmeticos.decoracao) {
    avatarHtml += '<img class="avatar-decoracao-img" src="' + escapeHtml(cosmeticos.decoracao) + '" alt="" />';
  }
  alvo.innerHTML =
    '<span class="perfil-avatar">' + avatarHtml + "</span>" +
    "<span><span class=\"perfil-nome\">" + escapeHtml(nick) + "</span>" +
    '<div class="perfil-sub">' +
    (logado
      ? "Conectado com Discord"
      : "Modo navegador — entre com Discord para registrar recordes") +
    "</div></span>";
  aplicarCorNickEl(alvo.querySelector(".perfil-nome"), cosmeticos);
}

var PERFIL_RESULTADOS = {
  vitoria: { texto: "Vitória", cor: "#85e0ae" },
  derrota: { texto: "Derrota", cor: "#ff9a9a" },
  empate: { texto: "Empate", cor: "#ffd36a" },
};

function renderPerfilHistorico() {
  var alvo = document.querySelector("#perfil-historico");
  if (!alvo) return;
  if (!usuarioDiscord) {
    alvo.innerHTML = '<p class="vazio">Entre com Discord para guardar o histórico das suas partidas.</p>';
    return;
  }
  var lista = (minhaCarteira && minhaCarteira.historico) || [];
  if (lista.length === 0) {
    alvo.innerHTML = '<p class="vazio">Nenhuma partida registrada ainda.</p>';
    return;
  }
  alvo.innerHTML = "";
  lista.slice(0, 10).forEach(function (item) {
    var resultado = PERFIL_RESULTADOS[item.resultado] || PERFIL_RESULTADOS.derrota;
    var quando = new Date((item.em || 0) * 1000).toLocaleString("pt-BR", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    var linha = document.createElement("div");
    linha.className = "registro";
    linha.innerHTML =
      "<span>" + escapeHtml(RANKING_JOGO_LABELS[item.jogo] || item.jogo) + " &middot; " + escapeHtml(quando) + "</span>" +
      '<strong style="color:' + resultado.cor + '">' + resultado.texto + "</strong>";
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


