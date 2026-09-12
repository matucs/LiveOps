import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LiveOps — Operations Dashboard",
  description: "Real-time event processing, workflow orchestration, and chaos testing for LiveOps.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
