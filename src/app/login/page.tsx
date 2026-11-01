import Link from "next/link";
import { isSupabaseConfigured } from "../../lib/supabase/config";
import LoginForm from "./LoginForm";
import LanguageSwitcher from "../LanguageSwitcher";
import "./login.css";

type Props = { searchParams: Promise<{ next?: string | string[]; error?: string | string[] }> };

function safeNext(value: string | string[] | undefined) {
  const path = Array.isArray(value) ? value[0] : value;
  return path?.startsWith("/") && !path.startsWith("//") ? path : "/workspace";
}

export default async function LoginPage({ searchParams }: Props) {
  const params = await searchParams;
  const error = Array.isArray(params.error) ? params.error[0] : params.error;
  return <main className="auth-shell">
    <header className="auth-top"><Link href="/" className="auth-brand">✳ aiask<span>.</span></Link><div className="auth-top-actions"><LanguageSwitcher /><Link href="/">Back to home</Link></div></header>
    <section className="auth-card"><div className="auth-kicker">YOUR PERSONAL AI TEAM</div><h1>Make room for<br/><em>what matters.</em></h1><p>Sign in or create an account to continue to your private workspace.</p>
      <LoginForm configured={isSupabaseConfigured()} nextPath={safeNext(params.next)} errorCode={error} />
      <small className="auth-privacy">Existing browser demo data is not uploaded or migrated when you sign in.</small>
    </section>
  </main>;
}
