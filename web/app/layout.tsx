import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tacet Dashboard",
  description: "Which page uses which API, and which APIs nothing uses",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <header className="top">
          <Link href="/" className="brand">
            Tacet
          </Link>
          <span className="muted">API ↔ Frontend</span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
