// Splano.io — cliente do jogo de bolinhas. O servidor (/ws/splano) manda o
// estado 20x por segundo; aqui a gente só desenha (interpolando pra ficar
// liso em 60fps) e envia a intenção do jogador (direção, dividir, soltar).

var spWs = null;
var spAtivo = false;
var spArena = 2200;
var spConfig = {};
var spFase = "espera";
var spInfo = {};          // pid -> {nick, avatar, cosmeticos, skin, bot}
var spCelulas = {};       // cid -> {pid, x, y, r, alvoX, alvoY, alvoR, visto}
var spPellets = [];
var spPowerups = [];
var spPlacar = [];
var spEu = { vivo: false, energia: 0, kills: 0, dobro: 0, dobro_x: 1, tempo: 0, vivos: 0 };
var spCamera = { x: 1100, y: 1100, alcance: 700, alvoAlcance: 700, prontoX: false };
var spCameraPidAtual = 0;  // de quem é a câmera agora (0 = eu mesmo)
var spDir = { x: 0, y: 0 };
var spUltimaDir = { x: 0, y: 0, em: 0 };
var spTeclas = {};
var spSoltando = false;
var spCtx = null;
var spCanvas = null;
var spQuadro = null;
var spUltimoQuadro = 0;
var spPingTimer = null;
var spReconectar = null;
var spImagens = {};       // url -> Image (ou false quando falhou)
var spMortes = [];        // avisos "X comeu Y"
var spToque = null;       // joystick do celular
var spUltimoToque = 0;
var spSeguraTimer = null;
var spPronto = false;     // meu voto de "pronto" na votação da sala
var spEspectroPid = 0;    // quem estou assistindo (0 = servidor escolhe)
var spVivosPids = [];     // pids vivos no último estado
var spEspectroChave = ""; // evita remontar o perfil do espectador sem mudar nada
var spEspectadorVisivel = false;

var SP_CORES_ENERGIA = ["#7ef0e0", "#ffd36a", "#ff9ecf", "#a3e635", "#7de8ff"];

// ---------------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------------

// Chamado pela loja quando o jogador equipa outra skin/decoração. A loja é só
// outra tela: o WebSocket do Splano continua aberto, então basta pedir ao
// servidor que releia os cosméticos — ele reenvia a sala pra todo mundo.
function spAvisarCosmeticosMudaram() {
  spEnviar({ tipo: "cosmeticos" });
}

function spEnviar(obj) {
  if (spWs && spWs.readyState === WebSocket.OPEN) {
    spWs.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function spConectar() {
  if (spWs && (spWs.readyState === WebSocket.OPEN || spWs.readyState === WebSocket.CONNECTING)) return;
  var protocolo = location.protocol === "https:" ? "wss:" : "ws:";
  var avatar = avatarAtual();
  var url = protocolo + "//" + location.host + "/ws/splano" +
    "?nome=" + encodeURIComponent(nomeUsuario()) +
    "&nick=" + encodeURIComponent(nomeExibicao()) +
    (avatar ? "&avatar=" + encodeURIComponent(avatar) : "");
  var ws = new WebSocket(url);
  spWs = ws;

  ws.onmessage = function (ev) {
    try { spProcessar(JSON.parse(ev.data)); } catch (e) { console.warn(e); }
  };
  ws.onclose = function () {
    if (ws !== spWs) return;
    spWs = null;
    if (spAtivo) {
      spMensagem("Conexão perdida. Tentando voltar...");
      clearTimeout(spReconectar);
      spReconectar = setTimeout(spConectar, 1500);
    }
  };
  ws.onerror = function () {};
  // Já nasce com a escolha de foto certa (inclusive reconexão no meio da
  // partida, onde a tela de espera não aparece mais).
  ws.onopen = function () {
    spEnviar({ tipo: "opcao", foto: spOpFoto });
  };

  clearInterval(spPingTimer);
  spPingTimer = setInterval(function () { spEnviar({ tipo: "ping" }); }, 20000);
}

function spProcessar(d) {
  switch (d.tipo) {
    case "bem_vindo":
      spArena = d.arena;
      spConfig = d.config || {};
      spMensagem("");
      break;
    case "sala":
      spFase = d.fase;
      spInfo = {};
      (d.jogadores || []).forEach(function (j) { spInfo[j.pid] = j; });
      spEspectroChave = "";
      spAtualizarEspera(d);
      break;
    case "estado":
      spFase = "jogando";
      spReceberEstado(d);
      break;
    case "morte":
      spMortes.push({ texto: d.por ? d.por + " comeu " + d.nick : d.nick + " sumiu da arena",
                      ate: Date.now() + 4000 });
      if (spMortes.length > 4) spMortes.shift();
      break;
    case "fim":
      spFase = "fim";
      spMostrarFim(d);
      break;
    case "erro_fatal":
      spMensagem(d.mensagem || "Erro.");
      spAtivo = false;
      break;
    default:
      break;
  }
}

function spReceberEstado(d) {
  // Trocar de quem se assiste é um corte de câmera, não um passeio: sem o
  // salto a câmera atravessava o mapa devagar até o novo alvo.
  var trocouDeAlvo = spCameraPidAtual !== spEspectroPid;
  spCameraPidAtual = spEspectroPid;

  spCamera.alvoAlcance = d.alcance;
  if (!spCamera.prontoX || trocouDeAlvo) {
    spCamera.x = d.cx;
    spCamera.y = d.cy;
    spCamera.alcance = d.alcance;
    spCamera.prontoX = true;
  }
  spCamera.alvoX = d.cx;
  spCamera.alvoY = d.cy;
  spPellets = d.pellets || [];
  spPowerups = d.powerups || [];
  spPlacar = d.placar || [];
  spVivosPids = d.vivos_pids || [];
  spEu = { vivo: d.vivo, energia: d.energia, kills: d.kills, dobro: d.dobro,
           dobro_x: d.dobro_x || 1, tempo: d.tempo, vivos: d.vivos,
           protegido: d.protegido || 0 };

  if (!spEu.vivo) {
    // Sem escolha válida (mortei agora, ou quem eu seguia morreu): manda
    // um passo na frente e avisa o servidor pra câmera acompanhar.
    if (spVivosPids.indexOf(spEspectroPid) === -1) {
      var escolhido = (d.assistindo && spVivosPids.indexOf(d.assistindo) !== -1)
        ? d.assistindo : spEspectroProximoValido();
      spEspectroPid = escolhido;
      if (escolhido) spEnviar({ tipo: "assistir", pid: escolhido });
    }
  } else {
    spEspectroPid = 0;
  }

  var agora = Date.now();
  (d.celulas || []).forEach(function (c) {
    var cid = c[1];
    var atual = spCelulas[cid];
    if (!atual) {
      atual = spCelulas[cid] = { pid: c[0], x: c[2], y: c[3], r: c[4] };
    }
    atual.pid = c[0];
    atual.alvoX = c[2];
    atual.alvoY = c[3];
    atual.alvoR = c[4];
    atual.visto = agora;
  });
  Object.keys(spCelulas).forEach(function (cid) {
    if (agora - (spCelulas[cid].visto || 0) > 600) delete spCelulas[cid];
  });

  spEsconderPaineis();
  spAtualizarHud();
}

// ---------------------------------------------------------------------------
// Telas auxiliares (espera / fim)
// ---------------------------------------------------------------------------

function spMensagem(texto) {
  var el = document.querySelector("#sp-mensagem");
  if (el) { el.textContent = texto || ""; el.style.display = texto ? "" : "none"; }
}

function spEsconderPaineis() {
  document.querySelector("#sp-espera").style.display = "none";
  document.querySelector("#sp-fim").style.display = "none";
}

function spAtualizarEspera(d) {
  var espera = document.querySelector("#sp-espera");
  var fim = document.querySelector("#sp-fim");
  if (d.fase === "jogando") { espera.style.display = "none"; return; }
  if (d.fase === "fim") return;
  fim.style.display = "none";
  espera.style.display = "";
  spEspectadorMostrar(false);

  var jogadores = d.jogadores || [];
  var humanos = d.humanos || 0;
  var prontos = d.prontos || 0;
  var faltam = Math.max(0, humanos - prontos);
  var contendo = d.fase === "contagem";
  var podeForcar = d.fase !== "contagem" && !!d.pode_forcar;

  document.querySelector("#sp-espera-titulo").textContent =
    contendo ? "Começando em " + d.contagem + "..." : "Votação pra começar";
  document.querySelector("#sp-espera-texto").textContent =
    contendo
      ? "Todo mundo votou pronto! Bots completam a arena até " +
        ((spConfig && spConfig.jogadores) || 20) + " jogadores."
      : (humanos > 1
          ? "A partida só começa quando TODOS marcarem pronto (" +
            prontos + "/" + humanos + " pronto" + (prontos === 1 ? "" : "s") + ")." +
            (faltam > 0 ? " Faltam " + faltam + " pra votar." : "")
          : "Marque pronto pra começar contra os bots — não começa sozinho.");

  var euNome = nomeUsuario();
  var meu = jogadores.filter(function (j) { return !j.bot && j.nome === euNome; })[0];
  spPronto = !!meu && !!meu.pronto;
  var botao = document.querySelector("#sp-pronto");
  botao.textContent = spPronto ? "👍 Pronto! (tocar pra voltar)" : "✅ Estou pronto";
  botao.classList.toggle("sp-pronto-marcado", spPronto);
  var botaoForcar = document.querySelector("#sp-forcar");
  if (botaoForcar) {
    botaoForcar.style.display = podeForcar ? "" : "none";
    botaoForcar.textContent = podeForcar
      ? "⚡ Forçar início (" + (d.prontos || 0) + "/" + (d.total_humanos || 0) + ")"
      : "⚡ Forçar início";
  }

  var lista = document.querySelector("#sp-espera-lista");
  var humanosInfo = jogadores.filter(function (j) { return !j.bot; });
  lista.innerHTML = humanosInfo.map(function (j) {
    return '<div class="sp-espera-item' + (j.pronto ? " pronto" : "") + '">' +
      avatarSalaHtml(j.avatar, j.nick, j.cosmeticos, j.nome) +
      "<span>" + nickHtml(j.nick, j.cosmeticos, j.nome) + "</span>" +
      '<span class="sp-espera-check">' + (j.pronto ? "✅" : "⏳") + "</span></div>";
  }).join("") || '<p class="vazio">Ninguém ainda.</p>';
}

function spMostrarFim(d) {
  var el = document.querySelector("#sp-fim");
  el.style.display = "";
  spEspectadorMostrar(false);
  // Acabou a partida: volta pra janela normal (a opção continua marcada
  // e a tela cheia volta quando ele votar "pronto" de novo).
  spTelaCheiaSair(true);
  var motivos = {
    ultimo: "Sobrou sozinho na arena!",
    ninguem: "Todo mundo se foi...",
    vazio: "Ninguém na sala — partida encerrada.",
    humanos_mortos: "Todos os jogadores morreram. Nova rodada em breve.",
  };
  var campeao = (d.placar || []).find(function (p) { return p.venceu; });
  document.querySelector("#sp-fim-titulo").textContent =
    campeao ? "🏆 " + campeao.nick + " venceu!" : "Fim de partida";
  document.querySelector("#sp-fim-motivo").textContent = motivos[d.motivo] || "";
  document.querySelector("#sp-fim-placar").innerHTML = (d.placar || []).map(function (p, i) {
    return '<div class="sp-fim-linha' + (p.venceu ? " venceu" : "") + '">' +
      '<span class="sp-fim-pos">' + (i + 1) + "º</span>" +
      "<span>" + escapeHtml(p.nick) + (p.bot ? ' <small class="sp-tag-bot">bot</small>' : "") + "</span>" +
      '<span class="sp-fim-num">⚡ ' + p.energia + "</span>" +
      '<span class="sp-fim-num">🍽️ ' + p.kills + "</span>" +
      (p.moedas ? '<span class="sp-fim-moedas">+' + p.moedas + " 🪙</span>" : "<span></span>") +
      "</div>";
  }).join("");
  if (typeof atualizarMoedasHeader === "function") atualizarMoedasHeader();
  spPronto = false;
  spEspectroPid = 0;
}

// ---------------------------------------------------------------------------
// Escolher quem assistir depois de morrer
// ---------------------------------------------------------------------------

function spEspectroVivos() {
  // Humanos e bots, na ordem em que entraram — só quem está vivo dá pra seguir.
  return Object.keys(spInfo).map(Number)
    .filter(function (pid) { return spVivosPids.indexOf(pid) !== -1; })
    .sort(function (a, b) { return a - b; });
}

function spEspectroProximoValido() {
  var vivos = spEspectroVivos();
  if (!vivos.length) return 0;
  if (vivos.indexOf(spEspectroPid) !== -1) return spEspectroPid;
  // O que eu seguia morreu: o próximo vivo depois dele (sem pular tudo).
  for (var i = 0; i < vivos.length; i++) {
    if (vivos[i] > spEspectroPid) return vivos[i];
  }
  return vivos[0];
}

function spEspectroMover(passo) {
  var vivos = spEspectroVivos();
  if (!vivos.length) return;
  var i = vivos.indexOf(spEspectroPid);
  if (i === -1) i = passo > 0 ? 0 : vivos.length - 1;
  else i = (i + passo + vivos.length) % vivos.length;
  spEspectroPid = vivos[i];
  spEnviar({ tipo: "assistir", pid: spEspectroPid });
  spRenderEspectro();
}

function spRenderEspectro() {
  var caixa = document.querySelector("#sp-espectro-perfil");
  if (!caixa) return;
  var info = spInfo[spEspectroPid];
  var vivos = spEspectroVivos();
  var pos = vivos.indexOf(spEspectroPid);
  var chave = spEspectroPid + "/" + vivos.length + "/" + (info ? info.nick : "");
  if (chave === spEspectroChave) return;   // nada mudou: não remonta o HTML 20x por segundo
  spEspectroChave = chave;

  if (!info) {
    caixa.innerHTML = "<span class='sp-espectro-vazio'>Ninguém vivo pra assistir</span>";
  } else {
    // Mesma regra da bolinha: quem desligou a foto não aparece com ela
    // nem no cartão de quem está sendo assistido.
    var verFoto = info.foto !== false;
    var cosmeticosCard = info.cosmeticos || {};
    if (!verFoto) {
      cosmeticosCard = Object.assign({}, cosmeticosCard, { decoracao: null });
    }
    caixa.innerHTML =
      avatarSalaHtml(verFoto ? info.avatar : "", info.nick, cosmeticosCard, info.nome) +
      "<span>" + nickHtml(info.nick, info.cosmeticos, info.nome) + "</span>" +
      (info.bot ? ' <small class="sp-tag-bot">bot</small>' : "");
  }
  var contador = document.querySelector("#sp-espectro-contador");
  if (contador) contador.textContent = vivos.length ? (pos + 1) + "/" + vivos.length : "";
}

function spEspectadorMostrar(sim) {
  var barra = document.querySelector("#sp-espectador");
  if (!barra) return;
  if (spEspectadorVisivel !== sim) {
    spEspectadorVisivel = sim;
    if (sim) spEspectroChave = "";
  }
  barra.style.display = sim ? "" : "none";
  if (sim) spRenderEspectro();
}

function spAtualizarEspectador() {
  spEspectadorMostrar(!spEu.vivo);
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

function spAtualizarHud() {
  document.querySelector("#sp-energia").textContent = spEu.energia;
  document.querySelector("#sp-kills").textContent = spEu.kills;
  document.querySelector("#sp-vivos").textContent = spEu.vivos;
  var minutos = Math.floor(spEu.tempo / 60);
  var segundos = spEu.tempo % 60;
  document.querySelector("#sp-tempo").textContent = minutos + ":" + (segundos < 10 ? "0" : "") + segundos;
  var escudo = document.querySelector("#sp-protegido");
  escudo.style.display = spEu.protegido > 0 && spEu.vivo ? "" : "none";
  escudo.textContent = "🛡️ Protegido (" + Math.ceil(spEu.protegido) + "s)";
  var dobro = document.querySelector("#sp-dobro");
  dobro.style.display = spEu.dobro > 0 ? "" : "none";
  dobro.textContent = (spEu.dobro_x || 1) + "x energia (" + spEu.dobro + "s)";
  spAtualizarEspectador();

  document.querySelector("#sp-placar-lista").innerHTML = spPlacar.map(function (p, i) {
    var info = spInfo[p.pid] || {};
    return '<div class="sp-placar-linha' + (p.vivo ? "" : " morto") + '">' +
      '<span class="sp-placar-pos">' + (i + 1) + "</span>" +
      '<span class="sp-placar-nick">' + escapeHtml(p.nick) +
      (p.bot ? ' <small class="sp-tag-bot">bot</small>' : "") + "</span>" +
      '<span class="sp-placar-energia">' + p.energia + "</span></div>";
  }).join("");
}

// ---------------------------------------------------------------------------
// Imagens (avatar / decoração / skin personalizada)
// ---------------------------------------------------------------------------

function spImagem(url) {
  if (!url) return null;
  if (spImagens[url] !== undefined) return spImagens[url] || null;
  var img = new Image();
  // Sem crossOrigin: a imagem só entra no canvas (nunca lemos os pixels),
  // e muitos hosts não mandam CORS — pedir CORS deixava a skin personalizada
  // falhando e virando uma bolinha cor sólida.
  img.onerror = function () {
    spImagens[url] = false;
    // Volta a tentar daqui a pouco: pode ter sido um tranco de rede.
    setTimeout(function () {
      if (spImagens[url] === false) delete spImagens[url];
    }, 20000);
  };
  img.src = url;
  spImagens[url] = img;
  return img;
}

function spImagemPronta(img) {
  return img && img.complete && img.naturalWidth > 0;
}

// ---------------------------------------------------------------------------
// Desenho
// ---------------------------------------------------------------------------

function spAjustarCanvas() {
  if (!spCanvas) return;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var caixa = spCanvas.parentElement.getBoundingClientRect();
  var largura = Math.max(320, Math.floor(caixa.width));
  var altura = Math.max(260, Math.floor(caixa.height));
  spCanvas.width = Math.floor(largura * dpr);
  spCanvas.height = Math.floor(altura * dpr);
  spCanvas.style.width = largura + "px";
  spCanvas.style.height = altura + "px";
  spCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  spCanvas._l = largura;
  spCanvas._a = altura;
}

function spPreencherSkin(ctx, skin, x, y, r, tempo) {
  var cores = (skin && skin.cores) || ["#3b82f6"];
  var padrao = (skin && skin.padrao) || "solido";

  if (padrao === "imagem") {
    var img = spImagem(urlImagemExterna(skin.imagem));
    if (spImagemPronta(img)) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.clip();
      var lado = r * 2;
      ctx.drawImage(img, x - r, y - r, lado, lado);
      ctx.restore();
      return;
    }
    padrao = "solido";
  }

  if (padrao === "rainbow") {
    var matiz = (tempo / 12 + x + y) % 360;
    var grad = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
    for (var i = 0; i <= 4; i++) {
      grad.addColorStop(i / 4, "hsl(" + ((matiz + i * 70) % 360) + ",85%,58%)");
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = cores[0];
  ctx.fillRect(x - r, y - r, r * 2, r * 2);

  if (padrao === "listras" && cores[1]) {
    ctx.fillStyle = cores[1];
    var alturaFaixa = r / 2.5;
    for (var fy = -r; fy < r; fy += alturaFaixa * 2) {
      ctx.fillRect(x - r, y + fy, r * 2, alturaFaixa);
    }
  } else if (padrao === "vertical" && cores[1]) {
    ctx.fillStyle = cores[1];
    var larguraFaixa = r / 2.5;
    for (var fx = -r; fx < r; fx += larguraFaixa * 2) {
      ctx.fillRect(x + fx, y - r, larguraFaixa, r * 2);
    }
  } else if (padrao === "faixa" && cores[1]) {
    ctx.fillStyle = cores[1];
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-Math.PI / 5);
    ctx.fillRect(-r * 1.6, -r * 0.3, r * 3.2, r * 0.6);
    ctx.restore();
  }
  ctx.restore();
}

function spDesenharCelula(ctx, celula, tempo) {
  var info = spInfo[celula.pid] || {};
  var r = celula.r;
  var x = celula.x;
  var y = celula.y;

  spPreencherSkin(ctx, info.skin, x, y, r, tempo);

  ctx.lineWidth = Math.max(2, r * 0.06);
  ctx.strokeStyle = "rgba(0,0,0,.35)";
  ctx.beginPath();
  ctx.arc(x, y, r - ctx.lineWidth / 2, 0, Math.PI * 2);
  ctx.stroke();

  // Foto do Discord no meio da bola (só quando cabe). Com skin de imagem
  // personalizada ela encolhe, senão tapava a arte que o jogador comprou.
  var arteDeFundo = !!(info.skin && info.skin.padrao === "imagem" &&
    spImagemPronta(spImagem(urlImagemExterna(info.skin.imagem))));
  var raioFoto = r * (arteDeFundo ? 0.44 : 0.62);
  // "Exibir foto de perfil" é decisão de CADA jogador (vem do servidor no
  // payload de jogadores, pra valer pra sala inteira): quem desligou mostra
  // só a arte/cor do círculo, o nick e a cor do nick — sem foto e sem a
  // moldura dela. Bots e quem não mexeu continuam vindo com foto.
  if (raioFoto >= 11 && info.foto !== false) {
    var foto = spImagem(info.avatar);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, raioFoto, 0, Math.PI * 2);
    ctx.clip();
    if (spImagemPronta(foto)) {
      ctx.drawImage(foto, x - raioFoto, y - raioFoto, raioFoto * 2, raioFoto * 2);
    } else {
      ctx.fillStyle = "rgba(10,14,26,.72)";
      ctx.fillRect(x - raioFoto, y - raioFoto, raioFoto * 2, raioFoto * 2);
      ctx.fillStyle = "#9dc2ff";
      ctx.font = "bold " + Math.round(raioFoto * 1.05) + "px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText((info.nick || "?").charAt(0).toUpperCase(), x, y + raioFoto * 0.04);
    }
    ctx.restore();

    var deco = spImagem((info.cosmeticos || {}).decoracao);
    if (spImagemPronta(deco)) {
      var d = raioFoto * 1.24;
      ctx.drawImage(deco, x - d, y - d, d * 2, d * 2);
    }
  }

  // Nick embaixo, na cor comprada na loja.
  var fonte = Math.max(11, Math.min(r * 0.42, 30));
  ctx.font = "bold " + fonte + "px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  var cor = (info.cosmeticos || {}).cor_nick;
  if (cor === "arco-iris") {
    ctx.fillStyle = "hsl(" + ((tempo / 10) % 360) + ",90%,72%)";
  } else {
    ctx.fillStyle = (typeof LOJA_CORES_HEX !== "undefined" && LOJA_CORES_HEX[cor]) || "#ffffff";
  }
  ctx.lineWidth = Math.max(2, fonte * 0.22);
  ctx.strokeStyle = "rgba(0,0,0,.75)";
  ctx.strokeText(info.nick || "?", x, y + r + 4);
  ctx.fillText(info.nick || "?", x, y + r + 4);
}

function spDesenhar(tempo) {
  if (!spCtx || !spCanvas._l) return;
  var ctx = spCtx;
  var L = spCanvas._l;
  var A = spCanvas._a;

  ctx.fillStyle = "#0a0f1c";
  ctx.fillRect(0, 0, L, A);

  var zoom = Math.min(L, A) / (spCamera.alcance * 2);
  ctx.save();
  ctx.translate(L / 2, A / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-spCamera.x, -spCamera.y);

  // Grade de fundo
  var passo = 130;
  ctx.strokeStyle = "rgba(90,120,190,.12)";
  ctx.lineWidth = 1 / zoom;
  var x0 = Math.max(0, spCamera.x - spCamera.alcance);
  var x1 = Math.min(spArena, spCamera.x + spCamera.alcance);
  var y0 = Math.max(0, spCamera.y - spCamera.alcance);
  var y1 = Math.min(spArena, spCamera.y + spCamera.alcance);
  ctx.beginPath();
  for (var gx = Math.floor(x0 / passo) * passo; gx <= x1; gx += passo) {
    ctx.moveTo(gx, y0); ctx.lineTo(gx, y1);
  }
  for (var gy = Math.floor(y0 / passo) * passo; gy <= y1; gy += passo) {
    ctx.moveTo(x0, gy); ctx.lineTo(x1, gy);
  }
  ctx.stroke();

  // Paredes da arena: não matam mais — as bolinhas só deslizam por elas.
  ctx.lineWidth = 12;
  ctx.strokeStyle = "rgba(96,132,214,.5)";
  ctx.strokeRect(0, 0, spArena, spArena);
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(160,196,255,.35)";
  ctx.strokeRect(0, 0, spArena, spArena);

  // Energia espalhada
  spPellets.forEach(function (p) {
    ctx.fillStyle = SP_CORES_ENERGIA[(Math.round(p[0] + p[1])) % SP_CORES_ENERGIA.length];
    ctx.beginPath();
    ctx.arc(p[0], p[1], p[2] > 1 ? 10 : 7, 0, Math.PI * 2);
    ctx.fill();
  });

  // Itens especiais (2x energia / 2x tamanho): bem maiores e brilhantes
  // pra dá pra achar de longe. Nascem em leva e somem em 10s.
  var raioPowerup = (spConfig && spConfig.powerup_raio) || 34;
  spPowerups.forEach(function (p) {
    // p[3] = segundos que ainda faltam: nos últimos 3s o item vai sumindo.
    var restante = typeof p[3] === "number" ? p[3] : 10;
    var some = restante <= 3 ? Math.max(0.15, restante / 3) : 1;
    ctx.save();
    ctx.globalAlpha = some;
    var ehEnergia = p[2] === "energia2x";
    var cor = ehEnergia ? "#ffd36a" : "#ff9ecf";
    var pulso = 1 + Math.sin(tempo / 220) * 0.09;
    var r = raioPowerup * pulso;

    // Halo pulsante ao redor
    ctx.save();
    ctx.globalAlpha = (0.22 + Math.sin(tempo / 300) * 0.1) * some;
    ctx.fillStyle = cor;
    ctx.beginPath();
    ctx.arc(p[0], p[1], r * 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.shadowColor = cor;
    ctx.shadowBlur = 30;
    ctx.fillStyle = cor;
    ctx.beginPath();
    ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(255,255,255,.92)";
    ctx.beginPath();
    ctx.arc(p[0], p[1], r - 2, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = "#1a1330";
    ctx.font = "bold " + Math.round(r * 0.62) + "px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(ehEnergia ? "2E" : "2X", p[0], p[1] + 1);
    ctx.font = "bold " + Math.round(r * 0.42) + "px system-ui, sans-serif";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(10,14,26,.85)";
    ctx.strokeText(ehEnergia ? "2x ENERGIA" : "2x TAMANHO", p[0], p[1] + r * 1.12);
    ctx.fillStyle = cor;
    ctx.fillText(ehEnergia ? "2x ENERGIA" : "2x TAMANHO", p[0], p[1] + r * 1.12);
    ctx.restore();
  });

  // Bolas: menores primeiro pra maior ficar por cima
  Object.keys(spCelulas)
    .map(function (cid) { return spCelulas[cid]; })
    .sort(function (a, b) { return a.r - b.r; })
    .forEach(function (c) { spDesenharCelula(ctx, c, tempo); });

  ctx.restore();

  // Avisos de morte
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = "bold 14px system-ui, sans-serif";
  var agora = Date.now();
  spMortes = spMortes.filter(function (m) { return m.ate > agora; });
  spMortes.forEach(function (m, i) {
    ctx.fillStyle = "rgba(255,180,180," + Math.min(1, (m.ate - agora) / 900) + ")";
    ctx.fillText(m.texto, L / 2, 14 + i * 20);
  });
}

function spLoop(agora) {
  if (!spAtivo) return;
  spQuadro = requestAnimationFrame(spLoop);
  var dt = Math.min(0.1, (agora - spUltimoQuadro) / 1000 || 0.016);
  spUltimoQuadro = agora;

  // Interpolação: puxa o desenhado na direção do que o servidor mandou.
  var suave = Math.min(1, dt * 14);
  Object.keys(spCelulas).forEach(function (cid) {
    var c = spCelulas[cid];
    if (c.alvoX === undefined) return;
    c.x += (c.alvoX - c.x) * suave;
    c.y += (c.alvoY - c.y) * suave;
    c.r += (c.alvoR - c.r) * suave;
  });
  if (spCamera.alvoX !== undefined) {
    spCamera.x += (spCamera.alvoX - spCamera.x) * Math.min(1, dt * 7);
    spCamera.y += (spCamera.alvoY - spCamera.y) * Math.min(1, dt * 7);
  }
  // O zoom também é puxado aos poucos: quem assiste um gigante recebia a
  // mudança de alcance de uma vez e a tela dava um tranco a cada tick.
  if (spCamera.alvoAlcance) {
    spCamera.alcance += (spCamera.alvoAlcance - spCamera.alcance) * Math.min(1, dt * 5);
  }
  spDesenhar(agora);
}

// ---------------------------------------------------------------------------
// Controles
// ---------------------------------------------------------------------------

function spAtualizarDirecaoTeclado() {
  var x = 0, y = 0;
  if (spTeclas.esquerda) x -= 1;
  if (spTeclas.direita) x += 1;
  if (spTeclas.cima) y -= 1;
  if (spTeclas.baixo) y += 1;
  spDefinirDirecao(x, y);
}

function spDefinirDirecao(x, y) {
  var tamanho = Math.hypot(x, y);
  if (tamanho > 0) { x /= tamanho; y /= tamanho; }
  spDir.x = x;
  spDir.y = y;
  var agora = Date.now();
  var mudou = Math.abs(x - spUltimaDir.x) > 0.02 || Math.abs(y - spUltimaDir.y) > 0.02;
  if (mudou && agora - spUltimaDir.em > 60) {
    spUltimaDir = { x: x, y: y, em: agora };
    spEnviar({ tipo: "dir", x: x, y: y });
  }
}

var SP_TECLAS = {
  KeyW: "cima", ArrowUp: "cima",
  KeyS: "baixo", ArrowDown: "baixo",
  KeyA: "esquerda", ArrowLeft: "esquerda",
  KeyD: "direita", ArrowRight: "direita",
};

function spTeclaBaixo(ev) {
  if (!spAtivo) return;
  // Morto: as setinhas viram "quem estou assistindo".
  if (spFase === "jogando" && !spEu.vivo) {
    if (ev.code === "ArrowLeft") {
      ev.preventDefault();
      spEspectroMover(-1);
      return;
    }
    if (ev.code === "ArrowRight") {
      ev.preventDefault();
      spEspectroMover(1);
      return;
    }
  }
  var acao = SP_TECLAS[ev.code];
  if (acao) {
    ev.preventDefault();
    spTeclas[acao] = true;
    spAtualizarDirecaoTeclado();
  } else if (ev.code === "Space") {
    ev.preventDefault();
    spEnviar({ tipo: "dividir" });
  } else if (ev.code === "ShiftLeft" || ev.code === "ShiftRight") {
    if (!spSoltando) { spSoltando = true; spEnviar({ tipo: "soltar", ativo: true }); }
  }
}

function spTeclaCima(ev) {
  if (!spAtivo) return;
  var acao = SP_TECLAS[ev.code];
  if (acao) {
    spTeclas[acao] = false;
    spAtualizarDirecaoTeclado();
  } else if (ev.code === "ShiftLeft" || ev.code === "ShiftRight") {
    spSoltando = false;
    spEnviar({ tipo: "soltar", ativo: false });
  }
}

function spPararDeSoltar() {
  clearTimeout(spSeguraTimer);
  if (spSoltando) {
    spSoltando = false;
    spEnviar({ tipo: "soltar", ativo: false });
  }
}

function spComecarSegurar() {
  clearTimeout(spSeguraTimer);
  spSeguraTimer = setTimeout(function () {
    spSoltando = true;
    spEnviar({ tipo: "soltar", ativo: true });
  }, 260);
}

function spLigarControles() {
  document.addEventListener("keydown", spTeclaBaixo);
  document.addEventListener("keyup", spTeclaCima);

  // Mouse: segurar = soltar energia, dois cliques = dividir.
  spCanvas.addEventListener("mousedown", function (ev) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    spComecarSegurar();
  });
  window.addEventListener("mouseup", spPararDeSoltar);
  spCanvas.addEventListener("dblclick", function (ev) {
    ev.preventDefault();
    spPararDeSoltar();
    spEnviar({ tipo: "dividir" });
  });

  // Toque: arrastar = direção (joystick), toque parado = soltar energia,
  // dois toques rápidos = dividir.
  spCanvas.addEventListener("touchstart", function (ev) {
    ev.preventDefault();
    var t = ev.touches[0];
    spToque = { x0: t.clientX, y0: t.clientY, moveu: false };
    var agora = Date.now();
    if (agora - spUltimoToque < 300) {
      spUltimoToque = 0;
      spEnviar({ tipo: "dividir" });
    } else {
      spUltimoToque = agora;
      spComecarSegurar();
    }
  }, { passive: false });

  spCanvas.addEventListener("touchmove", function (ev) {
    ev.preventDefault();
    if (!spToque) return;
    var t = ev.touches[0];
    var dx = t.clientX - spToque.x0;
    var dy = t.clientY - spToque.y0;
    if (Math.hypot(dx, dy) > 14) {
      spToque.moveu = true;
      spPararDeSoltar();
      spDefinirDirecao(dx, dy);
    }
  }, { passive: false });

  spCanvas.addEventListener("touchend", function (ev) {
    ev.preventDefault();
    spPararDeSoltar();
    spToque = null;
  }, { passive: false });

  window.addEventListener("resize", spAjustarCanvas);
}

// ---------------------------------------------------------------------------
// Opções da tela de espera: tela cheia e exibir foto de perfil
// ---------------------------------------------------------------------------

var spOpTelacheia = true;      // lembradas entre partidas (localStorage)
var spOpFoto = true;
var spTelaCheiaNativa = false; // entrou pelo Fullscreen do navegador
var spTelaCheiaCss = false;    // overlay fixo (iframe do Discord / iOS)
var spTelaCheiaPedido = 0;     // cancela a entrada se o jogador desmarcou

function spOpcoesCarregar() {
  try {
    spOpTelacheia = localStorage.getItem("splano:telaCheia") !== "0";
    spOpFoto = localStorage.getItem("splano:foto") !== "0";
  } catch (e) { /* sem localStorage: fica no padrão */ }
  spOpcoesSincronizar();
}

function spOpcoesSalvar() {
  try {
    localStorage.setItem("splano:telaCheia", spOpTelacheia ? "1" : "0");
    localStorage.setItem("splano:foto", spOpFoto ? "1" : "0");
  } catch (e) { /* sem localStorage: vale só nesta sessão */ }
}

function spOpcoesSincronizar() {
  var telacheia = document.querySelector("#sp-op-telacheia");
  var foto = document.querySelector("#sp-op-foto");
  if (telacheia) telacheia.checked = spOpTelacheia;
  if (foto) foto.checked = spOpFoto;
}

function spTelaCheiaAtiva() { return spTelaCheiaNativa || spTelaCheiaCss; }

function spTelaCheiaBotao() {
  var botao = document.querySelector("#sp-sair-tela-cheia");
  if (botao) botao.style.display = spTelaCheiaAtiva() ? "" : "none";
}

function spTelaCheiaEntrar() {
  var arena = document.querySelector("#tela-splano .sp-arena");
  if (!arena) return;
  spOpTelacheia = true;
  spOpcoesSalvar();
  if (spTelaCheiaAtiva()) { spTelaCheiaBotao(); return; }
  var pedido = ++spTelaCheiaPedido;
  try {
    if (typeof arena.requestFullscreen === "function") {
      var promessa = arena.requestFullscreen({ navigationUI: "hide" });
      if (promessa && typeof promessa.catch === "function") promessa.catch(function () {});
    } else if (typeof arena.webkitRequestFullscreen === "function") {
      arena.webkitRequestFullscreen();
    }
  } catch (e) { /* sem API de tela cheia: cai no overlay */ }
  // O navegador/Iframe pode negar (ou nem existir a API, como no iOS):
  // se em 350ms não entrou de verdade, a arena vira overlay fixo.
  setTimeout(function () {
    if (pedido !== spTelaCheiaPedido || !spOpTelacheia || spTelaCheiaAtiva()) return;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      spTelaCheiaNativa = true;
      setTimeout(spAjustarCanvas, 80);
    } else {
      arena.classList.add("sp-tela-cheia");
      spTelaCheiaCss = true;
      spAjustarCanvas();
    }
    spTelaCheiaBotao();
  }, 350);
}

function spTelaCheiaSair(manterOpcao) {
  spTelaCheiaPedido++;   // desiste de entrar, se a entrada estava pendente
  if (!manterOpcao) {
    spOpTelacheia = false;
    spOpcoesSalvar();
    spOpcoesSincronizar();
  }
  var arena = document.querySelector("#tela-splano .sp-arena");
  if (spTelaCheiaCss) {
    if (arena) arena.classList.remove("sp-tela-cheia");
    spTelaCheiaCss = false;
    setTimeout(spAjustarCanvas, 30);
  }
  if (spTelaCheiaNativa) {
    spTelaCheiaNativa = false;
    try {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } catch (e) { /* ignore */ }
    setTimeout(spAjustarCanvas, 80);
  }
  spTelaCheiaBotao();
}

// ---------------------------------------------------------------------------
// Abrir / sair
// ---------------------------------------------------------------------------

async function abrirSplano() {
  await garantirIdentidade();
  mostrarTela(document.querySelector("#tela-splano"));
  if (ehAnonimoNick(nomeExibicao()) || !usuarioDiscord) {
    spMensagem("Entre com Discord para jogar Splano.io.");
    return;
  }
  spAtivo = true;
  spCanvas = document.querySelector("#sp-canvas");
  spCtx = spCanvas.getContext("2d");
  spAjustarCanvas();
  spEsconderPaineis();
  document.querySelector("#sp-espera").style.display = "";
  spEspectadorMostrar(false);
  spCelulas = {};
  spVivosPids = [];
  spEspectroPid = 0;
  spPronto = false;
  spCamera.prontoX = false;
  spConectar();
  // Leva a arena pra vista: em notebook a tela do jogo fica abaixo da dobra.
  setTimeout(function () {
    var arena = document.querySelector(".sp-arena");
    if (arena && arena.scrollIntoView) arena.scrollIntoView({ block: "center", behavior: "smooth" });
  }, 60);
  cancelAnimationFrame(spQuadro);
  spUltimoQuadro = performance.now();
  spQuadro = requestAnimationFrame(spLoop);
}

function spSair() {
  spAtivo = false;
  spTelaCheiaSair(true);   // sai da tela cheia mas guarda a preferência
  cancelAnimationFrame(spQuadro);
  clearInterval(spPingTimer);
  clearTimeout(spReconectar);
  clearTimeout(spSeguraTimer);
  spTeclas = {};
  spSoltando = false;
  spPronto = false;
  spEspectroPid = 0;
  spVivosPids = [];
  if (spWs) {
    var ws = spWs;
    spWs = null;
    try { ws.close(); } catch (e) { /* ignore */ }
  }
  mostrarTela(document.querySelector("#tela-jogos"));
}

(function () {
  var card = document.querySelector("#jogo-splano");
  if (!card) return;
  card.addEventListener("click", abrirSplano);
  document.querySelector("#voltar-splano").addEventListener("click", spSair);
  spCanvas = document.querySelector("#sp-canvas");
  spCtx = spCanvas.getContext("2d");
  spLigarControles();
  document.querySelector("#sp-dividir").addEventListener("click", function () {
    spEnviar({ tipo: "dividir" });
  });
  document.querySelector("#sp-pronto").addEventListener("click", function () {
    spPronto = !spPronto;
    spEnviar({ tipo: "pronto", ativo: spPronto, foto: spOpFoto });
    // O clique é gesto do usuário: é o momento certo pra pedir tela cheia.
    if (spPronto && spOpTelacheia && !spTelaCheiaAtiva()) spTelaCheiaEntrar();
  });
  document.querySelector("#sp-forcar").addEventListener("click", function () {
    spEnviar({ tipo: "forcar_inicio" });
  });
  // Preferências da tela de espera (tela cheia e foto de perfil).
  spOpcoesCarregar();
  var chkTelacheia = document.querySelector("#sp-op-telacheia");
  if (chkTelacheia) {
    chkTelacheia.addEventListener("change", function () {
      if (chkTelacheia.checked) spTelaCheiaEntrar();
      else spTelaCheiaSair(false);
    });
  }
  var chkFoto = document.querySelector("#sp-op-foto");
  if (chkFoto) {
    chkFoto.addEventListener("change", function () {
      spOpFoto = chkFoto.checked;
      spOpcoesSalvar();
      // Vale pra sala inteira: manda agora, sem esperar o voto "pronto".
      spEnviar({ tipo: "opcao", foto: spOpFoto });
    });
  }
  var botaoSairTelaCheia = document.querySelector("#sp-sair-tela-cheia");
  if (botaoSairTelaCheia) {
    botaoSairTelaCheia.addEventListener("click", function () { spTelaCheiaSair(false); });
  }
  // Apertou Esc (ou o navegador saiu sozinho): desmarca a opção também.
  document.addEventListener("fullscreenchange", function () {
    if (spTelaCheiaNativa && !document.fullscreenElement) {
      spTelaCheiaNativa = false;
      spOpTelacheia = false;
      spOpcoesSalvar();
      spOpcoesSincronizar();
      spTelaCheiaBotao();
      setTimeout(spAjustarCanvas, 80);
    }
  });
  document.querySelector("#sp-espectro-anterior").addEventListener("click", function () {
    spEspectroMover(-1);
  });
  document.querySelector("#sp-espectro-proximo").addEventListener("click", function () {
    spEspectroMover(1);
  });
  var botaoSoltar = document.querySelector("#sp-soltar");
  ["mousedown", "touchstart"].forEach(function (evento) {
    botaoSoltar.addEventListener(evento, function (ev) {
      ev.preventDefault();
      spSoltando = true;
      spEnviar({ tipo: "soltar", ativo: true });
    }, { passive: false });
  });
  ["mouseup", "mouseleave", "touchend"].forEach(function (evento) {
    botaoSoltar.addEventListener(evento, spPararDeSoltar);
  });
})();
