"use client";

import { useEffect, useRef, useState } from "react";

type OverlayMessage = {
  id: number;
  user: string;
  text: string;
  color: string;
};

type OverlaySettings = {
  muted: boolean;
  template: string;
  rate: number;
  pitch: number;
  volume: number;
  voiceURI: string;
  voiceName: string;
  voiceLang: string;
};

const defaultSettings: OverlaySettings = {
  muted: false,
  template: "{user} disse: {msg}",
  rate: 1.05,
  pitch: 1,
  volume: 1,
  voiceURI: "",
  voiceName: "",
  voiceLang: "pt-BR",
};

function loadBrowserVoices(): Promise<SpeechSynthesisVoice[]> {
  const synthesis = window.speechSynthesis;
  const currentVoices = synthesis.getVoices();
  if (currentVoices.length) return Promise.resolve(currentVoices);
  return new Promise((resolve) => {
    const handleVoicesChanged = () => {
      synthesis.removeEventListener("voiceschanged", handleVoicesChanged);
      resolve(synthesis.getVoices());
    };
    synthesis.addEventListener("voiceschanged", handleVoicesChanged);
    window.setTimeout(() => {
      synthesis.removeEventListener("voiceschanged", handleVoicesChanged);
      resolve(synthesis.getVoices());
    }, 2000);
  });
}

async function speak(text: string, settings: OverlaySettings): Promise<void> {
  if (settings.voiceURI.startsWith("azure:")) {
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: settings.voiceURI.slice(6), rate: settings.rate, pitch: settings.pitch }),
    });
    if (!response.ok) throw new Error("Não foi possível gerar o áudio Azure.");
    const audio = new Audio(URL.createObjectURL(await response.blob()));
    audio.volume = settings.volume;
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("Não foi possível reproduzir o áudio."));
      void audio.play();
    });
    return;
  }
  if (!("speechSynthesis" in window)) return;
  const voices = await loadBrowserVoices();
  await new Promise<void>((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    const selectedVoice = voices.find((voice) => voice.voiceURI === settings.voiceURI)
      || voices.find((voice) => voice.name === settings.voiceName)
      || (settings.voiceURI && voices.find((voice) => voice.name.toLowerCase() === settings.voiceURI.toLowerCase()))
      || (settings.voiceName && voices.find((voice) => voice.name.toLowerCase().includes(settings.voiceName.toLowerCase())))
      || voices.find((voice) => voice.lang === settings.voiceLang);
    if (selectedVoice) {
      utterance.voice = selectedVoice;
      utterance.lang = selectedVoice.lang;
    } else {
      utterance.lang = settings.voiceLang;
    }
    utterance.rate = settings.rate;
    utterance.pitch = settings.pitch;
    utterance.volume = settings.volume;
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

export default function OverlayPage() {
  const [channel, setChannel] = useState("");
  const [messages, setMessages] = useState<OverlayMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const settingsRef = useRef<OverlaySettings>(defaultSettings);
  const lastSpokenAt = useRef(0);
  const speechQueue = useRef<Array<{ text: string; settings: OverlaySettings }>>([]);
  const speaking = useRef(false);

  function processSpeechQueue() {
    if (speaking.current || speechQueue.current.length === 0) return;
    const next = speechQueue.current.shift();
    if (!next) return;
    speaking.current = true;
    void speak(next.text, next.settings).catch(() => undefined).finally(() => {
      speaking.current = false;
      processSpeechQueue();
    });
  }

  useEffect(() => {
    const loadSettings = () => {
      const saved = window.localStorage.getItem("twitchvoice-settings");
      const params = new URLSearchParams(window.location.search);
      try {
        settingsRef.current = {
          ...defaultSettings,
          ...(saved ? JSON.parse(saved) : {}),
          ...(params.has("muted") ? { muted: params.get("muted") === "true" } : {}),
          ...(params.has("template") ? { template: params.get("template") || defaultSettings.template } : {}),
          ...(params.has("rate") ? { rate: Number(params.get("rate")) || defaultSettings.rate } : {}),
          ...(params.has("pitch") ? { pitch: Number(params.get("pitch")) || defaultSettings.pitch } : {}),
          ...(params.has("volume") ? { volume: Number(params.get("volume")) || defaultSettings.volume } : {}),
          ...(params.has("voiceURI") ? { voiceURI: params.get("voiceURI") || "" } : {}),
          ...(params.has("voiceName") ? { voiceName: params.get("voiceName") || "" } : {}),
          ...(params.has("voiceLang") ? { voiceLang: params.get("voiceLang") || defaultSettings.voiceLang } : {}),
        };
      } catch {
        settingsRef.current = defaultSettings;
      }
    };
    loadSettings();
    window.addEventListener("storage", loadSettings);

    const queryChannel = new URLSearchParams(window.location.search).get("channel")
      ?.toLowerCase().replace(/^#/, "").replace(/[^a-z0-9_]/g, "");
    if (!queryChannel) return;
    const socket = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    socket.addEventListener("open", () => {
      socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
      socket.send("PASS SCHMOOPIIE\r\n");
      socket.send(`NICK justinfan${Math.floor(Math.random() * 900000 + 100000)}\r\n`);
      socket.send(`JOIN #${queryChannel}\r\n`);
      setChannel(queryChannel);
      setConnected(true);
    });
    socket.addEventListener("message", (event) => {
      String(event.data).split("\r\n").filter(Boolean).forEach((line) => {
        if (line.startsWith("PING")) {
          socket.send("PONG :tmi.twitch.tv\r\n");
          return;
        }
        if (!line.includes(" PRIVMSG #")) return;
        const text = line.match(/ PRIVMSG #[^ ]+ :(.*)$/)?.[1];
        const user = line.match(/display-name=([^;]*)/)?.[1] || "Twitch";
        const color = line.match(/color=([^;]*)/)?.[1] || "#a875ff";
        if (!text) return;
        const speechText = sanitizeForSpeech(text);
        const message = { id: Date.now() + Math.random(), user, text, color };
        setMessages((current) => [...current.slice(-4), message]);
        if (Date.now() - lastSpokenAt.current > 1200) {
          lastSpokenAt.current = Date.now();
          const settings = settingsRef.current;
          if (!settings.muted && speechText && speechQueue.current.length < 20) {
            speechQueue.current.push({
              text: settings.template.replace("{user}", user).replace("{msg}", speechText),
              settings,
            });
            processSpeechQueue();
          }
        }
      });
    });
    return () => {
      window.removeEventListener("storage", loadSettings);
      socket.close();
      speechQueue.current = [];
      window.speechSynthesis.cancel();
    };
  }, []);

  return (
    <main className="overlay-page" aria-label={`Chat ao vivo de ${channel || "Twitch"}`}>
      <div className="overlay-messages">
        {messages.map((message) => (
          <article className="overlay-message" key={message.id}>
            <strong style={{ color: message.color }}>{message.user}</strong>
            <span>{message.text}</span>
          </article>
        ))}
      </div>
      <div className={`overlay-status ${connected ? "connected" : ""}`}>
        <span /> {connected ? `AO VIVO · ${channel}` : "CONECTANDO..."}
      </div>
    </main>
  );
}
