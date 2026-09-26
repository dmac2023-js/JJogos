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
      "&avatar=" + encodeURIComponent(avatarAtual() || "");
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
  ["#loja-menu", "#loja-secao-cores", "#loja-secao-fontes", "#loja-secao-decoracoes", "#loja-secao-roleta"].forEach(function (sel) {
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
  document.querySelector("#loja-preco-decoracao").textContent = lojaCatalogo.preco_decoracao;
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
      card.appendChild(lojaBotaoPreco(lojaCatalogo.preco_decoracao, possui, equipada, function (ev) {
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
  var botaoGirar = document.querySelector("#loja-roleta-girar");
  botaoMenos.disabled = lojaRoletaAposta <= lojaRoletaApostaMinima || lojaRoletaGirando;
  botaoMais.disabled = lojaRoletaAposta + lojaRoletaApostaMultiplo > minhaCarteira.saldo || lojaRoletaGirando;
  botaoGirar.textContent = lojaRoletaGirando ? "Girando..." : "Girar";
  botaoGirar.disabled = lojaRoletaGirando || lojaRoletaAposta > minhaCarteira.saldo || lojaRoletaAposta < lojaRoletaApostaMinima;
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
    var tipos = { decoracao: "a decoração", cor_nick: "a cor de nick", fonte_nick: "a fonte de nick" };
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

document.querySelector("#btn-abrir-loja").addEventListener("click", abrirLoja);
document.querySelector("#loja-btn-nametags").addEventListener("click", lojaMostrarSecaoCores);
document.querySelector("#loja-btn-decoracoes").addEventListener("click", lojaMostrarSecaoDecoracoes);
document.querySelector("#loja-btn-fontes").addEventListener("click", lojaMostrarSecaoFontes);
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
document.querySelector("#loja-roleta-girar").addEventListener("click", girarRoleta);
setInterval(tentarBonusAtividade, 60 * 1000);
setTimeout(tentarBonusAtividade, 5000);
