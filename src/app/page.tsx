"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Panel = "voice" | "words" | "users" | "translate";

type ChatMessage = {
  id: number;
  user: string;
  text: string;
  color: string;
  time: string;
  badge?: string;
};

const fallbackVoices = [
  { name: "Voz padrão do navegador", lang: "pt-BR", voiceURI: "" },
];

const azureVoices = [
  { name: "Microsoft Antônio Neural — Português (Brasil)", lang: "pt-BR", voiceURI: "azure:pt-BR-AntonioNeural" },
  { name: "Microsoft Francisca Neural — Português (Brasil)", lang: "pt-BR", voiceURI: "azure:pt-BR-FranciscaNeural" },
];

async function speak(text: string, rate: number, pitch: number, volume: number, voiceURI = ""): Promise<void> {
  if (voiceURI.startsWith("azure:")) {
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: voiceURI.slice(6), rate, pitch }),
    });
    if (!response.ok) throw new Error("Não foi possível gerar o áudio Azure.");
    const audio = new Audio(URL.createObjectURL(await response.blob()));
    audio.volume = volume;
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("Não foi possível reproduzir o áudio."));
      void audio.play();
    });
    return;
  }
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  await new Promise<void>((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    const selectedVoice = window.speechSynthesis.getVoices().find((voice) => voice.voiceURI === voiceURI);
    if (selectedVoice) {
      utterance.voice = selectedVoice;
      utterance.lang = selectedVoice.lang;
    } else {
      utterance.lang = "pt-BR";
    }
    utterance.rate = rate;
    utterance.pitch = pitch;
    utterance.volume = volume;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    window.speechSynthesis.speak(utterance);
  });
}

function sanitizeForSpeech(text: string): string | null {
  const withoutUrls = text.replace(/(?:https?:\/\/|www\.)\S+/gi, " ");
  const withoutEmojis = withoutUrls
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!withoutEmojis || /^(?:https?:\/\/|www\.)/i.test(withoutEmojis)) return null;

  const compact = withoutEmojis.replace(/[\s\W_]+/gu, "").toLowerCase();
  if (compact.length >= 8) {
    if (/(.)\1{4,}/u.test(compact)) return null;
    if (/(.{1,3})\1{3,}/u.test(compact)) return null;
    if (/^(?:k|h|a|e|o|r|ç|rs|kk|ha|ah|rsrs|rç){4,}$/u.test(compact)) return null;
  }
  return withoutEmojis;
}

export default function Home() {
  const [channel, setChannel] = useState("");
  const [connected, setConnected] = useState(false);
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [connectionState, setConnectionState] = useState<"disconnected" | "connecting" | "connected" | "error">("disconnected");
  const [connectionError, setConnectionError] = useState("");
  const [panel, setPanel] = useState<Panel>("voice");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voice, setVoice] = useState("");
  const [template, setTemplate] = useState("{msg}");
  const [rate, setRate] = useState(1.1);
  const [pitch, setPitch] = useState(1);
  const [volume, setVolume] = useState(0.9);
  const [autoScroll, setAutoScroll] = useState(true);
  const [ignoreBots, setIgnoreBots] = useState(true);
  const [ignoreCommands, setIgnoreCommands] = useState(true);
  const [antiFlood, setAntiFlood] = useState(true);
  const [maxQueue, setMaxQueue] = useState(20);
  const [muted, setMuted] = useState(false);
  const [blockedWords, setBlockedWords] = useState("spoiler\npolítica");
  const [blockedUsers, setBlockedUsers] = useState("nightbot\nstreamlabs");
  const [translated, setTranslated] = useState(false);
  const settingsRef = useRef({ muted, ignoreBots, ignoreCommands, antiFlood, maxQueue, blockedWords, blockedUsers, template, rate, pitch, volume, voice });
  const lastSpokenAtRef = useRef(0);
  const speechQueueRef = useRef<Array<{ text: string; rate: number; pitch: number; volume: number; voiceURI: string }>>([]);
  const speakingRef = useRef(false);

  useEffect(() => {
    settingsRef.current = { muted, ignoreBots, ignoreCommands, antiFlood, maxQueue, blockedWords, blockedUsers, template, rate, pitch, volume, voice };
  }, [antiFlood, blockedUsers, blockedWords, ignoreBots, ignoreCommands, maxQueue, muted, pitch, rate, template, voice, volume]);

  useEffect(() => {
    const selectedVoice = availableVoices.find((item) => item.voiceURI === voice);
    window.localStorage.setItem("twitchvoice-settings", JSON.stringify({
      muted,
      template,
      rate,
      pitch,
      volume,
      voiceURI: voice,
      voiceName: selectedVoice?.name || "",
      voiceLang: selectedVoice?.lang || "pt-BR",
    }));
  }, [availableVoices, muted, pitch, rate, template, voice, volume]);

  function processSpeechQueue() {
    if (speakingRef.current || speechQueueRef.current.length === 0) return;
    const next = speechQueueRef.current.shift();
    if (!next) return;
    speakingRef.current = true;
    void speak(next.text, next.rate, next.pitch, next.volume, next.voiceURI).catch(() => undefined).finally(() => {
      speakingRef.current = false;
      processSpeechQueue();
    });
  }

  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices()
        .filter((item) => item.lang.toLowerCase().startsWith("pt"))
        .sort((a, b) => Number(!/natural|neural|online|microsoft|google/i.test(b.name)) - Number(!/natural|neural|online|microsoft|google/i.test(a.name)));
      setAvailableVoices(voices);
      setVoice((current) => current || voices[0]?.voiceURI || "");
    };
    loadVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
  }, []);

  const queueCount = connected ? Math.min(messages.length, maxQueue) : 0;
  const statusText = connectionState === "connected"
    ? `Conectado · ${channel}`
    : connectionState === "connecting"
      ? `Conectando · ${channel}`
      : connectionState === "error"
        ? "Erro na conexão"
        : "Desconectado";

  const visibleMessages = useMemo(() => messages.filter((message) => {
    const words = blockedWords.toLowerCase().split("\n").filter(Boolean);
    const users = blockedUsers.toLowerCase().split("\n").filter(Boolean);
    return !users.includes(message.user.toLowerCase()) && !words.some((word) => message.text.toLowerCase().includes(word));
  }), [messages, blockedWords, blockedUsers]);

  useEffect(() => {
    if (!connected || !channel) return;

    const socket = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    socket.addEventListener("open", () => {
      socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership\r\n");
      socket.send("PASS SCHMOOPIIE\r\n");
      socket.send("NICK justinfan" + Math.floor(Math.random() * 900000 + 100000) + "\r\n");
      socket.send(`JOIN #${channel}\r\n`);
      setConnectionState("connected");
    });

    socket.addEventListener("message", (event) => {
      const raw = String(event.data);
      raw.split("\r\n").filter(Boolean).forEach((line) => {
        if (line.startsWith("PING")) {
          socket.send("PONG :tmi.twitch.tv\r\n");
          return;
        }
        if (!line.includes(" PRIVMSG #")) return;

        const messageMatch = line.match(/ PRIVMSG #[^ ]+ :(.*)$/);
        const userMatch = line.match(/display-name=([^;]*)/);
        const colorMatch = line.match(/color=([^;]*)/);
        const badgesMatch = line.match(/badges=([^;]*)/);
        if (!messageMatch || !userMatch) return;

        const text = messageMatch[1];
        const speechText = sanitizeForSpeech(text);
        const user = userMatch[1] || "Twitch user";
        const currentSettings = settingsRef.current;
        const blockedWordList = currentSettings.blockedWords.toLowerCase().split("\n").map((word) => word.trim()).filter(Boolean);
        const blockedUserList = currentSettings.blockedUsers.toLowerCase().split("\n").map((name) => name.trim()).filter(Boolean);
        const isBot = /bot$/i.test(user) || blockedUserList.includes(user.toLowerCase());
        const isCommand = text.startsWith("!") || text.startsWith("/");
        const isBlocked = blockedWordList.some((word) => text.toLowerCase().includes(word));
        if (isBlocked || (currentSettings.ignoreBots && isBot) || (currentSettings.ignoreCommands && isCommand)) return;

        const newMessage: ChatMessage = {
          id: Date.now() + Math.random(),
          user,
          text,
          color: colorMatch?.[1] || "#a875ff",
          time: new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
          badge: badgesMatch?.[1]?.includes("moderator") ? "MOD" : badgesMatch?.[1]?.includes("vip") ? "VIP" : undefined,
        };
        setMessages((current) => [...current.slice(-(currentSettings.maxQueue - 1)), newMessage]);
        const now = Date.now();
        if (!currentSettings.muted && (!currentSettings.antiFlood || now - lastSpokenAtRef.current > 1200)) {
          lastSpokenAtRef.current = now;
          if (speechText && speechQueueRef.current.length < currentSettings.maxQueue) {
            speechQueueRef.current.push({
              text: currentSettings.template.replace("{user}", user).replace("{msg}", speechText),
              rate: currentSettings.rate,
              pitch: currentSettings.pitch,
              volume: currentSettings.volume,
              voiceURI: currentSettings.voice,
            });
            processSpeechQueue();
          }
        }
      });
    });

    socket.addEventListener("error", () => {
      setConnectionState("error");
      setConnectionError("Não foi possível abrir o chat público da Twitch.");
    });
    socket.addEventListener("close", () => {
      setConnectionState((current) => current === "error" ? current : "disconnected");
    });
    return () => socket.close();
  }, [channel, connected, connectionVersion]);

  function connect() {
    const cleanChannel = channel.trim().toLowerCase().replace(/^https?:\/\/(www\.)?twitch\.tv\//, "").split(/[/?#]/)[0];
    if (!cleanChannel) return;
    setChannel(cleanChannel);
    setMessages([]);
    setConnected(true);
    setConnectionState("connecting");
    setConnectionError("");
    setConnectionVersion((version) => version + 1);
  }

  function resetVoice() {
    setVoice(availableVoices[0]?.voiceURI || "");
    setTemplate("{msg}");
    setRate(1.1);
    setPitch(1);
    setVolume(0.9);
  }

  function tryVoice() {
    void speak(template.replace("{user}", "TwitchVoice").replace("{msg}", "Este é um teste de voz para a sua live."), rate, pitch, volume, voice).catch(() => undefined);
  }

  function copyOverlayUrl() {
    const params = new URLSearchParams({
      channel,
      voiceURI: voice,
      voiceName: availableVoices.find((item) => item.voiceURI === voice)?.name || "",
      voiceLang: availableVoices.find((item) => item.voiceURI === voice)?.lang || "pt-BR",
      rate: String(rate),
      pitch: String(pitch),
      volume: String(volume),
      template,
      muted: String(muted),
    });
    void navigator.clipboard.writeText(`${window.location.origin}/overlay?${params.toString()}`);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="TwitchVoice início"><span className="brand-mark">◉</span><span>Twitch<span>Voice</span></span></a>
        <div className="connect-form">
          <div className="channel-input"><span className="input-icon">⌕</span><input aria-label="Canal ou URL da Twitch" placeholder="Canal ou URL da Twitch" value={channel} onChange={(event) => setChannel(event.target.value)} onKeyDown={(event) => event.key === "Enter" && connect()} /></div>
          <button className="primary-button" onClick={connect}><span>▶</span> {connected ? "Reconectar" : "Conectar"}</button>
        </div>
        <div className={`connection-status ${connectionState === "connected" ? "is-connected" : ""}`} title={connectionError}><span className="status-dot" />{statusText}</div>
      </header>

      <main className="main-content">
        <section className="hero">
          <div className="eyebrow"><span className="eyebrow-line" /> TTS PARA STREAMERS</div>
          <h1>Seu chat.<br /><em>Sua voz.</em> Sua live.</h1>
          <p>Transforme as mensagens da sua comunidade em uma experiência viva. Conecte seu canal e deixe o TwitchVoice narrar cada momento.</p>
          <div className="hero-meta"><span><span className="meta-icon">✦</span> Voz natural em tempo real</span><span><span className="meta-icon">◌</span> Privacidade em primeiro lugar</span></div>
        </section>

        <div className="workspace-grid">
          <aside className="settings-card card">
            <div className="card-heading"><div><span className="section-kicker">CONTROLE</span><h2>Configurações</h2></div><span className="gear">⚙</span></div>
            <div className="panel-tabs">
              <button className={panel === "voice" ? "active" : ""} onClick={() => setPanel("voice")}>◉ <span>Voz</span></button>
              <button className={panel === "words" ? "active" : ""} onClick={() => setPanel("words")}>✦ <span>Palavras</span></button>
              <button className={panel === "users" ? "active" : ""} onClick={() => setPanel("users")}>♙ <span>Usuários</span></button>
              <button className={panel === "translate" ? "active" : ""} onClick={() => setPanel("translate")}>文 <span>Traduzir</span></button>
            </div>

            {panel === "voice" && <div className="settings-body">
              <div className="setting-title"><label htmlFor="voice">Voz selecionada</label><button className="reset-button" onClick={resetVoice}>↺ Restaurar</button></div>
              <select id="voice" value={voice} onChange={(event) => setVoice(event.target.value)}>
                {[...azureVoices, ...(availableVoices.length ? availableVoices : fallbackVoices)].map((item) => <option key={item.voiceURI || item.name} value={item.voiceURI}>{item.name} ({item.lang})</option>)}
              </select>
              <p className="helper-text voice-help">{availableVoices.length ? "Vozes instaladas no seu navegador e sistema." : "Nenhuma voz carregada ainda. Clique novamente em Ouvir exemplo."}</p>
              <label className="field-label" htmlFor="template">Formato da mensagem <span title="Use {user} e {msg}">ⓘ</span></label>
              <input id="template" value={template} onChange={(event) => setTemplate(event.target.value)} placeholder="{user} disse: {msg}" />
              <div className="range-field"><div><label htmlFor="rate">Velocidade</label><output>{rate.toFixed(1)}x</output></div><input id="rate" type="range" min="0.5" max="2" step="0.1" value={rate} onChange={(event) => setRate(Number(event.target.value))} /></div>
              <div className="range-field"><div><label htmlFor="pitch">Tom</label><output>{pitch.toFixed(1)}</output></div><input id="pitch" type="range" min="0.5" max="2" step="0.1" value={pitch} onChange={(event) => setPitch(Number(event.target.value))} /></div>
              <div className="range-field"><div><label htmlFor="volume">Volume</label><output>{Math.round(volume * 100)}%</output></div><input id="volume" type="range" min="0" max="1" step="0.05" value={volume} onChange={(event) => setVolume(Number(event.target.value))} /></div>
              <button className="secondary-button full-width" onClick={tryVoice}>▷ Ouvir exemplo</button>
            </div>}
            {panel === "words" && <div className="settings-body"><label className="field-label" htmlFor="blocked-words">Palavras bloqueadas</label><textarea id="blocked-words" value={blockedWords} onChange={(event) => setBlockedWords(event.target.value)} /><p className="helper-text">Uma palavra por linha. Mensagens contendo esses termos não serão narradas.</p></div>}
            {panel === "users" && <div className="settings-body"><label className="field-label" htmlFor="blocked-users">Usuários bloqueados</label><textarea id="blocked-users" value={blockedUsers} onChange={(event) => setBlockedUsers(event.target.value)} /><p className="helper-text">Uma conta por linha. Bots conhecidos já ficam ignorados por padrão.</p></div>}
            {panel === "translate" && <div className="settings-body"><label className="field-label" htmlFor="language">Idioma de saída</label><select id="language"><option>Português (Brasil)</option><option>English (USA)</option><option>Español</option></select><div className="toggle-row"><span>Traduzir mensagens automaticamente</span><button className={`toggle ${translated ? "on" : ""}`} onClick={() => setTranslated(!translated)} aria-label="Ativar tradução"><span /></button></div><p className="helper-text">A tradução será aplicada antes da leitura da mensagem.</p></div>}

            <div className="preferences">
              <div className="preferences-title">PREFERÊNCIAS RÁPIDAS</div>
              <Toggle label="Auto-scroll do chat" value={autoScroll} onChange={setAutoScroll} />
              <Toggle label="Ignorar bots" value={ignoreBots} onChange={setIgnoreBots} />
              <Toggle label="Ignorar comandos (!/)" value={ignoreCommands} onChange={setIgnoreCommands} />
              <Toggle label="Proteção anti-flood" value={antiFlood} onChange={setAntiFlood} />
              <div className="queue-limit"><span>Máximo na fila</span><input type="number" min="1" max="99" value={maxQueue} onChange={(event) => setMaxQueue(Number(event.target.value))} /></div>
            </div>
          </aside>

          <section className="chat-card card">
            <div className="chat-heading"><div><span className="section-kicker">MONITORAMENTO</span><div className="chat-title-row"><h2>Feed do chat</h2><span className="live-pill"><span /> AO VIVO</span></div></div><div className="chat-actions"><button title="Copiar URL configurada para OBS" onClick={copyOverlayUrl}>OBS</button><button title="Limpar chat" onClick={() => setMessages([])}>⌫</button></div></div>
            <div className="chat-status"><div className={`sound-orb ${connectionState === "connected" ? "active" : ""}`}><span>{muted ? "◌" : "◉"}</span></div><div><strong>{connectionState === "connected" ? `Ouvindo #${channel}` : connectionState === "error" ? "Falha ao conectar" : connected ? `Conectando #${channel}` : "Aguardando conexão"}</strong><p>{connectionError || (connectionState === "connected" ? "As mensagens novas serão lidas automaticamente." : "Conecte um canal da Twitch para começar.")}</p></div><button className={`mute-button ${muted ? "muted" : ""}`} onClick={() => setMuted(!muted)} title={muted ? "Ativar voz" : "Silenciar voz"}>{muted ? "◌" : "◉"}</button></div>
            <div className="chat-toolbar"><span>Mensagens recentes</span><span className="queue-count"><span className="queue-dot" /> Fila: <b>{queueCount}</b></span></div>
            <div className="message-list">{visibleMessages.length ? visibleMessages.map((message) => <article className="message" key={message.id}><div className="avatar" style={{ background: `${message.color}20`, color: message.color }}>{message.user.slice(0, 1).toUpperCase()}</div><div className="message-content"><div className="message-meta"><strong style={{ color: message.color }}>{message.user}</strong>{message.badge && <span className="badge">{message.badge}</span>}<time>{message.time}</time></div><p>{translated ? "Esta es una demostración de traducción." : message.text}</p></div><button className="speak-message" onClick={() => speak(message.text, rate, pitch, volume, voice)} title="Ler mensagem">▷</button></article>) : <div className="empty-chat"><span>◌</span><p>Nenhuma mensagem visível.</p><small>Ajuste seus filtros ou conecte um canal.</small></div>}</div>
            <div className="chat-footer"><span><span className="footer-dot" /> Sistema operacional</span><span>v1.0.0 · TwitchVoice</span></div>
          </section>
        </div>
      </main>
      <footer className="footer"><span>Feito para quem transforma lives em <em>experiências.</em></span><span>© 2025 TwitchVoice <span className="footer-divider">·</span> Feito com <span className="heart">♥</span> para a comunidade</span></footer>
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <div className="toggle-row"><span>{label}</span><button className={`toggle ${value ? "on" : ""}`} onClick={() => onChange(!value)} aria-label={label}><span /></button></div>;
}
