import type { Metadata } from "next";
import { AuthProvider } from "@/components/auth/AuthProvider";
import "./globals.css";
import "../styles/base.css";
import "../styles/utilities.css";
import "../styles/tokens.css";

export const metadata: Metadata = {
  title: "Popcorn Ready — AI-native video editor",
  description: "Upload clips, give a goal, get an editable AI rough cut.",
};

const themeInitScript = `
(() => {
  try {
    const theme = window.localStorage.getItem("popcorn-ready-theme");
    const validThemes = new Set(["popcorn", "popcorn-warm", "popcorn-night"]);
    if (validThemes.has(theme)) {
      document.documentElement.dataset.theme = theme;
    }
  } catch {}
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
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
