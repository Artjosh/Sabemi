"use client";

import { useRouter } from "next/navigation";
import * as React from "react";

import { useAuth } from "@/components/auth-provider";
import { Skeleton } from "@/components/ui/primitives";

/** Encaminha a raiz para o dashboard ou para o login, conforme a sessao. */
export function HomeRedirect() {
  const { user, loading } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (loading) return;
    router.replace(user ? "/dashboard" : "/login");
  }, [loading, user, router]);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-3 p-6">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
