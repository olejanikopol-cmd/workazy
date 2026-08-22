import type { Metadata, Viewport } from "next";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#08090c",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://personal-planner.uchepir.chatgpt.site"),
  title: "Личный планер",
  description: "План, цели, дневник и календарь — в одном спокойном пространстве.",
  openGraph: {
    title: "Личный планер",
    description: "Планируй. Живи. Замечай прогресс.",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Личный планер — планируй, живи, замечай прогресс" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Личный планер",
    description: "Планируй. Живи. Замечай прогресс.",
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body className="antialiased">{children}</body>
    </html>
  );
}
