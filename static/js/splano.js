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
var spEu = { vivo: false, energia: 0, kills: 0, dobro: 0, restante: 0, vivos: 0 };
var spCamera = { x: 1100, y: 1100, alcance: 700, prontoX: false };
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

var SP_CORES_ENERGIA = ["#7ef0e0", "#ffd36a", "#ff9ecf", "#a3e635", "#7de8ff"];

// ---------------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------------

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
      spAtualizarEspera(d);
      break;
    case "estado":
      spFase = "jogando";
      spReceberEstado(d);
      break;
    case "morte":
      spMortes.push({ texto: d.por ? d.por + " comeu " + d.nick : d.nick + " bateu na borda",
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
  spCamera.alcance = d.alcance;
  if (!spCamera.prontoX) {
    spCamera.x = d.cx;
    spCamera.y = d.cy;
    spCamera.prontoX = true;
  }
  spCamera.alvoX = d.cx;
  spCamera.alvoY = d.cy;
  spPellets = d.pellets || [];
  spPowerups = d.powerups || [];
  spPlacar = d.placar || [];
  spEu = { vivo: d.vivo, energia: d.energia, kills: d.kills, dobro: d.dobro,
           restante: d.restante, vivos: d.vivos, protegido: d.protegido || 0 };

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
  var humanos = d.humanos || 0;
  var faltam = Math.max(0, (d.humanos_necessarios || 2) - humanos);
  document.querySelector("#sp-espera-titulo").textContent =
    d.fase === "contagem" ? "Começando em " + d.contagem + "..." : "Esperando jogadores";
  document.querySelector("#sp-espera-texto").textContent =
    d.fase === "contagem"
      ? "Prepare-se! Bots entram pra completar a arena."
      : (faltam > 0
          ? "Precisa de mais " + faltam + " jogador" + (faltam > 1 ? "es" : "") +
            " pra começar (" + humanos + "/" + (d.humanos_necessarios || 2) + ")."
          : "Montando a partida...");
  var lista = document.querySelector("#sp-espera-lista");
  var humanosInfo = (d.jogadores || []).filter(function (j) { return !j.bot; });
  lista.innerHTML = humanosInfo.map(function (j) {
    return '<div class="sp-espera-item">' + avatarSalaHtml(j.avatar, j.nick, j.cosmeticos, j.nome) +
      "<span>" + nickHtml(j.nick, j.cosmeticos, j.nome) + "</span></div>";
  }).join("") || '<p class="vazio">Ninguém ainda.</p>';
}

function spMostrarFim(d) {
  var el = document.querySelector("#sp-fim");
  el.style.display = "";
  var motivos = {
    ultimo: "Sobrou sozinho na arena!",
    arena: "Tomou conta da arena inteira!",
    tempo: "Acabou o tempo — venceu quem tinha mais energia.",
    ninguem: "Todo mundo se foi...",
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
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

function spAtualizarHud() {
  document.querySelector("#sp-energia").textContent = spEu.energia;
  document.querySelector("#sp-kills").textContent = spEu.kills;
  document.querySelector("#sp-vivos").textContent = spEu.vivos;
  var minutos = Math.floor(spEu.restante / 60);
  var segundos = spEu.restante % 60;
  document.querySelector("#sp-tempo").textContent = minutos + ":" + (segundos < 10 ? "0" : "") + segundos;
  var escudo = document.querySelector("#sp-protegido");
  escudo.style.display = spEu.protegido > 0 && spEu.vivo ? "" : "none";
  escudo.textContent = "🛡️ Protegido (" + Math.ceil(spEu.protegido) + "s)";
  var dobro = document.querySelector("#sp-dobro");
  dobro.style.display = spEu.dobro > 0 ? "" : "none";
  dobro.textContent = "2x energia (" + spEu.dobro + "s)";
  document.querySelector("#sp-morreu").style.display = spEu.vivo ? "none" : "";

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
  img.crossOrigin = "anonymous";
  img.onerror = function () { spImagens[url] = false; };
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
    var img = spImagem(skin.imagem);
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

  // Foto do Discord no meio da bola (só quando cabe).
  var raioFoto = r * 0.62;
  if (raioFoto >= 11) {
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

  // Borda mortal
  ctx.lineWidth = 10;
  ctx.strokeStyle = "rgba(255,90,90,.85)";
  ctx.setLineDash([26, 18]);
  ctx.lineDashOffset = -(tempo / 22);
  ctx.strokeRect(0, 0, spArena, spArena);
  ctx.setLineDash([]);

  // Energia espalhada
  spPellets.forEach(function (p) {
    ctx.fillStyle = SP_CORES_ENERGIA[(Math.round(p[0] + p[1])) % SP_CORES_ENERGIA.length];
    ctx.beginPath();
    ctx.arc(p[0], p[1], p[2] > 1 ? 10 : 7, 0, Math.PI * 2);
    ctx.fill();
  });

  // Itens especiais
  spPowerups.forEach(function (p) {
    var pulso = 1 + Math.sin(tempo / 180) * 0.12;
    var r = 20 * pulso;
    ctx.save();
    ctx.shadowColor = p[2] === "energia2x" ? "#ffd36a" : "#ff9ecf";
    ctx.shadowBlur = 18;
    ctx.fillStyle = p[2] === "energia2x" ? "#ffd36a" : "#ff9ecf";
    ctx.beginPath();
    ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = "#1a1330";
    ctx.font = "bold 18px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(p[2] === "energia2x" ? "2E" : "2X", p[0], p[1] + 1);
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
  spCelulas = {};
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
  cancelAnimationFrame(spQuadro);
  clearInterval(spPingTimer);
  clearTimeout(spReconectar);
  clearTimeout(spSeguraTimer);
  spTeclas = {};
  spSoltando = false;
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
