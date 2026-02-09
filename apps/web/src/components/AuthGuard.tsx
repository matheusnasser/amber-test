"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { isAuthenticated } from "@/services/api-client";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    // Skip auth check for login page
    if (pathname === "/login") {
      setIsChecking(false);
      return;
    }

    // Check authentication
    if (!isAuthenticated()) {
      router.replace("/login");
    } else {
      setIsChecking(false);
    }
  }, [pathname, router]);

  // Show loading while checking auth
  if (isChecking && pathname !== "/login") {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <div className="text-center">
          <div className="h-8 w-8 rounded-full border-4 border-gray-200 border-t-gray-600 animate-spin mx-auto" />
          <p className="text-sm text-gray-500 mt-4">Loading...</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
