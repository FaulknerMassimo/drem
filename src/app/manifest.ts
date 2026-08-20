import type { MetadataRoute } from "next";

/**
 * The install manifest.
 *
 * Installing matters for exactly one screen: capture. A dream survives about
 * ninety seconds after waking, and the difference between an icon on the home
 * screen and finding a browser, a tab and a URL is most of that. Everything
 * else here is in service of that one path being one tap away.
 *
 * `start_url` is the dashboard rather than `/capture`, because the app is
 * opened to read far more often than to write at 4am; the shortcut below is
 * what makes the 4am case a long-press instead of a navigation.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "drem",
    short_name: "drem",
    description: "A private dream journal for lucid dreaming practice",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#07070c",
    theme_color: "#0b0b12",
    orientation: "portrait",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Padded into the safe zone, so Android's own mask cannot crop the moon.
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      {
        name: "Capture a dream",
        short_name: "Capture",
        description: "The dark single-field screen, for writing something down at 4am",
        url: "/capture",
        icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
  };
}
