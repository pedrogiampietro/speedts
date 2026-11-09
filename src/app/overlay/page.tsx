"use client";

import { useEffect, useRef, useState } from "react";

type OverlayMessage = {
  id: number;
  user: string;
  text: string;
  color: string;
};

function speak(text: string) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "pt-BR";
  utterance.rate = 1.05;
  utterance.volume = 1;
  window.speechSynthesis.speak(utterance);
}

export default function OverlayPage() {
  const [channel, setChannel] = useState("");
  const [messages, setMessages] = useState<OverlayMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const lastSpokenAt = useRef(0);

  useEffect(() => {
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
        const message = { id: Date.now() + Math.random(), user, text, color };
        setMessages((current) => [...current.slice(-4), message]);
        if (Date.now() - lastSpokenAt.current > 1200) {
          lastSpokenAt.current = Date.now();
          speak(`${user} disse: ${text}`);
        }
      });
    });
    return () => socket.close();
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
