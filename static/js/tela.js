// Compartilhar Tela — transmissão e sala multi-tela.

// Compartilhar Tela - estado e presets
// ---------------------------------------------------------------------------
var telaWs = null;
var telaPingTimer = null;
var telaSala = null;
var telaEhHost = false;
var telaStream = null;
var telaPeers = {}; // host: viewer_id -> RTCPeerConnection
var telaPeerViewer = null; // viewer: 1 conexão com o host
var telaResolucao = "720p";
var telaFps = 30;
// "tela" = getDisplayMedia; "tela_legado" = getUserMedia(screen); "camera" = celular sem tela.
var telaFonte = "tela";
var cameraFacing = "environment";
var telaOfertaTimer = null;
// Relay de vídeo (Activity não suporta WebRTC — docs do Discord).
var telaModoRelay = false;
var telaRelayTimer = null;
var telaRelayTotal = 0;
var relayFrameOk = false;
var relayEncoder = null;
var relayAtivo = false;
var relayDrawTimer = null;
var relayForcarKey = false;
var relayDecoder = null;
var relayProntoEnviado = false;
var relayHostOk = false;
var relayEncoderVisibilityListener = null;
var relayTemKey = false;
var relayQuadros = 0;
var relayRxEnviado = false;
var relayPartes = {};
var relayCfgOk = false;
var relaySemOutput = 0;
var ultimoErroRelay = "";
var relayCodecAtual = "vp8";
var relayDecoderFallbackTentado = false;

// Áudio do relay (Activity não tem WebRTC): Opus via WebCodecs.
var relayAudioEncoder = null;
var relayAudioReader = null;
var relayAudioLoopAtivo = false;
var relayAudioDecoder = null;
var relayAudioCtx = null;
var relayAudioGain = null;
var relayAudioProxima = 0;
var relayAudioCfgOk = false;
var relayAudioMudoHost = false;
var relayAudioSr = 48000;
var relayAudioCh = 2;
var relayAudioChavePendente = true;
var relayAudioCfgDecoder = { sr: 0, ch: 0 };

// Sala multi-tela: várias lives simultâneas (720p30 fixo, máx. 8).
var multiSala = null;
var multiWs = null;
var multiPingTimer = null;
var multiEstado = null;
var multiTiles = {}; // sala_live -> contexto do tile
var multiHostSala = null; // live que ESTE cliente está transmitindo
var multiNaTela = false;

// Painel único de criação (hub).
var formTipoSala = "publica"; // publica | privada
var formModoTela = "normal";  // normal | multi

function logRelayDiag(etapa, extra) {
  var msg = { tipo: "relay_diag", etapa: etapa };
  if (extra) {
    if (extra.msg) msg.msg = String(extra.msg).slice(0, 200);
    if (typeof extra.quadros === "number") msg.quadros = extra.quadros;
    if (typeof extra.k === "number") msg.k = extra.k;
    if (typeof extra.bytes === "number") msg.bytes = extra.bytes;
    if (extra.state) msg.state = String(extra.state);
  }
  enviarTela(msg);
}

// Diagnóstico único do viewer da Activity: pergunta ao servidor o estado
// real da sala em vez de adivinhar.
async function diagnosticarRelaySemVideo() {
  if (!telaModoRelay || relayFrameOk || !telaSala) return;
  var codigo = telaSala;
  if (relayQuadros > 0) {
    // Quadros chegam no JS — o problema é decode/desenho, não a rede.
    logRelayDiag("sem_video", { quadros: relayQuadros, msg: ultimoErroRelay || ("cfg=" + relayCfgOk) });
    mensagemTransmissao(
      "Recebi " + relayQuadros + " quadros, mas o vídeo não abriu" +
      (ultimoErroRelay ? " (" + ultimoErroRelay + ")" : "") +
      ". Recarregue a Activity (Ctrl+F5).", "erro");
    return;
  }
  try {
    var res = await fetch("./tela/sala/" + encodeURIComponent(codigo));
    if (res.status === 404) {
      mensagemTransmissao("A transmissão foi encerrada (sala " + codigo + ").", "erro");
      return;
    }
    var info = await res.json();
    if (info.host_conectado === false) {
      mensagemTransmissao("Quem transmite NÃO está conectado (sala " + codigo +
        "). Feche e reabra a transmissão no navegador (Ctrl+F5).", "erro");
    } else {
      mensagemTransmissao("Quem transmite está online mas não enviou vídeo (sala " + codigo +
        "). Peça para ele Ctrl+F5 na aba de transmissão e transmitir de novo.", "erro");
    }
  } catch (e) {
    mensagemTransmissao("Sem resposta do servidor para a sala " + codigo + ".", "erro");
  }
}

// Bitrates altos = imagem nítida. O relay fragmenta em 12KB, então dá pra ir alto.
var TELA_PRESETS = {
  "480p": { largura: 854, altura: 480, bitrate: 2500000 },
  "720p": { largura: 1280, altura: 720, bitrate: 6000000 },
  "1080p": { largura: 1920, altura: 1080, bitrate: 12000000 },
};
var RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

var telaCompartilhar = document.querySelector("#tela-compartilhar");
var telaTransmissaoEl = document.querySelector("#tela-transmissao");
var mensagemTelaEl = document.querySelector("#mensagem-tela");
var mensagemTransmissaoEl = document.querySelector("#mensagem-transmissao");
var videoTransmissaoEl = document.querySelector("#video-transmissao");
var canvasRelayEl = document.querySelector("#canvas-relay");
var controlesTransmissaoEl = document.querySelector("#controles-transmissao");
var btnMudoEl = document.querySelector("#btn-mudo-transmissao");
var volumeEl = document.querySelector("#volume-transmissao");

// Estado de áudio/volume compartilhado host+viewer.
var audioMudo = false;
var volumeLocal = 1;
var telaAudioMuted = false;



function mensagemTela(texto, tipo) {
  mensagemTelaEl.textContent = texto;
  mensagemTelaEl.className = "mensagem" + (tipo ? " " + tipo : "");
}

function mensagemTransmissao(texto, tipo) {
  mensagemTransmissaoEl.textContent = texto;
  mensagemTransmissaoEl.className = "mensagem" + (tipo ? " " + tipo : "");
}

function bitrateEfetivo() {
  var base = TELA_PRESETS[telaResolucao].bitrate;
  return telaFps === 60 ? Math.round(base * 1.5) : base;
}

// Relay: prefere fluidez (pouco fps/delay) sobre bitrate máximo — o proxy do
// Discord engasga com ~8 Mbps de JSON base64 e aí o vídeo "trava".
function bitrateRelay() {
  if (multiSala) return 5000000; // multi-tela 720p30: um pouco mais de bits p/ fps estável
  var base = TELA_PRESETS[telaResolucao].bitrate;
  var teto = telaResolucao === "1080p" ? 6000000
    : telaResolucao === "720p" ? 4500000 : 2500000;
  var b = Math.min(base, teto);
  // 60fps usa o MESMO budget (não multiplica) — mais bits = mais fila/delay.
  return b;
}

function atualizarAvisoUpload() {
  if (formModoTela === "multi") {
    document.querySelector("#aviso-upload").textContent =
      "Multi-tela: até 8 telas na mesma sala, 720p 30fps fixo.";
    return;
  }
  var mbpsPorEspectador = bitrateEfetivo() / 1000000;
  var total = (mbpsPorEspectador * 9).toFixed(1);
  document.querySelector("#aviso-upload").textContent =
    "Vídeo direto entre você e cada espectador (P2P). Com 9 espectadores, seu upload chega a ~" +
    total + " Mbps (" + mbpsPorEspectador.toFixed(1) + " Mbps por pessoa). Para muita gente, prefira 720p 30fps.";
}

function codigoCustomValido(obrigatorio) {
  var el = document.querySelector("#codigo-custom-input");
  var codigoCustom = ((el && el.value) || "").trim().toLowerCase();
  if (!codigoCustom) {
    if (obrigatorio) return { erro: "Sala privada: digite um código para as pessoas entrarem." };
    return { codigo: null };
  }
  if (!/^[a-z0-9_-]{3,16}$/.test(codigoCustom)) {
    return { erro: "Código da sala: use de 3 a 16 caracteres (letras, números, - ou _)." };
  }
  return { codigo: codigoCustom };
}

function aplicarFormularioCriacao() {
  var multi = formModoTela === "multi";
  var privada = formTipoSala === "privada";
  var q = document.querySelector("#bloco-qualidade");
  var nota = document.querySelector("#nota-multi");
  var cod = document.querySelector("#grupo-codigo-sala");
  var entrar = document.querySelector("#entrar-multi-bloco");
  var audio = document.querySelector("#grupo-audio");
  var btn = document.querySelector("#iniciar-transmissao");
  if (q) q.style.display = multi ? "none" : "";
  if (nota) nota.style.display = multi ? "" : "none";
  if (cod) cod.style.display = privada ? "" : "none";
  if (entrar) entrar.style.display = multi ? "" : "none";
  if (audio) audio.style.display = "";
  if (btn) btn.textContent = multi ? "Criar sala multi-tela" : "Iniciar transmissão";
  atualizarAvisoUpload();
  if (multi) carregarSalasMulti();
}

// ---------------------------------------------------------------------------
// Compartilhar Tela - qualidade ao vivo (escala/bitrate/fps por sender)
// ---------------------------------------------------------------------------
function escalaDePreset() {
  var preset = TELA_PRESETS[telaResolucao];
  var tr = telaStream ? telaStream.getVideoTracks()[0] : null;
  var s = tr && tr.getSettings ? tr.getSettings() : {};
  var altura = s.height || preset.altura;
  return Math.max(1, Math.round(altura / preset.altura));
}

function aplicarParamsSender(sender) {
  if (!sender || !sender.getParameters) return;
  var params = sender.getParameters();
  params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
  params.encodings[0].maxBitrate = bitrateEfetivo();
  params.encodings[0].maxFramerate = telaFps;
  params.encodings[0].scaleResolutionDownBy = escalaDePreset();
  var r = sender.setParameters(params);
  if (r && r.catch) r.catch(function () {});
}

function aplicarQualidadeNosViewers() {
  if (!telaEhHost || !telaStream) return;
  Object.keys(telaPeers).forEach(function (id) {
    telaPeers[id].getSenders().forEach(function (sender) {
      if (sender.track && sender.track.kind === "video") aplicarParamsSender(sender);
    });
  });
  enviarTela({ tipo: "config", resolucao: telaResolucao, fps: telaFps });
}

function definirResolucao(valor) {
  if (multiSala || formModoTela === "multi") return; // multi-tela: 720p30 fixo
  telaResolucao = valor;
  ["#preset-resolucao", "#live-resolucao"].forEach(function (sel) {
    document.querySelectorAll(sel + " .botao-preset").forEach(function (b) {
      b.classList.toggle("selecionado", b.dataset.resolucao === valor);
    });
  });
  atualizarAvisoUpload();
  mostrarBadgeQualidade(telaResolucao, telaFps, null);
  if (telaEhHost && telaStream) {
    aplicarQualidadeNosViewers();
    mensagemTransmissao("Qualidade alterada: " + telaResolucao + " " + telaFps + "fps.", "sucesso");
    reiniciarEncoderRelaySeAtivo();
  }
}

function definirFps(valor) {
  if (multiSala || formModoTela === "multi") return; // multi-tela: 720p30 fixo
  telaFps = valor;
  ["#preset-fps", "#live-fps"].forEach(function (sel) {
    document.querySelectorAll(sel + " .botao-preset").forEach(function (b) {
      b.classList.toggle("selecionado", parseInt(b.dataset.fps, 10) === valor);
    });
  });
  atualizarAvisoUpload();
  mostrarBadgeQualidade(telaResolucao, telaFps, null);
  if (telaEhHost && telaStream) {
    // Não applyConstraints no meio da captura (congela a track no Chrome).
    // O timer do encoder lê telaFps ao vivo; só reconfigura/reinicia o encoder.
    aplicarQualidadeNosViewers();
    mensagemTransmissao("Qualidade alterada: " + telaResolucao + " " + telaFps + "fps.", "sucesso");
    reiniciarEncoderRelaySeAtivo();
  }
}

// Pede nova captura (o seletor do navegador permite trocar o programa/janela;
// no celular troca a câmera frente/verso) e troca a track ao vivo.
async function trocarJanelaTela() {
  if (!telaEhHost || !telaStream) return;
  if (telaFonte === "camera") {
    cameraFacing = cameraFacing === "environment" ? "user" : "environment";
  }
  var querAudio = true;
  var chkAudio = document.querySelector("#capturar-audio-tela");
  if (chkAudio) querAudio = !!chkAudio.checked;
  var novo;
  try {
    novo = await capturarMidiaTransmissao(querAudio);
  } catch (e) {
    mensagemTransmissao("Troca cancelada.");
    return;
  }

  var novaTrack = novo.getVideoTracks()[0];
  var novaAudio = novo.getAudioTracks()[0];
  var antiga = telaStream;
  var trocas = [];

  Object.keys(telaPeers).forEach(function (id) {
    telaPeers[id].getSenders().forEach(function (sender) {
      if (sender.track && sender.track.kind === "video") {
        var p = sender.replaceTrack(novaTrack);
        if (p && p.then) trocas.push(p);
      } else if (sender.track && sender.track.kind === "audio" && novaAudio) {
        var pa = sender.replaceTrack(novaAudio);
        if (pa && pa.then) trocas.push(pa);
      }
    });
  });

  function concluir() {
    antiga.getTracks().forEach(function (t) { t.stop(); });
    telaStream = novo;
    videoTransmissaoEl.srcObject = novo;
    if (novaAudio) {
      novaAudio.enabled = !audioMudo;
      iniciarEncoderAudioRelay();
    }
    novaTrack.addEventListener("ended", function () {
      encerrarTransmissao(false);
      mensagemTela("Transmissão encerrada: você parou a captura de tela.", "erro");
    });
    aplicarQualidadeNosViewers();
    var btnTrocar = document.querySelector("#trocar-janela");
    if (btnTrocar) {
      btnTrocar.textContent = telaFonte === "camera"
        ? "Trocar câmera (frente/verso)"
        : "Trocar programa/janela da transmissão";
    }
    mensagemTransmissao(
      "Fonte trocada (" + rotuloFonteCaptura() + "). Qualidade " + telaResolucao + " " + telaFps + "fps.",
      "sucesso");
  }

  if (trocas.length === 0) {
    concluir();
  } else {
    Promise.all(trocas).then(concluir).catch(function (erro) {
      console.warn("replaceTrack falhou, recriando conexões:", erro);
      concluir();
      Object.keys(telaPeers).forEach(function (id) {
        criarPeerParaViewer(id);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Compartilhar Tela - relay de vídeo por WebSocket (para a Activity)
// O Discord não suporta WebRTC dentro da Activity; o host codifica VP8 com
// WebCodecs e o servidor repassa os quadros binários até o canvas do viewer.
// ---------------------------------------------------------------------------
function iniciarDecoderRelay(resolucao, codec) {
  pararDecoderRelay();
  relayCodecAtual = codec || relayCodecAtual || "vp8";
  relayDecoderFallbackTentado = false;
  var dims = { "480p": [854, 480], "720p": [1280, 720], "1080p": [1920, 1080] }[resolucao] || [1280, 720];
  var canvas = document.querySelector("#canvas-relay");
  canvas.width = dims[0];
  canvas.height = dims[1];
  canvas.style.display = "";
  relayQuadros = 0;
  relayRxEnviado = false;
  relayPartes = {};
  relayCfgOk = false;
  relaySemOutput = 0;
  ultimoErroRelay = "";
  iniciarDecoderAudioRelay(relayAudioSr, relayAudioCh);
  relayAudioChavePendente = true;
  mostrarBadgeQualidade(resolucao, null, relayCodecAtual);
  if (typeof VideoDecoder === "undefined") {
    ultimoErroRelay = "sem VideoDecoder";
    logRelayDiag("sem_videodecoder");
    mensagemTransmissao("Seu cliente não suporta o modo de vídeo compatível.", "erro");
    return;
  }
  var ctx = canvas.getContext("2d", { alpha: false });
  var desenhados = 0;
  var errosDecoder = 0;
  relayTemKey = false;
  relayDecoder = new VideoDecoder({
    output: function (frame) {
      try {
        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
        desenhados++;
        relaySemOutput = 0;
        if (desenhados === 1) {
          relayFrameOk = true;
          clearTimeout(telaRelayTimer);
          logRelayDiag("desenhou", { quadros: relayQuadros });
          mensagemTransmissao("Recebendo vídeo de quem transmite.", "sucesso");
        }
      } catch (e) {
        ultimoErroRelay = "draw: " + e.message;
        logRelayDiag("draw_erro", { msg: e.message });
      }
      try { frame.close(); } catch (e2) { /* ignore */ }
    },
    error: function (e) {
      var texto = String(e && e.message ? e.message : e);
      ultimoErroRelay = texto;
      logRelayDiag("decoder_error", { msg: texto, quadros: relayQuadros, codec: relayCodecAtual });
      if (relayDecoder && relayDecoder.state !== "closed") {
        try { relayDecoder.close(); } catch (err) { /* ignore */ }
      }
      relayDecoder = null;
      relayTemKey = false;
      errosDecoder++;
      if (errosDecoder > 3) {
        mensagemTransmissao("Falha ao decodificar o vídeo (" +
          texto + "). Recarregue a Activity.", "erro");
        return;
      }
      // Config inválida (ex.: H.264 não suportado no viewer) → tenta VP8 1x.
      if (!relayDecoderFallbackTentado && relayCodecAtual !== "vp8") {
        relayDecoderFallbackTentado = true;
        relayCodecAtual = "vp8";
        logRelayDiag("decoder_fallback_vp8", { antes: texto });
        iniciarDecoderRelay(resolucao, "vp8");
        mensagemTransmissao("Codec do transmissor incompatível — tentando VP8...", "");
        return;
      }
      iniciarDecoderRelay(resolucao, relayCodecAtual);
      ultimoErroRelay = texto;
      // Não sobrescreve com "aguardando" — deixa o erro visível.
      mensagemTransmissao("Vídeo chegou mas falhou ao decodificar (" +
        texto + "). Tentando de novo...", "erro");
    },
  });

  // isConfigSupported ANTES de configure — senão lança "Unsupported configuration".
  var candidatos = [];
  if (relayCodecAtual === "h264") {
    candidatos.push("avc1.42001f");
    candidatos.push("vp8");
  } else {
    candidatos.push("vp8");
    candidatos.push("avc1.42001f");
  }

  function tentarCfg(lista) {
    if (!lista.length || !relayDecoder) {
      logRelayDiag("configure_sem_codec");
      mensagemTransmissao("Nenhum codec de vídeo suportado neste cliente.", "erro");
      return;
    }
    var codecStr = lista[0];
    var resto = lista.slice(1);
    var cfgDec = { codec: codecStr, optimizeForLatency: true };
    var promessa = (typeof VideoDecoder.isConfigSupported === "function")
      ? VideoDecoder.isConfigSupported(cfgDec)
      : Promise.resolve({ supported: true });

    promessa.then(function (sup) {
      if (!relayDecoder) return;
      if (sup && sup.supported === false) {
        logRelayDiag("decoder_nao_suportado", { codec: codecStr });
        tentarCfg(resto);
        return;
      }
      try {
        relayDecoder.configure(cfgDec);
        relayCfgOk = relayDecoder.state === "configured";
        relayCodecAtual = (codecStr.indexOf("avc") === 0) ? "h264" : "vp8";
        logRelayDiag("decoder_cfg", { state: relayDecoder.state, codec: codecStr, ok: relayCfgOk });
        if (!relayCfgOk) tentarCfg(resto);
      } catch (err) {
        logRelayDiag("configure_erro", { msg: err.message, codec: codecStr });
        tentarCfg(resto);
      }
    }).catch(function () {
      if (!relayDecoder) return;
      try {
        relayDecoder.configure(cfgDec);
        relayCfgOk = relayDecoder.state === "configured";
        logRelayDiag("decoder_cfg", { state: relayDecoder.state, codec: codecStr, via: "catch" });
      } catch (err) {
        logRelayDiag("configure_erro", { msg: err.message, codec: codecStr });
        tentarCfg(resto);
      }
    });
  }

  tentarCfg(candidatos);
}

function pararDecoderRelay() {
  relayTemKey = false;
  if (relayDecoder) {
    try { if (relayDecoder.state !== "closed") relayDecoder.close(); } catch (e) { /* ignore */ }
    relayDecoder = null;
  }
  pararDecoderAudioRelay();
}

// ---------------------------------------------------------------------------
// Áudio no relay: host codifica Opus → JSON base64 → servidor → viewer
// ---------------------------------------------------------------------------
function iniciarEncoderAudioRelay() {
  pararEncoderAudioRelay();
  if (!telaEhHost || !telaStream) return;
  var track = telaStream.getAudioTracks()[0];
  if (!track) {
    logRelayDiag("audio_sem_track");
    return;
  }
  if (typeof MediaStreamTrackProcessor === "undefined" || typeof AudioEncoder === "undefined") {
    logRelayDiag("sem_audio_encoder");
    return;
  }
  try {
    var proc = new MediaStreamTrackProcessor({ track: track });
    relayAudioReader = proc.readable.getReader();
  } catch (e) {
    logRelayDiag("audio_processor_erro", { msg: e.message });
    return;
  }
  var cfgFeita = false;
  relayAudioLoopAtivo = true;
  relayAudioEncoder = new AudioEncoder({
    output: function (chunk) {
      try {
        if (!telaWs || telaWs.readyState !== WebSocket.OPEN) return;
        if (relayAudioMudoHost) return;
        var bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        var s = "";
        for (var i = 0; i < bytes.length; i += 0x8000) {
          s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        enviarTela({
          tipo: "audio",
          t: chunk.timestamp,
          k: chunk.type === "key" ? 1 : 0,
          sr: relayAudioSr,
          ch: relayAudioCh,
          d: btoa(s),
        });
      } catch (e) { /* ignore */ }
    },
    error: function (e) {
      logRelayDiag("audio_enc_erro", { msg: e && e.message ? e.message : e });
    },
  });
  (async function pump() {
    while (relayAudioLoopAtivo && relayAudioReader) {
      try {
        var r = await relayAudioReader.read();
        if (r.done) break;
        var frame = r.value;
        if (!cfgFeita && relayAudioEncoder) {
          // Trava em 48k/estéreo quando o track permite — decoder fixo neles.
          relayAudioSr = frame.sampleRate || 48000;
          relayAudioCh = Math.min(2, Math.max(1, frame.numberOfChannels || 1));
          relayAudioEncoder.configure({
            codec: "opus",
            sampleRate: relayAudioSr,
            numberOfChannels: relayAudioCh,
            bitrate: 64000,
          });
          cfgFeita = true;
          relayAudioCfgOk = true;
          relayAudioChavePendente = true;
          logRelayDiag("audio_enc_cfg", {
            state: relayAudioEncoder.state,
            sr: relayAudioSr,
            ch: relayAudioCh,
          });
        }
        if (relayAudioEncoder && relayAudioEncoder.state === "configured"
            && relayAudioEncoder.encodeQueueSize < 20
            && !relayAudioMudoHost) {
          relayAudioEncoder.encode(frame);
        }
        if (frame.close) frame.close();
      } catch (e) {
        break;
      }
    }
  })();
}

function pararEncoderAudioRelay() {
  relayAudioLoopAtivo = false;
  if (relayAudioReader) {
    try { relayAudioReader.cancel(); } catch (e) { /* ignore */ }
    relayAudioReader = null;
  }
  if (relayAudioEncoder) {
    try { if (relayAudioEncoder.state !== "closed") relayAudioEncoder.close(); } catch (e) { /* ignore */ }
    relayAudioEncoder = null;
  }
}

function iniciarDecoderAudioRelay(sr, ch) {
  pararDecoderAudioRelay();
  if (typeof AudioDecoder === "undefined" || typeof AudioContext === "undefined") {
    logRelayDiag("sem_audio_decoder");
    return;
  }
  var taxa = sr || 48000;
  var canais = ch || 2;
  try {
    var relayAudioCtxTry = null;
    try {
      relayAudioCtxTry = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    } catch (eCtx) {
      try {
        relayAudioCtxTry = new AudioContext({ latencyHint: "interactive" });
      } catch (eCtx2) {
        relayAudioCtxTry = new AudioContext();
      }
    }
    relayAudioCtx = relayAudioCtxTry;
    relayAudioGain = relayAudioCtx.createGain();
    relayAudioGain.gain.value = audioMudo ? 0 : volumeLocal;
    relayAudioGain.connect(relayAudioCtx.destination);
    relayAudioProxima = 0;
    relayAudioDecoder = new AudioDecoder({
      output: function (frame) {
        try {
          if (!relayAudioCtx || !relayAudioGain) { frame.close(); return; }
          if (relayAudioCtx.state === "suspended") {
            relayAudioCtx.resume().catch(function () {});
          }
          var canaisF = frame.numberOfChannels;
          var n = frame.numberOfFrames;
          var ab = relayAudioCtx.createBuffer(canaisF, n, frame.sampleRate);
          for (var c = 0; c < canaisF; c++) {
            var plane = new Float32Array(n);
            frame.copyTo(plane, { planeIndex: c, format: "f32-planar" });
            ab.copyToChannel(plane, c);
          }
          var src = relayAudioCtx.createBufferSource();
          src.buffer = ab;
          src.connect(relayAudioGain);
          var agora = relayAudioCtx.currentTime;
          if (relayAudioProxima < agora || relayAudioProxima > agora + 0.5) {
            relayAudioProxima = agora + 0.02;
          }
          src.start(relayAudioProxima);
          relayAudioProxima += n / frame.sampleRate;
        } catch (e) { /* ignore */ }
        try { frame.close(); } catch (e2) { /* ignore */ }
      },
      error: function (e) {
        logRelayDiag("audio_dec_erro", { msg: e && e.message ? e.message : e });
      },
    });
    relayAudioDecoder.configure({ codec: "opus", sampleRate: taxa, numberOfChannels: canais });
    relayAudioCfgOk = true;
    relayAudioCfgDecoder = { sr: taxa, ch: canais };
    logRelayDiag("audio_dec_cfg", { state: relayAudioDecoder.state, sr: taxa, ch: canais });
  } catch (e) {
    logRelayDiag("audio_dec_init_erro", { msg: e.message });
  }
}

function pararDecoderAudioRelay() {
  relayAudioCfgOk = false;
  relayAudioCfgDecoder = { sr: 0, ch: 0 };
  if (relayAudioDecoder) {
    try { if (relayAudioDecoder.state !== "closed") relayAudioDecoder.close(); } catch (e) { /* ignore */ }
    relayAudioDecoder = null;
  }
  if (relayAudioCtx) {
    try { relayAudioCtx.close(); } catch (e) { /* ignore */ }
    relayAudioCtx = null;
    relayAudioGain = null;
  }
}

function receberAudioRelay(dados) {
  if (!telaModoRelay || telaEhHost || !dados || !dados.d) return;
  var sr = parseInt(dados.sr, 10) || 48000;
  var ch = parseInt(dados.ch, 10) || 2;
  if (relayAudioDecoder
      && relayAudioDecoder.state !== "closed"
      && (relayAudioCfgDecoder.sr !== sr || relayAudioCfgDecoder.ch !== ch)) {
    iniciarDecoderAudioRelay(sr, ch);
  }
  if (!relayAudioDecoder || relayAudioDecoder.state === "closed") {
    iniciarDecoderAudioRelay(sr, ch);
    if (!relayAudioDecoder || relayAudioDecoder.state === "closed") return;
  }
  if (relayAudioCtx && relayAudioCtx.state === "suspended") {
    relayAudioCtx.resume().catch(function () {});
  }
  try {
    var bin = atob(dados.d);
    var payload = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) payload[i] = bin.charCodeAt(i);
    if (relayAudioDecoder.decodeQueueSize > 40) return;
    var tipo = "delta";
    if (dados.k) {
      tipo = "key";
    } else if (relayAudioChavePendente) {
      tipo = "key";
      relayAudioChavePendente = false;
    }
    relayAudioDecoder.decode(new EncodedAudioChunk({
      type: tipo,
      timestamp: dados.t || 0,
      data: payload,
    }));
  } catch (e) {
    logRelayDiag("audio_rx_erro", { msg: e.message });
  }
}

function desbloquearAudioRelay() {
  if (relayAudioCtx && relayAudioCtx.state === "suspended") {
    relayAudioCtx.resume().then(function () {
      logRelayDiag("audio_ctx_resumed");
    }).catch(function () {});
  }
}
document.addEventListener("pointerdown", desbloquearAudioRelay, { passive: true });
document.addEventListener("keydown", desbloquearAudioRelay);

function aplicarVolumeLocal() {
  videoTransmissaoEl.volume = volumeLocal;
  if (relayAudioGain) relayAudioGain.gain.value = audioMudo ? 0 : volumeLocal;
  desbloquearAudioRelay();
  // Host: mudo no envio (track) — preview local NUNCA toca (eco).
  if (telaEhHost && telaStream) {
    var tr = telaStream.getAudioTracks()[0];
    if (tr) tr.enabled = !audioMudo;
    relayAudioMudoHost = audioMudo;
    videoTransmissaoEl.muted = true;
    if (hostOffVideo) hostOffVideo.muted = true;
    var tileHost = multiTiles[telaSala] || multiTiles[multiHostSala];
    if (tileHost && tileHost.preview) tileHost.preview.muted = true;
  }
  // Viewer WebRTC: mudo no elemento.
  if (!telaEhHost && !telaModoRelay) {
    videoTransmissaoEl.muted = audioMudo;
  }
}

function definirTamanhoVideo(tam) {
  var classes = ["tam-p", "tam-m", "tam-g", "tam-full"];
  [videoTransmissaoEl, canvasRelayEl].forEach(function (el) {
    if (!el) return;
    classes.forEach(function (c) { el.classList.remove(c); });
    el.classList.add("tam-" + tam);
  });
  document.querySelectorAll("#tamanho-video .botao-preset").forEach(function (b) {
    b.classList.toggle("selecionado", b.dataset.tam === tam);
  });
  // Tela cheia ocupa a Activity inteira (esconde header/footer/controles fixos).
  if (tam === "full") {
    document.body.classList.add("modo-cheia-transmissao");
    agendarEsconderControles();
  } else {
    document.body.classList.remove("modo-cheia-transmissao");
    cancelarEsconderControles();
    if (controlesTransmissaoEl) controlesTransmissaoEl.classList.remove("oculto");
  }
  try { localStorage.setItem("jj_tela_tam", tam); } catch (e) { /* ignore */ }
}

// Auto-hide dos controles P/M/G na tela cheia (estilo YouTube).
var controlesHideTimer = null;
function agendarEsconderControles() {
  if (!controlesTransmissaoEl) return;
  controlesTransmissaoEl.classList.remove("oculto");
  clearTimeout(controlesHideTimer);
  controlesHideTimer = setTimeout(function () {
    if (document.body.classList.contains("modo-cheia-transmissao")) {
      controlesTransmissaoEl.classList.add("oculto");
    }
  }, 2500);
}
function cancelarEsconderControles() {
  clearTimeout(controlesHideTimer);
  controlesHideTimer = null;
}
document.addEventListener("mousemove", function () {
  if (document.body.classList.contains("modo-cheia-transmissao")) agendarEsconderControles();
});
document.addEventListener("touchstart", function () {
  if (document.body.classList.contains("modo-cheia-transmissao")) agendarEsconderControles();
});

function receberRelay(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 5) return;
  var dv = new DataView(buffer);
  decodificarRelayFrame(dv.getUint8(0) === 1, dv.getUint32(1), new Uint8Array(buffer, 5));
}

function decodificarRelayFrame(ehKey, timestamp, payload) {
  if (!relayDecoder || relayDecoder.state === "closed") {
    if (!relayDecoder) logRelayDiag("decode_sem_decoder", { quadros: relayQuadros });
    return;
  }
  if (!payload || payload.byteLength < 1) return;
  // VP8 exige keyframe para começar (viewer pode entrar no meio do GOP).
  if (!ehKey && !relayTemKey) return;
  if (ehKey) relayTemKey = true;
  var maxDecodeRelay = multiSala ? 12 : 30;
  if (relayDecoder.decodeQueueSize > maxDecodeRelay && !ehKey) return;
  relayQuadros++;
  if (!relayRxEnviado) {
    relayRxEnviado = true;
    enviarTela({ tipo: "quadro_rx" });
    logRelayDiag("primeiro_decode", {
      k: ehKey ? 1 : 0, bytes: payload.byteLength, quadros: relayQuadros
    });
  }
  try {
    // WebCodecs exige EncodedVideoChunk — objeto literal lança TypeError.
    var chunk = new EncodedVideoChunk({
      type: ehKey ? "key" : "delta",
      timestamp: timestamp,
      data: payload,
    });
    relayDecoder.decode(chunk);
    relaySemOutput++;
    // Envia N decodes sem output do decoder → problema de decode.
    if (relaySemOutput === 30 && !relayFrameOk) {
      logRelayDiag("sem_output", { quadros: relayQuadros, state: relayDecoder.state });
    }
  } catch (e) {
    ultimoErroRelay = "decode: " + e.message;
    relayTemKey = false;
    logRelayDiag("decode_erro", { msg: e.message, k: ehKey ? 1 : 0, quadros: relayQuadros });
  }
  if (!relayFrameOk) {
    clearTimeout(telaRelayTimer);
    telaRelayTimer = setTimeout(function () {
      if (!relayFrameOk && telaModoRelay) {
        diagnosticarRelaySemVideo();
      }
    }, 8000);
  }
}

// Monta quadro fragmentado (proxy do Discord cai com mensagem única grande).
function montarQuadroRelay(dados) {
  if (!dados || !dados.d) return;
  if (!dados.n || dados.n <= 1) {
    processarParteRelay(dados.t, dados);
    return;
  }
  var t = dados.t;
  var buf = relayPartes[t];
  if (!buf) {
    buf = relayPartes[t] = { k: dados.k, n: dados.n, recebidas: 0, partes: [] };
  }
  if (buf.partes[dados.i]) return;
  buf.partes[dados.i] = dados.d;
  buf.recebidas++;
  if (buf.recebidas >= buf.n) {
    delete relayPartes[t];
    processarParteRelay(t, { k: buf.k, d: buf.partes.join("") });
  }
}

function processarParteRelay(t, dados) {
  try {
    var bin = atob(dados.d);
    var payload = new Uint8Array(bin.length);
    for (var qi = 0; qi < bin.length; qi++) payload[qi] = bin.charCodeAt(qi);
    decodificarRelayFrame(dados.k === 1, t >>> 0, payload);
  } catch (e) {
    console.warn("quadro relay:", e);
  }
}

async function iniciarEncoderRelay() {
  if (relayAtivo || !telaEhHost) return;
  if (!telaStream) {
    enviarTela({ tipo: "relay_erro", mensagem: "Captura de tela indisponível no transmissor." });
    return;
  }
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") {
    enviarTela({ tipo: "relay_erro", mensagem: "Navegador de quem transmite não tem WebCodecs." });
    return;
  }
  relayAtivo = true;
  var preset = TELA_PRESETS[telaResolucao];

  var canvas = document.createElement("canvas");
  canvas.width = preset.largura;
  canvas.height = preset.altura;
  var ctx = canvas.getContext("2d", { alpha: false });

  var video = hostVideoEncoder();
  var tsUs = 0;
  var ultimoKey = 0;
  var ticksSemVideo = 0;
  var inicioSemChunk = performance.now();
  var saidasRecebidas = 0;

  relayEncoder = new VideoEncoder({
    output: function (chunk) {
      try {
        saidasRecebidas++;
        if (!telaWs || telaWs.readyState !== WebSocket.OPEN) return;
        var dados = new Uint8Array(chunk.byteLength);
        chunk.copyTo(dados);
        // O proxy do Discord NÃO repassa frame binário no WS da Activity —
        // manda como JSON base64 em partes de ~12KB (mensagem única grande cai).
        var s = "";
        for (var i = 0; i < dados.length; i += 0x8000) {
          s += String.fromCharCode.apply(null, dados.subarray(i, i + 0x8000));
        }
        var b64 = btoa(s);
        var k = chunk.type === "key" ? 1 : 0;
        var t = chunk.timestamp;
        var TAM = 12000;
        if (b64.length <= TAM) {
          enviarTela({ tipo: "quadro", k: k, t: t, d: b64 });
        } else {
          var n = Math.ceil(b64.length / TAM);
          for (var pi = 0; pi < n; pi++) {
            enviarTela({
              tipo: "quadro", k: k, t: t, n: n, i: pi,
              d: b64.slice(pi * TAM, (pi + 1) * TAM),
            });
          }
        }
        if (!relayProntoEnviado) {
          relayProntoEnviado = true;
          enviarTela({ tipo: "relay_pronto", codec: relayCodecAtual });
        }
      } catch (e) {
        enviarTela({ tipo: "relay_erro", mensagem: "Falha ao enviar quadro do encoder: " + e.message });
        pararEncoderRelay();
      }
    },
    error: function (e) {
      console.warn("Encoder relay:", e);
      enviarTela({ tipo: "relay_erro", mensagem: String(e && e.message ? e.message : e) });
      pararEncoderRelay();
    },
  });

  // Prefere VP8 no relay: o viewer da Activity nem sempre tem H.264 em WebCodecs.
  // (H.264 quebrava com "Unsupported configuration" no decoder.)
  relayCodecAtual = "vp8";
  enviarTela({ tipo: "relay_codec", codec: "vp8" });
  logRelayDiag("encoder_codec", { codec: "vp8" });

  function cfgEncoder(w, h) {
    return {
      codec: "vp8",
      width: w,
      height: h,
      framerate: telaFps,
      bitrate: bitrateRelay(),
      latencyMode: "realtime",
    };
  }

  try {
    relayEncoder.configure(cfgEncoder(canvas.width, canvas.height));
  } catch (e) {
    // contentHint/latencyMode podem não existir — reconfigura sem.
    try {
      relayEncoder.configure({
        codec: "vp8",
        width: canvas.width,
        height: canvas.height,
        framerate: telaFps,
        bitrate: bitrateRelay(),
      });
    } catch (e2) {
      enviarTela({ tipo: "relay_erro", mensagem: "Falha ao configurar encoder: " + e2.message });
      pararEncoderRelay();
      return;
    }
  }

  // Aba em segundo plano: Chrome pausa/throttla timers — reforça o play e
  // força keyframe ao voltar para a frente.
  function aoVoltarAba() {
    if (!document.hidden && relayAtivo && video) {
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
      relayForcarKey = true;
    }
  }
  document.addEventListener("visibilitychange", aoVoltarAba);
  relayEncoderVisibilityListener = aoVoltarAba;

  // setTimeout recursivo: lê telaFps ao vivo e não acumula atraso como setInterval.
  var relayDrawRodando = false;
  function agendarDraw() {
    if (!relayAtivo || relayDrawRodando) return;
    relayDrawRodando = true;
    var intervalo = Math.max(16, Math.floor(1000 / telaFps));
    relayDrawTimer = setTimeout(function () {
      relayDrawRodando = false;
      if (!relayAtivo || !relayEncoder || relayEncoder.state === "closed") return;
      // Multi: reavalia a fonte (tile.preview pode só existir depois do grid).
      if (multiSala) {
        var fonte = hostVideoEncoder();
        if (fonte && fonte !== video) video = fonte;
      }
      if (video && video.paused) {
        var p = video.play();
        if (p && p.catch) p.catch(function () {});
      }
      if (!video || video.readyState < 2 || !video.videoWidth) {
        ticksSemVideo++;
        if (ticksSemVideo === 300) { // ~10s mesmo com timer throttado
          enviarTela({ tipo: "relay_erro", mensagem: "O vídeo da captura não carregou no transmissor (readyState=" +
            (video ? video.readyState : "nulo") + ", escondido=" + document.hidden + "). Ctrl+F5 e transmita de novo." });
          pararEncoderRelay();
        }
        agendarDraw();
        return;
      }
      ticksSemVideo = 0;
      // Fila maior = menos frames descartados em picos (qualidade/fps).
      // Multi: fila > 6 começa a atrasar — descarta antes (menos delay).
      var maxFila = multiSala ? 6 : 4;
      if (relayEncoder.encodeQueueSize > maxFila) {
        agendarDraw();
        return;
      }
      var frame;
      try {
        // Usa o tamanho REAL do vídeo capturado (não força upscale do preset).
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          var vw = video.videoWidth || canvas.width;
          var vh = video.videoHeight || canvas.height;
          // Limita ao preset (não manda acima do combinado).
          var maxW = preset.largura;
          var maxH = preset.altura;
          var escala = Math.min(1, maxW / vw, maxH / vh);
          canvas.width = Math.round(vw * escala);
          canvas.height = Math.round(vh * escala);
          if (relayEncoder.state === "configured") {
            // Reconfigura o encoder com a resolução real.
            relayEncoder.configure(cfgEncoder(canvas.width, canvas.height));
          }
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        frame = new VideoFrame(canvas, { timestamp: tsUs });
      } catch (e) {
        enviarTela({ tipo: "relay_erro", mensagem: "Falha ao capturar quadro: " + e.message });
        pararEncoderRelay();
        return;
      }
      tsUs += Math.round(1000000 / telaFps);
      var agora = performance.now();
      // Keyframe: multi 500ms (join rápido + menos delay acumulado no GOP),
      // single 1s (economiza bitrate).
      var intervaloKey = multiSala ? 500 : 1000;
      var forcar = relayForcarKey || (agora - ultimoKey) >= intervaloKey;
      if (forcar) { ultimoKey = agora; relayForcarKey = false; }
      try {
        relayEncoder.encode(frame, { keyFrame: forcar });
      } catch (e) {
        enviarTela({ tipo: "relay_erro", mensagem: "encode() falhou: " + e.message });
        frame.close();
        pararEncoderRelay();
        return;
      }
      frame.close();
      if (!relayProntoEnviado && (performance.now() - inicioSemChunk) > 6000) {
        enviarTela({ tipo: "relay_erro", mensagem: "Encoder sem chunk em 6s (saidas=" + saidasRecebidas +
          ", estado=" + relayEncoder.state + ", escondido=" + document.hidden + ")." });
        pararEncoderRelay();
        return;
      }
      agendarDraw();
    }, intervalo);
  }
  agendarDraw();
}

// Vídeo do host na multi-tela: a seção #tela-transmissao fica escondida.
// Prefere o preview visível do tile; senão usa um <video> minúsculo ON-SCREEN
// (left:-9999px pode não ser pintado pelo compositor → fps cai / atraso sobe).
var hostOffVideo = null;
function hostVideoEncoder() {
  if (multiSala && telaEhHost && telaStream) {
    var tileHost = multiTiles[telaSala] || multiTiles[multiHostSala];
    if (tileHost && tileHost.preview && tileHost.preview.srcObject === telaStream) {
      if (tileHost.preview.paused) {
        var pr0 = tileHost.preview.play();
        if (pr0 && pr0.catch) pr0.catch(function () {});
      }
      if (hostOffVideo && hostOffVideo.srcObject) hostOffVideo.srcObject = null;
      return tileHost.preview;
    }
    if (!hostOffVideo) {
      hostOffVideo = document.createElement("video");
      hostOffVideo.autoplay = true;
      hostOffVideo.muted = true;
      hostOffVideo.playsInline = true;
      hostOffVideo.setAttribute("playsinline", "");
      hostOffVideo.style.cssText =
        "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.02;pointer-events:none;z-index:1;";
      document.body.appendChild(hostOffVideo);
    }
    if (hostOffVideo.srcObject !== telaStream) hostOffVideo.srcObject = telaStream;
    if (hostOffVideo.paused) {
      var pr = hostOffVideo.play();
      if (pr && pr.catch) pr.catch(function () {});
    }
    return hostOffVideo;
  }
  if (hostOffVideo && hostOffVideo.srcObject) hostOffVideo.srcObject = null;
  return videoTransmissaoEl;
}

function pararEncoderRelay() {
  relayAtivo = false;
  relayProntoEnviado = false;
  clearTimeout(relayDrawTimer);
  clearInterval(relayDrawTimer);
  relayDrawTimer = null;
  if (relayEncoderVisibilityListener) {
    document.removeEventListener("visibilitychange", relayEncoderVisibilityListener);
    relayEncoderVisibilityListener = null;
  }
  if (relayEncoder) {
    try { if (relayEncoder.state !== "closed") relayEncoder.close(); } catch (e) { /* ignore */ }
    relayEncoder = null;
  }
  pararEncoderAudioRelay();
}

function reiniciarEncoderRelaySeAtivo() {
  if (relayAtivo) {
    pararEncoderRelay();
    if (telaRelayTotal > 0) {
      iniciarEncoderRelay().catch(function (e) {
        console.warn("Encoder relay:", e);
        enviarTela({ tipo: "relay_erro", mensagem: String(e) });
      });
      iniciarEncoderAudioRelay();
    }
  }
}

// ---------------------------------------------------------------------------
// Compartilhar Tela - hub
// ---------------------------------------------------------------------------
function abrirTelaCompartilhar() {
  mostrarTela(telaCompartilhar);
  mensagemTela("");
  var naActivity = dentroDaActivity();
  var celular = ehMobile();
  // Celular não transmite: nenhum browser mobile tem getDisplayMedia.
  document.querySelector("#tela-aviso-navegador").style.display = (naActivity && !celular) ? "" : "none";
  var painel = document.querySelector("#painel-criar");
  if (painel) painel.style.display = (naActivity || celular) ? "none" : "";
  document.querySelector("#abrir-navegador-tela").style.display = "";
  var avisoMobile = document.querySelector("#tela-aviso-mobile");
  if (avisoMobile) {
    avisoMobile.style.display = celular ? "" : "none";
  }

  // Lista sempre visível: salas públicas + da call (se houver instância).
  document.querySelector("#lista-transmissoes").style.display = "";
  document.querySelector("#atualizar-transmissoes").style.display = "";
  document.querySelector("#assistir-titulo-lista").style.display = "";
  document.querySelector("#assistir-titulo-lista").textContent = "Transmissões públicas";

  aplicarFormularioCriacao();
  atualizarAvisoUpload();
  carregarTransmissoes();
  carregarSalasMulti();
}

async function abrirNoNavegadorParaTransmitir() {
  // Sempre o site real: dentro da Activity location.origin é o proxy do
  // Discord (discordsays.com) e o WS do host pode não funcionar por lá.
  var url = appOrigin() + "/?transmitir=1";
  var instancia = compartilharInstanciaAtual();
  if (instancia) url += "&instancia=" + encodeURIComponent(instancia);

  if (discordSdkGlobal) {
    try {
      await discordSdkGlobal.commands.openExternalLink({ url: url });
      return;
    } catch (e) { /* fallback abaixo */ }
  }
  window.open(url, "_blank");
}

async function carregarTransmissoes() {
  var container = document.querySelector("#lista-transmissoes");
  var url = "./tela/transmissoes";
  var instancia = compartilharInstanciaAtual();
  if (instancia) url += "?instancia=" + encodeURIComponent(instancia);

  try {
    var res = await fetch(url);
    var dados = await res.json();
    var lista = dados.transmissoes || [];
    try {
      var resMulti = await fetch("./multitela/salas");
      var dadosMulti = await resMulti.json();
      (dadosMulti.salas || []).forEach(function (s) {
        lista.push({
          multi: true,
          sala: s.sala,
          nick: s.dono_nick || "Anônimo",
          avatar: s.dono_avatar || null,
          publica: true,
          resolucao: "720p",
          fps: 30,
          espectadores: s.total_membros || 0,
          nome: s.nome,
          lives: s.total_lives || 0,
        });
      });
    } catch (eMulti) { /* lista multi é opcional */ }
    container.innerHTML = "";

    if (lista.length === 0) {
      container.innerHTML = '<p class="vazio">Nenhuma transmissão ativa.</p>';
      return;
    }

    lista.forEach(function (t) {
      var item = document.createElement("div");
      item.className = "sala-item";
      var avatarHtml = t.avatar
        ? '<img class="sala-item-avatar" src="' + escapeHtml(t.avatar) + '" alt="" />'
        : '<span class="sala-item-avatar sala-item-avatar-inicial">' + escapeHtml((t.nick || "?").charAt(0).toUpperCase()) + "</span>";
      item.innerHTML =
        '<div class="sala-item-info">' +
        avatarHtml +
        "<span><strong>" + escapeHtml(t.multi ? (t.nome || t.nick) : t.nick) + "</strong>" +
        (t.multi ? ' <span class="etiqueta-publica">multi-tela</span>' : "") +
        (t.publica && !t.multi ? ' <span class="etiqueta-publica">pública</span>' : "") +
        "<small>" + t.resolucao + " &middot; " + t.fps + " fps &middot; sala " + escapeHtml(t.sala) +
        (t.multi ? " &middot; " + (t.lives || 0) + "/8 telas" : "") + "</small></span>" +
        "</div>" +
        '<span class="sala-item-jogadores">&#128247; ' + t.espectadores + (t.multi ? "" : "/9") + "</span>";
      item.addEventListener("click", function () {
        if (t.multi) entrarSalaMulti(t.sala);
        else assistirTransmissao(t.sala);
      });
      container.appendChild(item);
    });
  } catch (e) {
    container.innerHTML = '<p class="vazio">Erro ao carregar transmissões.</p>';
  }
}

// ---------------------------------------------------------------------------
// Compartilhar Tela - host
// ---------------------------------------------------------------------------
function ehMobile() {
  var ua = navigator.userAgent || "";
  if (/Android|iPhone|iPad|iPod|Mobile|Silk/i.test(ua)) return true;
  return navigator.maxTouchPoints > 1 && Math.min(window.innerWidth, window.innerHeight) < 900;
}

function suportaCapturaTela() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

async function opcoesCapturaVideo() {
  var preset = TELA_PRESETS[telaResolucao];
  // max 60 desde o início: trocar 30→60 ao vivo não pede nova captura.
  return {
    width: { ideal: preset.largura },
    height: { ideal: preset.altura },
    frameRate: { ideal: telaFps, max: 60 },
  };
}

function podeCapturarMidia() {
  if (navigator.mediaDevices && (navigator.mediaDevices.getDisplayMedia || navigator.mediaDevices.getUserMedia)) {
    return true;
  }
  return !!(navigator.webkitGetUserMedia || navigator.getUserMedia || navigator.mozGetUserMedia);
}

function gumLegado(constraints) {
  return new Promise(function (resolve, reject) {
    var fn = navigator.mediaDevices && navigator.mediaDevices.getUserMedia
      ? null
      : (navigator.webkitGetUserMedia || navigator.getUserMedia || navigator.mozGetUserMedia);
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia(constraints).then(resolve, reject);
      return;
    }
    if (!fn) {
      reject(new Error("SEU_NAVEGADOR_SEM_CAPTURE"));
      return;
    }
    fn.call(navigator, constraints, resolve, reject);
  });
}

async function capturarMidiaTransmissao(querAudio) {
  var video = await opcoesCapturaVideo();
  var semDisplay = !suportaCapturaTela();

  // 1) Tenta Screen Capture API em qualquer dispositivo (desktop e mobile).
  // No Chrome Android/iOS o picker pode não existir → cai no fallback câmera.
  if (suportaCapturaTela()) {
    try {
      var opcoes = {
        video: video,
        // Tela inteira: permite "Share system audio" (usuário pode marcar).
        systemAudio: "include",
        // NÃO usar windowAudio:"window" — no Chrome 143+ vira "exclude" e
        // MATA o áudio ao compartilhar janela. Default oferece áudio normal.
      };
      opcoes.audio = querAudio ? {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      } : false;
      telaFonte = "tela";
      var streamDisplay = await navigator.mediaDevices.getDisplayMedia(opcoes);
      try {
        var st = streamDisplay.getVideoTracks()[0] &&
          streamDisplay.getVideoTracks()[0].getSettings
          ? streamDisplay.getVideoTracks()[0].getSettings() : {};
        logRelayDiag("display_capture", {
          surface: st.displaySurface || "?",
          temAudio: streamDisplay.getAudioTracks().length > 0,
        });
      } catch (eSt) { /* settings é best-effort */ }
      return streamDisplay;
    } catch (e) {
      if (e && (e.name === "NotAllowedError" || e.name === "AbortError")) {
        // Mobile: sem picker de tela → tenta câmera em vez de abortar.
        if (!ehMobile()) throw e;
        logRelayDiag("displaymedia_negado_mobile", { msg: e && e.message });
      } else {
        logRelayDiag("displaymedia_falhou", { msg: e && e.message });
      }
    }
  }

  if (!podeCapturarMidia()) {
    if (!window.isSecureContext) {
      throw new Error("INSEGURO");
    }
    throw new Error("SEU_NAVEGADOR_SEM_CAPTURE");
  }

  // 2) Firefox — screen via getUserMedia legado.
  if (telaFonte !== "camera") {
    try {
      telaFonte = "tela_legado";
      return await gumLegado({
        video: Object.assign({ mediaSource: "screen" }, video),
        audio: querAudio ? {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        } : false,
      });
    } catch (e) {
      if (e && e.name === "NotAllowedError" && !ehMobile()) throw e;
      logRelayDiag("screen_legado_falhou", { msg: e && e.message });
    }
  }

  // 3) Tela indisponível/negada → câmera (frente/verso).
  telaFonte = "camera";
  if (semDisplay || ehMobile()) {
    logRelayDiag("fallback_camera_mobile", { semDisplay: semDisplay });
  }
  try {
    return await gumLegado({
      video: Object.assign({ facingMode: { ideal: cameraFacing } }, video),
      audio: querAudio ? {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      } : false,
    });
  } catch (e) {
    if (e && e.message === "SEU_NAVEGADOR_SEM_CAPTURE") throw e;
    if (e && e.name === "NotAllowedError") throw e;
    // Último recurso: constraints mínimos (câmera traseira simples).
    try {
      return await gumLegado({
        video: { facingMode: "environment" },
        audio: false,
      });
    } catch (e2) {
      throw e;
    }
  }
}

function rotuloFonteCaptura() {
  if (telaFonte === "camera") return "câmera do celular";
  if (telaFonte === "tela_legado") return "tela";
  return "tela";
}

async function iniciarTransmissaoTela() {
  // Celular não tem captura de tela em navegador → bloqueia transmissão.
  if (ehMobile()) {
    mensagemTela("Celulares não conseguem transmitir — use o computador. No celular você ainda pode assistir às transmissões.", "erro");
    return;
  }
  // Painel em modo multi sem sala ainda → cria a sala e depois compartilha.
  if (formModoTela === "multi" && !multiSala) {
    await iniciarCriacaoMultiPainel();
    return;
  }
  if (!podeCapturarMidia()) {
    if (!window.isSecureContext) {
      mensagemTela("Abra o site em https:// para usar câmera/tela. No Discord, use o app ou navegador seguro.", "erro");
    } else {
      mensagemTela(
        "Seu navegador não permite câmera nem captura de tela. " +
        "Tente Chrome/Edge no computador, ou no celular abra em https:// com permissão de câmera.",
        "erro");
      if (/Android|iPhone|iPad/i.test(navigator.userAgent || "")) {
        var btnNav = document.querySelector("#btn-abrir-navegador");
        if (!btnNav) {
          btnNav = document.createElement("button");
          btnNav.id = "btn-abrir-navegador";
          btnNav.className = "botao";
          btnNav.style.marginTop = "10px";
          btnNav.textContent = "Abrir no navegador do celular";
          btnNav.addEventListener("click", function () {
            window.open(location.href, "_blank");
          });
          var barra = document.querySelector("#controles-transmissao") ||
            document.querySelector("#mensagem-transmissao");
          if (barra && barra.parentNode) barra.parentNode.insertBefore(btnNav, barra.nextSibling);
        }
      }
    }
    return;
  }

  var valCod = codigoCustomValido(formTipoSala === "privada");
  if (valCod.erro) {
    mensagemTela(valCod.erro, "erro");
    return;
  }
  var codigoCustom = valCod.codigo;

  var querAudio = true;
  var chkAudio = document.querySelector("#capturar-audio-tela");
  if (chkAudio) querAudio = !!chkAudio.checked;

  try {
    telaStream = await capturarMidiaTransmissao(querAudio);
  } catch (e) {
    if (e && e.message === "INSEGURO") {
      avisoTela("Abra em https:// — o navegador bloqueia câmera/tela fora de conexão segura.", "erro");
    } else if (e && e.message === "SEU_NAVEGADOR_SEM_CAPTURE") {
      avisoTela(
        "Este navegador não liberou câmera nem tela. No celular, permita a câmera nas permissões do site " +
        "(ícone de cadeado → Câmera → Permitir) e tente de novo.",
        "erro");
    } else if (e && e.name === "NotAllowedError") {
      avisoTela("Permissão negada. Autorize a câmera/tela nas permissões do site e tente de novo.", "erro");
    } else if (e && e.name === "NotReadableError") {
      avisoTela("A câmera está em uso por outro app. Feche o outro app e tente de novo.", "erro");
    } else if (e && e.name === "OverconstrainedError") {
      avisoTela("Não consegui abrir a câmera com essa qualidade. Tente de novo.", "erro");
    } else {
      avisoTela("Captura cancelada ou falhou: " + (e && e.message ? e.message : "erro desconhecido"), "erro");
    }
    return;
  }

  // Tela indisponível/negada → câmera: avisa o usuário (pós-falha).
  if (telaFonte === "camera" && ehMobile()) {
    avisoTela("Seu navegador não permitiu capturar a tela — transmitindo pela câmera (frente/verso).", "");
  }

  // Prefer fluidez sobre nitidez (menos delay no relay/multi).
  var trVidCap = telaStream.getVideoTracks()[0];
  if (trVidCap && "contentHint" in trVidCap) trVidCap.contentHint = "motion";

  // Avisa se o Chrome não devolveu áudio (usuário não marcou a opção).
  if (querAudio && !telaStream.getAudioTracks().length) {
    if (telaFonte === "camera") {
      avisoTela(
        "Microfone não capturado: permita o microfone no celular/navegador.", "erro");
    } else {
      avisoTela(
        "Áudio não capturado: no seletor do Chrome, marque \"Compartilhar áudio\" " +
        "(aba: \"Share tab audio\"; tela: \"Share system audio\"). " +
        "Em janela, use a aba se não houver opção de áudio. " +
        "Você pode recapturar com Trocar janela depois.", "erro");
    }
  }

  await garantirIdentidade();
  var nick = nomeExibicao();
  var avatar = avatarAtual();
  var instancia = compartilharInstanciaAtual() || null;
  var publica = formTipoSala === "publica";
  if (multiSala) {
    // Multi-tela: qualidade travada em 720p30, sala só da multi.
    telaResolucao = "720p";
    telaFps = 30;
    publica = false;
  }

  try {
    var res = await fetch("./tela/novo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instancia: instancia,
        nick: nick,
        avatar: avatar,
        resolucao: telaResolucao,
        fps: telaFps,
        codigo: multiSala ? null : codigoCustom,
        publica: publica,
        multi: multiSala || null,
      }),
    });
    var dados = await res.json();
    if (!res.ok) throw new Error(dados.detail || "Erro ao criar transmissão.");
    telaSala = dados.sala;
  } catch (e) {
    telaStream.getTracks().forEach(function (t) { t.stop(); });
    telaStream = null;
    avisoTela(e.message, "erro");
    return;
  }

  telaEhHost = true;
  configurarTelaTransmissaoHost();
  conectarWsTela(true);

  // Se o usuário parar a captura pelo botão do próprio navegador, encerra tudo.
  telaStream.getVideoTracks()[0].addEventListener("ended", function () {
    encerrarTransmissao(false);
    avisoTela("Transmissão encerrada: você parou a captura de tela.", "erro");
  });
}

function avisoTela(texto, tipo) {
  if (multiNaTela) {
    mensagemMulti(texto, tipo);
    return;
  }
  mensagemTela(texto, tipo);
}

function configurarTelaTransmissaoHost() {
  if (multiSala) {
    // Na multi-tela o host fica no grid; qualidade fixa 720p30.
    multiHostSala = telaSala;
    telaResolucao = "720p";
    telaFps = 30;
    var btnAb = document.querySelector("#multi-abrir-tela");
    var btnFe = document.querySelector("#multi-fechar-tela");
    var btnVo = document.querySelector("#multi-voltar-assistir");
    if (btnAb) btnAb.style.display = "none";
    if (btnFe) btnFe.style.display = "";
    if (btnVo) btnVo.style.display = "none";
    var q = document.querySelector("#transmissao-qualidade");
    if (q) q.classList.add("bloqueada");
    mensagemMulti("Sua tela está na sala (" + rotuloFonteCaptura() + ") · 720p 30fps.", "sucesso");
    videoTransmissaoEl.style.display = "none";
    canvasRelayEl.style.display = "none";
    videoTransmissaoEl.muted = true; // eco: host nunca ouve a própria captura
    videoTransmissaoEl.srcObject = telaStream;
    var trAudioHostM = telaStream.getAudioTracks()[0];
    if (trAudioHostM) trAudioHostM.enabled = !audioMudo;
    hostVideoEncoder();
    iniciarEncoderAudioRelay();
    aplicarVolumeLocal();
    if (multiNaTela && !multiTiles[telaSala]) {
      criarTileMulti({ sala: telaSala, eu: true, nick: nomeExibicao() });
    }
    // Host não pode assistir a própria live (eco).
    if (multiTiles[telaSala]) desligarViewerMulti(multiTiles[telaSala]);
    return;
  }
  mostrarTela(telaTransmissaoEl);
  var fonte = rotuloFonteCaptura();
  mensagemTransmissao(
    "Você está transmitindo (" + fonte + ") em " + telaResolucao + " " + telaFps + "fps.",
    "sucesso");
  mostrarBadgeQualidade(telaResolucao, telaFps, relayCodecAtual);
  document.querySelector("#transmissao-papel").textContent = "Transmitindo";
  document.querySelector("#transmissao-codigo-valor").textContent = telaSala;
  document.querySelector("#transmissao-codigo-display").style.display = "";
  document.querySelector("#transmissao-viewers-contador").textContent = "0";
  document.querySelector("#transmissao-viewers-bar").style.display = "";
  document.querySelector("#encerrar-transmissao").style.display = "";
  document.querySelector("#parar-assistir").style.display = "none";
  document.querySelector("#transmissao-qualidade").style.display = "";
  var btnTrocar = document.querySelector("#trocar-janela");
  if (btnTrocar) {
    btnTrocar.textContent = telaFonte === "camera"
      ? "Trocar câmera (frente/verso)"
      : "Trocar programa/janela da transmissão";
  }
  controlesTransmissaoEl.style.display = "flex";
  btnMudoEl.title = "Mudo do que você está enviando";
  document.querySelectorAll("#live-resolucao .botao-preset").forEach(function (b) {
    b.classList.toggle("selecionado", b.dataset.resolucao === telaResolucao);
  });
  document.querySelectorAll("#live-fps .botao-preset").forEach(function (b) {
    b.classList.toggle("selecionado", parseInt(b.dataset.fps, 10) === telaFps);
  });
  videoTransmissaoEl.style.display = "";
  canvasRelayEl.style.display = "none";
  // Preview do host mudo por padrão (evita eco); botão controla o envio.
  videoTransmissaoEl.muted = true;
  videoTransmissaoEl.volume = volumeLocal;
  videoTransmissaoEl.srcObject = telaStream;
  var trAudioHost = telaStream.getAudioTracks()[0];
  if (trAudioHost) trAudioHost.enabled = !audioMudo;
  iniciarEncoderAudioRelay();
  aplicarVolumeLocal();
  var p = videoTransmissaoEl.play();
  if (p && p.catch) p.catch(function () { /* autoplay pode exigir gesto — silencioso */ });
}

function criarPeerParaViewer(viewerId) {
  if (telaPeers[viewerId]) {
    telaPeers[viewerId].close();
    delete telaPeers[viewerId];
  }

  var pc = new RTCPeerConnection(RTC_CONFIG);
  telaPeers[viewerId] = pc;

  telaStream.getTracks().forEach(function (track) {
    pc.addTrack(track, telaStream);
  });

  var sender = pc.getSenders().filter(function (s) { return s.track && s.track.kind === "video"; })[0];
  aplicarParamsSender(sender);

  pc.onicecandidate = function (evento) {
    if (evento.candidate) {
      enviarTela({ tipo: "ice", viewer_id: viewerId, dados: evento.candidate.toJSON() });
    }
  };

  pc.onconnectionstatechange = function () {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      if (telaPeers[viewerId]) {
        delete telaPeers[viewerId];
      }
    }
  };

  pc.createOffer()
    .then(function (oferta) { return pc.setLocalDescription(oferta); })
    .then(function () {
      enviarTela({ tipo: "oferta", viewer_id: viewerId, dados: pc.localDescription.sdp });
    })
    .catch(function (e) { console.warn("Falha ao criar oferta:", e); });
}

function encerrarTransmissao(silencioso) {
  limparConexaoTela();
  telaSala = null;
  if (telaEhHost && telaStream) {
    telaStream.getTracks().forEach(function (t) { t.stop(); });
  }
  telaStream = null;
  telaEhHost = false;
  if (hostOffVideo) hostOffVideo.srcObject = null;
  videoTransmissaoEl.srcObject = null;
  document.querySelector("#transmissao-codigo-display").style.display = "none";
  document.querySelector("#transmissao-viewers-bar").style.display = "none";
  document.querySelector("#transmissao-qualidade").style.display = "none";
  document.querySelector("#transmissao-qualidade").classList.remove("bloqueada");
  controlesTransmissaoEl.style.display = "none";
  var badgeOff = document.querySelector("#qualidade-badge");
  if (badgeOff) badgeOff.style.display = "none";
  if (multiSala) {
    multiHostSala = null;
    var btnAb = document.querySelector("#multi-abrir-tela");
    var btnFe = document.querySelector("#multi-fechar-tela");
    var btnVo = document.querySelector("#multi-voltar-assistir");
    if (btnAb) btnAb.style.display = "";
    if (btnFe) btnFe.style.display = "none";
    if (btnVo) btnVo.style.display = multiNaTela ? "" : "none";
    if (multiNaTela) {
      mensagemMulti("Sua tela foi encerrada. Você pode assistir às outras telas.", "");
      atualizarMultiEstado(multiEstado);
    }
    if (!silencioso && !multiNaTela) {
      mostrarTela(telaCompartilhar);
      carregarTransmissoes();
    }
    return;
  }
  if (!silencioso) {
    mostrarTela(telaCompartilhar);
    carregarTransmissoes();
  }
}

// ---------------------------------------------------------------------------
// Compartilhar Tela - espectador
// ---------------------------------------------------------------------------
async function assistirTransmissao(codigo) {
  codigo = (codigo || "").trim();
  if (!codigo) return;

  try {
    var res = await fetch("./tela/sala/" + encodeURIComponent(codigo));
    if (res.status === 404) {
      // Pode ser código de sala multi-tela.
      var resMulti = await fetch("./multitela/sala/" + encodeURIComponent(codigo));
      if (resMulti.ok) {
        entrarSalaMulti(codigo);
        return;
      }
      throw new Error("Transmissão não encontrada.");
    }
    if (!res.ok) throw new Error("Transmissão não encontrada.");
  } catch (e) {
    mensagemTela(e.message === "Failed to fetch" ? "Erro de conexão." : e.message, "erro");
    return;
  }

  // Quem acabou de criar a transmissão não deve entrar como viewer (eco).
  if (telaEhHost && telaSala === codigo) {
    mensagemTela("Você é quem está transmitendo nesta sala.", "erro");
    return;
  }

  telaEhHost = false;
  telaSala = codigo;
  telaModoRelay = dentroDaActivity();
  relayFrameOk = false;
  mostrarTela(telaTransmissaoEl);
  mensagemTransmissao("Conectando à transmissão...");
  document.querySelector("#transmissao-papel").textContent = "Assistindo";
  document.querySelector("#transmissao-codigo-display").style.display = "none";
  document.querySelector("#transmissao-viewers-bar").style.display = "none";
  document.querySelector("#encerrar-transmissao").style.display = "none";
  document.querySelector("#parar-assistir").style.display = "";
  document.querySelector("#transmissao-qualidade").style.display = "none";
  controlesTransmissaoEl.style.display = "flex";
  videoTransmissaoEl.style.display = telaModoRelay ? "none" : "";
  canvasRelayEl.style.display = telaModoRelay ? "" : "none";
  videoTransmissaoEl.srcObject = null;
  videoTransmissaoEl.muted = audioMudo;
  videoTransmissaoEl.volume = volumeLocal;
  var badge = document.querySelector("#qualidade-badge");
  if (badge) badge.style.display = "none";
  conectarWsTela(false);
}

function processarOfertaHost(sdp) {
  clearTimeout(telaOfertaTimer);
  if (telaPeerViewer) {
    telaPeerViewer.close();
  }

  var pc = new RTCPeerConnection(RTC_CONFIG);
  telaPeerViewer = pc;

  pc.ontrack = function (evento) {
    videoTransmissaoEl.srcObject = evento.streams[0];
    videoTransmissaoEl.muted = audioMudo;
    videoTransmissaoEl.volume = volumeLocal;
    var promessa = videoTransmissaoEl.play();
    if (promessa && promessa.then) {
      promessa.then(function () {
        if (multiNaTela && telaEhHost) return;
        mensagemTransmissao("Recebendo vídeo de quem transmite.", "sucesso");
      }).catch(function () {
        if (multiNaTela && telaEhHost) return;
        mensagemTransmissao("Vídeo recebido — clique no player para começar a assistir.");
      });
    }
  };

  pc.onicecandidate = function (evento) {
    if (evento.candidate) {
      enviarTela({ tipo: "ice", dados: evento.candidate.toJSON() });
    }
  };

  pc.onconnectionstatechange = function () {
    if (pc.connectionState === "failed") {
      mensagemTransmissao("Falha de conexão P2P com quem transmite.", "erro");
    }
  };

  pc.setRemoteDescription({ type: "offer", sdp: sdp })
    .then(function () { return pc.createAnswer(); })
    .then(function (resposta) { return pc.setLocalDescription(resposta); })
    .then(function () {
      enviarTela({ tipo: "resposta", dados: pc.localDescription.sdp });
    })
    .catch(function (e) {
      console.warn("Falha ao responder oferta:", e);
      mensagemTransmissao("Erro ao conectar na transmissão.", "erro");
    });
}

function pararDeAssistir() {
  limparConexaoTela();
  telaSala = null;
  telaEhHost = false;
  videoTransmissaoEl.srcObject = null;
  mostrarTela(telaCompartilhar);
  carregarTransmissoes();
}

// ---------------------------------------------------------------------------
// Compartilhar Tela - WebSocket de sinalização
// ---------------------------------------------------------------------------
var telaAbriu = false;
var telaTentativa = 1;
var TELA_MAX_TENTATIVAS = 3;

function enviarTela(obj) {
  if (telaWs && telaWs.readyState === WebSocket.OPEN) {
    telaWs.send(JSON.stringify(obj));
  }
}

function conectarWsTela(host, tentativa) {
  limparConexaoTela(); // não mexe em telaSala — quem chama já definiu a sala
  telaAbriu = false;
  telaTentativa = tentativa || 1;

  var nick = usuarioDiscord ? (usuarioDiscord.global_name || usuarioDiscord.username) : "Anônimo";
  var avatar = avatarAtual() || "";
  var logado = usuarioDiscord ? "1" : "0";
  var protocolo = location.protocol === "https:" ? "wss:" : "ws:";
  var url = protocolo + "//" + location.host + "/ws/tela/" + encodeURIComponent(telaSala) +
    "?papel=" + (host ? "host" : "viewer") + "&nick=" + encodeURIComponent(nick) +
    "&avatar=" + encodeURIComponent(avatar) +
    "&logado=" + logado +
    (!host && telaModoRelay ? "&transporte=relay" : "");

  var ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  telaWs = ws;

  clearInterval(telaPingTimer);
  telaPingTimer = setInterval(function () {
    enviarTela({ tipo: "ping" });
  }, 20000);

  ws.onopen = function () {
    telaAbriu = true;
    if (telaTentativa > 1) {
      mensagemTransmissao(host ? "Reconectado ao servidor." : "Reconectado. Recebendo transmissão...", "sucesso");
    }
  };

  ws.onmessage = function (evento) {
    if (typeof evento.data !== "string") {
      if (!host) receberRelay(evento.data);
      return;
    }
    try {
      processarMensagemTela(JSON.parse(evento.data));
    } catch (e) {
      console.error("Erro ao processar mensagem da tela:", e);
    }
  };

  ws.onclose = function (evento) {
    if (ws !== telaWs) return; // conexão já substituída/desligada de propósito
    clearInterval(telaPingTimer);
    if (!telaSala) return;
    console.warn("WS tela fechado: code=" + evento.code + " abriu=" + telaAbriu);

    // Nunca chegou a abrir: pode ser instância acordando/proxy — tenta de novo.
    if (!telaAbriu && telaTentativa < TELA_MAX_TENTATIVAS) {
      mensagemTransmissao("Reconectando ao servidor... (" + telaTentativa + "/" + TELA_MAX_TENTATIVAS + ")");
      setTimeout(function () {
        if (telaSala) conectarWsTela(host, telaTentativa + 1);
      }, 1500 * telaTentativa);
      return;
    }

    if (host) {
      encerrarTransmissao(true);
      if (multiNaTela) {
        avisoTela(telaAbriu
          ? "Conexão com o servidor foi encerrada."
          : "Não foi possível conectar ao servidor. Tente novamente.", "erro");
      } else {
        mensagemTela(telaAbriu
          ? "Conexão com o servidor foi encerrada."
          : "Não foi possível conectar ao servidor. Tente novamente.", "erro");
        mostrarTela(telaCompartilhar);
        carregarTransmissoes();
      }
    } else {
      encerrarViewerTela(telaAbriu
        ? "Conexão com o servidor foi encerrada."
        : "Não foi possível conectar ao servidor. Tente novamente.");
    }
  };

  ws.onerror = function () {};
}

// Fecha a conexão do espectador mostrando o erro sem voltar de tela antes da
// hora (o onclose é ignorado porque limparConexaoTela desliga os handlers).
function encerrarViewerTela(mensagem) {
  limparConexaoTela();
  telaSala = null;
  telaEhHost = false;
  document.querySelector("#parar-assistir").style.display = "none";
  document.querySelector("#encerrar-transmissao").style.display = "none";
  if (mensagem) mensagemTransmissao(mensagem, "erro");
}

function mostrarBadgeQualidade(res, fps, codec) {
  var el = document.querySelector("#qualidade-badge");
  if (!el) return;
  if (res) telaResolucao = res;
  if (typeof fps === "number" && fps > 0) telaFps = fps;
  if (codec) relayCodecAtual = codec;
  el.textContent = telaResolucao + " · " + telaFps + " fps · " + String(relayCodecAtual || "vp8").toUpperCase();
  el.style.display = "";
  document.querySelectorAll("#live-resolucao .botao-preset").forEach(function (b) {
    b.classList.toggle("selecionado", b.dataset.resolucao === telaResolucao);
  });
  document.querySelectorAll("#live-fps .botao-preset").forEach(function (b) {
    b.classList.toggle("selecionado", parseInt(b.dataset.fps, 10) === telaFps);
  });
}

function processarMensagemTela(dados) {
  switch (dados.tipo) {
    case "entrada_ok":
      mostrarBadgeQualidade(dados.resolucao, dados.fps, dados.codec || relayCodecAtual);
      mensagemTransmissao("Conectado a " + dados.nick + " (" + dados.resolucao + " " + dados.fps + "fps). Aguardando vídeo...", "sucesso");
      clearTimeout(telaOfertaTimer);
      clearTimeout(telaRelayTimer);
      relayFrameOk = false;
      relayHostOk = dados.host_conectado === true;
      if (dados.codec) relayCodecAtual = dados.codec;
      if (telaModoRelay) {
        iniciarDecoderRelay(dados.resolucao, dados.codec || relayCodecAtual);
        telaRelayTimer = setTimeout(diagnosticarRelaySemVideo, 15000);
      } else if (!telaEhHost) {
        telaOfertaTimer = setTimeout(async function () {
          if (telaEhHost || !telaSala || telaPeerViewer || telaModoRelay) return;
          var codigo = telaSala;
          try {
            var res = await fetch("./tela/sala/" + encodeURIComponent(codigo));
            if (res.status === 404) {
              encerrarViewerTela("A transmissão foi encerrada (sala " + codigo + ").");
              return;
            }
            var info = await res.json();
            if (info.host_conectado === false) {
              mensagemTransmissao("Quem transmite não está conectado ao servidor. Peça para ele abrir a transmissão de novo (sala " + codigo + ").", "erro");
            } else {
              mensagemTransmissao("Conectado ao servidor, mas o vídeo ainda não chegou. Confirme que quem transmite está transmitindo (sala " + codigo + ").", "erro");
            }
          } catch (e) {
            mensagemTransmissao("Conectado ao servidor, mas o vídeo ainda não chegou (sala " + codigo + ").", "erro");
          }
        }, 12000);
      }
      break;
    case "host_conectado":
      if (!telaEhHost && telaModoRelay) {
        relayHostOk = true;
        mensagemTransmissao("Quem transmite conectou — recebendo vídeo...", "sucesso");
        if (!relayFrameOk) {
          clearTimeout(telaRelayTimer);
          telaRelayTimer = setTimeout(diagnosticarRelaySemVideo, 15000);
        }
      }
      break;
    case "relay_total":
      telaRelayTotal = dados.total || 0;
      if (telaEhHost) {
        if (telaRelayTotal > 0) {
          relayForcarKey = true;
          if (!relayAtivo) {
            iniciarEncoderRelay().catch(function (e) {
              console.warn("Encoder relay:", e);
              enviarTela({ tipo: "relay_erro", mensagem: String(e) });
            });
          }
          iniciarEncoderAudioRelay();
        } else if (relayAtivo) {
          pararEncoderRelay();
        }
      }
      break;
    case "quadro":
      // Vídeo do relay em JSON base64 (proxy do Discord não repassa binário).
      if (telaModoRelay && !telaEhHost && dados.d) {
        montarQuadroRelay(dados);
      }
      break;
    case "audio":
      // Áudio Opus do relay em JSON base64.
      if (telaModoRelay && !telaEhHost) {
        receberAudioRelay(dados);
      }
      break;
    case "relay_codec":
      if (dados.codec) {
        relayCodecAtual = dados.codec;
        mostrarBadgeQualidade(null, null, dados.codec);
        if (telaModoRelay && !telaEhHost) {
          // Recria decoder com o codec/resolução da sala (não o default local).
          iniciarDecoderRelay(telaResolucao || "720p", dados.codec);
        }
      }
      break;
    case "config":
      // Líder mudou qualidade ao vivo — espectador atualiza badge/canvas.
      mostrarBadgeQualidade(dados.resolucao, dados.fps, null);
      if (telaModoRelay && !telaEhHost && dados.resolucao) {
        iniciarDecoderRelay(dados.resolucao, relayCodecAtual);
      }
      if (!telaEhHost) {
        mensagemTransmissao(
          "Qualidade da transmissão: " + telaResolucao + " " + telaFps + "fps.",
          "sucesso");
      }
      break;
    case "relay_pronto":
      if (telaModoRelay && !relayFrameOk) {
        // Não sobrescreve erro de decoder já mostrado.
        if (!ultimoErroRelay) {
          mensagemTransmissao("Transmitindo via relay — aguardando os primeiros quadros...", "sucesso");
        }
        clearTimeout(telaRelayTimer);
        telaRelayTimer = setTimeout(function () {
          if (!relayFrameOk && telaModoRelay) {
            diagnosticarRelaySemVideo();
          }
        }, 15000);
      }
      break;
    case "relay_erro":
      if (telaModoRelay) {
        clearTimeout(telaRelayTimer);
        mensagemTransmissao(dados.mensagem || "Quem transmite teve um erro no encoder.", "erro");
      }
      break;
    case "viewers_total":
    case "viewers_lista":
      if (telaEhHost) {
        document.querySelector("#transmissao-viewers-contador").textContent = String(dados.total || 0);
        var barEl = document.querySelector("#transmissao-viewers-bar");
        var listaEl = document.querySelector("#transmissao-viewers-lista");
        if (listaEl && dados.viewers) {
          listaEl.innerHTML = "";
          dados.viewers.forEach(function (v) {
            var chip = document.createElement("span");
            chip.className = "viewer-chip" + (v.logado ? " logado" : " anon");
            chip.title = v.logado ? (v.nick + " (Discord)") : (v.nick + " (site)");
            if (v.avatar) {
              var img = document.createElement("img");
              img.src = v.avatar;
              img.alt = "";
              chip.appendChild(img);
            } else {
              var ini = document.createElement("span");
              ini.className = "viewer-inicial";
              ini.textContent = (v.nick || "?").charAt(0).toUpperCase();
              chip.appendChild(ini);
            }
            var nome = document.createElement("small");
            nome.textContent = v.logado ? v.nick : (v.nick === "Anônimo" ? "Anônimo" : v.nick);
            chip.appendChild(nome);
            if (telaEhHost && v.id) {
              var btnX = document.createElement("button");
              btnX.type = "button";
              btnX.className = "viewer-expulsar";
              btnX.title = "Expulsar";
              btnX.textContent = "×";
              btnX.addEventListener("click", function () {
                enviarTela({ tipo: "expulsar_viewer", viewer_id: v.id });
              });
              chip.appendChild(btnX);
            }
            listaEl.appendChild(chip);
          });
        }
        if (barEl) barEl.style.display = "";
      }
      break;
    case "expulso":
      encerrarViewerTela(dados.mensagem || "Você foi expulso da sala.");
      break;
    case "aguardando_host":
      mensagemTransmissao("Aguardando quem transmite conectar...");
      break;
    case "host_pronto":
      break;
    case "viewer_entrou":
      if (telaEhHost) criarPeerParaViewer(dados.viewer_id);
      break;
    case "viewer_saiu":
      if (telaEhHost && telaPeers[dados.viewer_id]) {
        telaPeers[dados.viewer_id].close();
        delete telaPeers[dados.viewer_id];
      }
      break;
    case "oferta":
      if (!telaEhHost) processarOfertaHost(dados.dados);
      break;
    case "resposta":
      if (telaEhHost && telaPeers[dados.viewer_id]) {
        telaPeers[dados.viewer_id].setRemoteDescription({ type: "answer", sdp: dados.dados })
          .catch(function (e) { console.warn("Falha ao aplicar resposta:", e); });
      }
      break;
    case "ice":
      if (telaEhHost && telaPeers[dados.viewer_id]) {
        telaPeers[dados.viewer_id].addIceCandidate(dados.dados).catch(function () {});
      } else if (!telaEhHost && telaPeerViewer) {
        telaPeerViewer.addIceCandidate(dados.dados).catch(function () {});
      }
      break;
    case "transmissao_encerrada":
      // O host saiu: a sala foi fechada — derruba o espectador.
      if (telaPeerViewer) {
        limparConexaoTela();
        telaPeerViewer = null;
      }
      videoTransmissaoEl.srcObject = null;
      mensagemTransmissao("A transmissão foi encerrada" +
        (dados.motivo === "host_saiu" ? ": quem transmitiu saiu." : "."), "erro");
      if (multiNaTela) break;
      setTimeout(function () {
        telaSala = null;
        mostrarTela(telaCompartilhar);
        carregarTransmissoes();
      }, 2500);
      break;
    case "erro":
      // O servidor vai fechar a conexão: desliga os handlers ANTES para o
      // onclose não sobrescrever esta mensagem.
      if (telaEhHost) {
        encerrarTransmissao(true);
        avisoTela(dados.mensagem, "erro");
        if (!multiNaTela) {
          mensagemTela(dados.mensagem, "erro");
          mostrarTela(telaCompartilhar);
          carregarTransmissoes();
        }
      } else {
        encerrarViewerTela(dados.mensagem);
      }
      break;
  }
}

function limparConexaoTela() {
  clearTimeout(telaOfertaTimer);
  clearTimeout(telaRelayTimer);
  relayFrameOk = false;
  relayHostOk = false;
  pararDecoderRelay();
  pararEncoderRelay();
  pararEncoderAudioRelay();
  pararDecoderAudioRelay();
  if (telaWs) {
    var ws = telaWs;
    telaWs = null;
    clearInterval(telaPingTimer);
    // Desliga os handlers ANTES de fechar: fechações propositais não devem
    // disparar a lógica de onclose (senão derrubam a nova conexão).
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try { ws.send(JSON.stringify({ tipo: "sair" })); } catch (e) { /* ignore */ }
    try { ws.close(); } catch (e) { /* ignore */ }
  }
  Object.keys(telaPeers).forEach(function (id) {
    telaPeers[id].close();
  });
  telaPeers = {};
  if (telaPeerViewer) {
    telaPeerViewer.close();
    telaPeerViewer = null;
  }
}

// ---------------------------------------------------------------------------
// Compartilhar Tela - event listeners
// ---------------------------------------------------------------------------
document.querySelector("#jogo-tela").addEventListener("click", abrirTelaCompartilhar);

document.querySelector("#abrir-navegador-tela").addEventListener("click", abrirNoNavegadorParaTransmitir);

document.querySelectorAll("#preset-resolucao .botao-preset, #live-resolucao .botao-preset").forEach(function (botao) {
  botao.addEventListener("click", function () {
    definirResolucao(botao.dataset.resolucao);
  });
});

document.querySelectorAll("#preset-fps .botao-preset, #live-fps .botao-preset").forEach(function (botao) {
  botao.addEventListener("click", function () {
    definirFps(parseInt(botao.dataset.fps, 10));
  });
});

document.querySelector("#iniciar-transmissao").addEventListener("click", iniciarTransmissaoTela);

document.querySelectorAll("#op-tipo-sala .botao-preset").forEach(function (botao) {
  botao.addEventListener("click", function () {
    formTipoSala = botao.dataset.tipo === "privada" ? "privada" : "publica";
    document.querySelectorAll("#op-tipo-sala .botao-preset").forEach(function (b) {
      b.classList.toggle("selecionado", b === botao);
    });
    aplicarFormularioCriacao();
  });
});

document.querySelectorAll("#op-modo-tela .botao-preset").forEach(function (botao) {
  botao.addEventListener("click", function () {
    formModoTela = botao.dataset.modo === "multi" ? "multi" : "normal";
    document.querySelectorAll("#op-modo-tela .botao-preset").forEach(function (b) {
      b.classList.toggle("selecionado", b === botao);
    });
    aplicarFormularioCriacao();
  });
});

document.querySelector("#trocar-janela").addEventListener("click", trocarJanelaTela);

// Controles de volume/mudo (host e viewer).
if (btnMudoEl) {
  btnMudoEl.addEventListener("click", function () {
    audioMudo = !audioMudo;
    btnMudoEl.textContent = audioMudo ? "🔇" : "🔊";
    btnMudoEl.classList.toggle("selecionado", audioMudo);
    aplicarVolumeLocal();
  });
}
if (volumeEl) {
  volumeEl.addEventListener("input", function () {
    volumeLocal = Math.max(0, Math.min(1, parseInt(volumeEl.value, 10) / 100));
    aplicarVolumeLocal();
  });
}
document.querySelectorAll("#tamanho-video .botao-preset").forEach(function (botao) {
  botao.addEventListener("click", function () {
    definirTamanhoVideo(botao.dataset.tam);
  });
});
// Restaura tamanho salvo.
try {
  var tamSalvo = localStorage.getItem("jj_tela_tam");
  if (tamSalvo) definirTamanhoVideo(tamSalvo);
} catch (e) { /* ignore */ }

// Atualiza a lista da call automaticamente enquanto a hub está aberta.
setInterval(function () {
  if (telaCompartilhar && telaCompartilhar.classList.contains("ativa") && compartilharInstanciaAtual()) {
    carregarTransmissoes();
  }
}, 10000);

document.querySelector("#atualizar-transmissoes").addEventListener("click", carregarTransmissoes);

document.querySelector("#assistir-codigo").addEventListener("click", function () {
  assistirTransmissao(document.querySelector("#codigo-tela-input").value);
});

document.querySelector("#codigo-tela-input").addEventListener("keydown", function (e) {
  if (e.key === "Enter") assistirTransmissao(this.value);
});

document.querySelector("#encerrar-transmissao").addEventListener("click", function () {
  encerrarTransmissao(false);
});

document.querySelector("#parar-assistir").addEventListener("click", pararDeAssistir);

document.querySelector("#copiar-link-tela").addEventListener("click", function () {
  var botao = this;
  if (navigator.clipboard && telaSala) {
    navigator.clipboard.writeText(location.origin + "/?sala=" + telaSala).then(function () {
      botao.textContent = "Link copiado!";
      setTimeout(function () { botao.textContent = "Copiar link"; }, 2000);
    });
  }
});

document.querySelector("#voltar-transmissao").addEventListener("click", function () {
  if (telaEhHost) {
    encerrarTransmissao(true);
  } else {
    pararDeAssistir();
  }
});

document.querySelector("#copiar-codigo-tela").addEventListener("click", function () {
  var botao = this;
  if (navigator.clipboard && telaSala) {
    navigator.clipboard.writeText(telaSala).then(function () {
      botao.textContent = "Copiado!";
      botao.classList.add("copiado");
      setTimeout(function () {
        botao.textContent = "Copiar";
        botao.classList.remove("copiado");
      }, 2000);
    });
  }
});

// ---------------------------------------------------------------------------
// Sala multi-tela — listeners de UI
// ---------------------------------------------------------------------------
document.querySelector("#entrar-multi-codigo").addEventListener("click", function () {
  entrarSalaMulti(document.querySelector("#codigo-multi-input").value);
});

document.querySelector("#codigo-multi-input").addEventListener("keydown", function (e) {
  if (e.key === "Enter") entrarSalaMulti(this.value);
});

document.querySelector("#sair-sala-multi").addEventListener("click", sairSalaMulti);
document.querySelector("#sair-multi-topo").addEventListener("click", sairSalaMulti);

document.querySelector("#multi-abrir-tela").addEventListener("click", function () {
  if (!multiNaTela) return;
  iniciarTransmissaoTela();
});

document.querySelector("#multi-fechar-tela").addEventListener("click", function () {
  encerrarTransmissao(false);
});

document.querySelector("#multi-voltar-assistir").addEventListener("click", function () {
  var btnVo = document.querySelector("#multi-voltar-assistir");
  if (btnVo) btnVo.style.display = "none";
  mensagemMulti("Assistindo às outras telas...", "");
  Object.keys(multiTiles).forEach(function (sala) {
    var t = multiTiles[sala];
    if (!t || t.eu || t.oculta || t.assistindo) return;
    ligarViewerMulti(t);
  });
});

document.querySelector("#copiar-codigo-multi").addEventListener("click", function () {
  var botao = this;
  if (navigator.clipboard && multiSala) {
    navigator.clipboard.writeText(multiSala).then(function () {
      botao.textContent = "Copiado!";
      setTimeout(function () { botao.textContent = "Copiar"; }, 2000);
    });
  }
});

document.addEventListener("keydown", function (e) {
  if (e.key !== "Escape") return;
  var cheia = document.querySelector(".multi-tile.cheia");
  if (cheia) {
    cheia.classList.remove("cheia");
    var b = cheia.querySelector(".multi-tile-ctrls button:last-child");
    if (b) b.textContent = "⛶";
  }
});

// ---------------------------------------------------------------------------
// Sala multi-tela: várias lives 720p30, grid com volume/cheia/minimizar
// ---------------------------------------------------------------------------
function mensagemMulti(texto, tipo) {
  var el = document.querySelector("#mensagem-multi");
  if (!el) return;
  el.textContent = texto || "";
  el.className = "mensagem" + (tipo ? " " + tipo : "");
}

async function carregarSalasMulti() {
  try {
    var res = await fetch("./multitela/salas");
    var dados = await res.json();
    renderizarSalasMulti(dados.salas || []);
  } catch (e) {
    console.warn("salas multi:", e);
  }
}

function renderizarSalasMulti(salas) {
  var container = document.querySelector("#lista-salas-multi");
  if (!container) return;
  container.innerHTML = "";
  if (!salas || !salas.length) {
    container.innerHTML = '<p class="vazio">Nenhuma sala multi-tela pública.</p>';
    return;
  }
  salas.forEach(function (s) {
    var item = document.createElement("div");
    item.className = "sala-item";
    var avatarHtml = s.dono_avatar
      ? '<img class="sala-item-avatar" src="' + escapeHtml(s.dono_avatar) + '" alt="" />'
      : '<span class="sala-item-inicial">' + escapeHtml((s.dono_nick || "?").charAt(0).toUpperCase()) + "</span>";
    item.innerHTML =
      avatarHtml +
      '<div class="sala-item-info">' +
      "<strong>" + escapeHtml(s.nome || ("Sala de " + (s.dono_nick || "Anônimo"))) + "</strong>" +
      "<small>Código " + escapeHtml(s.sala) + " · " + (s.total_lives || 0) + "/" + (s.max_lives || 8) + " telas · " +
      (s.total_membros || 0) + " na sala</small></div>";
    var btn = document.createElement("button");
    btn.className = "botao";
    btn.textContent = "Entrar";
    btn.addEventListener("click", function () { entrarSalaMulti(s.sala); });
    item.appendChild(btn);
    container.appendChild(item);
  });
}

async function criarSalaMulti(opts) {
  opts = opts || {};
  try {
    await garantirIdentidade();
    var body = {
      publica: opts.publica !== false,
      nick: nomeExibicao(),
      avatar: avatarAtual() || null,
    };
    if (opts.codigo) body.codigo = opts.codigo;
    var res = await fetch("./multitela/novo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    var dados = await res.json();
    if (!res.ok) throw new Error(dados.detail || "Erro ao criar a sala multi-tela.");
    await entrarSalaMulti(dados.sala);
    if (opts.iniciarAgora) {
      // Painel "Criar sala multi-tela": entra e já compartilha a tela.
      // multiSala já setado → iniciarTransmissaoTela não volta para o form.
      setTimeout(function () {
        formModoTela = "multi";
        iniciarTransmissaoTela().catch(function (e) {
          console.warn("share multi:", e);
        });
      }, 400);
    }
    return dados.sala;
  } catch (e) {
    mensagemTela(e.message, "erro");
    if (multiNaTela) mensagemMulti(e.message, "erro");
    return null;
  }
}

async function iniciarCriacaoMultiPainel() {
  var valCod = codigoCustomValido(formTipoSala === "privada");
  if (valCod.erro) {
    mensagemTela(valCod.erro, "erro");
    return;
  }
  if (multiSala) {
    // Já está numa multi: só compartilha a tela.
    await iniciarTransmissaoTela();
    return;
  }
  await criarSalaMulti({
    publica: formTipoSala === "publica",
    codigo: valCod.codigo,
    iniciarAgora: true,
  });
}

function entrarSalaMulti(codigo) {
  codigo = (codigo || "").trim().toLowerCase();
  if (!codigo) {
    mensagemTela("Digite o código da multi-tela.", "erro");
    return;
  }

  // Sai de qualquer transmissão single-player antes de entrar na multi.
  if (telaEhHost) encerrarTransmissao(true);
  else if (telaSala) pararDeAssistir();

  multiSala = codigo;
  multiNaTela = true;
  multiHostSala = null;
  document.querySelector("#multi-nome-sala").textContent = "Sala multi-tela";
  document.querySelector("#multi-codigo-sala").textContent = codigo;
  var btnAb = document.querySelector("#multi-abrir-tela");
  var btnFe = document.querySelector("#multi-fechar-tela");
  var btnVo = document.querySelector("#multi-voltar-assistir");
  if (btnAb) { btnAb.style.display = ""; btnAb.disabled = false; btnAb.textContent = "Compartilhar minha tela"; }
  if (btnFe) btnFe.style.display = "none";
  if (btnVo) btnVo.style.display = "none";
  var listaMembros = document.querySelector("#multi-membros-lista");
  if (listaMembros) listaMembros.innerHTML = "";
  var q = document.querySelector("#transmissao-qualidade");
  if (q) q.classList.add("bloqueada");
  telaResolucao = "720p";
  telaFps = 30;
  limparTilesMulti();
  // multiNaTela já true — mostrarTela não dispara sairSalaMulti.
  mostrarTela(document.querySelector("#tela-multitela"));
  mensagemMulti("Conectando à sala multi-tela...");
  conectarMultiWs();
}

function sairSalaMulti() {
  if (!multiNaTela && !multiSala) return;
  if (telaEhHost) encerrarTransmissao(true);
  limparTilesMulti();
  if (multiWs) {
    try { multiWs.send(JSON.stringify({ tipo: "sair" })); } catch (e) { /* ignore */ }
    var ws = multiWs;
    multiWs = null;
    ws.onclose = null;
    try { ws.close(); } catch (e2) { /* ignore */ }
  }
  clearInterval(multiPingTimer);
  multiPingTimer = null;
  multiNaTela = false;
  multiSala = null;
  multiEstado = null;
  multiHostSala = null;
  var q = document.querySelector("#transmissao-qualidade");
  if (q) q.classList.remove("bloqueada");
  var btnVo = document.querySelector("#multi-voltar-assistir");
  if (btnVo) btnVo.style.display = "none";
  var listaMembros = document.querySelector("#multi-membros-lista");
  if (listaMembros) listaMembros.innerHTML = "";
  mensagemMulti("");
  // multiNaTela já false — não reentra no if de sair do mostrarTela.
  mostrarTela(telaCompartilhar);
  carregarTransmissoes();
  carregarSalasMulti();
}

function conectarMultiWs() {
  if (multiWs) {
    var antigo = multiWs;
    multiWs = null;
    antigo.onclose = null;
    try { antigo.close(); } catch (e) { /* ignore */ }
  }
  clearInterval(multiPingTimer);

  var nick = usuarioDiscord ? (usuarioDiscord.global_name || usuarioDiscord.username) : (nomeExibicao() || "Anônimo");
  var avatar = avatarAtual() || "";
  var logado = usuarioDiscord ? "1" : "0";
  var protocolo = location.protocol === "https:" ? "wss:" : "ws:";
  var url = protocolo + "//" + location.host + "/ws/multitela/" + encodeURIComponent(multiSala) +
    "?nick=" + encodeURIComponent(nick) +
    "&avatar=" + encodeURIComponent(avatar) +
    "&logado=" + logado;

  var ws = new WebSocket(url);
  multiWs = ws;

  multiPingTimer = setInterval(function () {
    if (multiWs && multiWs.readyState === WebSocket.OPEN) {
      multiWs.send(JSON.stringify({ tipo: "ping" }));
    }
  }, 20000);

  ws.onmessage = function (evento) {
    try {
      processarMultiMensagem(JSON.parse(evento.data));
    } catch (e) {
      console.error("Erro multi:", e);
    }
  };

  ws.onclose = function () {
    if (ws !== multiWs) return;
    if (!multiNaTela) return;
    mensagemMulti("Conexão perdida. Reconectando...", "erro");
    setTimeout(function () {
      if (multiNaTela && multiSala) conectarMultiWs();
    }, 2000);
  };

  ws.onerror = function () {};
}

function processarMultiMensagem(dados) {
  switch (dados.tipo) {
    case "multi_estado":
      atualizarMultiEstado(dados);
      break;
    case "multi_encerrada":
      mensagemMulti("A sala multi-tela foi encerrada" +
        (dados.motivo ? " (" + dados.motivo + ")." : "."), "erro");
      setTimeout(function () {
        if (multiNaTela) sairSalaMulti();
      }, 1800);
      break;
    case "erro":
      mensagemMulti(dados.mensagem || "Erro na sala multi-tela.", "erro");
      if (dados.mensagem && dados.mensagem.indexOf("não encontrada") !== -1) {
        setTimeout(function () { if (multiNaTela) sairSalaMulti(); }, 1800);
      }
      break;
    default:
      break;
  }
}

function atualizarMultiEstado(estado) {
  multiEstado = estado;
  if (!multiNaTela) return;

  var nome = estado.nome || ("Sala de " + (estado.dono_nick || "Anônimo"));
  document.querySelector("#multi-nome-sala").textContent = nome + " - Código";
  document.querySelector("#multi-codigo-sala").textContent = estado.sala || multiSala || "";
  document.querySelector("#multi-membros-total").textContent = String(estado.total_membros || 0);

  // Membros (foto + nick) sob "x/8 na sala".
  var lista = document.querySelector("#multi-membros-lista");
  if (lista) {
    lista.innerHTML = "";
    var membros = estado.membros || [];
    if (membros.length) {
      membros.forEach(function (m) {
        var chip = document.createElement("span");
        chip.className = "multi-membro" + (m.logado ? "" : " anonimo");
        chip.innerHTML = avatarOuIni(m.nick || "Anônimo", m.avatar) +
          "<strong>" + escapeHtml(m.nick || "Anônimo") + "</strong>" +
          (m.logado ? "" : '<span class="etiqueta">anônimo</span>');
        if (!m.conectado) chip.style.opacity = "0.55";
        lista.appendChild(chip);
      });
    }
  }

  var lives = estado.lives || [];
  var btnAb = document.querySelector("#multi-abrir-tela");
  if (btnAb && !multiHostSala) {
    var cheia = (estado.total_lives || 0) >= (estado.max_lives || 8);
    btnAb.disabled = cheia;
    btnAb.textContent = cheia
      ? "Telas cheias (" + (estado.max_lives || 8) + ")"
      : "Compartilhar minha tela";
  }

  var alvo = {};
  lives.forEach(function (l) { alvo[l.sala] = l; });
  // Tile do host local: mantém mesmo antes do host_ws entrar no lives.
  if (multiHostSala) {
    if (!alvo[multiHostSala]) {
      alvo[multiHostSala] = {
        sala: multiHostSala,
        nick: nomeExibicao(),
        avatar: avatarAtual() || null,
      };
    }
    alvo[multiHostSala].eu = true;
  }

  // Remove tiles de lives que sumiram (nunca o tile do host local).
  Object.keys(multiTiles).forEach(function (sala) {
    if (sala === multiHostSala) return;
    if (!alvo[sala]) removerTileMulti(sala);
  });

  // Cria/atualiza tiles.
  Object.keys(alvo).forEach(function (sala) {
    if (!multiTiles[sala]) criarTileMulti(alvo[sala]);
    else atualizarDadosTile(multiTiles[sala], alvo[sala]);
  });
}

function limparTilesMulti() {
  Object.keys(multiTiles).forEach(function (sala) {
    removerTileMulti(sala);
  });
}

function removerTileMulti(sala) {
  var tile = multiTiles[sala];
  if (!tile) return;
  desligarViewerMulti(tile);
  if (tile.el && tile.el.parentNode) tile.el.parentNode.removeChild(tile.el);
  delete multiTiles[sala];
}

function avatarOuIni(nick, avatar) {
  if (avatar) {
    return '<img src="' + escapeHtml(avatar) + '" alt="" onerror="this.outerHTML=\'<span class=&quot;ini&quot;>' +
      escapeHtml((nick || "?").charAt(0).toUpperCase()) + '</span>\'" />';
  }
  return '<span class="ini">' + escapeHtml((nick || "?").charAt(0).toUpperCase()) + "</span>";
}

function criarTileMulti(live) {
  var sala = live.sala;
  var ehEu = !!live.eu || sala === multiHostSala;
  var nick = ehEu ? (nomeExibicao() || "Você") : (live.nick || "Anônimo");
  var avatar = ehEu ? avatarAtual() : live.avatar;

  var el = document.createElement("div");
  el.className = "multi-tile" + (ehEu ? " multi-tile-eu" : "");
  el.dataset.sala = sala;

  var media = document.createElement("div");
  media.className = "multi-tile-media";

  var canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  media.appendChild(canvas);

  var video = null;
  if (!dentroDaActivity() && !ehEu) {
    video = document.createElement("video");
    video.playsInline = true;
    video.autoplay = true;
    video.muted = true;
    video.style.display = "none";
    media.appendChild(video);
  }

  var placeholder = document.createElement("div");
  placeholder.className = "multi-tile-placeholder";
  placeholder.textContent = ehEu
    ? "Você está transmitindo"
    : "Clique para assistir";
  media.appendChild(placeholder);

  var ctrls = document.createElement("div");
  ctrls.className = "multi-tile-ctrls";

  var btnVol = document.createElement("button");
  btnVol.type = "button";
  btnVol.title = "Volume (começa mudo)";
  btnVol.textContent = "🔇";

  var volSlider = document.createElement("input");
  volSlider.type = "range";
  volSlider.min = "0";
  volSlider.max = "100";
  volSlider.value = "80";
  volSlider.className = "multi-tile-volume";
  volSlider.title = "Volume desta transmissão";

  var btnOcultar = document.createElement("button");
  btnOcultar.type = "button";
  btnOcultar.title = "Não exibir / reassistir";
  btnOcultar.textContent = "👁";

  var btnMini = document.createElement("button");
  btnMini.type = "button";
  btnMini.title = "Minimizar";
  btnMini.textContent = "▁";

  var btnCheia = document.createElement("button");
  btnCheia.type = "button";
  btnCheia.title = "Tela cheia";
  btnCheia.textContent = "⛶";

  ctrls.appendChild(btnVol);
  if (!ehEu) ctrls.appendChild(volSlider);
  ctrls.appendChild(btnOcultar);
  ctrls.appendChild(btnMini);
  ctrls.appendChild(btnCheia);
  media.appendChild(ctrls);

  var rodape = document.createElement("div");
  rodape.className = "multi-tile-rodape";
  rodape.innerHTML = avatarOuIni(nick, avatar) +
    "<strong>" + escapeHtml(nick) + "</strong>" +
    (ehEu ? '<span class="etiqueta-eu">Você</span>' : "");

  var btnVoltar = document.createElement("button");
  btnVoltar.type = "button";
  btnVoltar.className = "multi-tile-voltar";
  btnVoltar.textContent = "Voltar a assistir";
  btnVoltar.style.display = "none";
  rodape.appendChild(btnVoltar);

  el.appendChild(media);
  el.appendChild(rodape);
  document.querySelector("#multi-grid").appendChild(el);

  var tile = {
    sala: sala,
    eu: ehEu,
    nick: nick,
    el: el,
    canvas: canvas,
    video: video,
    placeholder: placeholder,
    btnVol: btnVol,
    volSlider: volSlider,
    btnOcultar: btnOcultar,
    btnMini: btnMini,
    btnCheia: btnCheia,
    btnVoltar: btnVoltar,
    live: live,
    assistindo: false,
    oculta: false,
    mudo: true,
    volume: 0.8,
    ws: null,
    pc: null,
    decoder: null,
    audioDecoder: null,
    audioCtx: null,
    gain: null,
    partes: {},
    temKey: false,
    codec: "vp8",
    resolucao: live.resolucao || "720p",
    tentativas: 0,
    abriu: false,
    relay: dentroDaActivity(),
    ofertaTimer: null,
    audioCfg: { sr: 0, ch: 0 },
    audioChave: true,
    redeTimer: null,
  };
  multiTiles[sala] = tile;

  function atualizarVoltarTile() {
    // Mostra "Voltar a assistir" no rodapé quando o vídeo está fechado (_).
    var fechado = el.classList.contains("minimizado") || tile.oculta ||
      (!tile.assistindo && !ehEu && !tile.eu);
    btnVoltar.style.display = fechado ? "" : "none";
  }
  tile.atualizarVoltar = atualizarVoltarTile;

  btnVoltar.addEventListener("click", function (ev) {
    ev.stopPropagation();
    el.classList.remove("minimizado");
    btnMini.textContent = "▁";
    if (tile.oculta) {
      tile.oculta = false;
      el.classList.remove("oculta");
      btnOcultar.textContent = "👁";
    }
    if (!tile.eu && !tile.assistindo) ligarViewerMulti(tile);
    if (tile.eu && tile.preview) {
      var pr = tile.preview.play();
      if (pr && pr.catch) pr.catch(function () {});
    }
    atualizarVoltarTile();
  });

  btnMini.addEventListener("click", function () {
    el.classList.toggle("minimizado");
    btnMini.textContent = el.classList.contains("minimizado") ? "▔" : "▁";
    if (el.classList.contains("cheia")) {
      el.classList.remove("cheia");
      btnCheia.textContent = "⛶";
    }
    atualizarVoltarTile();
  });

  // Host: preview local no próprio tile (mudo).
  if (ehEu && telaStream) {
    canvas.style.display = "none";
    var prev = document.createElement("video");
    prev.autoplay = true;
    prev.muted = true; // eco: preview local sempre mudo
    prev.playsInline = true;
    prev.srcObject = telaStream;
    prev.style.display = "block";
    prev.style.width = "100%";
    prev.style.height = "100%";
    prev.style.objectFit = "contain";
    prev.style.background = "#000";
    media.insertBefore(prev, placeholder);
    tile.preview = prev;
    var pp = prev.play();
    if (pp && pp.catch) pp.catch(function () {});
    placeholder.textContent = "Transmitindo 720p 30fps";
    btnVol.disabled = true;
    btnOcultar.disabled = true;
    // Fonte do encoder: preview visível no grid (off-screen pode não pintar).
    if (relayAtivo || multiSala) hostVideoEncoder();
    return tile;
  }

  if (ehEu) {
    return tile;
  }

  // Auto-assiste lives (mutadas). Clique no media também religa se oculto.
  media.addEventListener("click", function (ev) {
    if (ev.target === btnVol || ev.target === btnOcultar ||
        ev.target === btnMini || ev.target === btnCheia ||
        ev.target === btnVoltar) return;
    if (tile.oculta) {
      tile.oculta = false;
      el.classList.remove("oculta");
      btnOcultar.textContent = "👁";
      ligarViewerMulti(tile);
    } else if (!tile.assistindo) {
      ligarViewerMulti(tile);
    }
    atualizarVoltarTile();
  });

  function aplicarVolumeTile() {
    var vol = tile.mudo ? 0 : tile.volume;
    if (tile.gain) tile.gain.gain.value = vol;
    if (tile.video) {
      tile.video.muted = tile.mudo;
      tile.video.volume = tile.volume;
    }
    btnVol.textContent = tile.mudo ? "🔇" : (tile.volume <= 0 ? "🔈" : "🔊");
    if (!tile.mudo && tile.audioCtx && tile.audioCtx.state === "suspended") {
      tile.audioCtx.resume().catch(function () {});
    }
  }
  tile.aplicarVolume = aplicarVolumeTile;

  btnVol.addEventListener("click", function (ev) {
    ev.stopPropagation();
    tile.mudo = !tile.mudo;
    aplicarVolumeTile();
  });

  volSlider.addEventListener("input", function (ev) {
    ev.stopPropagation();
    tile.volume = Math.max(0, Math.min(1, parseInt(volSlider.value, 10) / 100));
    if (tile.mudo && tile.volume > 0) tile.mudo = false;
    aplicarVolumeTile();
  });
  volSlider.addEventListener("click", function (ev) { ev.stopPropagation(); });

  btnOcultar.addEventListener("click", function () {
    if (tile.oculta) {
      tile.oculta = false;
      el.classList.remove("oculta");
      btnOcultar.textContent = "👁";
      ligarViewerMulti(tile);
    } else {
      tile.oculta = true;
      el.classList.add("oculta");
      btnOcultar.textContent = "🙈";
      desligarViewerMulti(tile);
    }
    atualizarVoltarTile();
  });

  btnCheia.addEventListener("click", function (ev) {
    ev.stopPropagation();
    var cheiaAgora = el.classList.contains("cheia");
    document.querySelectorAll(".multi-tile.cheia").forEach(function (t) {
      t.classList.remove("cheia");
      var b = t.querySelector(".multi-tile-ctrls button:last-child");
      if (b) b.textContent = "⛶";
    });
    if (!cheiaAgora) {
      el.classList.add("cheia");
      el.classList.remove("minimizado");
      btnCheia.textContent = "✕";
      btnMini.textContent = "▁";
      atualizarVoltarTile();
    }
  });

  ligarViewerMulti(tile);
  atualizarVoltarTile();
  return tile;
}

function atualizarDadosTile(tile, live) {
  tile.live = live;
  if (tile.eu) return;
  var nick = live.nick || "Anônimo";
  var forte = tile.el.querySelector(".multi-tile-rodape strong");
  if (forte) forte.textContent = nick;
}

function enviarMulti(obj) {
  if (multiWs && multiWs.readyState === WebSocket.OPEN) {
    multiWs.send(JSON.stringify(obj));
  }
}

function enviarTile(tile, obj) {
  if (tile.ws && tile.ws.readyState === WebSocket.OPEN) {
    tile.ws.send(JSON.stringify(obj));
  }
}

function desligarViewerMulti(tile) {
  tile.assistindo = false;
  clearTimeout(tile.ofertaTimer);
  clearInterval(tile.redeTimer);
  tile.redeTimer = null;
  if (tile.ws) {
    var ws = tile.ws;
    tile.ws = null;
    ws.onclose = null;
    ws.onmessage = null;
    try { ws.close(); } catch (e) { /* ignore */ }
  }
  if (tile.pc) {
    try { tile.pc.close(); } catch (e) { /* ignore */ }
    tile.pc = null;
  }
  if (tile.decoder && tile.decoder.state !== "closed") {
    try { tile.decoder.close(); } catch (e) { /* ignore */ }
  }
  tile.decoder = null;
  if (tile.audioDecoder && tile.audioDecoder.state !== "closed") {
    try { tile.audioDecoder.close(); } catch (e) { /* ignore */ }
  }
  tile.audioDecoder = null;
  if (tile.audioCtx) {
    try { tile.audioCtx.close(); } catch (e) { /* ignore */ }
  }
  tile.audioCtx = null;
  tile.gain = null;
  tile.partes = {};
  tile.temKey = false;
  tile.abriu = false;
  tile.tentativas = 0;
  if (tile.video) tile.video.srcObject = null;
  var ctx = tile.canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, tile.canvas.width, tile.canvas.height);
  if (!tile.oculta) tile.placeholder.textContent = "Clique para assistir";
  if (tile.atualizarVoltar) tile.atualizarVoltar();
}

function ligarViewerMulti(tile) {
  if (tile.eu || tile.assistindo || !multiNaTela) return;
  // Eco: o host nunca abre viewer da própria live.
  if (tile.sala === multiHostSala || tile.sala === telaSala) return;
  tile.assistindo = true;
  tile.tentativas = 0;
  tile.relay = dentroDaActivity();
  tile.placeholder.textContent = "Conectando...";
  abrirWsViewerMulti(tile);
  if (tile.atualizarVoltar) tile.atualizarVoltar();
}

function abrirWsViewerMulti(tile) {
  var nick = usuarioDiscord ? (usuarioDiscord.global_name || usuarioDiscord.username) : (nomeExibicao() || "Anônimo");
  var avatar = avatarAtual() || "";
  var logado = usuarioDiscord ? "1" : "0";
  var protocolo = location.protocol === "https:" ? "wss:" : "ws:";
  var url = protocolo + "//" + location.host + "/ws/tela/" + encodeURIComponent(tile.sala) +
    "?papel=viewer" +
    "&nick=" + encodeURIComponent(nick) +
    "&avatar=" + encodeURIComponent(avatar) +
    "&logado=" + logado +
    (tile.relay ? "&transporte=relay" : "");

  var ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  tile.ws = ws;
  tile.abriu = false;

  ws.onopen = function () {
    tile.abriu = true;
    tile.tentativas = 0;
    tile.placeholder.textContent = "Aguardando vídeo...";
  };

  ws.onmessage = function (evento) {
    if (typeof evento.data !== "string") {
      if (tile.relay) receberRelayTile(tile, evento.data);
      return;
    }
    try {
      processarMsgTile(tile, JSON.parse(evento.data));
    } catch (e) {
      console.warn("msg tile:", e);
    }
  };

  ws.onclose = function () {
    if (ws !== tile.ws) return;
    tile.ws = null;
    tile.assistindo = false;
    if (!multiNaTela || tile.oculta || !multiTiles[tile.sala]) return;
    if (!tile.abriu && tile.tentativas < 3) {
      tile.tentativas++;
      tile.placeholder.textContent = "Reconectando... (" + tile.tentativas + "/3)";
      setTimeout(function () {
        if (multiTiles[tile.sala] && !tile.oculta) ligarViewerMulti(tile);
      }, 1500 * tile.tentativas);
      return;
    }
    tile.placeholder.textContent = "Conexão perdida — clique para reassistir";
  };

  ws.onerror = function () {};
}

function processarMsgTile(tile, dados) {
  switch (dados.tipo) {
    case "entrada_ok":
      tile.resolucao = dados.resolucao || "720p";
      if (dados.codec) tile.codec = dados.codec;
      tile.placeholder.textContent = "Aguardando vídeo...";
      if (tile.relay) {
        iniciarDecoderTile(tile, tile.resolucao, tile.codec);
        clearTimeout(tile.ofertaTimer);
        tile.ofertaTimer = setTimeout(function () {
          if (tile.assistindo && tile.placeholder.textContent.indexOf("vídeo") === -1 &&
              tile.placeholder.textContent.indexOf("Recebendo") === -1) {
            tile.placeholder.textContent = "Host sem vídeo ainda — clique para reassistir";
          }
        }, 12000);
      }
      break;
    case "host_conectado":
      // WebRTC: host avisa; oferta vem em seguida.
      break;
    case "quadro":
      if (tile.relay && dados.d) montarQuadroTile(tile, dados);
      break;
    case "audio":
      if (tile.relay) receberAudioTile(tile, dados);
      break;
    case "relay_codec":
      if (dados.codec) {
        tile.codec = dados.codec;
        if (tile.relay && tile.assistindo) iniciarDecoderTile(tile, tile.resolucao, tile.codec);
      }
      break;
    case "config":
      if (tile.relay && dados.resolucao) {
        iniciarDecoderTile(tile, dados.resolucao, tile.codec);
      }
      break;
    case "oferta":
      if (!tile.relay) processarOfertaTile(tile, dados.dados);
      break;
    case "resposta":
      if (tile.pc) tile.pc.setRemoteDescription({ type: "answer", sdp: dados.dados }).catch(function () {});
      break;
    case "ice":
      if (tile.pc) tile.pc.addIceCandidate(dados.dados).catch(function () {});
      break;
    case "aguardando_host":
      tile.placeholder.textContent = "Aguardando quem transmite conectar...";
      break;
    case "transmissao_encerrada":
      desligarViewerMulti(tile);
      tile.placeholder.textContent = "Live encerrada — clique para reassistir se voltar";
      break;
    case "erro":
      tile.placeholder.textContent = dados.mensagem || "Erro na live";
      break;
    default:
      break;
  }
}

function processarOfertaTile(tile, sdp) {
  if (tile.pc) {
    try { tile.pc.close(); } catch (e) { /* ignore */ }
  }
  var pc = new RTCPeerConnection(RTC_CONFIG);
  tile.pc = pc;

  pc.ontrack = function (evento) {
    if (!tile.video) return;
    tile.video.srcObject = evento.streams[0];
    tile.video.muted = tile.mudo;
    tile.video.volume = tile.volume;
    // Fluidez: prefer motion (menos latência de encode WebRTC).
    (evento.track ? [evento.track] : []).forEach(function (tr) {
      if (tr && "contentHint" in tr) tr.contentHint = "motion";
    });
    tile.placeholder.style.display = "none";
    tile.canvas.style.display = "none";
    tile.video.style.display = "";
    var p = tile.video.play();
    if (p && p.catch) p.catch(function () {});
  };

  pc.onicecandidate = function (evento) {
    if (evento.candidate) {
      enviarTile(tile, { tipo: "ice", dados: evento.candidate.toJSON() });
    }
  };

  pc.setRemoteDescription({ type: "offer", sdp: sdp })
    .then(function () { return pc.createAnswer(); })
    .then(function (resposta) { return pc.setLocalDescription(resposta); })
    .then(function () {
      enviarTile(tile, { tipo: "resposta", dados: pc.localDescription.sdp });
      tile.placeholder.textContent = "Recebendo vídeo...";
    })
    .catch(function () {
      tile.placeholder.textContent = "Falha ao conectar P2P nesta live.";
    });
}

function iniciarDecoderTile(tile, resolucao, codec) {
  if (tile.decoder && tile.decoder.state !== "closed") {
    try { tile.decoder.close(); } catch (e) { /* ignore */ }
  }
  tile.decoder = null;
  tile.temKey = false;
  tile.partes = {};
  var dims = { "480p": [854, 480], "720p": [1280, 720], "1080p": [1920, 1080] }[resolucao] || [1280, 720];
  tile.canvas.width = dims[0];
  tile.canvas.height = dims[1];
  if (typeof VideoDecoder === "undefined") {
    tile.placeholder.textContent = "Seu navegador não suporta o modo de vídeo da multi-tela.";
    return;
  }
  var ctx = tile.canvas.getContext("2d", { alpha: false });
  tile.decoder = new VideoDecoder({
    output: function (frame) {
      try {
        ctx.drawImage(frame, 0, 0, tile.canvas.width, tile.canvas.height);
        if (!tile.oculta) {
          tile.placeholder.style.display = "none";
          tile.canvas.style.display = "block";
          if (tile.preview) tile.preview.style.display = "none";
        }
      } catch (e) { /* ignore */ }
      try { frame.close(); } catch (e2) { /* ignore */ }
    },
    error: function () {
      if (tile.decoder && tile.decoder.state !== "closed") {
        try { tile.decoder.close(); } catch (e) { /* ignore */ }
      }
      tile.decoder = null;
      tile.temKey = false;
      if (tile.codec !== "vp8") {
        tile.codec = "vp8";
        iniciarDecoderTile(tile, resolucao, "vp8");
      }
    },
  });
  var alvo = codec === "h264" ? ["avc1.42001f", "vp8"] : ["vp8", "avc1.42001f"];
  function tentar(lista) {
    if (!lista.length || !tile.decoder) return;
    var codecStr = lista[0];
    var resto = lista.slice(1);
    var cfg = { codec: codecStr, optimizeForLatency: true };
    var promessa = (typeof VideoDecoder.isConfigSupported === "function")
      ? VideoDecoder.isConfigSupported(cfg)
      : Promise.resolve({ supported: true });
    promessa.then(function (sup) {
      if (!tile.decoder) return;
      if (sup && sup.supported === false) { tentar(resto); return; }
      try {
        tile.decoder.configure(cfg);
        if (tile.decoder.state !== "configured") tentar(resto);
      } catch (e) { tentar(resto); }
    }).catch(function () {
      if (!tile.decoder) return;
      try { tile.decoder.configure(cfg); } catch (e) { tentar(resto); }
    });
  }
  tentar(alvo);
  iniciarDecoderAudioTile(tile, 48000, 2);
}

function receberRelayTile(tile, buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 5) return;
  var dv = new DataView(buffer);
  decodificarRelayFrameTile(tile, dv.getUint8(0) === 1, dv.getUint32(1), new Uint8Array(buffer, 5));
}

function montarQuadroTile(tile, dados) {
  if (!dados || !dados.d) return;
  if (!dados.n || dados.n <= 1) {
    processarParteRelayTile(tile, dados.t, dados);
    return;
  }
  var t = dados.t;
  var buf = tile.partes[t];
  if (!buf) buf = tile.partes[t] = { k: dados.k, n: dados.n, recebidas: 0, partes: [] };
  if (buf.partes[dados.i]) return;
  buf.partes[dados.i] = dados.d;
  buf.recebidas++;
  if (buf.recebidas >= buf.n) {
    delete tile.partes[t];
    processarParteRelayTile(tile, t, { k: buf.k, d: buf.partes.join("") });
  }
}

function processarParteRelayTile(tile, t, dados) {
  try {
    var bin = atob(dados.d);
    var payload = new Uint8Array(bin.length);
    for (var qi = 0; qi < bin.length; qi++) payload[qi] = bin.charCodeAt(qi);
    decodificarRelayFrameTile(tile, dados.k === 1, t >>> 0, payload);
  } catch (e) { /* ignore */ }
}

function decodificarRelayFrameTile(tile, ehKey, timestamp, payload) {
  if (!tile.decoder || tile.decoder.state === "closed") return;
  if (!payload || payload.byteLength < 1) return;
  if (!ehKey && !tile.temKey) return;
  if (ehKey) tile.temKey = true;
  // Fila de decode: multi usa limiar menor (menos delay); single mantém 30.
  var maxDecode = multiSala ? 12 : 30;
  if (tile.decoder.decodeQueueSize > maxDecode && !ehKey) return;
  try {
    tile.decoder.decode(new EncodedVideoChunk({
      type: ehKey ? "key" : "delta",
      timestamp: timestamp,
      data: payload,
    }));
  } catch (e) {
    tile.temKey = false;
  }
}

function iniciarDecoderAudioTile(tile, sr, ch) {
  if (tile.audioDecoder && tile.audioDecoder.state !== "closed") {
    try { tile.audioDecoder.close(); } catch (e) { /* ignore */ }
  }
  tile.audioDecoder = null;
  if (typeof AudioDecoder === "undefined" || typeof AudioContext === "undefined") return;
  if (!tile.audioCtx) {
    try {
      tile.audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    } catch (e) {
      try {
        tile.audioCtx = new AudioContext({ latencyHint: "interactive" });
      } catch (e2) {
        tile.audioCtx = new AudioContext();
      }
    }
    tile.gain = tile.audioCtx.createGain();
    tile.gain.gain.value = tile.mudo ? 0 : tile.volume;
    tile.gain.connect(tile.audioCtx.destination);
  }
  tile.audioCfg = { sr: sr || 48000, ch: ch || 2 };
  tile.audioChave = true;
  var proxima = 0;
  tile.audioDecoder = new AudioDecoder({
    output: function (frame) {
      try {
        if (!tile.audioCtx || !tile.gain) { frame.close(); return; }
        if (tile.audioCtx.state === "suspended") tile.audioCtx.resume().catch(function () {});
        var n = frame.numberOfFrames;
        var ab = tile.audioCtx.createBuffer(frame.numberOfChannels, n, frame.sampleRate);
        for (var c = 0; c < frame.numberOfChannels; c++) {
          var plane = new Float32Array(n);
          frame.copyTo(plane, { planeIndex: c, format: "f32-planar" });
          ab.copyToChannel(plane, c);
        }
        var src = tile.audioCtx.createBufferSource();
        src.buffer = ab;
        src.connect(tile.gain);
        var agora = tile.audioCtx.currentTime;
        if (proxima < agora || proxima > agora + 0.5) proxima = agora + 0.02;
        src.start(proxima);
        proxima += n / frame.sampleRate;
      } catch (e) { /* ignore */ }
      try { frame.close(); } catch (e2) { /* ignore */ }
    },
    error: function () { tile.audioDecoder = null; },
  });
  try {
    tile.audioDecoder.configure({ codec: "opus", sampleRate: tile.audioCfg.sr, numberOfChannels: tile.audioCfg.ch });
  } catch (e) { /* ignore */ }
}

function receberAudioTile(tile, dados) {
  if (!dados || !dados.d) return;
  if (!tile.audioCtx || !tile.audioDecoder || tile.audioDecoder.state === "closed") {
    iniciarDecoderAudioTile(tile, parseInt(dados.sr, 10) || 48000, parseInt(dados.ch, 10) || 2);
  }
  if (!tile.audioDecoder || tile.audioDecoder.state === "closed") return;
  var sr = parseInt(dados.sr, 10) || tile.audioCfg.sr;
  var ch = parseInt(dados.ch, 10) || tile.audioCfg.ch;
  if (sr !== tile.audioCfg.sr || ch !== tile.audioCfg.ch) {
    iniciarDecoderAudioTile(tile, sr, ch);
    if (!tile.audioDecoder || tile.audioDecoder.state === "closed") return;
  }
  if (tile.audioCtx && tile.audioCtx.state === "suspended") {
    tile.audioCtx.resume().catch(function () {});
  }
  try {
    var bin = atob(dados.d);
    var payload = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) payload[i] = bin.charCodeAt(i);
    if (tile.audioDecoder.decodeQueueSize > 40) return;
    var tipo = "delta";
    if (dados.k) tipo = "key";
    else if (tile.audioChave) { tipo = "key"; tile.audioChave = false; }
    tile.audioDecoder.decode(new EncodedAudioChunk({
      type: tipo,
      timestamp: dados.t || 0,
      data: payload,
    }));
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------

function irParaMulti() {
  if (!multiNaTela || !multiSala) return;
  mostrarTela(document.querySelector("#tela-multitela"));
}

// ---------------------------------------------------------------------------

