"use client";

import { useEffect, useState } from "react";
import { createClient } from "../../lib/supabase/client";
import { isSupabaseConfigured } from "../../lib/supabase/config";

type Scope = { status: "ready"; userId: string | null } | { status: "loading" | "unavailable" };

export function useWorkspaceAccount() {
  const [scope, setScope] = useState<Scope>(() => isSupabaseConfigured() ? { status: "loading" } : { status: "ready", userId: null });
  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    let requestedId: string | null | undefined;
    let generation = 0;
    let timer: number | undefined;
    try {
      const client = createClient();
      const { data } = client.auth.onAuthStateChange((_event, session) => {
        const id = session?.user.id ?? null;
        if (id === requestedId) return;
        requestedId = id;
        const request = ++generation;
        window.clearTimeout(timer);
        if (!id) {
          setScope({ status: "unavailable" });
          return;
        }
        setScope({ status: "loading" });
        // Verify outside the Supabase auth change callback.
        timer = window.setTimeout(async () => {
          try {
            const { data: { user }, error } = await client.auth.getUser();
            if (request === generation) setScope(!error && user?.id === id ? { status: "ready", userId: id } : { status: "unavailable" });
          } catch {
            if (request === generation) setScope({ status: "unavailable" });
          }
        }, 0);
      });
      return () => {
        generation++;
        window.clearTimeout(timer);
        data.subscription.unsubscribe();
      };
    } catch {
      setScope({ status: "unavailable" });
    }
  }, []);
  return scope;
}
