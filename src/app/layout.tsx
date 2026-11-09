import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TwitchVoice — Seu chat. Sua voz. Sua live.",
  description: "Transforme as mensagens da sua comunidade em uma experiência viva.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
