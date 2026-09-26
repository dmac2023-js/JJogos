// Ranking global — top moedas e top partidas jogadas.

var rankingDados = null;
var rankingTabAtiva = "moedas";

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

function rankingCorNick(jogador) {
  var cor = (typeof LOJA_CORES_HEX !== "undefined" && LOJA_CORES_HEX[jogador.cor_nick]) || null;
  return { estilo: cor ? 'style="color:' + cor + '"' : "", classe: jogador.cor_nick === "arco-iris" ? " nick-arco-iris" : "" };
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
    var nc = rankingCorNick(jogador);
    var nickHtml = '<span class="ranking-nick' + nc.classe + '" ' + nc.estilo + ">" +
      escapeHtml(jogador.nick || jogador.nome || "?") + "</span>";

    var valorHtml;
    if (rankingTabAtiva === "moedas") {
      valorHtml = '<span class="ranking-valor"><span class="loja-moeda-icone">🪙</span> ' +
        (jogador.saldo || 0).toLocaleString("pt-BR") + "</span>";
    } else {
      valorHtml = '<span class="ranking-valor">🎮 ' + (jogador.total_partidas || 0).toLocaleString("pt-BR") + " partidas</span>";
    }

    btn.innerHTML = posHtml + avatarHtml + nickHtml + valorHtml;
    btn.addEventListener("click", function () { abrirPerfilRanking(jogador); });
    tabela.appendChild(btn);
  });
  lista.appendChild(tabela);
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

  var nc = rankingCorNick(jogador);
  var avatarHtml = rankingAvatarHtml(jogador, 72);
  var nickDisplay = escapeHtml(jogador.nick || jogador.nome || "?");
  var usernameExtra = (jogador.nome && jogador.nome !== jogador.nick)
    ? ' <span class="rmodal-username">(' + escapeHtml(jogador.nome) + ")</span>"
    : "";
  var nickHtml = '<span class="rmodal-nick' + nc.classe + '" ' + nc.estilo + ">" +
    nickDisplay + "</span>" + usernameExtra;

  card.innerHTML =
    '<button class="rmodal-fechar" type="button" aria-label="Fechar">✕</button>' +
    '<div class="rmodal-cabecalho">' + avatarHtml + nickHtml + "</div>" +
    '<div id="rmodal-conteudo"><p class="vazio">Carregando...</p></div>';

  overlay.appendChild(card);
  document.body.appendChild(overlay);
  card.querySelector(".rmodal-fechar").addEventListener("click", fecharModalRanking);

  try {
    var resp = await fetch("./perfil/recordes?nome=" + encodeURIComponent(jogador.nome));
    var perfil = resp.ok ? await resp.json() : {};
    var conteudo = card.querySelector("#rmodal-conteudo");
    _renderizarConteudoModal(conteudo, jogador, perfil);
  } catch (e) {
    var conteudo = card.querySelector("#rmodal-conteudo");
    if (conteudo) conteudo.innerHTML = '<p class="vazio">Erro ao carregar perfil.</p>';
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
