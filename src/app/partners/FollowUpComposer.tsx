import type { FormEvent } from "react";
import { Send } from "lucide-react";

type FollowUpComposerProps = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  disabled: boolean;
  loading: boolean;
  label?: string;
};

export default function FollowUpComposer({ id, value, onChange, onSubmit, disabled, loading, label = "Follow-up question" }: FollowUpComposerProps) {
  return <form className="follow-up-composer" onSubmit={onSubmit} aria-label={label} aria-busy={loading}>
    <label className="sr-only" htmlFor={id}>Follow-up question</label>
    <input id={id} value={value} onChange={event => onChange(event.target.value)} placeholder="Ask a follow-up question…" disabled={disabled || loading} />
    <button type="submit" aria-label="Send follow-up question" disabled={!value.trim() || disabled || loading}>
      {loading ? <span className="follow-up-spinner" aria-label="Thinking…">…</span> : <Send size={14} />}
    </button>
  </form>;
}
