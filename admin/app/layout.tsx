import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Practice Manager",
  description: "Client and policy administration",
  // This portal must never be indexed. It is a private client book on a
  // public URL, and a search engine listing it would be a serious problem.
  robots: { index: false, follow: false, nocache: true },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-SG">
      <body>{children}</body>
    </html>
  );
}
