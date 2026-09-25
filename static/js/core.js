// Core — estado e utilidades compartilhadas por todos os jogos
// (identidade Discord, navegação entre telas, lobby, login, perfil-trigger).

// ---------------------------------------------------------------------------
// Estado global
// ---------------------------------------------------------------------------

let usuarioDiscord = null;
let discordSdkGlobal = null;

const elementoStatus = document.querySelector("#status-discord");

const todasTelas = document.querySelectorAll(".tela");
const nomesDificuldade = { facil: "Fácil", medio: "Médio", dificil: "Difícil" };


// ---------------------------------------------------------------------------
// Identidade Discord (site OAuth + Activity SDK) — evita "Anônimo" por corrida
// ---------------------------------------------------------------------------
var conexaoDiscordPromise = null;

function escapeHtml(texto) {
  return String(texto == null ? "" : texto)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function nomeExibicao() {
  if (!usuarioDiscord) return "Anônimo";
  return usuarioDiscord.global_name || usuarioDiscord.username;
}

function nomeUsuario() {
  return usuarioDiscord ? usuarioDiscord.username : "Anônimo";
}

function avatarAtual() {
  if (!usuarioDiscord) return null;
  try { return avatarUrlDiscord(usuarioDiscord); } catch (e) { return null; }
}

/** Espera a identidade (OAuth no site, SDK na Activity) antes de criar sala.
 *  Timeout curto: na Activity o SDK pode demorar — nunca trava o botão. */
async function garantirIdentidade() {
  if (usuarioDiscord) return usuarioDiscord;
  try {
    var cru = localStorage.getItem("usuario-discord");
    if (cru) {
      await Promise.race([
        restaurarSessaoDiscord(),
        new Promise(function (r) { setTimeout(r, 1200); }),
      ]);
      if (usuarioDiscord) return usuarioDiscord;
    }
  } catch (e) { /* ignore */ }
  if (dentroDaActivity()) {
    // OAuth completo (authorize+token+@me) pode levar ~2-4s — dá tempo real.
    for (var i = 0; i < 3 && !usuarioDiscord; i++) {
      try {
        await Promise.race([
          conectarAoDiscord(),
          new Promise(function (r) { setTimeout(r, 4000); }),
        ]);
      } catch (e) { /* segue sem identidade */ }
      if (!usuarioDiscord) {
        await new Promise(function (r) { setTimeout(r, 250); });
      }
    }
  }
  return usuarioDiscord;
}

// ---------------------------------------------------------------------------

// Navegação entre telas
// ---------------------------------------------------------------------------
function mostrarTela(tela) {
  todasTelas.forEach((item) => item.classList.remove("ativa"));
  tela.classList.add("ativa");
  if (!tela || tela.id !== "tela-transmissao") {
    document.body.classList.remove("modo-cheia-transmissao");
  }
  // Sai da multi se o usuário navegar para outra tela sem usar o botão Sair.
  // (sairSalaMulti limpa os flags ANTES de chamar mostrarTela de novo.)
  if (multiNaTela && tela && tela.id !== "tela-multitela") {
    multiNaTela = false;
    sairSalaMulti();
  }
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function formatarTempo(segundos) {
  const m = Math.floor(segundos / 60).toString().padStart(2, "0");
  const s = (segundos % 60).toString().padStart(2, "0");
  return m + ":" + s;
}

// ---------------------------------------------------------------------------
// Perfil — histórico recente unificado (todos os jogos)
// ---------------------------------------------------------------------------
function registrarHistoricoGeral(jogo, detalhe) {
  try {
    const lista = JSON.parse(localStorage.getItem("jj-historico-geral") || "[]");
    lista.unshift({ jogo: jogo, detalhe: detalhe, data: new Date().toLocaleDateString("pt-BR") });
    localStorage.setItem("jj-historico-geral", JSON.stringify(lista.slice(0, 20)));
  } catch (e) { /* ignore */ }
}


let lobbyWs = null;
let lobbyPingTimer = null;

// Lobby WebSocket — salas em tempo real
// ---------------------------------------------------------------------------

function conectarLobbyWs() {
  if (lobbyWs && lobbyWs.readyState === WebSocket.OPEN) return;

  var protocolo = location.protocol === "https:" ? "wss:" : "ws:";
  var url = protocolo + "//" + location.host + "/ws/lobby";

  lobbyWs = new WebSocket(url);

  clearInterval(lobbyPingTimer);
  lobbyPingTimer = setInterval(function () {
    if (lobbyWs && lobbyWs.readyState === WebSocket.OPEN) {
      lobbyWs.send("ping");
    }
  }, 20000);

  lobbyWs.onmessage = function (evento) {
    var dados = JSON.parse(evento.data);
    if (dados.tipo === "salas_atualizadas") {
      renderizarSalasLobby(dados.salas);
      renderizarSalasEspectacao(dados.salas);
    } else if (dados.tipo === "salas_multi") {
      renderizarSalasMulti(dados.salas || []);
    } else if (dados.tipo === "multi_removida") {
      carregarSalasMulti();
    } else if (dados.tipo === "salas_ludo") {
      renderizarSalasLudo(dados.salas || []);
    } else if (dados.tipo === "salas_campo") {
      renderizarSalasCampo(dados.salas || []);
    } else if (dados.tipo === "salas_termo") {
      renderizarSalasTermo(dados.salas || []);
    }
  };

  lobbyWs.onclose = function () {
    clearInterval(lobbyPingTimer);
    setTimeout(conectarLobbyWs, 3000);
  };

  lobbyWs.onerror = function () {};
}

function ehAnonimoNick(nick) {
  var n = (nick || "").trim().toLowerCase();
  return n === "anônimo" || n === "anonimo";
}


document.querySelectorAll(".voltar").forEach(function (botao) {
  botao.addEventListener("click", function () {
    // Sair da velha pela seta precisa fechar a sala no servidor.
    if (botao.id === "voltar-velha" && velhaModo === "multiplayer" && velhaSala) {
      localStorage.removeItem("velha-reconnect");
      esconderCodigoSala();
      if (velhaWs && velhaWs.readyState === WebSocket.OPEN) {
        try { velhaWs.send(JSON.stringify({ tipo: "sair" })); } catch (e) { /* ignore */ }
      }
      if (velhaWs) {
        velhaWs.close();
        velhaWs = null;
      }
      velhaSala = null;
      velhaModo = null;
    }
    // Sair do sudoku online (tela-jogo → voltar) encerra a sala.
    if (sudokuOnlineAtivo && botao.dataset.tela === "tela-dificuldade") {
      if (sudokuWs && sudokuWs.readyState === WebSocket.OPEN) {
        try { sudokuWs.send(JSON.stringify({ tipo: "sair" })); } catch (e) { /* ignore */ }
      }
      fecharSudokuOnline(null);
      carregarSalasSudoku();
    }
    // Sair do campo online pela seta.
    if (campoOnlineAtivo && botao.dataset.tela === "tela-modo-campo") {
      campoFechar(null);
      carregarSalasCampo();
    }
    // Sair do termo online pela seta.
    if (botao.id === "voltar-termo" && termoOnlineAtivo) {
      if (termoWs && termoWs.readyState === WebSocket.OPEN) {
        try { termoWs.send(JSON.stringify({ tipo: "sair" })); } catch (e) { /* ignore */ }
      }
      termoFechar(null);
      carregarSalasTermo();
    }
    var telaId = botao.dataset.tela;
    mostrarTela(document.querySelector("#" + telaId));
    if (telaId === "tela-lobby-velha" || telaId === "tela-modo-velha") {
      carregarRankingVelha();
    }
    if (telaId === "tela-modo-campo" || telaId === "tela-lobby-campo") {
      carregarRankingCampo();
      carregarSalasCampo();
    }
  });
});

function preencherAvatarPlacar(el, nick, avatar, cosmeticos) {
  if (!el) return;
  var decoracaoUrl = cosmeticos && cosmeticos.decoracao;
  el.classList.toggle("tem-decoracao", !!decoracaoUrl);
  var html = avatar
    ? '<img src="' + escapeHtml(avatar) + '" alt="" />'
    : escapeHtml((nick || "?").charAt(0).toUpperCase());
  if (decoracaoUrl) {
    html += '<img class="avatar-decoracao-img" src="' + escapeHtml(decoracaoUrl) + '" alt="" />';
  }
  el.innerHTML = html;
}

/** Aplica a cor/arco-íris do nick equipado num elemento de texto qualquer
 *  (placares, listas de sala) — usa a mesma lógica do cabeçalho. */
function aplicarCorNickEl(el, cosmeticos) {
  if (!el || typeof aplicarCorEmElemento !== "function") return;
  aplicarCorEmElemento(el, cosmeticos && cosmeticos.cor_nick);
}

/** HTML de um avatar pequeno (listas de sala) com a decoração de perfil
 *  equipada sobreposta, quando houver. */
function avatarSalaHtml(avatar, nick, cosmeticos) {
  var decoracaoUrl = cosmeticos && cosmeticos.decoracao;
  var interno = avatar
    ? '<img class="sala-item-avatar" src="' + escapeHtml(avatar) + '" alt="" />'
    : '<span class="sala-item-avatar sala-item-avatar-inicial">' + escapeHtml((nick || "?").charAt(0).toUpperCase()) + "</span>";
  if (decoracaoUrl) {
    interno += '<img class="avatar-decoracao-img" src="' + escapeHtml(decoracaoUrl) + '" alt="" />';
  }
  return '<span class="sala-item-avatar-box">' + interno + "</span>";
}

/** Atributo style/class pra colorir um <strong>/<span> de nick em HTML
 *  montado via string (listas de sala) — mesma cor/arco-íris da loja. */
function corNickAtributoHtml(cosmeticos) {
  var cor = cosmeticos && cosmeticos.cor_nick;
  if (cor === "arco-iris") return ' class="nick-arco-iris"';
  if (cor && typeof LOJA_CORES_HEX !== "undefined" && LOJA_CORES_HEX[cor]) {
    return ' style="color:' + LOJA_CORES_HEX[cor] + '"';
  }
  return '';
}


// ---------------------------------------------------------------------------
// Discord — conexão
// ---------------------------------------------------------------------------
async function conectarAoDiscord() {
  if (conexaoDiscordPromise) return conexaoDiscordPromise;
  conexaoDiscordPromise = (async function () {
    try {
      var respostaConfiguracao = await fetch("./config");
      if (!respostaConfiguracao.ok) {
        if (dentroDaActivity()) {
          elementoStatus.textContent = "Erro ao ler config (" + respostaConfiguracao.status + ")";
          elementoStatus.classList.remove("conectado");
        }
        return;
      }
      var configuracao = await respostaConfiguracao.json();
      if (!configuracao.application_id) {
        if (dentroDaActivity()) {
          elementoStatus.textContent = "application_id não configurado no servidor";
          elementoStatus.classList.remove("conectado");
        }
        return;
      }

      var mod;
      try {
        mod = await import("/sdk/npm/@discord/embedded-app-sdk/+esm");
      } catch (importErr) {
        console.warn("SDK import failed (likely not in Discord iframe):", importErr);
        if (dentroDaActivity()) {
          elementoStatus.textContent = "Erro ao carregar SDK do Discord";
          elementoStatus.classList.remove("conectado");
        }
        return;
      }

      var DiscordSDK = mod.DiscordSDK;
      discordSdkGlobal = new DiscordSDK(configuracao.application_id);
      try {
        await discordSdkGlobal.ready();
      } catch (readyErr) {
        console.warn("discordSdkGlobal.ready() falhou:", readyErr);
        elementoStatus.textContent = "Erro ao conectar com o Discord";
        elementoStatus.classList.remove("conectado");
        return;
      }

      var autenticou = false;
      try {
        // Fluxo correto da Activity: authorize -> code -> /token -> access_token
        // -> authenticate({access_token}) -> user. authenticate() sem token
        // retorna sem user e deixava o header em "sem login".
        var authz = await discordSdkGlobal.commands.authorize({
          client_id: configuracao.application_id,
          response_type: "code",
          state: "",
          prompt: "none",
          scope: ["identify", "applications.commands"],
        });
        var codigo = authz && authz.code;
        if (!codigo) throw new Error("authorize não retornou code");

        var resTroca = await fetch("./token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: codigo, activity: true }),
        });
        var token = await resTroca.json();
        if (!resTroca.ok) throw new Error(token.detail || "Falha ao trocar o code.");

        // O @me já vem pronto do backend (buscado lá) — dentro da Activity um
        // fetch do cliente direto para discord.com fica preso pelo sandbox do
        // iframe (mapeamento de URLs do portal) e nunca resolve.
        var user = token.user;
        if (!user || !user.id) throw new Error("@me sem user.");

        usuarioDiscord = user;
        autenticou = true;
        try {
          await discordSdkGlobal.commands.authenticate({ access_token: token.access_token });
        } catch (eAuth) {
          console.warn("SDK authenticate (com token) falhou (ok se @me ok):", eAuth);
        }
        salvarSessaoDiscord({
          user: user,
          access_token: token.access_token,
          refresh_token: token.refresh_token,
          obtido_em: Date.now(),
        });
        console.log("Discord user identified:", user.username);
      } catch (e) {
        console.warn("Não foi possível autenticar:", e);
        if (dentroDaActivity()) {
          elementoStatus.textContent = "Falha no login: " + String((e && e.message) || e).slice(0, 60);
          elementoStatus.classList.remove("conectado");
        }
        // limpa a promise para permitir retry (garantirIdentidade chama de novo)
        conexaoDiscordPromise = null;
      }

      if (autenticou) {
        elementoStatus.textContent = "Conectado ao Discord";
        elementoStatus.classList.add("conectado");
      } else if (!dentroDaActivity()) {
        elementoStatus.textContent = "Discord (sem login)";
        elementoStatus.classList.remove("conectado");
      }
      renderAuth();
    } catch (erro) {
      console.warn("A conex\u00e3o com o Discord n\u00e3o foi conclu\u00edda:", erro);
      if (dentroDaActivity()) {
        elementoStatus.textContent = "Erro: " + String((erro && erro.message) || erro).slice(0, 60);
        elementoStatus.classList.remove("conectado");
      }
      conexaoDiscordPromise = null;
    }
  })();
  return conexaoDiscordPromise;
}

// ---------------------------------------------------------------------------

function obterInstanciaParam() {
  var params = new URLSearchParams(location.search);
  // O Discord injeta o param instance_id no iframe da Activity.
  return params.get("instancia") || params.get("instance_id") || "";
}

// Origem REAL do app. Dentro da Activity o location.origin é o proxy do
// Discord (ex.: 123.discordsays.com) — links/redirects devem apontar o site.
function appOrigin() {
  if (/\.discordsays\.com$/i.test(location.hostname)) return "https://jogos7.onrender.com";
  return location.origin;
}

// True dentro da Activity (mesmo se o SDK falhar ao carregar).
// O hostname .discordsays.com é o sinal mais confiável: nem sempre o Discord
// injeta frame_id/instance_id na query string, e sem isso o botão de login
// do site (navegação de página inteira) ficava visível dentro da Activity —
// clicar nele tenta navegar o iframe restrito para discord.com e trava em
// branco (a Activity só pode navegar via SDK, não por location.href).
function dentroDaActivity() {
  if (discordSdkGlobal) return true;
  if (/\.discordsays\.com$/i.test(location.hostname)) return true;
  var params = new URLSearchParams(location.search);
  return params.has("frame_id") || params.has("instance_id");
}

function compartilharInstanciaAtual() {
  if (obterInstanciaParam()) return obterInstanciaParam();
  if (discordSdkGlobal && discordSdkGlobal.instanceId) return discordSdkGlobal.instanceId;
  return "";
}

// Discord OAuth2 - login no site (modo navegador)
// ---------------------------------------------------------------------------
function estadoDiscord() {
  try {
    return JSON.parse(localStorage.getItem("usuario-discord") || "null");
  } catch (e) {
    return null;
  }
}

function salvarSessaoDiscord(sessao) {
  localStorage.setItem("usuario-discord", JSON.stringify(sessao));
  usuarioDiscord = sessao.user;
  renderAuth();
}

function limparSessaoDiscord() {
  localStorage.removeItem("usuario-discord");
  usuarioDiscord = null;
  renderAuth();
}

function avatarUrlDiscord(user) {
  if (user && user.avatar) {
    return "https://cdn.discordapp.com/avatars/" + user.id + "/" + user.avatar + ".png?size=64";
  }
  return "https://cdn.discordapp.com/embed/avatars/" + ((user ? parseInt(user.discriminator || "0", 10) : 0) % 6) + ".png";
}

function renderAuth() {
  var botaoLogin = document.querySelector("#btn-login-discord");
  var caixa = document.querySelector("#auth-usuario");
  if (!botaoLogin || !caixa) return;

  if (usuarioDiscord) {
    botaoLogin.style.display = "none";
    caixa.style.display = "";
    var avatar = document.querySelector("#auth-avatar");
    avatar.onerror = function () {
      this.onerror = null;
      this.src = "https://cdn.discordapp.com/embed/avatars/0.png";
    };
    avatar.src = avatarUrlDiscord(usuarioDiscord);
    document.querySelector("#auth-nome").textContent =
      usuarioDiscord.global_name || usuarioDiscord.username;
    // Na Activity a identidade vem do SDK — logout local não faria sentido.
    document.querySelector("#btn-logout-discord").style.display = dentroDaActivity() ? "none" : "";
    if (typeof atualizarMoedasHeader === "function") atualizarMoedasHeader();
  } else {
    caixa.style.display = "none";
    botaoLogin.style.display = dentroDaActivity() ? "none" : "";
    var botaoLoja = document.querySelector("#btn-abrir-loja");
    if (botaoLoja) botaoLoja.style.display = "none";
  }
}

async function iniciarLoginDiscord() {
  // Dentro da Activity o iframe não pode navegar a página inteira para
  // discord.com (fica em branco) — o login lá é automático via SDK.
  if (dentroDaActivity()) {
    conectarAoDiscord();
    return;
  }
  try {
    var res = await fetch("./config");
    var config = await res.json();
    if (!config.application_id) throw new Error("application_id ausente.");

    var state = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : String(Math.random()).slice(2) + String(Math.random()).slice(2);
    sessionStorage.setItem("oauth-state", state);

    // redirect_uri canônico: precisa existir nos Redirects do portal e ser
    // idêntico no authorize E na troca do code pelo token.
    var redirect = config.redirect_uri || (appOrigin() + "/auth/callback");
    sessionStorage.setItem("oauth-redirect", redirect);

    var url = "https://discord.com/api/oauth2/authorize?" + new URLSearchParams({
      client_id: config.application_id,
      response_type: "code",
      redirect_uri: redirect,
      scope: "identify",
      state: state,
    });
    location.href = url;
  } catch (e) {
    console.warn("Falha ao iniciar login:", e);
    abrirTelaCompartilhar();
    mensagemTela("Não foi possível iniciar o login com o Discord.", "erro");
  }
}

async function processarCallbackOAuth() {
  var params = new URLSearchParams(location.search);
  var code = params.get("code");
  if (!code) return;

  var state = params.get("state");
  var guardado = sessionStorage.getItem("oauth-state");
  var redirectGuardado = sessionStorage.getItem("oauth-redirect") || (appOrigin() + "/auth/callback");
  sessionStorage.removeItem("oauth-state");
  sessionStorage.removeItem("oauth-redirect");
  history.replaceState({}, "", "/");

  if (!state || !guardado || state !== guardado) {
    console.warn("OAuth: state inválido.");
    abrirTelaCompartilhar();
    mensagemTela("Login cancelado (verificação de segurança falhou).", "erro");
    return;
  }

  try {
    var res = await fetch("./token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code, redirect_uri: redirectGuardado }),
    });
    var token = await res.json();
    if (!res.ok) throw new Error(token.detail || "Falha ao trocar o código.");

    var user = token.user;
    if (!user || !user.id) throw new Error("Falha ao obter o perfil.");

    salvarSessaoDiscord({
      user: user,
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      obtido_em: Date.now(),
    });
    console.log("Login Discord ok:", user.username);
  } catch (e) {
    console.warn("OAuth callback falhou:", e);
    abrirTelaCompartilhar();
    mensagemTela("Não foi possível concluir o login: " + e.message, "erro");
  }
}

async function restaurarSessaoDiscord() {
  var sessao = estadoDiscord();
  if (!sessao) return;

  // Tokens do Discord expiram em ~7 dias; renova a partir do 6º.
  var idade = Date.now() - (sessao.obtido_em || 0);
  if (sessao.refresh_token && idade > 6 * 24 * 60 * 60 * 1000) {
    try {
      var res = await fetch("./token/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: sessao.refresh_token }),
      });
      if (res.ok) {
        var novo = await res.json();
        sessao.access_token = novo.access_token || sessao.access_token;
        sessao.refresh_token = novo.refresh_token || sessao.refresh_token;
        sessao.obtido_em = Date.now();
        salvarSessaoDiscord(sessao);
      }
    } catch (e) { /* mantém a sessão atual */ }
  }

  usuarioDiscord = sessao.user;
  renderAuth();
}

document.querySelector("#btn-login-discord").addEventListener("click", iniciarLoginDiscord);
document.querySelector("#btn-logout-discord").addEventListener("click", limparSessaoDiscord);
document.querySelector("#btn-ver-perfil").addEventListener("click", abrirPerfil);
document.querySelector("#status-discord").addEventListener("click", abrirPerfil);
document.querySelector("#status-discord").addEventListener("keydown", function (e) {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); abrirPerfil(); }
});

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------
window.addEventListener("error", function (e) {
  console.error("Erro global:", e.message, e.filename, e.lineno);
});

window.addEventListener("unhandledrejection", function (e) {
  console.error("Promise rejeitada:", e.reason);
});

// ---------------------------------------------------------------------------

conectarAoDiscord();


// Sessão OAuth + links diretos: ?transmitir=1&instancia=... (gerado pelo
// botão da Activity), ?sala=<codigo> (espectador) e /auth/callback?code=...
(function () {
  restaurarSessaoDiscord().then(function () {
    renderAuth();
    return processarCallbackOAuth();
  }).then(function () {
    var params = new URLSearchParams(location.search);
    var salaCompartilhada = params.get("sala");
    var querTransmitir = params.get("transmitir") === "1";

    if (salaCompartilhada) {
      abrirTelaCompartilhar();
      assistirTransmissao(salaCompartilhada);
    } else if (querTransmitir) {
      abrirTelaCompartilhar();
    }
  }).catch(function (e) {
    console.error("Init OAuth/deep-link falhou:", e);
    if (location.pathname !== "/") history.replaceState({}, "", "/");
  });
})();


