"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { createClient } from "../../lib/supabase/client";

const CODE_MIN_LENGTH = 6;
const CODE_MAX_LENGTH = 10;
const RESEND_COOLDOWN_SECONDS = 60;

export default function LoginForm({ configured, nextPath, errorCode }: { configured: boolean; nextPath: string; errorCode?: string }) {
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [code, setCode] = useState("");
  const [resendSeconds, setResendSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = window.setTimeout(() => setResendSeconds(value => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [resendSeconds]);

  async function sendCode() {
    const normalizedEmail = email.trim();
    setMessage("");
    setIsError(false);
    if (!configured) {
      setIsError(true);
      setMessage("No code was sent. Connect this project to Supabase first, then restart the development server.");
      return;
    }
    if (!normalizedEmail || busy) return;

    setBusy(true);
    try {
      const { error } = await createClient().auth.signInWithOtp({
        email: normalizedEmail,
        options: { shouldCreateUser: true },
      });
      if (error) throw error;

      setEmail(normalizedEmail);
      setCode("");
      setStep("code");
      setResendSeconds(RESEND_COOLDOWN_SECONDS);
      setMessage("A new verification code is on its way. Enter it below to continue.");
    } catch (error) {
      const detail = error instanceof Error ? error.message.toLowerCase() : "";
      setIsError(true);
      setMessage(detail.includes("rate") || detail.includes("too many") || detail.includes("wait")
        ? "Please wait before requesting another code, then try again."
        : "We couldn't send a code. Check the email address and try again.");
    } finally {
      setBusy(false);
    }
  }

  function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendCode();
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!/^\d{6,10}$/.test(code)) {
      setIsError(true);
      setMessage("Enter the verification code from your email.");
      return;
    }

    setBusy(true);
    setMessage("");
    setIsError(false);
    try {
      const { error } = await createClient().auth.verifyOtp({ email: email.trim(), token: code, type: "email" });
      if (error) throw error;
      window.location.replace(nextPath);
    } catch {
      setIsError(true);
      setMessage("That code could not be verified. It may be incorrect or expired. Request a new code and try again.");
    } finally {
      setBusy(false);
    }
  }

  function changeEmail() {
    setStep("email");
    setCode("");
    setResendSeconds(0);
    setMessage("");
    setIsError(false);
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
    {step === "email" ? <form className="auth-form" onSubmit={submitEmail}>
      <label htmlFor="auth-email">EMAIL ADDRESS</label>
      <input id="auth-email" type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" />
      <button type="submit" disabled={busy}>{busy ? "Sending…" : "Email me a sign-in code"}</button>
      <small className="auth-form-note">New to AIASK? You can create an account by entering the code and verifying your email.</small>
    </form> : <div className="auth-sent-card">
      <h2 id="auth-code-title">Check your email</h2>
      <p>We sent a sign-in code to <strong>{email}</strong>.</p>
      <form className="auth-form auth-code-form" onSubmit={submitCode}>
        <label htmlFor="auth-code">VERIFICATION CODE</label>
        <input
          id="auth-code"
          className="auth-code-input"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6,10}"
          maxLength={CODE_MAX_LENGTH}
          required
          autoFocus
          value={code}
          onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, CODE_MAX_LENGTH))}
          aria-describedby="auth-code-hint"
          placeholder="Enter code"
        />
        <small id="auth-code-hint" className="auth-form-note">Enter the code from your email. You can paste it here.</small>
        <button type="submit" disabled={busy || code.length < CODE_MIN_LENGTH || code.length > CODE_MAX_LENGTH}>{busy ? "Verifying…" : "Verify and continue"}</button>
      </form>
      <div className="auth-code-actions">
        <button type="button" className="auth-text-button" onClick={() => void sendCode()} disabled={busy || resendSeconds > 0}>
          {resendSeconds > 0 ? "Resend code in " + resendSeconds + "s" : "Resend code"}
        </button>
        <button type="button" className="auth-text-button" onClick={changeEmail} disabled={busy}>Use a different email</button>
      </div>
      <small>The default Supabase email service only sends to authorized project-team addresses during testing.</small>
    </div>}
    <div className="auth-divider"><span>OR</span></div><button className="auth-google" type="button" onClick={googleSignIn} disabled={busy}>Continue with Google</button>
    {message && <p className={"auth-message " + (isError ? "error" : "")} role={isError ? "alert" : "status"}>{message}</p>}
    <small className="auth-provider-note">Email sign-in uses a one-time code. Google also requires enabling the Google provider in Supabase.</small>
  </>;
}
