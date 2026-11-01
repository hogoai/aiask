"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { isSupabaseConfigured } from "../lib/supabase/config";
import { createClient } from "../lib/supabase/client";

export default function AccountControl() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    const client = createClient();
    void client.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
    const { data: listener } = client.auth.onAuthStateChange((_event, session) => setEmail(session?.user.email ?? null));
    return () => listener.subscription.unsubscribe();
  }, []);
  if (!isSupabaseConfigured()) return <Link className="account-link" href="/login">Sign in</Link>;
  if (!email) return <Link className="account-link" href="/login">Sign in</Link>;
  return <div className="account-control"><span title={email}>{email}</span><button onClick={async () => { await createClient().auth.signOut(); router.replace("/"); router.refresh(); }}>Sign out</button></div>;
}
