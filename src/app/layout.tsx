import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Popcorn Ready — AI-native video editor",
  description: "Upload clips, give a goal, get an editable AI rough cut.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
