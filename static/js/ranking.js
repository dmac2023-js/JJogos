// Ranking global — top moedas e top horas jogadas.

var rankingDados = null;
var rankingTabAtiva = "moedas";

function formatarHoras(seg) {
  if (!seg || seg < 60) return (seg || 0) + "s";
  var min = Math.floor(seg / 60);
  if (min < 60) return min + " min";
  var h = Math.floor(min / 60);
  var m = min % 60;
  return h + "h" + (m > 0 ? " " + m + "min" : "");
}

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
    var linha = document.createElement("div");
    linha.className = "ranking-linha" + (i < 3 ? " ranking-top" + (i + 1) : "");

    var posHtml = '<span class="ranking-pos">' + (medalhas[i] || "#" + (i + 1)) + "</span>";

    var cor = (typeof LOJA_CORES_HEX !== "undefined" && LOJA_CORES_HEX[jogador.cor_nick]) || null;
    var corEstilo = cor ? ' style="color:' + cor + '"' : "";
    var corClasse = jogador.cor_nick === "arco-iris" ? ' class="ranking-nick nick-arco-iris"' : ' class="ranking-nick"';
    var nickHtml = "<span" + corClasse + corEstilo + ">" + escapeHtml(jogador.nick || jogador.nome || "?") + "</span>";

    var valorHtml;
    if (rankingTabAtiva === "moedas") {
      valorHtml = '<span class="ranking-valor"><span class="loja-moeda-icone">🪙</span> ' + (jogador.saldo || 0).toLocaleString("pt-BR") + "</span>";
    } else {
      valorHtml = '<span class="ranking-valor">⏱ ' + formatarHoras(jogador.segundos || 0) + "</span>";
    }

    linha.innerHTML = posHtml + nickHtml + valorHtml;
    tabela.appendChild(linha);
  });
  lista.appendChild(tabela);
}

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
})();
