import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { AppHeader } from "@/components/AppHeader";
import "./globals.css";

// Variable font: all weights from one file
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Koya Lead Studio",
  description:
    "Research companies that fit your criteria, qualify them with cited evidence, and prepare outreach drafts for human review.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} h-full`}>
      <body className="flex min-h-full flex-col bg-canvas text-ink">
        <AppHeader />
        <div className="flex-1">{children}</div>
        <footer className="border-t border-line">
          <p className="mx-auto max-w-5xl px-6 py-6 text-xs text-muted">
            Koya Lead Studio drafts outreach for review. Nothing is ever sent automatically.
          </p>
        </footer>
      </body>
    </html>
  );
}
