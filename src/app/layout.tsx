import type { Metadata, Viewport } from "next";
import { ServiceWorker } from "@/components/service-worker";
import "./globals.css";

export const metadata: Metadata = {
  title: "drem",
  description: "A private dream journal for lucid dreaming practice",
  // A dream journal has no business appearing in any index, ever.
  robots: { index: false, follow: false, nocache: true },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    // iOS has no manifest; these are how an installed drem gets the same
    // chrome-less dark screen there that `display: standalone` gives elsewhere.
    capable: true,
    title: "drem",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0b12",
  width: "device-width",
  initialScale: 1,
  // An installed app should not rubber-band like a page. Zoom is deliberately
  // left alone: pinching to read your own handwriting on a photographed page
  // is a thing people do.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
