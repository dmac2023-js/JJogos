// Ranking global — top moedas e top partidas jogadas.

var rankingDados = null;
var rankingTabAtiva = "moedas";
var rankingDoadoresCache = null;
var INSIGNIA_CORES = { patrono: "#3187e8", campeao: "#08bda8", iluminado: "#ef4f8f", heroi: "#963de8", lendario: "#8ad92b", divindade: "#f39a27" };

var RANKING_JOGO_LABELS = {
  sudoku_solo: "Sudoku Solo",
  sudoku_online: "Sudoku Online",
  velha_maquina: "Velha vs Máquina",
  velha_online: "Velha Online",
  campo_solo: "Campo Minado Solo",
  campo_online: "Campo Minado Online",
  termo_solo: "Termo Solo",
  termo_online: "Termo Online",
  ludo: "Ludo",
  clickj_pvp: "ClickJ PvP",
  splano_io: "Splano.io",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatarHoras(seg) {
  if (!seg || seg < 60) return (seg || 0) + "s";
  var min = Math.floor(seg / 60);
  if (min < 60) return min + " min";
  var h = Math.floor(min / 60);
  var m = min % 60;
  return h + "h" + (m > 0 ? " " + m + "min" : "");
}

function rankingNickHtml(jogador) {
  return nickHtml(jogador.nick || jogador.nome || "?", { cor_nick: jogador.cor_nick, fonte_nick: jogador.fonte_nick });
}

function insigniaPerfilHtml(jogador) {
  var d = jogador.doacao;
  if (!d || !d.atual) return "";
  var proxima = d.proxima ? "Próxima: " + d.proxima.nome + " · faltam " + d.falta.toLocaleString("pt-BR") : "Todas as insignias conquistadas";
  var cor = d.proxima ? (INSIGNIA_CORES[d.proxima.icone] || "#5b9dff") : (INSIGNIA_CORES[d.atual.icone] || "#ffd36a");
  return '<span class="insignia-perfil" tabindex="0"><img src="./img/insignia-' + escapeHtml(d.atual.icone) + '.svg" alt="Insignia ' + escapeHtml(d.atual.nome) + '" /><span class="insignia-tooltip"><b>' + escapeHtml(d.atual.nome) + '</b><strong>' + d.total.toLocaleString("pt-BR") + ' moedas doadas</strong><span class="insignia-tooltip-bar"><i style="width:' + d.progresso + '%;background:' + cor + '"></i></span><small>' + escapeHtml(proxima) + '</small></span></span>';
}

/** Abre o perfil de qualquer jogador pelo nome (username) — usado quando se
 *  clica em alguém numa sala, placar ou tabela de vitórias. */
async function abrirPerfilJogador(nome) {
  try {
    var resp = await fetch("./economia/jogador?nome=" + encodeURIComponent(nome));
    if (resp.ok) {
      abrirPerfilRanking(await resp.json());
      return;
    }
  } catch (e) { /* cai no perfil mínimo abaixo */ }
  abrirPerfilRanking({ nome: nome, nick: nome });
}

function rankingAvatarHtml(jogador, tamanho) {
  var tam = tamanho || 36;
  var inicial = escapeHtml((jogador.nick || jogador.nome || "?").charAt(0).toUpperCase());
  var decoHtml = jogador.decoracao_imagem
    ? '<img class="ranking-avatar-deco" src="' + escapeHtml(jogador.decoracao_imagem) + '" alt="" />'
    : "";
  if (!jogador.avatar) {
    return (
      '<span class="ranking-avatar-box" style="width:' + tam + 'px;height:' + tam + 'px;">' +
        '<span class="ranking-avatar-inicial" style="font-size:' + Math.round(tam * 0.44) + 'px;">' + inicial + "</span>" +
        decoHtml +
      "</span>"
    );
  }
  // Para exibições grandes (modal), usa resolução maior mesmo se a URL armazenada tiver size=64.
  var avatarSrc = tam >= 64 ? jogador.avatar.replace(/[?&]size=\d+/, "").replace(/\.png$/, ".png?size=128") : jogador.avatar;
  return (
    '<span class="ranking-avatar-box" style="width:' + tam + 'px;height:' + tam + 'px;">' +
      '<img class="ranking-avatar-img" src="' + escapeHtml(avatarSrc) + '" alt="" />' +
      decoHtml +
    "</span>"
  );
}

// ---------------------------------------------------------------------------
// Renderização da lista
// ---------------------------------------------------------------------------

function renderizarRanking(dados) {
  rankingDados = dados;
  var lista = document.querySelector("#ranking-lista");
  if (!lista) return;

  if (rankingTabAtiva === "doadores") {
    renderizarRankingDoadores(lista);
    return;
  }

  var itens = rankingTabAtiva === "moedas" ? dados.top_moedas : dados.top_horas;
  if (!itens || itens.length === 0) {
    lista.innerHTML = '<p class="vazio">Nenhum jogador registrado ainda.</p>';
    return;
  }
  lista.innerHTML = "";
  var tabela = document.createElement("div");
  tabela.className = "ranking-tabela";
  var medalhas = ["🥇", "🥈", "🥉"];

  itens.forEach(function (jogador, i) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ranking-linha" + (i < 3 ? " ranking-top" + (i + 1) : "");
    btn.title = "Ver perfil de " + (jogador.nick || jogador.nome);

    var posHtml = '<span class="ranking-pos">' + (medalhas[i] || "#" + (i + 1)) + "</span>";
    var avatarHtml = rankingAvatarHtml(jogador, 38);
    var nickLinha = '<span class="ranking-nick">' + rankingNickHtml(jogador) + "</span>";

    var valorHtml;
    if (rankingTabAtiva === "moedas") {
      valorHtml = '<span class="ranking-valor"><span class="loja-moeda-icone">🪙</span> ' +
        (jogador.saldo || 0).toLocaleString("pt-BR") + "</span>";
    } else {
      var total = jogador.total_partidas || 0;
      valorHtml = '<span class="ranking-valor">🎮 ' + total.toLocaleString("pt-BR") +
        " partida" + (total === 1 ? "" : "s") + "</span>";
    }

    btn.innerHTML = posHtml + avatarHtml + nickLinha + valorHtml;
    btn.addEventListener("click", function () { abrirPerfilRanking(jogador); });
    tabela.appendChild(btn);
  });
  lista.appendChild(tabela);
}

async function renderizarRankingDoadores(lista) {
  lista.innerHTML = '<p class="vazio">Carregando...</p>';
  try {
    var resp = await fetch("./economia/top-doadores?limit=10");
    if (!resp.ok) throw new Error("status " + resp.status);
    var dados = await resp.json();
    var itens = dados.top_doadores || [];
    if (!itens.length) {
      lista.innerHTML = '<p class="vazio">Nenhum doador ainda.</p>';
      return;
    }
    lista.innerHTML = "";
    var tabela = document.createElement("div");
    tabela.className = "ranking-tabela";
    var medalhas = ["🥇", "🥈", "🥉"];
    itens.forEach(function (jogador, i) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ranking-linha" + (i < 3 ? " ranking-top" + (i + 1) : "");
      var posHtml = '<span class="ranking-pos">' + (medalhas[i] || "#" + (i + 1)) + "</span>";
      var avatarHtml = rankingAvatarHtml(jogador, 38);
      var nickLinha = '<span class="ranking-nick">' + rankingNickHtml(jogador) + insigniaPerfilHtml(jogador) + "</span>";
      var valorHtml = '<span class="ranking-valor">💝 ' + (jogador.total_doado || 0).toLocaleString("pt-BR") + "</span>";
      btn.innerHTML = posHtml + avatarHtml + nickLinha + valorHtml;
      btn.addEventListener("click", function () { abrirPerfilRanking(jogador); });
      tabela.appendChild(btn);
    });
    lista.appendChild(tabela);
  } catch (e) {
    lista.innerHTML = '<p class="vazio">Erro ao carregar doadores.</p>';
  }
}

// ---------------------------------------------------------------------------
// Modal de perfil
// ---------------------------------------------------------------------------

function fecharModalRanking() {
  var modal = document.querySelector("#ranking-modal");
  if (modal) modal.remove();
}

// Grupos de jogo para exibição no modal: cada item tem título, variantes [chave, rótulo].
var RANKING_GRUPOS_JOGO = [
  { titulo: "Sudoku",        variantes: [["sudoku_solo", "Solo"], ["sudoku_online", "Online"]] },
  { titulo: "Velha",         variantes: [["velha_maquina", "vs Máquina"], ["velha_online", "Online"]] },
  { titulo: "Campo Minado",  variantes: [["campo_solo", "Solo"], ["campo_online", "Online"]] },
  { titulo: "Termo",         variantes: [["termo_solo", "Solo"], ["termo_online", "Online"]] },
  { titulo: "Ludo",          variantes: [["ludo", "Online"]] },
  { titulo: "Splano.io",     variantes: [["splano_io", "Online"]] },
  { titulo: "ClickJ",        variantes: [["clickj_pvp", "PvP"]] },
];

function _renderizarConteudoModal(container, jogador, perfil) {
  var html = "";

  // Stats principais
  html += '<div class="rmodal-stats">';
  html += '<span><span class="loja-moeda-icone">🪙</span> ' + (jogador.saldo || 0).toLocaleString("pt-BR") + " moedas</span>";
  html += '<span>🎮 ' + (jogador.total_partidas || 0).toLocaleString("pt-BR") + " partidas</span>";
  if (jogador.segundos > 0) {
    html += '<span>⏱ ' + formatarHoras(jogador.segundos) + " jogados</span>";
  }
  html += "</div>";

  var partidas = jogador.partidas || {};
  var vitorias = jogador.vitorias || {};
  var temDados = false;

  RANKING_GRUPOS_JOGO.forEach(function (grupo) {
    var variantesComDados = grupo.variantes.filter(function (v) {
      return (partidas[v[0]] || 0) > 0;
    });
    if (variantesComDados.length === 0) return;
    temDados = true;
    html += '<div class="rmodal-jogo"><h4>' + grupo.titulo + "</h4>";
    variantesComDados.forEach(function (v) {
      var chave = v[0], rotulo = v[1];
      var nPart = (partidas[chave] || 0).toLocaleString("pt-BR");
      var nVit  = (vitorias[chave] || 0).toLocaleString("pt-BR");
      html += '<div class="rmodal-linha"><span>' + rotulo + "</span><strong>" +
        nPart + " partidas, " + nVit + " vitórias</strong></div>";
    });
    html += "</div>";
  });

  if (!temDados) {
    html += '<p class="vazio" style="margin-top:14px;">Nenhuma partida registrada ainda.</p>';
  }

  container.innerHTML = html;
}

function doacaoHtml(jogador) {
  var d = jogador.doacao || { total: jogador.total_doado || 0, progresso: 0, falta: 0, insignias: [], proxima: null };
  var proxima = d.proxima ? "Próxima: " + d.proxima.icone + " " + d.proxima.nome + " · faltam " + d.falta.toLocaleString("pt-BR") : "Todas as insignias conquistadas";
  var corBarra = d.proxima ? (INSIGNIA_CORES[d.proxima.icone] || "#5b9dff") : (d.atual && INSIGNIA_CORES[d.atual.icone] || "#ffd36a");
  var badges = (d.insignias || []).map(function (b) { return '<span class="rmodal-doacao-badge"><img src="./img/insignia-' + escapeHtml(b.icone) + '.svg" alt="" />' + escapeHtml(b.nome) + "</span>"; }).join("");
  return '<div class="rmodal-doacao" title="' + escapeHtml(proxima) + '"><h4>💝 Progresso de doador</h4><strong>' + d.total.toLocaleString("pt-BR") + ' moedas doadas</strong><div class="rmodal-doacao-bar"><div style="width:' + d.progresso + '%;background:' + corBarra + '"></div></div><div class="rmodal-doacao-meta"><span>' + escapeHtml(proxima) + '</span><span>' + d.progresso + '%</span></div><div class="rmodal-doacao-badges">' + (badges || '<span class="rmodal-doacao-badge">Nenhuma ainda</span>') + '</div></div>';
}

function mostrarPopupInsignia(insignia) {
  var antigo = document.querySelector(".insignia-up-popup");
  if (antigo) antigo.remove();
  var overlay = document.createElement("div");
  overlay.className = "insignia-up-popup";
  overlay.innerHTML = '<div class="insignia-up-card"><h2>Parabéns, você upou de insignia!</h2><img src="./img/insignia-' + escapeHtml(insignia.icone) + '.svg" alt="" /><strong>' + escapeHtml(insignia.nome) + '</strong><button type="button" class="botao principal">OK</button></div>';
  document.body.appendChild(overlay);
  overlay.querySelector("button").addEventListener("click", function () { overlay.classList.add("fechando"); setTimeout(function () { overlay.remove(); }, 260); });
}

function abrirFormularioDoacao(card, jogador) {
  var antigo = document.querySelector(".rmodal-transfer-overlay");
  if (antigo) { antigo.remove(); return; }
  var overlay = document.createElement("div");
  overlay.className = "rmodal-transfer-overlay";
  var form = document.createElement("div");
  form.className = "rmodal-transfer";
  form.innerHTML = '<div class="rmodal-transfer-pessoas"><div><b>Enviando</b>' + rankingAvatarHtml({ avatar: "", nick: "?", decoracao_imagem: "" }, 48) + '<strong class="rmodal-remetente-nick">Carregando...</strong><span class="rmodal-remetente-saldo"></span></div><span class="rmodal-seta">→</span><div><b>Recebendo</b>' + rankingAvatarHtml(jogador, 48) + '<strong>' + rankingNickHtml(jogador) + '</strong><span>' + (jogador.saldo || 0).toLocaleString("pt-BR") + ' moedas</span></div></div><div class="rmodal-transfer-insignia"></div><div class="rmodal-transfer-barra"><div></div><small></small></div><label>Valor a enviar<input type="number" min="1" step="1" placeholder="Digite o valor" /></label><div class="rmodal-transfer-resumo">Digite um valor para ver a simulação.</div><div class="rmodal-transfer-progresso"></div><div class="rmodal-transfer-acoes"><button type="button" class="botao principal rmodal-confirmar">Enviar</button><button type="button" class="botao rmodal-cancelar">Cancelar</button></div><small class="rmodal-transfer-taxa">A transação tem taxa de 10%: o destinatário recebe 90% do valor. 1% da taxa vai para o dono.</small>';
  overlay.appendChild(form);
  document.body.appendChild(overlay);
  var input = form.querySelector("input");
  var resumo = form.querySelector(".rmodal-transfer-resumo");
  var progresso = form.querySelector(".rmodal-transfer-progresso");
  var meuNome = (typeof nomeUsuario === "function") ? nomeUsuario() : null;
  var meuPerfil = null;
  fetch("./economia/jogador?nome=" + encodeURIComponent(meuNome || ""))
    .then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      meuPerfil = d;
      if (d) form.querySelector(".rmodal-remetente-nick").outerHTML = '<strong class="rmodal-remetente-nick">' + rankingNickHtml(d) + '</strong>';
      else form.querySelector(".rmodal-remetente-nick").textContent = meuNome || "Você";
      if (d) form.querySelector(".rmodal-transfer-pessoas > div:first-child .ranking-avatar-box").outerHTML = rankingAvatarHtml(d, 48);
      form.querySelector(".rmodal-remetente-saldo").textContent = d ? d.saldo.toLocaleString("pt-BR") + " moedas" : "Saldo indisponível";
      var atual = d && d.doacao && d.doacao.atual;
      form.querySelector(".rmodal-transfer-insignia").innerHTML = atual ? '<span>Insígnia atual</span><img src="./img/insignia-' + escapeHtml(atual.icone) + '.svg" alt="" /><b>' + escapeHtml(atual.nome) + '</b>' : '<span>Insígnia atual</span><b>Nenhuma ainda</b>';
      var doacao = (d && d.doacao) || { total: 0, progresso: 0, falta: 0, proxima: null };
      form.querySelector(".rmodal-transfer-barra div").style.width = doacao.progresso + "%";
      form.querySelector(".rmodal-transfer-barra div").style.background = INSIGNIA_CORES[doacao.proxima && doacao.proxima.icone] || "#ffd36a";
      form.querySelector(".rmodal-transfer-barra small").textContent = doacao.total.toLocaleString("pt-BR") + " doadas · " + (doacao.proxima ? "faltam " + doacao.falta.toLocaleString("pt-BR") : "todas conquistadas");
      atualizarPrevia();
    });
  async function atualizarPrevia() {
    var quantidade = parseInt(input.value, 10);
    if (!quantidade || quantidade <= 0) { resumo.textContent = "Digite um valor para ver a simulação."; progresso.innerHTML = ""; return; }
    try {
      var r = await fetch("./economia/transferir/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ remetente: meuNome, destinatario: jogador.nome, quantidade: quantidade }) });
      var p = await r.json();
      if (!r.ok) { resumo.textContent = p.detail || "Não foi possível simular."; return; }
      resumo.innerHTML = "Você ficará com <b>" + (p.saldo_remetente - quantidade).toLocaleString("pt-BR") + "</b> moedas. " + escapeHtml(jogador.nick || jogador.nome) + " ficará com <b>" + (p.saldo_destinatario + p.recebido).toLocaleString("pt-BR") + "</b> moedas.";
      progresso.innerHTML = p.conta_insignia ? "<span class=\"rmodal-progresso-ok\">Esta doação contará para sua progressão.</span>" : "<span class=\"rmodal-progresso-alerta\">Esta transação não dará progresso: você já doou para esta mesma pessoa nos últimos 7 dias.</span>";
    } catch (e) { resumo.textContent = "Não foi possível simular agora."; }
  }
  input.addEventListener("input", atualizarPrevia);
  form.querySelector(".rmodal-cancelar").addEventListener("click", function () { overlay.remove(); });
  overlay.addEventListener("click", function (ev) { if (ev.target === overlay) overlay.remove(); });
  form.querySelector(".rmodal-confirmar").addEventListener("click", async function () {
    var quantidade = parseInt(form.querySelector("input").value, 10);
    var remetente = (typeof nomeUsuario === "function") ? nomeUsuario() : null;
    if (!quantidade || quantidade <= 0) { alert("Digite um valor válido."); return; }
    try {
      var resp = await fetch("./economia/transferir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ remetente: remetente, destinatario: jogador.nome, quantidade: quantidade }) });
      var dados = await resp.json();
      if (!resp.ok) { alert(dados.detail || "Falha na transferência."); return; }
      if (dados.insignia_nova) mostrarPopupInsignia(dados.insignia_nova);
      overlay.remove();
    } catch (e) { alert("Erro ao enviar moedas."); }
  });
}

async function enviarDinheiro(destinatario, nickDest) {
  var remetente = (typeof nomeUsuario === "function") ? nomeUsuario() : null;
  if (!remetente) { alert("Você precisa estar logado para enviar moedas."); return; }
  var quantidadeStr = prompt("Quantas moedas enviar para " + nickDest + "?");
  if (!quantidadeStr) return;
  var quantidade = parseInt(quantidadeStr, 10);
  if (!quantidade || quantidade <= 0) { alert("Quantidade inválida."); return; }
  try {
    var resp = await fetch("./economia/transferir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remetente: remetente, destinatario: destinatario, quantidade: quantidade }),
    });
    var dados = await resp.json();
    if (!resp.ok) { alert("Erro: " + (dados.detail || "Falha na transferência.")); return; }
    mostrarMensagem
      ? mostrarMensagem("Enviado! Seu novo saldo: " + dados.novo_saldo_remetente.toLocaleString("pt-BR") + " 🪙", "sucesso")
      : alert("Transferência realizada! Novo saldo: " + dados.novo_saldo_remetente.toLocaleString("pt-BR"));
  } catch (e) {
    alert("Erro ao enviar moedas: " + e.message);
  }
}

async function abrirPerfilRanking(jogador) {
  fecharModalRanking();

  var overlay = document.createElement("div");
  overlay.id = "ranking-modal";
  overlay.className = "rmodal-overlay";
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) fecharModalRanking();
  });

  var card = document.createElement("div");
  card.className = "rmodal-card";

  var avatarHtml = rankingAvatarHtml(jogador, 72);
  var usernameExtra = (jogador.nome && jogador.nome !== jogador.nick)
    ? ' <span class="rmodal-username">(' + escapeHtml(jogador.nome) + ")</span>"
    : "";
  var cabecalhoNick = '<span class="rmodal-nick">' + rankingNickHtml(jogador) + insigniaPerfilHtml(jogador) + "</span>" + usernameExtra;

  var meuNome = (typeof nomeUsuario === "function") ? nomeUsuario() : null;
  var btnEnviarHtml = (jogador.nome && meuNome && jogador.nome !== meuNome)
    ? '<button class="botao rmodal-btn-enviar" type="button" style="margin-top:10px;width:100%;">💝 Enviar dinheiro</button>'
    : "";

  card.innerHTML =
    '<button class="rmodal-fechar" type="button" aria-label="Fechar">✕</button>' +
    '<div class="rmodal-cabecalho">' + avatarHtml + cabecalhoNick + "</div>" +
    btnEnviarHtml +
    '<div id="rmodal-conteudo"><p class="vazio">Carregando...</p></div>';

  overlay.appendChild(card);
  document.body.appendChild(overlay);
  card.querySelector(".rmodal-fechar").addEventListener("click", fecharModalRanking);

  var btnEnviar = card.querySelector(".rmodal-btn-enviar");
  if (btnEnviar) {
    btnEnviar.addEventListener("click", function () {
      abrirFormularioDoacao(card, jogador);
    });
  }

  // Moldura de perfil equipada em volta do card (as camadas vazam pra fora,
  // por isso o host é o overlay e não o card: o card rola com overflow-y).
  if (typeof aplicarMolduraPerfil === "function") {
    aplicarMolduraPerfil(overlay, card, jogador.moldura_perfil);
  }

  try {
    var respostas = await Promise.all([
      fetch("./perfil/recordes?nome=" + encodeURIComponent(jogador.nome)),
      fetch("./economia/jogador?nome=" + encodeURIComponent(jogador.nome)),
    ]);
    var resp = respostas[0], respEconomia = respostas[1];
    var perfil = resp.ok ? await resp.json() : {};
    var economiaPerfil = respEconomia.ok ? await respEconomia.json() : {};
    jogador = Object.assign({}, jogador, economiaPerfil);
    card.querySelector(".rmodal-cabecalho").innerHTML = rankingAvatarHtml(jogador, 72) + '<span class="rmodal-nick">' + rankingNickHtml(jogador) + insigniaPerfilHtml(jogador) + "</span>" + ((jogador.nome && jogador.nome !== jogador.nick) ? ' <span class="rmodal-username">(' + escapeHtml(jogador.nome) + ")</span>" : "");
    var conteudo = card.querySelector("#rmodal-conteudo");
    _renderizarConteudoModal(conteudo, jogador, perfil);
    if (typeof atualizarMoldurasPerfil === "function") atualizarMoldurasPerfil();
  } catch (e) {
    var conteudo = card.querySelector("#rmodal-conteudo");
    if (conteudo) conteudo.innerHTML = '<p class="vazio">Erro ao carregar perfil.</p>';
    if (typeof atualizarMoldurasPerfil === "function") atualizarMoldurasPerfil();
  }
}

// ---------------------------------------------------------------------------
// Carregar e controles
// ---------------------------------------------------------------------------

async function carregarRanking() {
  var lista = document.querySelector("#ranking-lista");
  if (!lista) return;
  lista.innerHTML = '<p class="vazio">Carregando...</p>';
  try {
    var resp = await fetch("./economia/ranking?limit=10");
    if (!resp.ok) throw new Error("status " + resp.status);
    var dados = await resp.json();
    renderizarRanking(dados);
  } catch (e) {
    lista.innerHTML = '<p class="vazio">Erro ao carregar ranking.</p>';
  }
}

function rankingMudarTab(tab) {
  rankingTabAtiva = tab;
  document.querySelectorAll(".ranking-tab").forEach(function (btn) {
    btn.classList.toggle("ativa", btn.dataset.tab === tab);
  });
  if (rankingDados) renderizarRanking(rankingDados);
  else carregarRanking();
}

async function abrirRanking() {
  mostrarTela(document.querySelector("#tela-ranking"));
  await carregarRanking();
}

(function () {
  var btnRanking = document.querySelector("#btn-ranking");
  if (btnRanking) btnRanking.addEventListener("click", abrirRanking);

  document.querySelectorAll(".ranking-tab").forEach(function (btn) {
    btn.addEventListener("click", function () { rankingMudarTab(btn.dataset.tab); });
  });

  var btnAtt = document.querySelector("#ranking-atualizar");
  if (btnAtt) btnAtt.addEventListener("click", carregarRanking);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") fecharModalRanking();
  });
})();
