"use client";

import { SessionProvider } from "next-auth/react";
import { LiveSessionProvider } from "./LiveSession";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <LiveSessionProvider>{children}</LiveSessionProvider>
    </SessionProvider>
  );
}
