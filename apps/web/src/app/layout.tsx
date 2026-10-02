import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "@xyflow/react/dist/style.css";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Chorus",
  description: "many agents, one coordinated output.",
};

/**
 * Root layout: document shell only.
 *
 * The workspace chrome (header, composer, socket provider) lives in the
 * `(workspace)` route group rather than here. Two reasons, both learned the hard
 * way:
 *
 * - `/login` must render without it. Gated by a cookie, the workspace shell would
 *   401 constantly behind the login form, and its fixed header overlays the page
 *   and swallows clicks on the form.
 * - The root layout is cached in the client during navigation and does not
 *   re-render (Next.js 16 docs), so a session check here could not respond to the
 *   `AUTH_EXPIRED` event the sync layer emits.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      lang="en"
    >
      <body className="flex h-screen flex-col overflow-hidden">{children}</body>
    </html>
  );
}
