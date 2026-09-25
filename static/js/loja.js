// Loja — moedas, decorações de perfil (avatar decoration) e cor do nick (nametag).

let lojaCatalogo = null;
let minhaCarteira = { saldo: 0, decoracoes: [], cores_nick: [], equipado: { decoracao: null, cor_nick: null } };
let lojaPaginaDecoracoes = 0;
let lojaCorSelecionada = null;
let lojaDecoracaoSelecionadaSku = null;
const LOJA_DECORACOES_POR_PAGINA = 12;
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
    var params = "nome=" + encodeURIComponent(nomeUsuario()) + "&nick=" + encodeURIComponent(nomeExibicao());
    var resp = await fetch("./economia/carteira?" + params);
    minhaCarteira = await resp.json();
    if (badge) badge.textContent = minhaCarteira.saldo;
    aplicarCosmeticosHeader();
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

function aplicarCosmeticosHeader() {
  var nomeEl = document.querySelector("#auth-nome");
  if (!nomeEl) return;
  aplicarCorEmElemento(nomeEl, minhaCarteira.equipado && minhaCarteira.equipado.cor_nick);
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
function lojaMostrarMenu() {
  document.querySelector("#loja-menu").style.display = "";
  document.querySelector("#loja-secao-cores").style.display = "none";
  document.querySelector("#loja-secao-decoracoes").style.display = "none";
}

function lojaMostrarSecaoCores() {
  document.querySelector("#loja-menu").style.display = "none";
  document.querySelector("#loja-secao-cores").style.display = "";
  document.querySelector("#loja-secao-decoracoes").style.display = "none";
  renderLojaCores();
}

function lojaMostrarSecaoDecoracoes() {
  document.querySelector("#loja-menu").style.display = "none";
  document.querySelector("#loja-secao-cores").style.display = "none";
  document.querySelector("#loja-secao-decoracoes").style.display = "";
  renderLojaDecoracoes();
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
  document.querySelector("#loja-preco-decoracao").textContent = lojaCatalogo.preco_decoracao;
  document.querySelector("#loja-preco-cor").textContent = lojaCatalogo.preco_cor_nick;
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
  aplicarCorEmElemento(texto, cor);
  caixa.style.display = "";
}

async function lojaCliqueCor(cor) {
  var possui = minhaCarteira.cores_nick.indexOf(cor) !== -1;
  var equipada = minhaCarteira.equipado.cor_nick === cor;
  if (equipada) return;
  if (!possui) {
    await comprarCor(cor);
  } else {
    await equiparItem("cor_nick", cor);
  }
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
    card.addEventListener("click", function () { lojaPreviewCor(cor); });

    var amostra = document.createElement("span");
    amostra.className = "loja-cor-amostra" + (cor === "arco-iris" ? " nick-arco-iris" : "");
    if (cor !== "arco-iris") amostra.style.background = LOJA_CORES_HEX[cor] || "#fff";
    card.appendChild(amostra);

    var label = document.createElement("span");
    label.className = "loja-item-nome";
    label.textContent = cor === "arco-iris" ? "Arco-íris" : cor.charAt(0).toUpperCase() + cor.slice(1);
    card.appendChild(label);

    card.appendChild(lojaBotaoPreco(lojaCatalogo.preco_cor_nick, possui, equipada, function (ev) {
      ev.stopPropagation();
      lojaPreviewCor(cor);
      lojaCliqueCor(cor);
    }));
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

async function lojaCliqueDecoracao(item) {
  var possui = minhaCarteira.decoracoes.indexOf(item.sku_id) !== -1;
  var equipada = minhaCarteira.equipado.decoracao === item.sku_id;
  if (equipada) return;
  if (!possui) {
    await comprarDecoracao(item.sku_id);
  } else {
    await equiparItem("decoracao", item.sku_id);
  }
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
    card.addEventListener("click", function () { lojaPreviewDecoracao(item); });

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
    card.appendChild(moldura);

    var nome = document.createElement("span");
    nome.className = "loja-item-nome";
    nome.textContent = item.nome;
    card.appendChild(nome);

    card.appendChild(lojaBotaoPreco(lojaCatalogo.preco_decoracao, possui, equipada, function (ev) {
      ev.stopPropagation();
      lojaPreviewDecoracao(item);
      lojaCliqueDecoracao(item);
    }));
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
    lojaPaginaDecoracoes = 0;
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
      lojaPaginaDecoracoes = 0;
      renderLojaDecoracoes();
    } else {
      renderLojaCores();
    }
  } catch (e) { /* ignore */ }
}

// Bônus de atividade — 5 moedas a cada 15 min; o servidor decide quando pode.
async function tentarBonusAtividade() {
  if (!usuarioDiscord) return;
  try {
    var resp = await fetch("./economia/bonus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: nomeUsuario(), nick: nomeExibicao() }),
    });
    var dados = await resp.json();
    if (dados.creditado) {
      minhaCarteira.saldo = dados.saldo;
      lojaAtualizarSaldoTelas();
    }
  } catch (e) { /* ignore */ }
}

document.querySelector("#btn-abrir-loja").addEventListener("click", abrirLoja);
document.querySelector("#loja-btn-nametags").addEventListener("click", lojaMostrarSecaoCores);
document.querySelector("#loja-btn-decoracoes").addEventListener("click", lojaMostrarSecaoDecoracoes);
document.querySelectorAll(".loja-sub-voltar").forEach(function (botao) {
  botao.addEventListener("click", lojaMostrarMenu);
});
setInterval(tentarBonusAtividade, 60 * 1000);
setTimeout(tentarBonusAtividade, 5000);
