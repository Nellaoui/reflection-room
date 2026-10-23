import type { Metadata } from "next";
import "./globals.css";
import { getStaffIdentity } from "./lib/staff-auth";
import { getGoogleConfiguration } from "./lib/school-auth-config";
import SignInPanel from "./components/SignInPanel";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Reflection Room · London Academy",
  description: "Morning and lunch break reflection sessions. One shared register for London Academy Bouskoura.",
  icons: {
    icon: "/school-logo.png",
    shortcut: "/school-logo.png",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await getStaffIdentity();
  return (
    <html lang="en">
      <body className="antialiased">{user ? children : <SignInPanel googleReady={!!getGoogleConfiguration()} />}</body>
    </html>
  );
}
