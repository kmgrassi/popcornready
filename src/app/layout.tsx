import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "aividi — AI-native video editor",
  description: "Upload clips, give a goal, get an editable AI rough cut.",
};

const themeInitScript = `
(() => {
  try {
    const theme = window.localStorage.getItem("aividi-theme");
    const validThemes = ["popcorn", "popcorn-warm", "popcorn-night"];
    if (validThemes.includes(theme)) {
      document.documentElement.dataset.theme = theme;
    } else {
      delete document.documentElement.dataset.theme;
    }
  } catch {
    delete document.documentElement.dataset.theme;
  }
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
