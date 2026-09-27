// Loja — moedas, decorações de perfil (avatar decoration) e cor do nick (nametag).

// ---------------------------------------------------------------------------
// Cronômetro de sessão — rastreia horas jogadas para o ranking global.
// jogoIniciarTimer() é chamado quando uma partida começa.
// jogoRegistrarTempo() é chamado quando termina (vitória, derrota ou saída).
// ---------------------------------------------------------------------------
var _jogoTempoInicioMs = null;

function jogoIniciarTimer() {
  _jogoTempoInicioMs = Date.now();
}

function jogoRegistrarTempo(jogoNome, venceu, resultado) {
  var seg = _jogoTempoInicioMs ? Math.round((Date.now() - _jogoTempoInicioMs) / 1000) : 0;
  _jogoTempoInicioMs = null;
  if (!usuarioDiscord || !nomeUsuario()) return;
  // Registra sempre que há um jogo identificado (mesmo que curto), ou quando durou > 10s
  if (!jogoNome && seg < 10) return;
  fetch("./economia/tempo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nome: nomeUsuario(),
      nick: nomeExibicao(),
      avatar: avatarAtual() || "",
      segundos: Math.max(seg, 0),
      jogo: jogoNome || "",
      venceu: venceu === true,
      resultado: resultado || "",
    }),
  }).catch(function () {});
}

let lojaCatalogo = null;
let minhaCarteira = { saldo: 0, decoracoes: [], cores_nick: [], fontes_nick: [], historico: [], equipado: { decoracao: null, cor_nick: null, fonte_nick: null } };
let lojaPaginaDecoracoes = 0;
let lojaFiltroDecoracoes = "";
let lojaCorSelecionada = null;
let lojaDecoracaoSelecionadaSku = null;
const LOJA_DECORACOES_POR_PAGINA = 12;

// Roleta da sorte.
let lojaRoletaFatias = null;
let lojaRoletaAngulos = null;
let lojaRoletaApostaMinima = 10;
let lojaRoletaApostaMultiplo = 10;
let lojaRoletaAposta = 10;
let lojaRoletaRotacaoAtual = 0;
let lojaRoletaGirando = false;
const LOJA_CORES_HEX = {
  azul: "#5b9dff", verde: "#7ddea3", vermelho: "#ff8a8a", amarelo: "#ffd36a",
  roxo: "#c9a6ff", rosa: "#ff9ecf", laranja: "#ffab66", ciano: "#7ef0e0",
};

async function atualizarMoedasHeader() {
  var badge = document.querySelector("#moedas-valor");
  var botaoLoja = document.querySelector("#btn-abrir-loja");
  if (!usuarioDiscord) {
    if (botaoLoja) botaoLoja.style.display = "none";
    return;
  }
  if (botaoLoja) botaoLoja.style.display = "";
  try {
    var params = "nome=" + encodeURIComponent(nomeUsuario()) +
      "&nick=" + encodeURIComponent(nomeExibicao()) +
      "&avatar=" + encodeURIComponent(avatarAtual() || "") +
      "&discord_id=" + encodeURIComponent(usuarioDiscord.id || "");
    var resp = await fetch("./economia/carteira?" + params);
    minhaCarteira = await resp.json();
    if (badge) badge.textContent = minhaCarteira.saldo;
    aplicarCosmeticosHeader();
    var btnAdmin = document.querySelector("#loja-btn-admin-doar");
    if (btnAdmin) btnAdmin.style.display = minhaCarteira.eh_admin ? "" : "none";
  } catch (e) { /* ignore */ }
}

function aplicarCorEmElemento(el, cor) {
  el.classList.remove("nick-arco-iris");
  el.style.color = "";
  if (cor === "arco-iris") {
    el.classList.add("nick-arco-iris");
  } else if (cor && LOJA_CORES_HEX[cor]) {
    el.style.color = LOJA_CORES_HEX[cor];
  }
}

/** Cosméticos do próprio usuário, pra usar em telas de espera antes do
 *  servidor confirmar quem é quem (ex: sala "esperando oponente"). */
function minhasCosmeticosAtuais() {
  if (!minhaCarteira) return null;
  var equipado = minhaCarteira.equipado || {};
  return { decoracao: minhaCarteira.decoracao_imagem || null, cor_nick: equipado.cor_nick || null, fonte_nick: equipado.fonte_nick || null };
}

function aplicarCosmeticosHeader() {
  var nomeEl = document.querySelector("#auth-nome");
  if (nomeEl) aplicarCorNickEl(nomeEl, minhasCosmeticosAtuais());

  var decoImg = document.querySelector("#auth-avatar-decoracao");
  if (decoImg) {
    if (minhaCarteira.decoracao_imagem) {
      decoImg.src = minhaCarteira.decoracao_imagem;
      decoImg.style.display = "";
    } else {
      decoImg.style.display = "none";
    }
  }
}

async function carregarCatalogoLoja() {
  var resp = await fetch("./economia/loja");
  lojaCatalogo = await resp.json();
  return lojaCatalogo;
}

function ordenarPossuidosPrimeiro(lista, chaveDe, possuidos) {
  return lista
    .map(function (item, indice) { return { item: item, indice: indice }; })
    .sort(function (a, b) {
      var pa = possuidos.indexOf(chaveDe(a.item)) !== -1 ? 0 : 1;
      var pb = possuidos.indexOf(chaveDe(b.item)) !== -1 ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return a.indice - b.indice;
    })
    .map(function (par) { return par.item; });
}

// ---------------------------------------------------------------------------
// Navegação: menu principal <-> nametags / decorações
// ---------------------------------------------------------------------------
function lojaMostrarSomente(id) {
  ["#loja-menu", "#loja-secao-cores", "#loja-secao-fontes", "#loja-secao-skins-splano",
   "#loja-secao-decoracoes", "#loja-secao-roleta"].forEach(function (sel) {
    document.querySelector(sel).style.display = sel === id ? "" : "none";
  });
}

function lojaMostrarMenu() {
  lojaMostrarSomente("#loja-menu");
}

function lojaMostrarSecaoCores() {
  lojaMostrarSomente("#loja-secao-cores");
  renderLojaCores();
}

function lojaMostrarSecaoFontes() {
  lojaMostrarSomente("#loja-secao-fontes");
  renderLojaFontes();
}

function lojaMostrarSecaoSkinsSplano() {
  lojaMostrarSomente("#loja-secao-skins-splano");
  renderLojaSkinsSplano();
}

function lojaMostrarSecaoDecoracoes() {
  lojaMostrarSomente("#loja-secao-decoracoes");
  renderLojaDecoracoes();
}

async function lojaMostrarSecaoRoleta() {
  lojaMostrarSomente("#loja-secao-roleta");
  await carregarRoleta();
  lojaRoletaAtualizarValor();
}

async function abrirLoja() {
  mostrarTela(document.querySelector("#tela-loja"));
  await garantirIdentidade();
  await atualizarMoedasHeader();
  await carregarCatalogoLoja();
  lojaPaginaDecoracoes = 0;
  lojaCorSelecionada = null;
  lojaDecoracaoSelecionadaSku = null;
  document.querySelector("#loja-saldo").textContent = minhaCarteira.saldo;
  document.querySelector("#loja-preco-cor").textContent = lojaCatalogo.preco_cor_nick;
  document.querySelector("#loja-preco-fonte").textContent = lojaCatalogo.preco_fonte_nick;
  lojaMostrarMenu();
}

function lojaAtualizarSaldoTelas() {
  var saldoEl = document.querySelector("#loja-saldo");
  if (saldoEl) saldoEl.textContent = minhaCarteira.saldo;
  var badge = document.querySelector("#moedas-valor");
  if (badge) badge.textContent = minhaCarteira.saldo;
}

// ---------------------------------------------------------------------------
// Nametags (cor do nick)
// ---------------------------------------------------------------------------
function lojaPreviewCor(cor) {
  lojaCorSelecionada = cor;
  var caixa = document.querySelector("#loja-preview-cor");
  var texto = document.querySelector("#loja-preview-cor-texto");
  texto.textContent = nomeExibicao();
  aplicarCorNickEl(texto, { cor_nick: cor, fonte_nick: minhasCosmeticosAtuais().fonte_nick });
  caixa.style.display = "";
}

// ---------------------------------------------------------------------------
// Fontes do nick
// ---------------------------------------------------------------------------
function lojaPreviewFonte(fonte) {
  var texto = document.querySelector("#loja-preview-fonte-texto");
  texto.textContent = nomeExibicao();
  aplicarCorNickEl(texto, { cor_nick: minhasCosmeticosAtuais().cor_nick, fonte_nick: fonte });
  document.querySelector("#loja-preview-fonte").style.display = "";
}

function renderLojaFontes() {
  var alvo = document.querySelector("#loja-fontes");
  if (!alvo) return;
  if (!usuarioDiscord) {
    alvo.innerHTML = '<p class="perfil-vazio">Entre com Discord para comprar fontes.</p>';
    return;
  }
  alvo.innerHTML = "";
  var possuidas = minhaCarteira.fontes_nick || [];
  var equipadaAtual = (minhaCarteira.equipado || {}).fonte_nick;
  ordenarPossuidosPrimeiro(lojaCatalogo.fontes_nick, function (f) { return f.id; }, possuidas).forEach(function (fonte) {
    var possui = possuidas.indexOf(fonte.id) !== -1;
    var equipada = equipadaAtual === fonte.id;
    var card = document.createElement("div");
    card.className = "loja-item" + (equipada ? " equipado" : "");
    card.addEventListener("click", function () {
      lojaPreviewFonte(fonte.id);
      if (possui && !equipada) equiparItem("fonte_nick", fonte.id);
    });

    var moldura = document.createElement("span");
    moldura.className = "loja-cor-amostra-box loja-fonte-amostra";
    var amostra = document.createElement("span");
    amostra.textContent = "Aa";
    aplicarFonteNickEl(amostra, fonte.id);
    moldura.appendChild(amostra);
    if (equipada) moldura.appendChild(lojaBadgeEquipado());
    card.appendChild(moldura);

    var label = document.createElement("span");
    label.className = "loja-item-nome";
    label.textContent = fonte.nome;
    card.appendChild(label);

    if (!possui) {
      card.appendChild(lojaBotaoPreco(lojaCatalogo.preco_fonte_nick, possui, equipada, function (ev) {
        ev.stopPropagation();
        lojaPreviewFonte(fonte.id);
        comprarFonte(fonte.id);
      }));
    }
    alvo.appendChild(card);
  });

  if (equipadaAtual) {
    var limpar = document.createElement("button");
    limpar.className = "botao-copiar";
    limpar.textContent = "Voltar à fonte padrão";
    limpar.addEventListener("click", function () { equiparItem("fonte_nick", null); });
    alvo.appendChild(limpar);
  }
}

async function comprarFonte(fonte) {
  try {
    var resp = await fetch("./economia/comprar/fonte", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: nomeUsuario(), nick: nomeExibicao(), fonte: fonte }),
    });
    if (!resp.ok) {
      var erro = await resp.json().catch(function () { return {}; });
      alert(erro.detail || "Não foi possível comprar.");
      return;
    }
    minhaCarteira = await resp.json();
    aplicarCosmeticosHeader();
    lojaAtualizarSaldoTelas();
    renderLojaFontes();
  } catch (e) { alert("Não foi possível comprar agora."); }
}

function renderLojaCores() {
  var alvo = document.querySelector("#loja-cores");
  if (!alvo) return;
  if (!usuarioDiscord) {
    alvo.innerHTML = '<p class="perfil-vazio">Entre com Discord para comprar cores.</p>';
    return;
  }
  alvo.innerHTML = "";
  var cores = lojaCatalogo.cores_nick.slice();
  if (lojaCatalogo.tem_arco_iris) cores.push("arco-iris");
  cores = ordenarPossuidosPrimeiro(cores, function (c) { return c; }, minhaCarteira.cores_nick);

  cores.forEach(function (cor) {
    var possui = minhaCarteira.cores_nick.indexOf(cor) !== -1;
    var equipada = minhaCarteira.equipado.cor_nick === cor;
    var card = document.createElement("div");
    card.className = "loja-item" + (equipada ? " equipado" : "");
    card.addEventListener("click", function () {
      lojaPreviewCor(cor);
      if (possui && !equipada) equiparItem("cor_nick", cor);
    });

    var moldura = document.createElement("span");
    moldura.className = "loja-cor-amostra-box";
    var amostra = document.createElement("span");
    amostra.className = "loja-cor-amostra" + (cor === "arco-iris" ? " nick-arco-iris" : "");
    if (cor !== "arco-iris") amostra.style.background = LOJA_CORES_HEX[cor] || "#fff";
    moldura.appendChild(amostra);
    if (equipada) moldura.appendChild(lojaBadgeEquipado());
    card.appendChild(moldura);

    var label = document.createElement("span");
    label.className = "loja-item-nome";
    label.textContent = cor === "arco-iris" ? "Arco-íris" : cor.charAt(0).toUpperCase() + cor.slice(1);
    card.appendChild(label);

    if (!possui) {
      card.appendChild(lojaBotaoPreco(lojaCatalogo.preco_cor_nick, possui, equipada, function (ev) {
        ev.stopPropagation();
        lojaPreviewCor(cor);
        comprarCor(cor);
      }));
    }
    alvo.appendChild(card);
  });

  if (minhaCarteira.equipado.cor_nick) {
    var limpar = document.createElement("button");
    limpar.className = "botao-copiar";
    limpar.textContent = "Remover cor";
    limpar.addEventListener("click", function () { equiparItem("cor_nick", null); });
    alvo.appendChild(limpar);
  }
}

// ---------------------------------------------------------------------------
// Decorações de perfil
// ---------------------------------------------------------------------------
function lojaPreviewDecoracao(item) {
  lojaDecoracaoSelecionadaSku = item.sku_id;
  var avatarImg = document.querySelector("#loja-preview-avatar-img");
  var decoImg = document.querySelector("#loja-preview-decoracao-img");
  var nomeEl = document.querySelector("#loja-preview-decoracao-nome");
  avatarImg.src = avatarAtual() || "https://cdn.discordapp.com/embed/avatars/0.png";
  decoImg.src = item.imagem_animada || item.imagem;
  decoImg.style.display = "";
  nomeEl.textContent = item.nome;
}

// ---------------------------------------------------------------------------
// Skins do Splano.io
// ---------------------------------------------------------------------------
var lojaSkinGrupo = "cores";

function lojaAmostraSkin(skin) {
  var amostra = document.createElement("span");
  amostra.className = "sp-skin-amostra";
  if (skin.padrao === "rainbow") {
    amostra.classList.add("sp-skin-rainbow");
    return amostra;
  }
  if (skin.padrao === "imagem") {
    var url = minhaCarteira.skin_splano_imagem;
    if (url) {
      var img = document.createElement("img");
      img.src = urlImagemExterna(url);
      img.alt = "";
      amostra.appendChild(img);
    } else {
      amostra.style.background = skin.cores[0];
      amostra.style.display = "grid";
      amostra.style.placeItems = "center";
      amostra.textContent = "🖼️";
    }
    return amostra;
  }
  var a = skin.cores[0];
  var b = skin.cores[1] || skin.cores[0];
  if (skin.padrao === "listras") {
    amostra.style.background = "repeating-linear-gradient(180deg," + a + " 0 8px," + b + " 8px 16px)";
  } else if (skin.padrao === "vertical") {
    amostra.style.background = "repeating-linear-gradient(90deg," + a + " 0 8px," + b + " 8px 16px)";
  } else if (skin.padrao === "faixa") {
    amostra.style.background = "linear-gradient(125deg," + a + " 0 38%," + b + " 38% 62%," + a + " 62%)";
  } else {
    amostra.style.background = a;
  }
  return amostra;
}

function renderLojaSkinsSplano() {
  var alvo = document.querySelector("#loja-skins-splano");
  if (!alvo || !lojaCatalogo.skins_splano) return;
  document.querySelector("#loja-preco-skin").textContent = 1000;
  var especiais = {};
  lojaCatalogo.skins_splano.forEach(function (s) { especiais[s.id] = s.preco; });
  document.querySelector("#loja-preco-skin-rainbow").textContent = especiais.rainbow || 1500;
  document.querySelector("#loja-preco-skin-imagem").textContent = especiais.imagem || 2000;

  if (!usuarioDiscord) {
    alvo.innerHTML = '<p class="perfil-vazio">Entre com Discord para comprar skins.</p>';
    document.querySelector("#loja-skins-filtros").innerHTML = "";
    return;
  }

  var grupos = lojaCatalogo.skins_splano_grupos || {};
  var filtros = document.querySelector("#loja-skins-filtros");
  filtros.innerHTML = "";
  Object.keys(grupos).forEach(function (g) {
    var botao = document.createElement("button");
    botao.type = "button";
    botao.className = "loja-filtro" + (g === lojaSkinGrupo ? " ativo" : "");
    botao.textContent = grupos[g];
    botao.addEventListener("click", function () {
      lojaSkinGrupo = g;
      renderLojaSkinsSplano();
    });
    filtros.appendChild(botao);
  });

  var possuidas = minhaCarteira.skins_splano || [];
  var equipada = (minhaCarteira.equipado || {}).skin_splano;
  var lista = lojaCatalogo.skins_splano.filter(function (s) { return s.grupo === lojaSkinGrupo; });
  lista = ordenarPossuidosPrimeiro(lista, function (s) { return s.id; }, possuidas);

  alvo.innerHTML = "";
  lista.forEach(function (skin) {
    var possui = possuidas.indexOf(skin.id) !== -1;
    var estaEquipada = equipada === skin.id;
    var card = document.createElement("div");
    card.className = "loja-item" + (estaEquipada ? " equipado" : "");
    card.addEventListener("click", function () {
      if (possui && !estaEquipada) equiparItem("skin_splano", skin.id);
    });

    var moldura = document.createElement("span");
    moldura.className = "loja-cor-amostra-box";
    moldura.appendChild(lojaAmostraSkin(skin));
    if (estaEquipada) moldura.appendChild(lojaBadgeEquipado());
    card.appendChild(moldura);

    var label = document.createElement("span");
    label.className = "loja-item-nome";
    label.textContent = skin.nome;
    card.appendChild(label);

    if (!possui) {
      card.appendChild(lojaBotaoPreco(skin.preco, possui, estaEquipada, function (ev) {
        ev.stopPropagation();
        comprarSkinSplano(skin.id);
      }));
    }
    alvo.appendChild(card);
  });

  if (equipada) {
    var limpar = document.createElement("button");
    limpar.className = "botao-copiar";
    limpar.textContent = "Voltar à bolinha padrão";
    limpar.addEventListener("click", function () { equiparItem("skin_splano", null); });
    alvo.appendChild(limpar);
  }

  // Campo da imagem personalizada só aparece pra quem comprou.
  var area = document.querySelector("#loja-skin-imagem-area");
  var temImagem = possuidas.indexOf("imagem") !== -1;
  area.style.display = temImagem ? "" : "none";
  if (temImagem) {
    document.querySelector("#loja-skin-imagem-url").value = minhaCarteira.skin_splano_imagem || "";
  }
}

async function comprarSkinSplano(skin) {
  try {
    var resp = await fetch("./economia/comprar/skin-splano", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: nomeUsuario(), nick: nomeExibicao(), skin: skin }),
    });
    if (!resp.ok) {
      var erro = await resp.json().catch(function () { return {}; });
      alert(erro.detail || "Não foi possível comprar.");
      return;
    }
    minhaCarteira = await resp.json();
    aplicarCosmeticosHeader();
    lojaAtualizarSaldoTelas();
    renderLojaSkinsSplano();
  } catch (e) { alert("Não foi possível comprar agora."); }
}

async function salvarImagemSkinSplano() {
  var url = document.querySelector("#loja-skin-imagem-url").value.trim();
  try {
    var resp = await fetch("./economia/skin-splano/imagem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: nomeUsuario(), nick: nomeExibicao(), imagem: url }),
    });
    if (!resp.ok) {
      var erro = await resp.json().catch(function () { return {}; });
      alert(erro.detail || "Não deu pra salvar essa imagem.");
      return;
    }
    minhaCarteira = await resp.json();
    renderLojaSkinsSplano();
  } catch (e) { alert("Não deu pra salvar agora."); }
}

function lojaBadgeEquipado() {
  var badge = document.createElement("span");
  badge.className = "loja-badge-equipado";
  badge.textContent = "✓ Em uso";
  return badge;
}

function lojaBotaoPreco(preco, possui, equipada, aoClicar) {
  var botao = document.createElement("button");
  botao.className = "botao loja-preco-botao";
  botao.innerHTML = '<span class="loja-moeda-icone">🪙</span> ' + preco;
  botao.disabled = equipada || (!possui && minhaCarteira.saldo < preco);
  botao.addEventListener("click", aoClicar);
  return botao;
}

function renderLojaDecoracoes() {
  var alvo = document.querySelector("#loja-decoracoes");
  var paginacaoAlvo = document.querySelector("#loja-decoracoes-paginacao");
  if (!alvo) return;
  if (!usuarioDiscord) {
    alvo.innerHTML = '<p class="perfil-vazio">Entre com Discord para comprar decorações.</p>';
    paginacaoAlvo.innerHTML = "";
    return;
  }
  if (!lojaCatalogo.decoracoes.length) {
    alvo.innerHTML = '<p class="perfil-vazio">Nenhuma decoração disponível no momento.</p>';
    paginacaoAlvo.innerHTML = "";
    return;
  }

  var lista = ordenarPossuidosPrimeiro(lojaCatalogo.decoracoes, function (d) { return d.sku_id; }, minhaCarteira.decoracoes);
  if (lojaFiltroDecoracoes) {
    var termo = lojaFiltroDecoracoes.toLowerCase();
    lista = lista.filter(function (d) { return (d.nome || "").toLowerCase().indexOf(termo) !== -1; });
  }
  if (!lista.length) {
    alvo.innerHTML = '<p class="perfil-vazio">Nenhuma decoração encontrada pra "' + escapeHtml(lojaFiltroDecoracoes) + '".</p>';
    paginacaoAlvo.innerHTML = "";
    return;
  }
  var totalPaginas = Math.max(1, Math.ceil(lista.length / LOJA_DECORACOES_POR_PAGINA));
  if (lojaPaginaDecoracoes >= totalPaginas) lojaPaginaDecoracoes = totalPaginas - 1;
  var inicio = lojaPaginaDecoracoes * LOJA_DECORACOES_POR_PAGINA;
  var pagina = lista.slice(inicio, inicio + LOJA_DECORACOES_POR_PAGINA);

  alvo.innerHTML = "";
  pagina.forEach(function (item) {
    var possui = minhaCarteira.decoracoes.indexOf(item.sku_id) !== -1;
    var equipada = minhaCarteira.equipado.decoracao === item.sku_id;
    var card = document.createElement("div");
    card.className = "loja-item" + (equipada ? " equipado" : "");
    card.addEventListener("click", function () {
      lojaPreviewDecoracao(item);
      if (possui && !equipada) equiparItem("decoracao", item.sku_id);
    });

    var moldura = document.createElement("span");
    moldura.className = "loja-item-imgbox";
    var imgParada = document.createElement("img");
    imgParada.className = "loja-item-img loja-item-img-parada";
    imgParada.src = item.imagem;
    imgParada.alt = "";
    imgParada.loading = "lazy";
    moldura.appendChild(imgParada);
    if (item.imagem_animada) {
      var imgAnimada = document.createElement("img");
      imgAnimada.className = "loja-item-img loja-item-img-animada";
      imgAnimada.src = item.imagem_animada;
      imgAnimada.alt = "";
      imgAnimada.loading = "lazy";
      moldura.appendChild(imgAnimada);
    }
    if (equipada) moldura.appendChild(lojaBadgeEquipado());
    card.appendChild(moldura);

    var nome = document.createElement("span");
    nome.className = "loja-item-nome";
    nome.textContent = item.nome;
    card.appendChild(nome);

    if (!possui) {
      card.appendChild(lojaBotaoPreco(item.preco || lojaCatalogo.preco_decoracao, possui, equipada, function (ev) {
        ev.stopPropagation();
        lojaPreviewDecoracao(item);
        comprarDecoracao(item.sku_id);
      }));
    }
    alvo.appendChild(card);
  });

  paginacaoAlvo.innerHTML = "";
  if (totalPaginas > 1) {
    var botaoAnterior = document.createElement("button");
    botaoAnterior.className = "botao-copiar";
    botaoAnterior.textContent = "← Anterior";
    botaoAnterior.disabled = lojaPaginaDecoracoes === 0;
    botaoAnterior.addEventListener("click", function () {
      lojaPaginaDecoracoes--;
      renderLojaDecoracoes();
    });
    paginacaoAlvo.appendChild(botaoAnterior);

    var info = document.createElement("span");
    info.className = "loja-paginacao-info";
    info.textContent = "Página " + (lojaPaginaDecoracoes + 1) + " de " + totalPaginas;
    paginacaoAlvo.appendChild(info);

    var botaoProxima = document.createElement("button");
    botaoProxima.className = "botao-copiar";
    botaoProxima.textContent = "Próxima →";
    botaoProxima.disabled = lojaPaginaDecoracoes >= totalPaginas - 1;
    botaoProxima.addEventListener("click", function () {
      lojaPaginaDecoracoes++;
      renderLojaDecoracoes();
    });
    paginacaoAlvo.appendChild(botaoProxima);
  }

  if (minhaCarteira.equipado.decoracao) {
    var limpar = document.createElement("button");
    limpar.className = "botao-copiar";
    limpar.textContent = "Remover decoração";
    limpar.addEventListener("click", function () { equiparItem("decoracao", null); });
    alvo.appendChild(limpar);
  }
}

// ---------------------------------------------------------------------------
// Compra / equipar
// ---------------------------------------------------------------------------
async function comprarDecoracao(skuId) {
  try {
    var resp = await fetch("./economia/comprar/decoracao", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: nomeUsuario(), nick: nomeExibicao(), sku_id: skuId }),
    });
    if (!resp.ok) {
      var erro = await resp.json().catch(function () { return {}; });
      alert(erro.detail || "Não foi possível comprar.");
      return;
    }
    minhaCarteira = await resp.json();
    aplicarCosmeticosHeader();
    lojaAtualizarSaldoTelas();
    renderLojaDecoracoes();
  } catch (e) { alert("Não foi possível comprar agora."); }
}

async function comprarCor(cor) {
  try {
    var resp = await fetch("./economia/comprar/cor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: nomeUsuario(), nick: nomeExibicao(), cor: cor }),
    });
    if (!resp.ok) {
      var erro = await resp.json().catch(function () { return {}; });
      alert(erro.detail || "Não foi possível comprar.");
      return;
    }
    minhaCarteira = await resp.json();
    aplicarCosmeticosHeader();
    lojaAtualizarSaldoTelas();
    renderLojaCores();
  } catch (e) { alert("Não foi possível comprar agora."); }
}

async function equiparItem(tipo, valor) {
  try {
    var resp = await fetch("./economia/equipar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: nomeUsuario(), nick: nomeExibicao(), tipo: tipo, valor: valor }),
    });
    if (!resp.ok) return;
    minhaCarteira = await resp.json();
    aplicarCosmeticosHeader();
    if (tipo === "decoracao") {
      renderLojaDecoracoes();
    } else if (tipo === "fonte_nick") {
      renderLojaFontes();
    } else if (tipo === "skin_splano") {
      renderLojaSkinsSplano();
    } else {
      renderLojaCores();
    }
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Roleta da sorte
// ---------------------------------------------------------------------------
async function carregarRoleta() {
  if (lojaRoletaFatias) return;
  var resp = await fetch("./economia/roleta");
  var dados = await resp.json();
  lojaRoletaFatias = dados.fatias;
  lojaRoletaApostaMinima = dados.aposta_minima;
  lojaRoletaApostaMultiplo = dados.aposta_multiplo;
  lojaRoletaAposta = lojaRoletaApostaMinima;

  var acumulado = 0;
  lojaRoletaAngulos = lojaRoletaFatias.map(function (fatia) {
    var inicio = acumulado;
    var tamanho = (fatia.peso / 100) * 360;
    var fim = acumulado + tamanho;
    acumulado = fim;
    return { inicio: inicio, fim: fim, meio: (inicio + fim) / 2 };
  });

  lojaRoletaRenderLabels();
}

function lojaRoletaRenderLabels() {
  var roda = document.querySelector("#loja-roleta-roda");
  roda.querySelectorAll(".loja-roleta-label").forEach(function (el) { el.remove(); });
  var raio = 88;
  lojaRoletaFatias.forEach(function (fatia, indice) {
    var meio = lojaRoletaAngulos[indice].meio;
    var rad = (meio * Math.PI) / 180;
    var x = raio * Math.sin(rad);
    var y = -raio * Math.cos(rad);
    var label = document.createElement("span");
    label.className = "loja-roleta-label";
    label.style.left = "calc(50% + " + x + "px)";
    label.style.top = "calc(50% + " + y + "px)";
    label.textContent = fatia.tipo === "presente" ? "🎁" : fatia.label;
    roda.appendChild(label);
  });
}

function lojaRoletaAtualizarValor() {
  document.querySelector("#loja-roleta-aposta-valor").textContent = lojaRoletaAposta;
  var botaoMenos = document.querySelector("#loja-roleta-menos");
  var botaoMais = document.querySelector("#loja-roleta-mais");
  var botaoMenos100 = document.querySelector("#loja-roleta-menos100");
  var botaoMais100 = document.querySelector("#loja-roleta-mais100");
  var botaoGirar = document.querySelector("#loja-roleta-girar");
  botaoMenos.disabled = lojaRoletaAposta <= lojaRoletaApostaMinima || lojaRoletaGirando;
  botaoMais.disabled = lojaRoletaAposta + lojaRoletaApostaMultiplo > minhaCarteira.saldo || lojaRoletaGirando;
  botaoMenos100.disabled = lojaRoletaAposta <= lojaRoletaApostaMinima || lojaRoletaGirando;
  botaoMais100.disabled = lojaRoletaAposta + 100 > minhaCarteira.saldo || lojaRoletaGirando;
  botaoGirar.textContent = lojaRoletaGirando ? "Girando..." : "Girar";
  botaoGirar.disabled = lojaRoletaGirando || lojaRoletaAposta > minhaCarteira.saldo || lojaRoletaAposta < lojaRoletaApostaMinima;
  var botaoAllIn = document.querySelector("#loja-roleta-allin");
  var tudo = lojaRoletaApostaMaxima();
  botaoAllIn.disabled = lojaRoletaGirando || tudo < lojaRoletaApostaMinima;
  botaoAllIn.textContent = tudo >= lojaRoletaApostaMinima
    ? "🔥 All-in: apostar " + tudo + " 🪙"
    : "🔥 All-in (sem moedas suficientes)";
}

/* A aposta tem que ser múltipla de lojaRoletaApostaMultiplo, então o all-in é
   o maior múltiplo que cabe no saldo — o troco fica na carteira. */
function lojaRoletaApostaMaxima() {
  var saldo = (minhaCarteira && minhaCarteira.saldo) || 0;
  return saldo - (saldo % lojaRoletaApostaMultiplo);
}

function lojaRoletaAllIn() {
  if (lojaRoletaGirando) return;
  var tudo = lojaRoletaApostaMaxima();
  if (tudo < lojaRoletaApostaMinima) return;
  var troco = ((minhaCarteira && minhaCarteira.saldo) || 0) - tudo;
  var aviso = "Apostar TUDO: " + tudo + " moedas" +
    (troco ? " (sobram " + troco + " que não fecham um múltiplo de " + lojaRoletaApostaMultiplo + ")" : "") +
    ".\n\nSe a roleta cair mal você perde tudo. Tem certeza?";
  if (!confirm(aviso)) return;
  lojaRoletaAposta = tudo;
  lojaRoletaAtualizarValor();
  girarRoleta();
}

function lojaRoletaGirarPara(indice) {
  var roda = document.querySelector("#loja-roleta-roda");
  var meio = lojaRoletaAngulos[indice].meio;
  var voltasExtras = 6;
  var offsetNecessario = (360 - meio) % 360;
  var baseAtual = lojaRoletaRotacaoAtual - (lojaRoletaRotacaoAtual % 360);
  var alvo = baseAtual + voltasExtras * 360 + offsetNecessario;
  if (alvo <= lojaRoletaRotacaoAtual) alvo += 360;
  lojaRoletaRotacaoAtual = alvo;
  roda.style.transition = "transform 4.2s cubic-bezier(0.22, 0.61, 0.36, 1)";
  roda.style.transform = "rotate(" + alvo + "deg)";
}

function lojaRoletaMensagemResultado(dados) {
  var resultado = dados.resultado;
  if (resultado.tipo === "multiplicador") {
    if (resultado.valor > 1) {
      return { texto: "🎉 Caiu " + resultado.label + "! Você ganhou " + dados.premio_moedas + " moedas.", perda: false };
    }
    return { texto: "😬 Caiu " + resultado.label + ". Você recebeu " + dados.premio_moedas + " moedas de volta.", perda: true };
  }
  var presente = dados.presente;
  if (presente) {
    var tipos = { decoracao: "a decoração", cor_nick: "a cor de nick", fonte_nick: "a fonte de nick",
      skin_splano: "a skin do Splano.io" };
    return { texto: "🎁 Presente! Você ganhou " + tipos[presente.tipo] + " \"" + presente.nome + "\" de graça — já está na sua loja.", perda: false };
  }
  return { texto: "🎁 Você já tem tudo da loja! Recebeu " + dados.premio_moedas + " moedas.", perda: false };
}

async function girarRoleta() {
  if (lojaRoletaGirando) return;
  if (lojaRoletaAposta < lojaRoletaApostaMinima || lojaRoletaAposta > minhaCarteira.saldo) return;

  lojaRoletaGirando = true;
  lojaRoletaAtualizarValor();
  var resultadoEl = document.querySelector("#loja-roleta-resultado");
  resultadoEl.textContent = "";
  resultadoEl.className = "loja-roleta-resultado";

  try {
    var resp = await fetch("./economia/roleta/girar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: nomeUsuario(), nick: nomeExibicao(), aposta: lojaRoletaAposta }),
    });
    if (!resp.ok) {
      var erro = await resp.json().catch(function () { return {}; });
      alert(erro.detail || "Não foi possível girar agora.");
      lojaRoletaGirando = false;
      lojaRoletaAtualizarValor();
      return;
    }
    var dados = await resp.json();
    lojaRoletaGirarPara(dados.fatia_indice);

    setTimeout(function () {
      minhaCarteira = dados.carteira;
      lojaAtualizarSaldoTelas();
      var msg = lojaRoletaMensagemResultado(dados);
      resultadoEl.textContent = msg.texto;
      resultadoEl.className = "loja-roleta-resultado" + (msg.perda ? " perda" : "");
      lojaRoletaGirando = false;
      lojaRoletaAtualizarValor();
    }, 4300);
  } catch (e) {
    alert("Não foi possível girar agora.");
    lojaRoletaGirando = false;
    lojaRoletaAtualizarValor();
  }
}

// Bônus de atividade — 5 moedas a cada 15 min; o servidor decide quando pode.
async function tentarBonusAtividade() {
  if (!usuarioDiscord) return;
  try {
    var resp = await fetch("./economia/bonus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: nomeUsuario(), nick: nomeExibicao(), avatar: avatarAtual() || "" }),
    });
    var dados = await resp.json();
    if (dados.creditado) {
      minhaCarteira.saldo = dados.saldo;
      lojaAtualizarSaldoTelas();
    }
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Admin: doar/remover moedas e apagar itens (só aparece pra quem o servidor
// reconhece como admin — o botão em si não dá acesso a nada, o endpoint
// checa o ID de novo).
// ---------------------------------------------------------------------------
var ESTILO_INPUT_ADMIN =
  "width:100%;margin-top:4px;padding:9px;border:1px solid #2d4470;border-radius:8px;" +
  "background:#0d1424;color:#f4f6ff;font-size:14px;box-sizing:border-box;";

function fecharModalAdminDoar() {
  var overlay = document.querySelector("#admin-doar-modal");
  if (overlay) overlay.remove();
}

function abrirModalAdminDoar() {
  fecharModalAdminDoar();

  var overlay = document.createElement("div");
  overlay.id = "admin-doar-modal";
  overlay.className = "rmodal-overlay";
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) fecharModalAdminDoar();
  });

  var card = document.createElement("div");
  card.className = "rmodal-card";
  card.innerHTML =
    '<button class="rmodal-fechar" type="button" aria-label="Fechar">✕</button>' +
    "<h3>💰 Moedas e itens</h3>" +
    '<p style="color:#aeb2c7;font-size:13px;">Digite o ID do jogador pra ver o saldo dele e depois adicione, remova moedas ou apague os itens da loja.</p>' +
    '<label style="display:block;margin-top:10px;">ID do Discord ou @username' +
    '<input id="admin-doar-id" type="text" placeholder="Ex: 1527038915628761110 ou kaizo" style="' + ESTILO_INPUT_ADMIN + '"></label>' +
    '<button id="admin-consultar" type="button" class="botao-copiar" style="margin-top:8px;width:100%;">🔍 Consultar jogador</button>' +
    '<div id="admin-doar-info" style="display:none;margin-top:12px;padding:10px 12px;border:1px solid #26314f;border-radius:10px;background:#0d1424;font-size:13px;color:#c9ccda;"></div>' +
    '<label style="display:block;margin-top:10px;">Quantidade de moedas' +
    '<input id="admin-doar-qtd" type="number" min="1" step="1" value="100" style="' + ESTILO_INPUT_ADMIN + '"></label>' +
    '<div style="display:flex;gap:8px;margin-top:10px;">' +
    '<button id="admin-add" type="button" class="botao-copiar" style="flex:1;">➕ Adicionar</button>' +
    '<button id="admin-rem" type="button" class="botao-copiar" style="flex:1;">➖ Remover</button>' +
    "</div>" +
    '<button id="admin-zerar-saldo" type="button" class="botao-copiar" style="margin-top:8px;width:100%;background:#3a1414;color:#ffc9c9;">💸 Remover TODO o dinheiro</button>' +
    '<button id="admin-limpar-itens" type="button" class="botao-copiar" style="margin-top:8px;width:100%;background:#3a1414;color:#ffc9c9;">🗑️ Remover todos os itens da loja</button>' +
    '<p id="admin-doar-erro" class="mensagem erro" style="display:none;margin-top:8px;"></p>';

  overlay.appendChild(card);
  document.body.appendChild(overlay);
  card.querySelector(".rmodal-fechar").addEventListener("click", fecharModalAdminDoar);
  card.querySelector("#admin-consultar").addEventListener("click", adminConsultar);
  card.querySelector("#admin-add").addEventListener("click", function () { adminAlterar("adicionar"); });
  card.querySelector("#admin-rem").addEventListener("click", function () { adminAlterar("remover"); });
  card.querySelector("#admin-zerar-saldo").addEventListener("click", adminZerarSaldo);
  card.querySelector("#admin-limpar-itens").addEventListener("click", adminLimparItens);
  card.querySelector("#admin-doar-id").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") adminConsultar();
  });
}

function adminErro(texto) {
  var erroEl = document.querySelector("#admin-doar-erro");
  if (!erroEl) return;
  erroEl.textContent = texto || "";
  erroEl.style.display = texto ? "" : "none";
}

function adminAlvo() {
  var idInput = document.querySelector("#admin-doar-id");
  var alvoId = ((idInput && idInput.value) || "").trim();
  if (!alvoId) {
    adminErro("Digite o ID do Discord ou o @username do jogador.");
    return null;
  }
  adminErro("");
  return alvoId;
}

function adminRenderInfo(dados) {
  var info = document.querySelector("#admin-doar-info");
  if (!info) return;
  var itens = dados.itens || {};
  info.style.display = "";
  info.innerHTML =
    "<strong>" + escapeHtml(dados.nick || dados.nome) + "</strong> (" + escapeHtml(dados.nome) + ")<br>" +
    "Saldo: <strong style='color:#ffd36a;'>" + dados.saldo + " moedas</strong><br>" +
    "Itens da loja: <strong style='color:#9dc2ff;'>" + (itens.total || 0) + "</strong> — " +
    (itens.decoracoes || 0) + " decorações, " + (itens.cores_nick || 0) + " cores, " +
    (itens.fontes_nick || 0) + " fontes, " + (itens.skins_splano || 0) + " skins.";
}

async function adminConsultar() {
  var alvoId = adminAlvo();
  if (!alvoId) return;
  try {
    var resp = await fetch("./economia/admin/consultar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ admin_id: usuarioDiscord.id, alvo_id: alvoId }),
    });
    var dados = await resp.json().catch(function () { return {}; });
    if (!resp.ok) {
      adminErro(dados.detail || "Não consegui achar esse jogador.");
      return;
    }
    adminRenderInfo(dados);
  } catch (e) {
    adminErro("Não foi possível consultar agora.");
  }
}

async function adminAlterar(acao) {
  var alvoId = adminAlvo();
  if (!alvoId) return;
  var qtdInput = document.querySelector("#admin-doar-qtd");
  var quantidade = parseInt(qtdInput.value, 10);
  if (!quantidade || quantidade <= 0) {
    adminErro("Digite uma quantidade válida de moedas.");
    return;
  }
  try {
    var resp = await fetch("./economia/admin/doar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ admin_id: usuarioDiscord.id, alvo_id: alvoId,
                             quantidade: quantidade, acao: acao }),
    });
    var dados = await resp.json().catch(function () { return {}; });
    if (!resp.ok) {
      adminErro(dados.detail || "Não foi possível alterar o saldo.");
      return;
    }
    adminRenderInfo(dados);
    if (dados.nome === nomeUsuario()) {
      minhaCarteira.saldo = dados.saldo;
      lojaAtualizarSaldoTelas();
    }
    adminErro("");
  } catch (e) {
    adminErro("Não foi possível alterar o saldo agora.");
  }
}

async function adminZerarSaldo() {
  var alvoId = adminAlvo();
  if (!alvoId) return;
  if (!confirm("Zerar TODO o dinheiro desse jogador? Os itens da loja continuam com ele.")) return;
  try {
    var resp = await fetch("./economia/admin/zerar-saldo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ admin_id: usuarioDiscord.id, alvo_id: alvoId }),
    });
    var dados = await resp.json().catch(function () { return {}; });
    if (!resp.ok) {
      adminErro(dados.detail || "Não consegui zerar o saldo.");
      return;
    }
    adminRenderInfo(dados);
    adminErro("");
    if (dados.nome === nomeUsuario()) await atualizarMoedasHeader();
  } catch (e) {
    adminErro("Não foi possível zerar o saldo agora.");
  }
}

async function adminLimparItens() {
  var alvoId = adminAlvo();
  if (!alvoId) return;
  if (!confirm("Apagar TODOS os itens da loja desse jogador? As moedas ficam na conta.")) return;
  try {
    var resp = await fetch("./economia/admin/limpar-itens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ admin_id: usuarioDiscord.id, alvo_id: alvoId }),
    });
    var dados = await resp.json().catch(function () { return {}; });
    if (!resp.ok) {
      adminErro(dados.detail || "Não consegui apagar os itens.");
      return;
    }
    adminRenderInfo(dados);
    adminErro("");
    if (dados.nome === nomeUsuario()) {
      await atualizarMoedasHeader();
      var telaLoja = document.querySelector("#tela-loja");
      if (telaLoja && telaLoja.classList.contains("ativa")) lojaMostrarMenu();
    }
  } catch (e) {
    adminErro("Não foi possível apagar os itens agora.");
  }
}

document.querySelector("#loja-btn-admin-doar").addEventListener("click", abrirModalAdminDoar);

document.querySelector("#btn-abrir-loja").addEventListener("click", abrirLoja);
document.querySelector("#loja-btn-nametags").addEventListener("click", lojaMostrarSecaoCores);
document.querySelector("#loja-btn-decoracoes").addEventListener("click", lojaMostrarSecaoDecoracoes);
document.querySelector("#loja-decoracoes-busca").addEventListener("input", function (ev) {
  lojaFiltroDecoracoes = ev.target.value.trim();
  lojaPaginaDecoracoes = 0;
  renderLojaDecoracoes();
});
document.querySelector("#loja-btn-fontes").addEventListener("click", lojaMostrarSecaoFontes);
document.querySelector("#loja-btn-skins-splano").addEventListener("click", lojaMostrarSecaoSkinsSplano);
document.querySelector("#loja-skin-imagem-salvar").addEventListener("click", salvarImagemSkinSplano);
document.querySelector("#loja-btn-roleta").addEventListener("click", lojaMostrarSecaoRoleta);
document.querySelectorAll(".loja-sub-voltar").forEach(function (botao) {
  botao.addEventListener("click", lojaMostrarMenu);
});
document.querySelector("#loja-roleta-menos").addEventListener("click", function () {
  if (lojaRoletaAposta - lojaRoletaApostaMultiplo >= lojaRoletaApostaMinima) {
    lojaRoletaAposta -= lojaRoletaApostaMultiplo;
    lojaRoletaAtualizarValor();
  }
});
document.querySelector("#loja-roleta-mais").addEventListener("click", function () {
  if (lojaRoletaAposta + lojaRoletaApostaMultiplo <= minhaCarteira.saldo) {
    lojaRoletaAposta += lojaRoletaApostaMultiplo;
    lojaRoletaAtualizarValor();
  }
});
document.querySelector("#loja-roleta-menos100").addEventListener("click", function () {
  var novo = Math.max(lojaRoletaApostaMinima, lojaRoletaAposta - 100);
  lojaRoletaAposta = novo - (novo % lojaRoletaApostaMultiplo);
  lojaRoletaAtualizarValor();
});
document.querySelector("#loja-roleta-mais100").addEventListener("click", function () {
  var novo = Math.min(minhaCarteira.saldo, lojaRoletaAposta + 100);
  novo -= novo % lojaRoletaApostaMultiplo;
  lojaRoletaAposta = Math.max(lojaRoletaApostaMinima, novo);
  lojaRoletaAtualizarValor();
});
document.querySelector("#loja-roleta-girar").addEventListener("click", girarRoleta);
document.querySelector("#loja-roleta-allin").addEventListener("click", lojaRoletaAllIn);
setInterval(tentarBonusAtividade, 60 * 1000);
setTimeout(tentarBonusAtividade, 5000);
