"use client";

import { SessionProvider } from "next-auth/react";
import { CompanyProfileProvider } from "./CompanyProfile";
import { LiveSessionProvider } from "./LiveSession";
import { ThemeProvider } from "./ThemeProvider";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <ThemeProvider>
        <CompanyProfileProvider>
          <LiveSessionProvider>{children}</LiveSessionProvider>
        </CompanyProfileProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}
