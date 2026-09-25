// Loja — moedas, decorações de perfil (avatar decoration) e cor do nick.

let lojaCatalogo = null;
let minhaCarteira = { saldo: 0, decoracoes: [], cores_nick: [], equipado: { decoracao: null, cor_nick: null } };
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

function aplicarCosmeticosHeader() {
  var nomeEl = document.querySelector("#auth-nome");
  if (!nomeEl) return;
  nomeEl.classList.remove("nick-arco-iris");
  nomeEl.style.color = "";
  var cor = minhaCarteira.equipado && minhaCarteira.equipado.cor_nick;
  if (cor === "arco-iris") {
    nomeEl.classList.add("nick-arco-iris");
  } else if (cor && LOJA_CORES_HEX[cor]) {
    nomeEl.style.color = LOJA_CORES_HEX[cor];
  }
}

async function carregarCatalogoLoja() {
  var resp = await fetch("./economia/loja");
  lojaCatalogo = await resp.json();
  return lojaCatalogo;
}

async function abrirLoja() {
  mostrarTela(document.querySelector("#tela-loja"));
  await garantirIdentidade();
  await atualizarMoedasHeader();
  await carregarCatalogoLoja();
  renderLoja();
}

function renderLoja() {
  if (!lojaCatalogo) return;
  document.querySelector("#loja-saldo").textContent = minhaCarteira.saldo;
  document.querySelector("#loja-preco-decoracao").textContent = lojaCatalogo.preco_decoracao;
  document.querySelector("#loja-preco-cor").textContent = lojaCatalogo.preco_cor_nick;
  renderLojaDecoracoes();
  renderLojaCores();
}

function lojaBotaoAcao(possui, equipado, preco, aoComprar, aoEquipar) {
  var botao = document.createElement("button");
  botao.className = "botao";
  if (equipado) {
    botao.textContent = "Equipada";
    botao.disabled = true;
  } else if (possui) {
    botao.textContent = "Equipar";
    botao.addEventListener("click", aoEquipar);
  } else {
    botao.textContent = "Comprar (" + preco + ")";
    botao.disabled = minhaCarteira.saldo < preco;
    botao.addEventListener("click", aoComprar);
  }
  return botao;
}

function renderLojaDecoracoes() {
  var alvo = document.querySelector("#loja-decoracoes");
  if (!alvo) return;
  if (!usuarioDiscord) {
    alvo.innerHTML = '<p class="perfil-vazio">Entre com Discord para comprar decorações.</p>';
    return;
  }
  if (!lojaCatalogo.decoracoes.length) {
    alvo.innerHTML = '<p class="perfil-vazio">Nenhuma decoração disponível no momento.</p>';
    return;
  }
  alvo.innerHTML = "";
  lojaCatalogo.decoracoes.forEach(function (item) {
    var possui = minhaCarteira.decoracoes.indexOf(item.sku_id) !== -1;
    var equipada = minhaCarteira.equipado.decoracao === item.sku_id;
    var card = document.createElement("div");
    card.className = "loja-item" + (equipada ? " equipado" : "");
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
    card.appendChild(lojaBotaoAcao(possui, equipada, lojaCatalogo.preco_decoracao,
      function () { comprarDecoracao(item.sku_id); },
      function () { equiparItem("decoracao", item.sku_id); }));
    alvo.appendChild(card);
  });
  if (minhaCarteira.equipado.decoracao) {
    var limpar = document.createElement("button");
    limpar.className = "botao-copiar";
    limpar.textContent = "Remover decoração";
    limpar.addEventListener("click", function () { equiparItem("decoracao", null); });
    alvo.appendChild(limpar);
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
  cores.forEach(function (cor) {
    var possui = minhaCarteira.cores_nick.indexOf(cor) !== -1;
    var equipada = minhaCarteira.equipado.cor_nick === cor;
    var card = document.createElement("div");
    card.className = "loja-item" + (equipada ? " equipado" : "");
    var amostra = document.createElement("span");
    amostra.className = "loja-cor-amostra" + (cor === "arco-iris" ? " nick-arco-iris" : "");
    if (cor !== "arco-iris") amostra.style.background = LOJA_CORES_HEX[cor] || "#fff";
    card.appendChild(amostra);
    var label = document.createElement("span");
    label.className = "loja-item-nome";
    label.textContent = cor === "arco-iris" ? "Arco-íris" : cor.charAt(0).toUpperCase() + cor.slice(1);
    card.appendChild(label);
    card.appendChild(lojaBotaoAcao(possui, equipada, lojaCatalogo.preco_cor_nick,
      function () { comprarCor(cor); },
      function () { equiparItem("cor_nick", cor); }));
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
    document.querySelector("#moedas-valor").textContent = minhaCarteira.saldo;
    renderLoja();
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
    document.querySelector("#moedas-valor").textContent = minhaCarteira.saldo;
    renderLoja();
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
    renderLoja();
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
      var badge = document.querySelector("#moedas-valor");
      if (badge) badge.textContent = dados.saldo;
    }
  } catch (e) { /* ignore */ }
}

document.querySelector("#btn-abrir-loja").addEventListener("click", abrirLoja);
setInterval(tentarBonusAtividade, 60 * 1000);
setTimeout(tentarBonusAtividade, 5000);
