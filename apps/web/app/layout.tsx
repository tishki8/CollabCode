import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CollabCode",
  description: "Write code together, see who wrote what.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:m-2 focus:rounded focus:bg-white focus:p-2 focus:text-black">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
