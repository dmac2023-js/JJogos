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

function _formatarTempoRec(seg) {
  if (!seg) return "";
  var m = Math.floor(seg / 60);
  var s = seg % 60;
  return (m > 0 ? m + "min " : "") + (s > 0 ? s + "s" : "");
}

function _renderizarConteudoModal(container, jogador, perfil) {
  var nomes = { facil: "Fácil", medio: "Médio", dificil: "Difícil" };
  var html = "";

  // Stats principais
  html += '<div class="rmodal-stats">';
  html += '<span><span class="loja-moeda-icone">🪙</span> ' + (jogador.saldo || 0).toLocaleString("pt-BR") + " moedas</span>";
  html += '<span>🎮 ' + (jogador.total_partidas || 0).toLocaleString("pt-BR") + " partidas</span>";
  if (jogador.segundos > 0) {
    html += '<span>⏱ ' + formatarHoras(jogador.segundos) + " jogados</span>";
  }
  html += "</div>";

  // Partidas por jogo
  var partidas = jogador.partidas || {};
  var jogosComPartidas = Object.keys(RANKING_JOGO_LABELS).filter(function (k) { return (partidas[k] || 0) > 0; });
  if (jogosComPartidas.length > 0) {
    html += '<div class="rmodal-jogo"><h4>Partidas jogadas</h4>';
    jogosComPartidas.forEach(function (k) {
      html += '<div class="rmodal-linha"><span>' + RANKING_JOGO_LABELS[k] + "</span><strong>" +
        partidas[k].toLocaleString("pt-BR") + "</strong></div>";
    });
    html += "</div>";
  }

  // Recordes por jogo (do endpoint /perfil/recordes)
  var temRecordes = false;

  if (perfil.sudoku && Object.keys(perfil.sudoku).length > 0) {
    temRecordes = true;
    html += '<div class="rmodal-jogo"><h4>Sudoku — recordes</h4>';
    ["facil", "medio", "dificil"].forEach(function (dif) {
      var r = perfil.sudoku[dif];
      if (r) html += '<div class="rmodal-linha"><span>' + nomes[dif] + "</span><strong>" +
        _formatarTempoRec(r.tempo_segundos) + "</strong></div>";
    });
    html += "</div>";
  }

  if (perfil.velha && Object.keys(perfil.velha).length > 0) {
    temRecordes = true;
    html += '<div class="rmodal-jogo"><h4>Velha — recordes</h4>';
    Object.entries(perfil.velha).forEach(function (kv) {
      var dif = kv[0], r = kv[1];
      html += '<div class="rmodal-linha"><span>' + (nomes[dif] || dif) + "</span><strong>" +
        (r.vitorias || 0) + " vitórias</strong></div>";
    });
    html += "</div>";
  }

  var cm = perfil.campo_minado;
  if (cm) {
    var temV = cm.vitorias && Object.keys(cm.vitorias).length > 0;
    var temT = cm.tempos && Object.keys(cm.tempos).length > 0;
    if (temV || temT) {
      temRecordes = true;
      html += '<div class="rmodal-jogo"><h4>Campo Minado — recordes</h4>';
      var difs = new Set([].concat(Object.keys(cm.vitorias || {}), Object.keys(cm.tempos || {})));
      difs.forEach(function (dif) {
        var vit = (cm.vitorias || {})[dif];
        var tmp = (cm.tempos || {})[dif];
        var val = "";
        if (vit) val += vit.vitorias + "v";
        if (tmp) val += (val ? " · " : "") + _formatarTempoRec(tmp.tempo_segundos);
        if (val) html += '<div class="rmodal-linha"><span>' + (nomes[dif] || dif) + "</span><strong>" + val + "</strong></div>";
      });
      html += "</div>";
    }
  }

  if (perfil.termo && Object.keys(perfil.termo).length > 0) {
    temRecordes = true;
    html += '<div class="rmodal-jogo"><h4>Termo — recordes</h4>';
    Object.entries(perfil.termo).forEach(function (kv) {
      var dif = kv[0], r = kv[1];
      html += '<div class="rmodal-linha"><span>' + (nomes[dif] || dif) + "</span><strong>" +
        (r.vitorias || 0) + " vitórias</strong></div>";
    });
    html += "</div>";
  }

  if (perfil.ludo && perfil.ludo.vitorias > 0) {
    temRecordes = true;
    html += '<div class="rmodal-jogo"><h4>Ludo — recordes</h4>' +
      '<div class="rmodal-linha"><span>Online</span><strong>' + perfil.ludo.vitorias + " vitórias</strong></div>" +
      "</div>";
  }

  if (!temRecordes && jogosComPartidas.length === 0) {
    html += '<p class="vazio" style="margin-top:14px;">Nenhum dado registrado ainda.</p>';
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
