// ClickJ — clicker + PvP por turnos. O servidor (/ws/clickj) é a autoridade:
// aqui só mostramos o estado, mandamos cliques em lote e as ações da luta.

var cjWs = null;
var cjAtivo = false;
var cjBloqueado = false;
var cjCatalogo = null;
var cjEu = null;
var cjEuRecebidoEm = 0;
var cjOnline = [];
var cjLuta = null;
var cjLutaRecebidaEm = 0;
var cjUltimoEvento = 0;
var cjPendentes = 0;
var cjSeq = 0;
var cjLotes = {};
var cjEnvioTimer = null;
var cjPingTimer = null;
var cjRelogio = null;
var cjReconectarTimer = null;
var cjGenero = "m";
var cjClasseEscolhida = null;
var cjLojaAba = "armas";
var cjLojaFiltro = {};
var cjDesafio = null;
var cjDesafioTimer = null;
var cjToastTimer = null;
var cjView = "carregando";

var CJ_CLASSE_ICONES = { mago: "🧙", arqueiro: "🏹", guerreiro: "⚔️", curandeiro: "✨", monge: "🥋" };
var CJ_CLASSE_DESC = {
  mago: "Ataques mágicos fortes e curas melhores.",
  arqueiro: "Acerta o dano total com mais frequência.",
  guerreiro: "O ataque físico mais pesado.",
  curandeiro: "Aguenta mais pancada.",
  monge: "Esquiva com facilidade.",
};
var CJ_SKILL_ICONES = { magia: "🔮", precisao: "🎯", forca: "💪", resistencia: "🛡️", agilidade: "💨" };
var CJ_CATEGORIAS = { basico: "Básico", medio: "Médio", avancado: "Avançado" };
var CJ_PALETA = {
  m: { pano: "#3552c9", detalhe: "#f5c542", enfeite: "#5b9dff", borla: "#e03131" },
  f: { pano: "#9c36b5", detalhe: "#ff8cc6", enfeite: "#ffb3dc", borla: "#ff8cc6" },
};
var CJ_SEM_MATERIAL = "#c9ccda";
var CJ_MADEIRA = "#7a4e26";
var CJ_ICONE_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<g stroke="#9dc2ff" stroke-linecap="round"><line x1="8.2" y1="15.8" x2="20.6" y2="3.4" stroke-width="2.3"/>' +
  '<line x1="5.6" y1="13.4" x2="10.6" y2="18.4" stroke-width="1.8"/>' +
  '<line x1="7.4" y1="16.6" x2="4.4" y2="19.6" stroke-width="1.7" stroke="#f5c542"/></g>' +
  '<circle cx="3.8" cy="20.2" r="1.2" fill="#f5c542"/>' +
  '<g fill="#f4f6ff" stroke="#0a0e1a" stroke-width="0.6"><rect x="11.7" y="15.2" width="8.8" height="7.8" rx="2.4"/>' +
  '<rect x="17.8" y="14.4" width="2.4" height="3.6" rx="1.2"/><rect x="15.4" y="13.8" width="2.4" height="3.8" rx="1.2"/>' +
  '<rect x="9.6" y="17" width="3.6" height="2.3" rx="1.15"/><rect x="12.4" y="10.6" width="2.5" height="7.6" rx="1.25"/></g>' +
  '<g stroke="#f5c542" stroke-width="1.1" stroke-linecap="round"><line x1="16.4" y1="9.6" x2="17.9" y2="8.6"/>' +
  '<line x1="16.9" y1="11.8" x2="18.7" y2="11.8"/><line x1="10.2" y1="9.4" x2="9.2" y2="8"/></g></svg>';
var CJ_ESCUDO_SVG =
  '<svg class="cj-escudo" viewBox="0 0 100 100" aria-hidden="true">' +
  '<path d="M50 6 L88 20 V48 C88 72 70 88 50 96 C30 88 12 72 12 48 V20 Z" fill="rgba(91,157,255,.35)" stroke="#9dc2ff" stroke-width="5"/>' +
  '<path d="M50 20 L74 29 V48 C74 64 63 75 50 81 C37 75 26 64 26 48 V29 Z" fill="none" stroke="#f4f6ff" stroke-width="3" opacity=".7"/></svg>';

var cjFormatoCompacto = null;
try { cjFormatoCompacto = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 }); } catch (e) { /* navegador antigo */ }

function cjFmt(n) {
  n = Math.floor(n || 0);
  if (n < 100000 || !cjFormatoCompacto) return n.toLocaleString("pt-BR");
  return cjFormatoCompacto.format(n);
}

function cjFmtTempo(seg) {
  seg = Math.max(0, Math.floor(seg));
  var m = Math.floor(seg / 60);
  if (m >= 60) return Math.floor(m / 60) + "h" + String(m % 60).padStart(2, "0");
  return m + ":" + String(seg % 60).padStart(2, "0");
}

function cjMoedaHtml(valor) {
  return '<span class="cj-moeda">J</span>' + cjFmt(valor);
}

function cjNickHtml(nick, cosmeticos) {
  return "<span" + corNickAtributoHtml(cosmeticos) + ">" + escapeHtml(nick || "?") + "</span>";
}

// ---------------------------------------------------------------------------
// Avatar: foto do Discord + item da classe por cima
// ---------------------------------------------------------------------------

function cjCorMaterial(idx) {
  if (!cjCatalogo || idx == null || idx < 0 || !cjCatalogo.materiais[idx]) return CJ_SEM_MATERIAL;
  return cjCatalogo.materiais[idx].cor;
}

function cjEstrela(cx, cy, r, cor) {
  var pts = [];
  for (var i = 0; i < 10; i++) {
    var ang = -Math.PI / 2 + i * Math.PI / 5;
    var rr = i % 2 ? r * 0.45 : r;
    pts.push((cx + rr * Math.cos(ang)).toFixed(1) + "," + (cy + rr * Math.sin(ang)).toFixed(1));
  }
  return '<polygon points="' + pts.join(" ") + '" fill="' + cor + '" stroke="#0a0e1a" stroke-width="1"/>';
}

function cjItemSvg(classe, genero, armaIdx) {
  var p = CJ_PALETA[genero] || CJ_PALETA.m;
  var metal = cjCorMaterial(armaIdx);
  var f = genero === "f";
  var s = "";
  if (classe === "mago") {
    s += '<line x1="90" y1="106" x2="80" y2="30" stroke="' + CJ_MADEIRA + '" stroke-width="5" stroke-linecap="round"/>' +
      '<circle cx="79" cy="22" r="10" fill="' + metal + '" stroke="#0a0e1a" stroke-width="2"/>' +
      '<circle cx="76" cy="19" r="3" fill="#fff" opacity=".7"/>' +
      '<g transform="rotate(-12 50 12)">' +
      '<path d="M24 12 C34 -6 44 -24 58 -40 C58 -22 66 -4 76 12 Z" fill="' + p.pano + '" stroke="#0a0e1a" stroke-width="2"/>' +
      '<ellipse cx="50" cy="13" rx="38" ry="9" fill="' + p.pano + '" stroke="#0a0e1a" stroke-width="2"/>' +
      '<path d="M27 8 Q50 14 73 8 L74 13 Q50 19 26 13 Z" fill="' + p.detalhe + '"/>' +
      cjEstrela(50, -6, 6, p.detalhe) + cjEstrela(58, -22, 4, p.enfeite) +
      (f ? '<path d="M68 10 l9 -6 v12 z M68 10 l-9 -6 v12 z" fill="' + p.enfeite + '" stroke="#0a0e1a" stroke-width="1"/>' +
        '<circle cx="68" cy="10" r="3" fill="' + p.detalhe + '"/>' : "") +
      "</g>";
  } else if (classe === "arqueiro") {
    s += '<path d="M82 6 Q120 56 82 106" fill="none" stroke="#0a0e1a" stroke-width="8" stroke-linecap="round"/>' +
      '<path d="M82 6 Q120 56 82 106" fill="none" stroke="' + metal + '" stroke-width="5" stroke-linecap="round"/>' +
      '<line x1="82" y1="6" x2="82" y2="106" stroke="#f4f6ff" stroke-width="1.2"/>' +
      '<rect x="97" y="49" width="8" height="14" rx="3" fill="' + p.pano + '" stroke="#0a0e1a" stroke-width="1"/>' +
      '<line x1="68" y1="56" x2="114" y2="56" stroke="' + CJ_MADEIRA + '" stroke-width="3"/>' +
      '<polygon points="122,56 112,50 112,62" fill="' + metal + '" stroke="#0a0e1a" stroke-width="1"/>' +
      '<path d="M70 56 l-8 -7 h7 z M70 56 l-8 7 h7 z" fill="' + p.enfeite + '" stroke="#0a0e1a" stroke-width=".8"/>';
  } else if (classe === "guerreiro") {
    s += '<g transform="translate(86 62) rotate(20)">' +
      '<polygon points="-5,-4 -5,-58 0,-70 5,-58 5,-4" fill="' + metal + '" stroke="#0a0e1a" stroke-width="1.5"/>' +
      '<line x1="0" y1="-60" x2="0" y2="-8" stroke="#fff" stroke-width="1.2" opacity=".5"/>' +
      '<rect x="-15" y="-5" width="30" height="6" rx="3" fill="' + p.detalhe + '" stroke="#0a0e1a" stroke-width="1.5"/>' +
      '<rect x="-3.5" y="1" width="7" height="18" rx="2" fill="#3b2a1a"/>' +
      '<circle cx="0" cy="22" r="5" fill="' + p.detalhe + '" stroke="#0a0e1a" stroke-width="1.5"/>' +
      (f ? '<path d="M3 8 q12 4 8 16" stroke="' + p.enfeite + '" stroke-width="3" fill="none" stroke-linecap="round"/>' : "") +
      "</g>";
  } else if (classe === "monge") {
    s += '<g transform="translate(88 48) rotate(-15)">' +
      '<line x1="0" y1="64" x2="0" y2="-56" stroke="' + CJ_MADEIRA + '" stroke-width="4.5" stroke-linecap="round"/>' +
      '<polygon points="0,-84 -7,-58 0,-52 7,-58" fill="' + metal + '" stroke="#0a0e1a" stroke-width="1.5"/>' +
      '<path d="M-2 -52 q-8 10 -4 22 M2 -52 q6 10 2 22" stroke="' + p.borla + '" stroke-width="3" fill="none" stroke-linecap="round"/>' +
      '<rect x="-3.5" y="10" width="7" height="14" rx="2" fill="' + p.pano + '"/>' +
      "</g>";
  } else if (classe === "curandeiro") {
    s += '<g transform="translate(86 76) rotate(25)">' +
      '<rect x="-2.5" y="-34" width="5" height="40" rx="2.5" fill="#f4f6ff" stroke="#0a0e1a" stroke-width="1.2"/>' +
      '<rect x="-3.5" y="-4" width="7" height="12" rx="2" fill="' + p.pano + '"/>' +
      cjEstrela(0, -42, 12, metal) +
      "</g>" +
      cjEstrela(70, 18, 4, p.enfeite) + cjEstrela(104, 36, 3, p.enfeite) +
      '<path d="M100 2 h4 v-4 h4 v4 h4 v4 h-4 v4 h-4 v-4 h-4 z" fill="#51cf66" stroke="#0a0e1a" stroke-width=".8"/>';
  }
  return '<svg class="cj-av-item" viewBox="0 0 100 100" aria-hidden="true">' + s + "</svg>";
}

function cjAvatarHtml(info, tamanho, opcoes) {
  opcoes = opcoes || {};
  var foto = info.avatar
    ? '<img class="cj-av-foto" src="' + escapeHtml(info.avatar) + '" alt="" />'
    : '<span class="cj-av-foto cj-av-inicial">' + escapeHtml((info.nick || "?").charAt(0).toUpperCase()) + "</span>";
  var deco = opcoes.decoracao && info.cosmeticos && info.cosmeticos.decoracao
    ? '<img class="cj-av-deco" src="' + escapeHtml(info.cosmeticos.decoracao) + '" alt="" />'
    : "";
  var item = info.classe ? cjItemSvg(info.classe, info.genero, info.arma) : "";
  return '<div class="cj-av" style="--t:' + tamanho + 'px">' + foto + deco + item + (opcoes.extra || "") + "</div>";
}

// ---------------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------------

function cjEnviar(obj) {
  if (cjWs && cjWs.readyState === WebSocket.OPEN) {
    cjWs.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function cjConectar() {
  if (cjWs && (cjWs.readyState === WebSocket.OPEN || cjWs.readyState === WebSocket.CONNECTING)) return;
  var protocolo = location.protocol === "https:" ? "wss:" : "ws:";
  var avatar = avatarAtual();
  var url = protocolo + "//" + location.host + "/ws/clickj" +
    "?nome=" + encodeURIComponent(nomeUsuario()) +
    "&nick=" + encodeURIComponent(nomeExibicao()) +
    (avatar ? "&avatar=" + encodeURIComponent(avatar) : "");
  var ws = new WebSocket(url);
  cjWs = ws;
  ws.onmessage = function (ev) {
    if (typeof ev.data !== "string") return;
    try { cjProcessar(JSON.parse(ev.data)); } catch (e) { console.warn(e); }
  };
  ws.onclose = function () {
    if (cjWs !== ws) return;
    cjWs = null;
    if (cjAtivo && !cjBloqueado) {
      cjMsg("Conexão perdida. Reconectando...", "erro");
      clearTimeout(cjReconectarTimer);
      cjReconectarTimer = setTimeout(cjConectar, 2000);
    }
  };
  ws.onerror = function () {};
  clearInterval(cjPingTimer);
  cjPingTimer = setInterval(function () { cjEnviar({ tipo: "ping" }); }, 20000);
}

function cjProcessar(d) {
  switch (d.tipo) {
    case "bem_vindo":
      cjCatalogo = d.catalogo;
      cjLotes = {};
      cjPendentes = 0;
      cjMsg("", "");
      if (!d.tem_personagem) {
        cjEu = null;
        cjMostrarView("criar");
        cjRenderCriar();
      }
      break;
    case "estado":
      cjEu = d.jogador;
      cjEuRecebidoEm = Date.now();
      cjLimparLotes(cjEu.ack);
      cjRenderJogo();
      if (document.querySelector("#cj-loja").classList.contains("ativa")) cjRenderLoja();
      if (d.aviso) cjToast(d.aviso);
      break;
    case "online":
      cjOnline = d.jogadores || [];
      cjRenderOnline();
      break;
    case "desafio":
      cjMostrarDesafio(d.de, d.expira_em || 20);
      break;
    case "desafio_cancelado":
      if (cjDesafio && cjDesafio.nome === d.de) cjFecharPopup();
      break;
    case "luta":
      cjReceberLuta(d.luta);
      break;
    case "luta_fim":
      cjFimLuta(d);
      break;
    case "aviso":
      cjToast(d.mensagem);
      break;
    case "erro":
      cjToast(d.mensagem, true);
      if (cjLuta && !cjLuta.fim && cjView === "luta") cjRenderLuta();
      break;
    case "erro_fatal":
      cjBloqueado = true;
      cjMostrarView("carregando");
      document.querySelector("#cj-view-carregando").innerHTML = '<p class="vazio">' + escapeHtml(d.mensagem) + "</p>";
      break;
  }
}

function cjMsg(texto, tipo) {
  var el = document.querySelector("#cj-mensagem");
  el.textContent = texto || "";
  el.className = "mensagem" + (tipo ? " " + tipo : "");
}

function cjToast(texto, erro) {
  var el = document.querySelector("#cj-toast");
  if (!el || !texto) return;
  el.textContent = texto;
  el.className = "cj-toast visivel" + (erro ? " erro" : "");
  clearTimeout(cjToastTimer);
  cjToastTimer = setTimeout(function () { el.className = "cj-toast" + (erro ? " erro" : ""); }, 2800);
}

function cjMostrarView(nome) {
  cjView = nome;
  document.querySelectorAll("#tela-clickj .cj-view").forEach(function (v) {
    v.classList.toggle("ativa", v.id === "cj-view-" + nome);
  });
  document.querySelector("#voltar-clickj").style.display = nome === "luta" ? "none" : "";
}

// ---------------------------------------------------------------------------
// Criação de personagem
// ---------------------------------------------------------------------------

function cjRenderCriar() {
  if (!cjCatalogo) return;
  document.querySelectorAll(".cj-genero-btn").forEach(function (b) {
    b.classList.toggle("ativo", b.dataset.genero === cjGenero);
  });
  var html = "";
  Object.keys(cjCatalogo.classes).forEach(function (classe) {
    var info = cjCatalogo.classes[classe];
    html +=
      '<button type="button" class="cj-classe' + (cjClasseEscolhida === classe ? " selecionada" : "") + '" data-classe="' + classe + '">' +
      cjAvatarHtml({ avatar: avatarAtual(), nick: nomeExibicao(), classe: classe, genero: cjGenero, arma: -1 }, 72) +
      "<strong>" + info.titulo[cjGenero] + "</strong>" +
      '<small class="cj-classe-bonus">+5 ' + cjCatalogo.skill_nomes[info.skill] + "</small>" +
      "<small>" + CJ_CLASSE_DESC[classe] + "</small>" +
      "</button>";
  });
  document.querySelector("#cj-classes").innerHTML = html;
  var botao = document.querySelector("#cj-criar");
  botao.disabled = !cjClasseEscolhida;
  botao.textContent = cjClasseEscolhida
    ? "Criar " + cjCatalogo.classes[cjClasseEscolhida].titulo[cjGenero]
    : "Escolha uma classe";
}

// ---------------------------------------------------------------------------
// Tela principal
// ---------------------------------------------------------------------------

function cjNaoConfirmados() {
  var total = cjPendentes;
  for (var k in cjLotes) total += cjLotes[k];
  return total;
}

function cjLimparLotes(ack) {
  for (var k in cjLotes) {
    if (+k <= ack) delete cjLotes[k];
  }
}

function cjJcoinsAtuais() {
  if (!cjEu) return 0;
  return cjEu.jcoins + cjNaoConfirmados() * cjEu.jcoins_por_clique;
}

function cjAtualizarContadores() {
  if (!cjEu) return;
  var extra = cjNaoConfirmados();
  var jcoins = cjJcoinsAtuais();
  var cliques = cjEu.cliques + extra * cjEu.cliques_por_clique;
  document.querySelector("#cj-jcoins").textContent = jcoins.toLocaleString("pt-BR");
  document.querySelector("#cj-loja-jcoins").textContent = cjFmt(jcoins);
  var barra = document.querySelector("#cj-progresso-barra");
  var texto = document.querySelector("#cj-progresso-texto");
  if (cjEu.cliques_proximo_nivel) {
    var base = cjEu.cliques_nivel_atual;
    var pct = Math.min(100, Math.max(0, (cliques - base) / (cjEu.cliques_proximo_nivel - base) * 100));
    barra.style.width = pct + "%";
    texto.textContent = "Nível " + (cjEu.nivel + 1) + " em " + cjFmt(cjEu.cliques_proximo_nivel) +
      " cliques · você tem " + cjFmt(cliques);
  } else {
    barra.style.width = "100%";
    texto.textContent = "Nível máximo! " + cjFmt(cliques) + " cliques no total.";
  }
}

function cjRenderJogo() {
  if (!cjEu || !cjCatalogo) return;
  if (cjView === "carregando" || cjView === "criar") cjMostrarView("jogo");
  var cosm = cjEu.cosmeticos || {};
  var avatarInfo = {
    avatar: cjEu.avatar || avatarAtual(), nick: cjEu.nick, classe: cjEu.classe,
    genero: cjEu.genero, arma: cjEu.equip.arma,
  };
  var chaveAvatar = JSON.stringify(avatarInfo);
  var avatarEl = document.querySelector("#cj-meu-avatar");
  if (avatarEl.dataset.chave !== chaveAvatar) {
    avatarEl.dataset.chave = chaveAvatar;
    avatarEl.innerHTML = cjAvatarHtml(avatarInfo, 96);
  }
  var nickEl = document.querySelector("#cj-meu-nick");
  nickEl.textContent = cjEu.nick || nomeExibicao();
  if (typeof aplicarCorEmElemento === "function") aplicarCorEmElemento(nickEl, cosm.cor_nick);
  document.querySelector("#cj-meu-titulo").textContent = CJ_CLASSE_ICONES[cjEu.classe] + " " + cjEu.titulo;
  document.querySelector("#cj-meu-nivel").textContent = "Nível " + cjEu.nivel + "/" + cjEu.nivel_max;
  document.querySelector("#cj-meus-rebirths").textContent = cjEu.rebirths ? "🔁 " + cjEu.rebirths + " rebirth" + (cjEu.rebirths > 1 ? "s" : "") : "";
  document.querySelector("#cj-meu-pvp").textContent = "⚔️ " + cjEu.pvp_vitorias + "V / " + cjEu.pvp_derrotas + "D · ❤️ " + cjEu.hp_max;
  document.querySelector("#cj-valor-clique").textContent = "+" + cjFmt(cjEu.jcoins_por_clique) + " J";
  var auto = cjEu.auto_nivel
    ? "Autoclicker nível " + cjEu.auto_nivel + ": " + cjEu.auto_cps + " cliques/s"
    : "Autoclicker libera no nível " + cjCatalogo.auto.nivel_desbloqueio;
  document.querySelector("#cj-info-clique").textContent =
    "1 clique conta como " + cjFmt(cjEu.cliques_por_clique) + " e dá " + cjFmt(cjEu.jcoins_por_clique) + " Jcoins · " + auto;
  cjAtualizarContadores();
  cjRenderEfeitos();

  var podeRebirth = cjEu.faltando_rebirth.length === 0;
  document.querySelector("#cj-rebirth").style.display = podeRebirth ? "" : "none";
  var dica = "";
  if (!podeRebirth && cjEu.nivel >= cjEu.nivel_max) {
    dica = "Rebirth: falta comprar " + cjEu.faltando_rebirth.length + " item(ns) de Diamante (armas, armaduras e livros).";
  }
  document.querySelector("#cj-rebirth-dica").textContent = dica;
  cjRenderSkills();
}

function cjRenderEfeitos() {
  var el = document.querySelector("#cj-efeitos");
  if (!cjEu) { el.innerHTML = ""; return; }
  var passou = (Date.now() - cjEuRecebidoEm) / 1000;
  var html = "";
  Object.keys(cjEu.efeitos || {}).forEach(function (chave) {
    var ef = cjEu.efeitos[chave];
    var restante = ef.restante - passou;
    if (restante <= 0) return;
    var rotulo = chave === "clique"
      ? "⚡ Cliques " + ef.valor + "x"
      : CJ_SKILL_ICONES[chave] + " +" + ef.valor + " " + cjCatalogo.skill_nomes[chave];
    html += '<span class="cj-efeito">' + rotulo + " · " + cjFmtTempo(restante) + "</span>";
  });
  el.innerHTML = html;
}

function cjRenderSkills() {
  var principal = cjCatalogo.classes[cjEu.classe].skill;
  var maior = 1;
  cjCatalogo.skills.forEach(function (s) { maior = Math.max(maior, cjEu.skills[s]); });
  var html = "";
  cjCatalogo.skills.forEach(function (s) {
    var valor = cjEu.skills[s];
    var pocao = (cjEu.skills_pocao || {})[s];
    html +=
      '<div class="cj-skill' + (s === principal ? " principal" : "") + '">' +
      '<span class="cj-skill-nome">' + CJ_SKILL_ICONES[s] + " " + cjCatalogo.skill_nomes[s] + "</span>" +
      '<span class="cj-skill-barra"><div style="width:' + (valor / maior * 100).toFixed(1) + '%"></div></span>' +
      '<span class="cj-skill-valor">' + cjFmt(valor) + (pocao ? " <small>(+" + pocao + ")</small>" : "") + "</span>" +
      "</div>";
  });
  document.querySelector("#cj-skills").innerHTML = html;
}

function cjRenderOnline() {
  var el = document.querySelector("#cj-online-lista");
  if (!cjOnline.length) {
    el.innerHTML = '<p class="vazio">Ninguém online.</p>';
    return;
  }
  var eu = nomeUsuario();
  var emLuta = cjLuta && !cjLuta.fim;
  var html = "";
  cjOnline.forEach(function (j) {
    var acao;
    if (j.nome === eu) acao = '<span class="cj-tag">Você</span>';
    else if (j.em_luta) acao = '<span class="cj-tag">⚔️ Lutando</span>';
    else acao = '<button type="button" class="cj-desafiar" data-alvo="' + escapeHtml(j.nome) + '"' +
      (!cjEu || emLuta ? " disabled" : "") + ">Desafiar</button>";
    html +=
      '<div class="cj-online-item">' +
      avatarSalaHtml(j.avatar, j.nick, j.cosmeticos) +
      '<div class="cj-online-info">' +
      "<strong>" + cjNickHtml(j.nick, j.cosmeticos) + "</strong>" +
      "<small>" + CJ_CLASSE_ICONES[j.classe] + " Nv " + j.nivel + " · 🔁 " + j.rebirths + "</small>" +
      '<span class="cj-online-jcoins">' + cjMoedaHtml(j.jcoins) + "</span>" +
      "</div>" + acao + "</div>";
  });
  el.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Clique
// ---------------------------------------------------------------------------

function cjClicar(ev) {
  if (!cjEu) return;
  cjPendentes++;
  cjAtualizarContadores();
  var botao = document.querySelector("#cj-botao-clique");
  botao.classList.add("apertado");
  setTimeout(function () { botao.classList.remove("apertado"); }, 70);
  var rect = botao.getBoundingClientRect();
  var x = ev && ev.clientX != null ? ev.clientX - rect.left : rect.width / 2;
  var y = ev && ev.clientY != null ? ev.clientY - rect.top : rect.height / 3;
  var flutuante = document.createElement("span");
  flutuante.className = "cj-flutuante";
  flutuante.textContent = "+" + cjFmt(cjEu.jcoins_por_clique);
  flutuante.style.left = x + "px";
  flutuante.style.top = y + "px";
  botao.appendChild(flutuante);
  setTimeout(function () { flutuante.remove(); }, 800);
  if (!cjEnvioTimer) cjEnvioTimer = setTimeout(cjEnviarLote, 250);
}

function cjEnviarLote() {
  cjEnvioTimer = null;
  if (!cjPendentes) return;
  cjSeq++;
  if (cjEnviar({ tipo: "cliques", n: cjPendentes, seq: cjSeq })) {
    cjLotes[cjSeq] = cjPendentes;
    cjPendentes = 0;
  } else {
    cjEnvioTimer = setTimeout(cjEnviarLote, 1000);
  }
}

// ---------------------------------------------------------------------------
// Loja
// ---------------------------------------------------------------------------

function cjNomeItem(slot, idx) {
  var material = cjCatalogo.materiais[idx].nome;
  if (slot === "arma") return cjCatalogo.classes[cjEu.classe].arma + " de " + material;
  if (cjCatalogo.armaduras[slot]) return cjCatalogo.armaduras[slot].nome + " de " + material;
  return cjCatalogo.livros[slot].nome + " (" + material + ")";
}

function cjSkillDoSlot(slot) {
  if (slot === "arma") return cjCatalogo.classes[cjEu.classe].skill;
  if (cjCatalogo.armaduras[slot]) return cjCatalogo.armaduras[slot].skill;
  return cjCatalogo.livros[slot].skill;
}

function cjBotaoComprar(atributos, preco, rotulo, desabilitado) {
  return '<button type="button" class="cj-comprar" ' + atributos + (desabilitado ? " disabled" : "") + ">" +
    (rotulo ? rotulo + " " : "") + cjMoedaHtml(preco) + "</button>";
}

function cjLinhasEquip(slot) {
  var atual = cjEu.equip[slot] != null ? cjEu.equip[slot] : -1;
  var jcoins = cjJcoinsAtuais();
  var skill = cjSkillDoSlot(slot);
  var html = "";
  cjCatalogo.materiais.forEach(function (m, idx) {
    var estado = idx <= atual ? "comprado" : idx === atual + 1 ? "disponivel" : "bloqueado";
    var acao;
    if (estado === "comprado") acao = '<span class="cj-possui">' + (idx === atual ? "✓ Em uso" : "✓ Comprado") + "</span>";
    else if (estado === "disponivel") acao = cjBotaoComprar('data-comprar="' + slot + ":" + m.id + '"', m.preco, "Comprar", jcoins < m.preco);
    else acao = '<span class="cj-tag">🔒 ' + cjMoedaHtml(m.preco) + "</span>";
    html +=
      '<div class="cj-item ' + estado + '">' +
      '<span class="cj-swatch" style="background:' + m.cor + '"></span>' +
      '<div class="cj-item-info"><strong>' + escapeHtml(cjNomeItem(slot, idx)) +
      '<span class="cj-cat cj-cat-' + m.categoria + '">' + CJ_CATEGORIAS[m.categoria] + "</span></strong>" +
      "<small>+" + cjFmt(m.bonus) + " " + cjCatalogo.skill_nomes[skill] + "</small></div>" +
      '<div class="cj-item-acao">' + acao + "</div></div>";
  });
  return html;
}

function cjLinhasPocoes(filtro) {
  var jcoins = cjJcoinsAtuais();
  var html = "";
  cjCatalogo.pocoes.forEach(function (p) {
    if (filtro === "clique" ? p.tipo !== "clique" : p.skill !== filtro) return;
    var tenho = (cjEu.pocoes || {})[p.id] || 0;
    var dur = p.dur >= 3600 ? (p.dur / 3600) + " h" : (p.dur / 60) + " min";
    var desc = p.tipo === "clique"
      ? "Cliques valem " + p.valor + "x por " + dur
      : "+" + p.valor + " " + cjCatalogo.skill_nomes[p.skill] + " por " + dur + " (vale na luta)";
    html +=
      '<div class="cj-item">' +
      '<span class="cj-swatch" style="background:#2a1f45">' + (p.tipo === "clique" ? "⚡" : CJ_SKILL_ICONES[p.skill]) + "</span>" +
      '<div class="cj-item-info"><strong>' + escapeHtml(p.nome) + "</strong><small>" + desc +
      (tenho ? " · você tem " + tenho : "") + "</small></div>" +
      '<div class="cj-item-acao">' +
      (tenho ? '<button type="button" class="cj-comprar cj-usar" data-usar="' + p.id + '">Usar</button>' : "") +
      cjBotaoComprar('data-comprar="' + p.id + '"', p.preco, "", jcoins < p.preco) +
      "</div></div>";
  });
  return html;
}

function cjCardAutoclicker() {
  var auto = cjCatalogo.auto;
  if (!cjEu.auto_nivel) {
    return '<div class="cj-auto-card"><strong>🔒 Autoclicker</strong><small>Libera de graça no nível ' +
      auto.nivel_desbloqueio + " (você está no nível " + cjEu.nivel + ").</small></div>";
  }
  var html = '<div class="cj-auto-card"><strong>🤖 Autoclicker nível ' + cjEu.auto_nivel + "/5</strong>" +
    "<small>Clica " + auto.cps[cjEu.auto_nivel] + " vezes por segundo enquanto você está no ClickJ.</small>";
  if (cjEu.auto_nivel < 5) {
    var prox = cjEu.auto_nivel + 1;
    var preco = auto.precos[prox];
    html += cjBotaoComprar("data-auto", preco, "Melhorar para nível " + prox + " (" + auto.cps[prox] + "/s)", cjJcoinsAtuais() < preco);
  } else {
    html += '<span class="cj-possui">✓ Nível máximo</span>';
  }
  return html + "</div>";
}

function cjFiltrosHtml(opcoes, ativo, aba) {
  return opcoes.map(function (o) {
    return '<button type="button" class="cj-filtro' + (o[0] === ativo ? " ativo" : "") + '" data-filtro="' + o[0] + '" data-aba-filtro="' + aba + '">' + o[1] + "</button>";
  }).join("");
}

function cjRenderLoja() {
  if (!cjEu || !cjCatalogo) return;
  document.querySelectorAll(".cj-aba").forEach(function (b) {
    b.classList.toggle("ativa", b.dataset.aba === cjLojaAba);
  });
  var filtros = "";
  var lista = "";
  var skillsOpcoes = cjCatalogo.skills.map(function (s) { return [s, CJ_SKILL_ICONES[s] + " " + cjCatalogo.skill_nomes[s]]; });
  if (cjLojaAba === "armas") {
    lista = cjLinhasEquip("arma");
  } else if (cjLojaAba === "armaduras") {
    var slot = cjLojaFiltro.armaduras || "capacete";
    filtros = cjFiltrosHtml(Object.keys(cjCatalogo.armaduras).map(function (k) { return [k, cjCatalogo.armaduras[k].nome]; }), slot, "armaduras");
    lista = cjLinhasEquip(slot);
  } else if (cjLojaAba === "pocoes") {
    var tipo = cjLojaFiltro.pocoes || "clique";
    filtros = cjFiltrosHtml([["clique", "⚡ Cliques"]].concat(skillsOpcoes), tipo, "pocoes");
    lista = cjLinhasPocoes(tipo);
  } else {
    var livro = cjLojaFiltro.utilitarios || cjCatalogo.classes[cjEu.classe].skill;
    filtros = cjFiltrosHtml(skillsOpcoes, livro, "utilitarios");
    lista = cjCardAutoclicker() + cjLinhasEquip("livro_" + livro);
  }
  document.querySelector("#cj-loja-filtros").innerHTML = filtros;
  document.querySelector("#cj-loja-lista").innerHTML = lista;
  cjAtualizarContadores();
}

function cjAbrirLoja() {
  document.querySelector("#cj-loja").classList.add("ativa");
  cjRenderLoja();
}

function cjFecharLoja() {
  document.querySelector("#cj-loja").classList.remove("ativa");
}

// ---------------------------------------------------------------------------
// Popups (desafio, rebirth)
// ---------------------------------------------------------------------------

function cjPopup(titulo, corpoHtml, botoes) {
  document.querySelector("#cj-popup-titulo").textContent = titulo;
  document.querySelector("#cj-popup-corpo").innerHTML = corpoHtml;
  var area = document.querySelector("#cj-popup-botoes");
  area.innerHTML = "";
  botoes.forEach(function (b) {
    var el = document.createElement("button");
    el.type = "button";
    el.className = "botao" + (b.principal ? " principal" : "");
    el.textContent = b.texto;
    el.addEventListener("click", b.acao);
    area.appendChild(el);
  });
  document.querySelector("#cj-popup").classList.add("ativo");
}

function cjFecharPopup() {
  document.querySelector("#cj-popup").classList.remove("ativo");
  clearInterval(cjDesafioTimer);
  cjDesafio = null;
}

function cjMostrarDesafio(de, segundos) {
  if (!de) return;
  cjDesafio = de;
  var fim = Date.now() + segundos * 1000;
  cjPopup("⚔️ Desafio de PvP!",
    cjAvatarHtml(de, 72, { decoracao: true }) +
    "<p><strong>" + cjNickHtml(de.nick, de.cosmeticos) + "</strong> (" + escapeHtml(de.titulo) + ", nível " + de.nivel +
    ") te chamou pra lutar.</p>" +
    '<p class="cj-popup-contagem" id="cj-desafio-contagem"></p>',
    [
      { texto: "Aceitar", principal: true, acao: function () { cjResponderDesafio(true); } },
      { texto: "Recusar", acao: function () { cjResponderDesafio(false); } },
    ]);
  var contagem = function () {
    var resta = Math.ceil((fim - Date.now()) / 1000);
    var el = document.querySelector("#cj-desafio-contagem");
    if (el) el.textContent = "Expira em " + Math.max(0, resta) + "s";
    if (resta <= 0) cjFecharPopup();
  };
  contagem();
  clearInterval(cjDesafioTimer);
  cjDesafioTimer = setInterval(contagem, 500);
}

function cjResponderDesafio(aceitar) {
  if (!cjDesafio) return;
  cjEnviar({ tipo: "responder_desafio", de: cjDesafio.nome, aceitar: aceitar });
  cjFecharPopup();
}

function cjConfirmarRebirth() {
  if (!cjEu) return;
  var mult = 10 * (cjEu.rebirths + 1);
  cjPopup("🔁 Rebirth",
    "<p>Você volta ao nível 1 e perde Jcoins, cliques, armas, armaduras, livros e poções.</p>" +
    "<p>Em troca: cada clique passa a dar <strong>" + mult + "x</strong> Jcoins, o autoclicker já vem no nível 1 e sua vida no PvP vai para <strong>" +
    (cjEu.hp_max + cjCatalogo.luta.hp_por_rebirth) + "</strong>.</p>",
    [
      { texto: "Fazer rebirth", principal: true, acao: function () { cjEnviar({ tipo: "rebirth" }); cjFecharPopup(); } },
      { texto: "Cancelar", acao: cjFecharPopup },
    ]);
}

// ---------------------------------------------------------------------------
// Luta
// ---------------------------------------------------------------------------

function cjNomesLuta() {
  var eu = nomeUsuario();
  var outro = cjLuta.ordem[0] === eu ? cjLuta.ordem[1] : cjLuta.ordem[0];
  return { eu: eu, outro: outro };
}

function cjMontarLutador(el, l) {
  el.innerHTML =
    '<div class="cj-lutador-av">' +
    cjAvatarHtml({ avatar: l.avatar, nick: l.nick, classe: l.classe, genero: l.genero, arma: l.arma }, 104) +
    CJ_ESCUDO_SVG +
    '<span class="cj-cruz">✚</span><span class="cj-mao">✋</span><div class="cj-numeros"></div>' +
    "</div>" +
    '<strong class="cj-lutador-nick">' + cjNickHtml(l.nick, l.cosmeticos) + "</strong>" +
    '<small class="cj-lutador-titulo">' + CJ_CLASSE_ICONES[l.classe] + " " + escapeHtml(l.titulo) + "</small>" +
    '<div class="cj-hp"><div class="cj-hp-barra"></div><span class="cj-hp-texto"></span></div>' +
    '<div class="cj-lutador-status"></div>';
}

function cjAtualizarLutador(el, l, vez) {
  var pct = Math.max(0, l.hp / l.hp_max * 100);
  var barra = el.querySelector(".cj-hp-barra");
  barra.style.width = pct + "%";
  barra.classList.toggle("baixa", pct <= 30);
  el.querySelector(".cj-hp-texto").textContent = l.hp + " / " + l.hp_max;
  el.classList.toggle("vez", vez);
  el.classList.toggle("defendendo", !!l.defendendo);
  el.classList.toggle("esquivando", !!l.esquivando);
  el.classList.toggle("desconectado", !l.conectado);
  var status = [];
  if (!l.conectado) status.push("📡 desconectado");
  if (l.defendendo) status.push("🛡️ defendendo");
  if (l.esquivando) status.push("💨 pronto pra esquivar");
  el.querySelector(".cj-lutador-status").textContent = status.join(" · ");
}

function cjReceberLuta(luta) {
  var nova = !cjLuta || cjLuta.id !== luta.id;
  cjLuta = luta;
  cjLutaRecebidaEm = Date.now();
  var n = cjNomesLuta();
  if (nova) {
    cjUltimoEvento = 0;
    cjFecharLoja();
    if (cjDesafio) cjFecharPopup();
    var tela = document.querySelector("#tela-clickj");
    if (!tela.classList.contains("ativa")) mostrarTela(tela);
    document.querySelector("#cj-resultado").style.display = "none";
    cjMontarLutador(document.querySelector("#cj-lutador-eu"), luta.lutadores[n.eu]);
    cjMontarLutador(document.querySelector("#cj-lutador-outro"), luta.lutadores[n.outro]);
    cjRenderOnline();
  }
  cjMostrarView("luta");
  cjRenderLuta();
  if (luta.evento && luta.evento.seq > cjUltimoEvento) {
    cjUltimoEvento = luta.evento.seq;
    cjAnimarEvento(luta.evento);
  }
}

function cjRenderLuta() {
  var luta = cjLuta;
  var n = cjNomesLuta();
  var eu = luta.lutadores[n.eu];
  var outro = luta.lutadores[n.outro];
  var minhaVez = !luta.fim && luta.turno_de === n.eu;
  cjAtualizarLutador(document.querySelector("#cj-lutador-eu"), eu, !luta.fim && luta.turno_de === n.eu);
  cjAtualizarLutador(document.querySelector("#cj-lutador-outro"), outro, !luta.fim && luta.turno_de === n.outro);

  var msg = document.querySelector("#cj-turno-msg");
  msg.textContent = luta.fim ? "" : minhaVez ? "Sua vez! Escolha uma ação." : "Vez de " + outro.nick + "...";
  msg.classList.toggle("minha", minhaVez);

  document.querySelectorAll(".cj-acao").forEach(function (b) {
    var acao = b.dataset.acao;
    var ok = minhaVez;
    if (acao === "esquivar" && eu.esquiva_em > 0) ok = false;
    if (acao === "curar" && !eu.pode_curar) ok = false;
    b.disabled = !ok;
  });
  document.querySelector("#cj-esquiva-info").textContent =
    eu.esquiva_em > 0 ? "em " + eu.esquiva_em + " turno(s)" : "Agilidade";
  document.querySelector("#cj-cura-info").textContent =
    eu.hp >= eu.hp_max ? "vida cheia" : eu.pode_curar ? "Magia" : "não 2x seguidas";
  document.querySelector("#cj-desistir").style.display = luta.fim ? "none" : "";

  document.querySelector("#cj-log").innerHTML = luta.log.slice().reverse().map(function (t) {
    return "<p>" + escapeHtml(t) + "</p>";
  }).join("");
  cjAtualizarRelogioTurno();
}

function cjAtualizarRelogioTurno() {
  var el = document.querySelector("#cj-turno-tempo");
  if (!cjLuta || cjLuta.fim) { el.textContent = ""; return; }
  var resta = cjLuta.restante - (Date.now() - cjLutaRecebidaEm) / 1000;
  el.textContent = "⏱ " + Math.max(0, Math.ceil(resta)) + "s";
}

function cjAnimar(el, classe, ms) {
  if (!el) return;
  el.classList.remove(classe);
  void el.offsetWidth;
  el.classList.add(classe);
  setTimeout(function () { el.classList.remove(classe); }, ms);
}

function cjNumero(avEl, texto, classe) {
  var area = avEl && avEl.querySelector(".cj-numeros");
  if (!area) return;
  var el = document.createElement("span");
  el.className = "cj-numero " + classe;
  el.textContent = texto;
  area.appendChild(el);
  setTimeout(function () { el.remove(); }, 1100);
}

function cjAnimarEvento(ev) {
  var eu = nomeUsuario();
  var ladoAtor = ev.ator === eu ? "#cj-lutador-eu" : "#cj-lutador-outro";
  var ladoAlvo = ev.ator === eu ? "#cj-lutador-outro" : "#cj-lutador-eu";
  var atorAv = document.querySelector(ladoAtor + " .cj-lutador-av");
  var alvoAv = document.querySelector(ladoAlvo + " .cj-lutador-av");
  if (ev.acao === "atacar") {
    cjAnimar(atorAv, ev.ator === eu ? "cj-anim-tapa-dir" : "cj-anim-tapa-esq", 600);
    setTimeout(function () {
      if (ev.resultado === "esquivou") {
        cjAnimar(alvoAv, "cj-anim-esquiva", 900);
        cjNumero(alvoAv, "Esquivou!", "esquiva");
        return;
      }
      cjAnimar(alvoAv, "cj-anim-tremer", 450);
      cjAnimar(alvoAv.querySelector(".cj-mao"), "cj-anim-mao", 500);
      if (ev.resultado === "defendeu") cjAnimar(alvoAv.querySelector(".cj-escudo"), "cj-anim-escudo", 500);
      cjNumero(alvoAv, "-" + ev.dano, ev.total ? "dano total" : "dano");
    }, 260);
  } else if (ev.acao === "defender") {
    cjAnimar(atorAv.querySelector(".cj-escudo"), "cj-anim-escudo", 500);
  } else if (ev.acao === "esquivar") {
    cjNumero(atorAv, "Pronto pra esquivar", "info");
  } else if (ev.acao === "curar") {
    cjAnimar(atorAv, "cj-anim-cura", 1000);
    cjNumero(atorAv, "+" + ev.cura, "cura");
  }
}

function cjFimLuta(d) {
  var el = document.querySelector("#cj-resultado");
  var titulo = d.empate ? "Luta cancelada" : d.venceu ? "🏆 Vitória!" : "Derrota";
  var texto = d.motivo ? escapeHtml(d.motivo) : "";
  if (d.recompensa) {
    texto += (texto ? "<br>" : "") + "Você ganhou +" + cjFmt(d.recompensa.cliques) + " cliques e +" +
      cjFmt(d.recompensa.jcoins) + " Jcoins.";
  }
  el.className = "cj-resultado " + (d.empate ? "" : d.venceu ? "vitoria" : "derrota");
  el.innerHTML = "<h3>" + titulo + "</h3><p>" + texto + '</p><button type="button" class="botao principal" id="cj-voltar-jogo">Voltar ao jogo</button>';
  el.style.display = "";
  document.querySelector("#cj-voltar-jogo").addEventListener("click", function () {
    cjLuta = null;
    cjMostrarView(cjEu ? "jogo" : "criar");
    cjRenderJogo();
    cjRenderOnline();
  });
  document.querySelectorAll(".cj-acao").forEach(function (b) { b.disabled = true; });
}

// ---------------------------------------------------------------------------
// Entrar / sair
// ---------------------------------------------------------------------------

function cjTickRelogio() {
  if (cjEu && cjView === "jogo") cjRenderEfeitos();
  if (cjLuta && cjView === "luta") cjAtualizarRelogioTurno();
}

async function abrirClickJ() {
  mostrarTela(document.querySelector("#tela-clickj"));
  cjAtivo = true;
  cjBloqueado = false;
  clearInterval(cjRelogio);
  cjRelogio = setInterval(cjTickRelogio, 1000);
  if (cjWs && cjWs.readyState === WebSocket.OPEN) return;
  cjMostrarView("carregando");
  document.querySelector("#cj-view-carregando").innerHTML = '<p class="vazio">Conectando...</p>';
  cjMsg("", "");
  await garantirIdentidade();
  if (!usuarioDiscord) {
    cjAtivo = false;
    document.querySelector("#cj-view-carregando").innerHTML =
      '<p class="vazio">Entre com Discord para jogar ClickJ — seu progresso fica salvo na sua conta.</p>';
    return;
  }
  cjConectar();
}

function cjSair() {
  cjAtivo = false;
  clearTimeout(cjReconectarTimer);
  clearTimeout(cjEnvioTimer);
  cjEnvioTimer = null;
  cjEnviarLote();
  clearInterval(cjPingTimer);
  clearInterval(cjRelogio);
  if (cjWs) {
    var ws = cjWs;
    cjWs = null;
    try { ws.close(); } catch (e) { /* ignore */ }
  }
  cjLuta = null;
  cjFecharLoja();
  cjFecharPopup();
}

(function () {
  var card = document.querySelector("#jogo-clickj");
  if (!card) return;
  card.addEventListener("click", abrirClickJ);
  document.querySelector("#voltar-clickj").addEventListener("click", cjSair);
  document.querySelector("#cj-botao-icone").innerHTML = CJ_ICONE_SVG;

  document.querySelectorAll(".cj-genero-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      cjGenero = b.dataset.genero;
      cjRenderCriar();
    });
  });
  document.querySelector("#cj-classes").addEventListener("click", function (ev) {
    var card = ev.target.closest(".cj-classe");
    if (!card) return;
    cjClasseEscolhida = card.dataset.classe;
    cjRenderCriar();
  });
  document.querySelector("#cj-criar").addEventListener("click", function () {
    if (cjClasseEscolhida) cjEnviar({ tipo: "criar", classe: cjClasseEscolhida, genero: cjGenero });
  });

  var botao = document.querySelector("#cj-botao-clique");
  botao.addEventListener("pointerdown", function (ev) {
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    cjClicar(ev);
  });
  botao.addEventListener("keydown", function (ev) {
    if ((ev.key === " " || ev.key === "Enter") && !ev.repeat) {
      ev.preventDefault();
      cjClicar(null);
    }
  });

  document.querySelector("#cj-abrir-loja").addEventListener("click", cjAbrirLoja);
  document.querySelector("#cj-fechar-loja").addEventListener("click", cjFecharLoja);
  document.querySelector("#cj-loja").addEventListener("click", function (ev) {
    if (ev.target.id === "cj-loja") { cjFecharLoja(); return; }
    var aba = ev.target.closest(".cj-aba");
    if (aba) { cjLojaAba = aba.dataset.aba; cjRenderLoja(); return; }
    var filtro = ev.target.closest(".cj-filtro");
    if (filtro) { cjLojaFiltro[filtro.dataset.abaFiltro] = filtro.dataset.filtro; cjRenderLoja(); return; }
    var comprar = ev.target.closest("[data-comprar]");
    if (comprar && !comprar.disabled) { cjEnviar({ tipo: "comprar", item: comprar.dataset.comprar }); return; }
    var usar = ev.target.closest("[data-usar]");
    if (usar) { cjEnviar({ tipo: "usar_pocao", item: usar.dataset.usar }); return; }
    var auto = ev.target.closest("[data-auto]");
    if (auto && !auto.disabled) cjEnviar({ tipo: "melhorar_auto" });
  });
  document.querySelector("#cj-rebirth").addEventListener("click", cjConfirmarRebirth);

  document.querySelector("#cj-online-lista").addEventListener("click", function (ev) {
    var b = ev.target.closest(".cj-desafiar");
    if (b && !b.disabled) {
      cjEnviar({ tipo: "desafiar", alvo: b.dataset.alvo });
      b.disabled = true;
    }
  });

  document.querySelectorAll(".cj-acao").forEach(function (b) {
    b.addEventListener("click", function () {
      if (b.disabled) return;
      document.querySelectorAll(".cj-acao").forEach(function (x) { x.disabled = true; });
      cjEnviar({ tipo: "acao", acao: b.dataset.acao });
    });
  });
  document.querySelector("#cj-desistir").addEventListener("click", function () {
    cjPopup("Desistir da luta?", "<p>Quem desiste perde a luta.</p>", [
      { texto: "Desistir", principal: true, acao: function () { cjEnviar({ tipo: "desistir" }); cjFecharPopup(); } },
      { texto: "Continuar lutando", acao: cjFecharPopup },
    ]);
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") cjFecharLoja();
  });
})();
