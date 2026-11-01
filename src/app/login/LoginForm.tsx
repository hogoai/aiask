"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "../../lib/supabase/client";

export default function LoginForm({ configured, nextPath, errorCode }: { configured: boolean; nextPath: string; errorCode?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  async function sendLink() {
    setBusy(true); setMessage(""); setIsError(false);
    if (!configured) {
      setIsError(true);
      setMessage("No sign-in link was sent. Connect this project to Supabase first, then restart the development server.");
      setBusy(false);
      return;
    }
    try {
      const callback = new URL("/auth/callback", window.location.origin);
      callback.searchParams.set("next", nextPath);
      const { error } = await createClient().auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: true, emailRedirectTo: callback.toString() },
      });
      if (error) throw error;
      setSent(true); setMessage("A sign-in link has been sent. Open it in this browser to finish signing in.");
    } catch (error) { setIsError(true); setMessage(error instanceof Error ? error.message : "Could not send the sign-in link."); }
    finally { setBusy(false); }
  }
  function submitEmail(event: FormEvent) {
    event.preventDefault();
    void sendLink();
  }
  async function googleSignIn() {
    setBusy(true); setMessage(""); setIsError(false);
    if (!configured) {
      setIsError(true);
      setMessage("Google sign-in is unavailable until Supabase is connected and its Google provider is enabled.");
      setBusy(false);
      return;
    }
    try {
      const callback = new URL("/auth/callback", window.location.origin); callback.searchParams.set("next", nextPath);
      const { error } = await createClient().auth.signInWithOAuth({ provider: "google", options: { redirectTo: callback.toString() } });
      if (error) throw error;
    } catch (error) { setIsError(true); setMessage(error instanceof Error ? error.message : "Google sign-in is not available."); setBusy(false); }
  }
  return <>
    {!configured && <div className="auth-setup" role="note"><b>Preview mode — account service not connected</b><p>You can view the sign-in form, but no code can be sent and no account can be created until Supabase is configured. Setup instructions are in the project README.</p></div>}
    {errorCode && <p className="auth-message error" role="alert">{errorCode === "setup" ? "Authentication setup is incomplete." : "Sign-in could not be completed. Please try again."}</p>}
    {!sent ? <form className="auth-form" onSubmit={submitEmail}><label htmlFor="auth-email">EMAIL ADDRESS</label><input id="auth-email" type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com"/><button disabled={busy}>{busy ? "Sending…" : "Email me a sign-in link"}</button><small className="auth-form-note">New to AIASK? Your account will be created after you open the link and verify your email.</small></form> : <div className="auth-sent-card"><b>Check your email</b><p>We sent a sign-in link to <strong>{email}</strong>. Open it in this browser to finish signing in.</p><button type="button" className="auth-google" onClick={() => void sendLink()} disabled={busy}>{busy ? "Sending…" : "Resend sign-in link"}</button><button type="button" className="auth-text-button" onClick={() => { setSent(false); setMessage(""); }}>Use a different email</button><small>The default Supabase email service only sends to authorized project-team addresses during testing.</small></div>}
    <div className="auth-divider"><span>OR</span></div><button className="auth-google" type="button" onClick={googleSignIn} disabled={busy}>Continue with Google</button>
    {message && <p className={`auth-message ${isError ? "error" : ""}`} role={isError ? "alert" : "status"}>{message}</p>}
    <small className="auth-provider-note">Email sign-in uses a one-time link. Google also requires enabling the Google provider in Supabase.</small>
  </>;
}
