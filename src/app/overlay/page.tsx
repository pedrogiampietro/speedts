"use client";

import { useEffect, useRef, useState } from "react";

type ReadStatus = "pending" | "reading" | "read";

type OverlayMessage = {
  id: string;
  user: string;
  text: string;
  color: string;
  status: ReadStatus;
  kind: "chat" | "event";
  createdAt: number;
};

type QueueItem = {
  id: string;
  text: string;
  settings: OverlaySettings;
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
  blockedUsers: string[];
  blockedWords: string[];
  ignoreCommands: boolean;
  duplicateWindow: number;
};

type QueueStats = {
  received: number;
  ignored: number;
  queued: number;
  read: number;
  failed: number;
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
  blockedUsers: [],
  blockedWords: [],
  ignoreCommands: true,
  duplicateWindow: 8,
};

const QUEUE_STORAGE_KEY = "twitchvoice-pending-queue";
const STATS_STORAGE_KEY = "twitchvoice-stats";
const HISTORY_STORAGE_KEY = "twitchvoice-history";

function loadBrowserVoices(): Promise<SpeechSynthesisVoice[]> {
  const synthesis = window.speechSynthesis;
  const currentVoices = synthesis.getVoices();
  if (currentVoices.length) return Promise.resolve(currentVoices);
  return new Promise((resolve) => {
    const handler = () => {
      synthesis.removeEventListener("voiceschanged", handler);
      resolve(synthesis.getVoices());
    };
    synthesis.addEventListener("voiceschanged", handler);
    window.setTimeout(() => {
      synthesis.removeEventListener("voiceschanged", handler);
      resolve(synthesis.getVoices());
    }, 2000);
  });
}

async function speak(text: string, settings: OverlaySettings): Promise<void> {
  if (settings.voiceURI.startsWith("azure:")) {
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice: settings.voiceURI.slice(6),
        rate: settings.rate,
        pitch: settings.pitch,
      }),
    });
    if (!response.ok) throw new Error("Não foi possível gerar o áudio Azure.");
    const objectUrl = URL.createObjectURL(await response.blob());
    const audio = new Audio(objectUrl);
    audio.volume = settings.volume;
    try {
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error("Não foi possível reproduzir o áudio."));
        void audio.play().catch(reject);
      });
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
    return;
  }

  if (!("speechSynthesis" in window)) throw new Error("Síntese de voz não disponível.");
  const voices = await loadBrowserVoices();
  await new Promise<void>((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text);
    const selectedVoice = voices.find((voice) => voice.voiceURI === settings.voiceURI)
      || voices.find((voice) => voice.name === settings.voiceName)
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
    utterance.onerror = (event) => reject(new Error(`Falha na síntese: ${event.error}`));
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
  if (compact.length >= 10) {
    if (/(.)\1{7,}/u.test(compact)) return null;
    if (/(.{2,4})\1{4,}/u.test(compact)) return null;
  }
  return withoutEmojis;
}

function parseTag(line: string, name: string): string {
  const match = line.match(new RegExp(`(?:^|;)${name}=([^;]*)`));
  return match?.[1]?.replaceAll("\\s", " ").trim() || "";
}

function listSetting(value: string | null): string[] {
  return (value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function readStoredJson<T>(key: string, fallback: T): T {
  try {
    const stored = window.localStorage.getItem(key);
    return stored ? JSON.parse(stored) as T : fallback;
  } catch {
    return fallback;
  }
}

export default function OverlayPage() {
  const [messages, setMessages] = useState<OverlayMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [connectionLabel, setConnectionLabel] = useState("CONECTANDO...");
  const [stats, setStats] = useState<QueueStats>(() =>
    readStoredJson(STATS_STORAGE_KEY, { received: 0, ignored: 0, queued: 0, read: 0, failed: 0 })
  );
  const [showStats, setShowStats] = useState(true);

  const settingsRef = useRef<OverlaySettings>(defaultSettings);
  const speechQueue = useRef<QueueItem[]>([]);
  const speaking = useRef(false);
  const mounted = useRef(true);
  const processRef = useRef<() => void>(() => undefined);
  const retryTimer = useRef<number | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const reconnectAttempt = useRef(0);
  const socketRef = useRef<WebSocket | null>(null);
  const statsRef = useRef(stats);
  const recentMessages = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    statsRef.current = stats;
    window.localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(stats));
  }, [stats]);

  function updateStats(change: Partial<QueueStats>) {
    setStats((current) => {
      const next = { ...current };
      (Object.keys(change) as Array<keyof QueueStats>).forEach((key) => {
        next[key] += change[key] || 0;
      });
      return next;
    });
  }

  function persistPendingQueue() {
    const pending = speechQueue.current.map(({ id, text, settings }) => ({ id, text, settings }));
    window.localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(pending));
  }

  function persistHistory(message: OverlayMessage) {
    const history = readStoredJson<OverlayMessage[]>(HISTORY_STORAGE_KEY, []);
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify([
      message,
      ...history.filter((item) => item.id !== message.id),
    ].slice(0, 100)));
  }

  function processSpeechQueue() {
    if (!mounted.current || speaking.current || speechQueue.current.length === 0) return;
    const next = speechQueue.current.shift();
    if (!next) return;

    persistPendingQueue();
    setMessages((current) => current.map((message) =>
      message.id === next.id ? { ...message, status: "reading" } : message
    ));
    speaking.current = true;

    void speak(next.text, next.settings).then(() => {
      if (!mounted.current) return;
      setMessages((current) => current.map((message) => {
        if (message.id !== next.id) return message;
        const readMessage = { ...message, status: "read" as const };
        persistHistory(readMessage);
        updateStats({ read: 1, queued: -1 });
        return readMessage;
      }));
    }).catch(() => {
      if (!mounted.current) return;
      speechQueue.current.unshift(next);
      updateStats({ failed: 1 });
    }).finally(() => {
      if (!mounted.current) return;
      speaking.current = false;
      persistPendingQueue();
      if (speechQueue.current.length > 0) {
        retryTimer.current = window.setTimeout(() => processRef.current(), 1500);
      }
    });
  }

  useEffect(() => {
    mounted.current = true;
    processRef.current = processSpeechQueue;

    const loadSettings = () => {
      const saved = window.localStorage.getItem("twitchvoice-settings");
      const params = new URLSearchParams(window.location.search);
      try {
        const stored = saved ? JSON.parse(saved) : {};
        settingsRef.current = {
          ...defaultSettings,
          ...stored,
          blockedUsers: [
            ...defaultSettings.blockedUsers,
            ...listSetting(params.get("blockedUsers")),
            ...(Array.isArray(stored.blockedUsers) ? stored.blockedUsers : []),
          ],
          blockedWords: [
            ...defaultSettings.blockedWords,
            ...listSetting(params.get("blockedWords")),
            ...(Array.isArray(stored.blockedWords) ? stored.blockedWords : []),
          ],
          ignoreCommands: params.has("ignoreCommands")
            ? params.get("ignoreCommands") === "true"
            : stored.ignoreCommands ?? defaultSettings.ignoreCommands,
          duplicateWindow: params.has("duplicateWindow")
            ? Number(params.get("duplicateWindow")) || defaultSettings.duplicateWindow
            : stored.duplicateWindow ?? defaultSettings.duplicateWindow,
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
      window.queueMicrotask(() => setShowStats(params.get("stats") !== "false"));
    };

    loadSettings();
    window.addEventListener("storage", loadSettings);

    const queryChannel = new URLSearchParams(window.location.search).get("channel")
      ?.toLowerCase().replace(/^#/, "").replace(/[^a-z0-9_]/g, "");
    if (!queryChannel) return;

    const pendingStored = readStoredJson<Array<{ id: string; text: string; settings: OverlaySettings }>>(
      QUEUE_STORAGE_KEY,
      []
    );
    const history = readStoredJson<OverlayMessage[]>(HISTORY_STORAGE_KEY, []);
    const pendingMessages = pendingStored.map((item) => ({
      id: item.id,
      user: "Fila restaurada",
      text: item.text,
      color: "#64dbc5",
      status: "pending" as const,
      kind: "chat" as const,
      createdAt: Date.now(),
    }));
    window.queueMicrotask(() => {
      setMessages([...pendingMessages, ...history.filter((item) => item.status === "read")].slice(-5));
    });

    pendingStored.forEach((item) => speechQueue.current.push(item));
    if (pendingStored.length) {
      window.queueMicrotask(() => {
        updateStats({ queued: pendingStored.length });
        processRef.current();
      });
    }

    function shouldIgnore(user: string, text: string): boolean {
      const settings = settingsRef.current;
      const normalizedUser = user.toLowerCase();
      const normalizedText = text.toLowerCase();
      if (settings.blockedUsers.includes(normalizedUser)) return true;
      if (settings.blockedWords.some((word) => normalizedText.includes(word))) return true;
      if (settings.ignoreCommands && normalizedText.startsWith("!")) return true;
      const now = Date.now();
      const key = `${normalizedUser}:${normalizedText}`;
      const last = recentMessages.current.get(key);
      recentMessages.current.forEach((time, recentKey) => {
        if (now - time > settings.duplicateWindow * 1000) recentMessages.current.delete(recentKey);
      });
      if (last && now - last < settings.duplicateWindow * 1000) return true;
      recentMessages.current.set(key, now);
      return false;
    }

    function enqueue(message: OverlayMessage, speechText: string) {
      setMessages((current) => [...current.slice(-4), message]);
      if (settingsRef.current.muted) return;
      speechQueue.current.push({
        id: message.id,
        text: speechText,
        settings: settingsRef.current,
      });
      updateStats({ queued: 1 });
      persistPendingQueue();
      processRef.current();
    }

    let socket: WebSocket | null = null;

    function connect() {
      if (!mounted.current) return;
      setConnected(false);
      setConnectionLabel(reconnectAttempt.current ? "RECONECTANDO..." : "CONECTANDO...");
      socket = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        reconnectAttempt.current = 0;
        socket?.send("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
        socket?.send("PASS SCHMOOPIIE\r\n");
        socket?.send(`NICK justinfan${Math.floor(Math.random() * 900000 + 100000)}\r\n`);
        socket?.send(`JOIN #${queryChannel}\r\n`);
        setConnected(true);
        setConnectionLabel(`AO VIVO · ${queryChannel}`);
      });

      socket.addEventListener("message", (event) => {
        String(event.data).split("\r\n").filter(Boolean).forEach((line) => {
          if (line.startsWith("PING")) {
            socket?.send("PONG :tmi.twitch.tv\r\n");
            return;
          }

          if (line.includes(" PRIVMSG #")) {
            const text = line.match(/ PRIVMSG #[^ ]+ :(.*)$/)?.[1];
            if (!text) return;
            updateStats({ received: 1 });
            const user = parseTag(line, "display-name") || "Twitch";
            const color = parseTag(line, "color") || "#a875ff";
            if (shouldIgnore(user, text)) {
              updateStats({ ignored: 1 });
              return;
            }
            const speechText = sanitizeForSpeech(text);
            if (!speechText) {
              updateStats({ ignored: 1 });
              return;
            }
            const message: OverlayMessage = {
              id: crypto.randomUUID(),
              user,
              text,
              color,
              status: "pending",
              kind: "chat",
              createdAt: Date.now(),
            };
            enqueue(message, settingsRef.current.template
              .replace("{user}", user)
              .replace("{msg}", speechText));
          }

          if (line.includes(" USERNOTICE #")) {
            const messageId = parseTag(line, "msg-id");
            if (!messageId) return;
            const user = parseTag(line, "display-name") || "Twitch";
            let eventText = "";
            if (messageId === "sub" || messageId === "resub") {
              eventText = `${user} acabou de assinar o canal!`;
            } else if (messageId === "subgift") {
              eventText = `${user} enviou uma inscrição presenteada!`;
            } else if (messageId === "raid") {
              const viewers = parseTag(line, "msg-param-viewerCount");
              eventText = `${user} está trazendo ${viewers || "uma nova"} audiência!`;
            } else if (messageId === "ritual") {
              eventText = `${user} chegou ao canal pela primeira vez!`;
            }
            if (!eventText) return;
            updateStats({ received: 1 });
            const message: OverlayMessage = {
              id: crypto.randomUUID(),
              user,
              text: eventText,
              color: "#64dbc5",
              status: "pending",
              kind: "event",
              createdAt: Date.now(),
            };
            enqueue(message, eventText);
          }
        });
      });

      socket.addEventListener("close", () => {
        if (!mounted.current) return;
        setConnected(false);
        setConnectionLabel("RECONECTANDO...");
        reconnectAttempt.current += 1;
        const delay = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempt.current - 1, 5));
        reconnectTimer.current = window.setTimeout(connect, delay);
      });

      socket.addEventListener("error", () => {
        socket?.close();
      });
    }

    connect();

    return () => {
      mounted.current = false;
      window.removeEventListener("storage", loadSettings);
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
      if (reconnectTimer.current !== null) window.clearTimeout(reconnectTimer.current);
      socket?.close();
      persistPendingQueue();
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- processSpeechQueue is accessed through processRef.
  }, []);

  const pendingCount = messages.filter((message) => message.status === "pending").length;
  const readingCount = messages.filter((message) => message.status === "reading").length;

  return (
    <main className="overlay-page" aria-label="Overlay de chat ao vivo da Twitch">
      {showStats && (
        <div className="overlay-panel">
          <span><b>{stats.received}</b> recebidas</span>
          <span><b>{stats.queued}</b> na fila</span>
          <span><b>{stats.read}</b> lidas</span>
          <span><b>{stats.ignored}</b> ignoradas</span>
          <span><b>{stats.failed}</b> falhas</span>
        </div>
      )}
      <div className="overlay-messages">
        {messages.map((message) => (
          <article
            className={`overlay-message ${message.status} ${message.kind}`}
            key={message.id}
          >
            <strong style={{ color: message.color }}>{message.user}</strong>
            <span>{message.text}</span>
            <small>{message.status === "read" ? "lida" : message.status === "reading" ? "lendo" : "pendente"}</small>
          </article>
        ))}
      </div>
      <div className="overlay-queue">
        {pendingCount} pendente{pendingCount === 1 ? "" : "s"} · {readingCount} lendo
      </div>
      <div className={`overlay-status ${connected ? "connected" : ""}`}>
        <span /> {connectionLabel}
      </div>
    </main>
  );
}
