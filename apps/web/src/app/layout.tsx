import type { Metadata } from "next";
import "./globals.css";
import { AuthGuard } from "@/components/AuthGuard";

export const metadata: Metadata = {
  title: "Supplier Negotiation System",
  description: "AI-powered supplier negotiation platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50 text-gray-900 antialiased">
        <AuthGuard>{children}</AuthGuard>
      </body>
    </html>
  );
}
