"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, CalendarDays, Camera, Check, FileText, ImagePlus, LoaderCircle, Search, Sparkles, Trash2, UploadCloud, X } from "lucide-react";
import { createClient } from "../../lib/supabase/client";
import { isSupabaseConfigured } from "../../lib/supabase/config";
import { listPrivateDocuments } from "../../lib/documents/client";
import { extractDocumentText } from "../../lib/documents/extract";
import {
  DOCUMENT_BUCKET,
  DOCUMENT_CLASSIFICATIONS,
  DOCUMENT_MIME_TYPES,
  MAX_DOCUMENT_BYTES,
  type DocumentClassification,
  type DocumentMimeType,
  type DocumentRecord,
} from "../../lib/documents/types";
import type { PartnerResponse } from "../../lib/ai/contracts";
import "./documents.css";

const allowedTypes = new Set<string>(DOCUMENT_MIME_TYPES);
const subscribeToClientMount = () => () => {};
const getClientMountSnapshot = () => true;
const getServerMountSnapshot = () => false;

function readableSize(bytes: number | null) {
  if (!bytes) return "Text note";
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileExtension(type: DocumentMimeType) {
  return type === "application/pdf" ? "pdf" : type === "image/jpeg" ? "jpg" : type === "image/png" ? "png" : "webp";
}

async function hasValidSignature(file: File) {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (file.type === "application/pdf") return new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";
  if (file.type === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (file.type === "image/png") return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  if (file.type === "image/webp") return new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  return false;
}

function safeFileName(name: string) {
  return name.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 240) || "document";
}

function errorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error
    ? error.message
    : error && typeof error === "object" && "message" in error && typeof error.message === "string"
      ? error.message
      : "";
  if (/could not find the table ['"]?public\.documents['"]? in the schema cache/i.test(message)) {
    return "Private document storage is not set up in Supabase yet. Apply migration 0005_private_documents.sql, then reload this page.";
  }
  return message || fallback;
}

function parseApiError(value: unknown) {
  if (value && typeof value === "object" && "error" in value && value.error && typeof value.error === "object" && "message" in value.error && typeof value.error.message === "string") {
    return value.error.message;
  }
  return "The document could not be explained right now.";
}

function suggestionKey(documentId: string, value: string) {
  let hash = 2166136261;
  for (const char of value.trim().replace(/\s+/g, " ")) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `${documentId}:${(hash >>> 0).toString(36)}`;
}

export default function DocumentLibrary({
  openCapture = false,
  openDocumentId,
  ownerId,
  authState,
}: {
  openCapture?: boolean;
  openDocumentId?: string;
  ownerId: string | null;
  authState: "loading" | "ready" | "unavailable";
}) {
  const clientMounted = useSyncExternalStore(subscribeToClientMount, getClientMountSnapshot, getServerMountSnapshot);
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const supabaseConfigured = isSupabaseConfigured();
  const [accountReady, setAccountReady] = useState(!supabaseConfigured);
  const [userId, setUserId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(supabaseConfigured);
  const [captureOpen, setCaptureOpen] = useState(openCapture);
  const [classification, setClassification] = useState<DocumentClassification | "">("");
  const [title, setTitle] = useState("");
  const [noteText, setNoteText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyMessage, setBusyMessage] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<{ document: DocumentRecord; url?: string } | null>(null);
  const [extracted, setExtracted] = useState<Record<string, { text: string; method: string }>>({});
  const [extractionStatus, setExtractionStatus] = useState<{ id: string; message: string } | null>(null);
  const [explanations, setExplanations] = useState<Record<string, PartnerResponse>>({});
  const [dismissedSuggestions, setDismissedSuggestions] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem("aiask-dismissed-document-suggestions");
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(-100) : [];
    } catch {
      return [];
    }
  });
  const [explainBusyId, setExplainBusyId] = useState<string | null>(null);
  const previousOwnerId = useRef<string | null | undefined>(undefined);
  const automaticPreviewId = useRef<string | null>(null);

  const openPreview = useCallback(async (document: DocumentRecord) => {
    setError("");
    if (!document.storage_path) { setPreview({ document }); return; }
    try {
      const { data, error: urlError } = await createClient().storage.from(DOCUMENT_BUCKET).createSignedUrl(document.storage_path, 300);
      if (urlError || !data?.signedUrl) throw urlError ?? new Error("A private preview link could not be created.");
      setPreview({ document, url: data.signedUrl });
    } catch (previewError) {
      setError(errorMessage(previewError, "This document could not be previewed."));
    }
  }, []);

  useEffect(() => {
    if (openCapture) setCaptureOpen(true);
  }, [openCapture]);

  useEffect(() => {
    let active = true;
    const previousId = previousOwnerId.current;
    previousOwnerId.current = ownerId;
    if (previousId && previousId !== ownerId) {
      automaticPreviewId.current = null;
      setDocuments([]);
      setPreview(null);
      setExtracted({});
      setExplanations({});
      setCaptureOpen(false);
      setClassification("");
      setTitle("");
      setNoteText("");
      setFile(null);
      setError("");
      if (fileInput.current) fileInput.current.value = "";
      if (cameraInput.current) cameraInput.current.value = "";
    }
    if (!supabaseConfigured) return;
    if (!ownerId) {
      setUserId(null);
      setDocuments([]);
      setAccountReady(authState !== "loading");
      setLoading(authState === "loading");
      if (authState !== "loading") setError("");
      return () => { active = false; };
    }

    setAccountReady(false);
    setLoading(true);
    void (async () => {
      try {
        const data = await listPrivateDocuments(ownerId);
        if (!active) return;
        setUserId(ownerId);
        setDocuments(data);
        setError("");
      } catch (loadError) {
        if (active) {
          setUserId(null);
          setDocuments([]);
          setError(errorMessage(loadError, "Your private document library could not be loaded."));
        }
      } finally {
        if (active) { setAccountReady(true); setLoading(false); }
      }
    })();

    return () => {
      active = false;
    };
  }, [ownerId, authState, supabaseConfigured]);

  useEffect(() => {
    if (!openDocumentId || loading || !userId || userId !== ownerId) return;
    const document = documents.find(item => item.id === openDocumentId);
    if (!document && automaticPreviewId.current !== openDocumentId) {
      automaticPreviewId.current = openDocumentId;
      setNotice("That source document is no longer in your private library. Any linked To-do or Calendar entry was kept.");
      return;
    }
    if (document && automaticPreviewId.current !== openDocumentId) {
      automaticPreviewId.current = openDocumentId;
      void openPreview(document);
    }
  }, [openDocumentId, loading, userId, ownerId, documents, openPreview]);

  async function saveCapture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (!classification) { setError("Choose a classification before saving."); return; }
    if (!file && (classification !== "Note & Idea" || !noteText.trim())) {
      setError("Add a photo or PDF. Text-only captures can be saved as Note & Idea.");
      return;
    }
    if (!userId || userId !== ownerId || !isSupabaseConfigured()) { setError("Sign in and connect Supabase to save private documents."); return; }
    if (file && (!allowedTypes.has(file.type) || file.size < 1 || file.size > MAX_DOCUMENT_BYTES)) {
      setError("Choose a PDF or JPEG, PNG, or WebP image smaller than 10 MB.");
      return;
    }
    if (file) {
      try {
        if (!(await hasValidSignature(file))) {
          setError("The selected file does not match its file type. Choose a valid PDF or image.");
          return;
        }
      } catch {
        setError("The selected file could not be read. Choose it again and try once more.");
        return;
      }
    }

    setSaving(true);
    setBusyMessage(file ? "Saving to your private library…" : "Saving your note…");
    const client = createClient();
    const id = crypto.randomUUID();
    const originalName = file ? safeFileName(file.name) : null;
    const displayTitle = (title.trim() || (originalName ? originalName.replace(/\.[^.]+$/, "") : noteText.trim().split(/\r?\n/).find(line => line.trim())) || "Untitled Note")
      .replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 180);
    const storagePath = file ? `${userId}/${id}.${fileExtension(file.type as DocumentMimeType)}` : null;
    let uploaded = false;
    try {
      if (file && storagePath) {
        const { error: uploadError } = await client.storage.from(DOCUMENT_BUCKET).upload(storagePath, file, {
          contentType: file.type,
          cacheControl: "3600",
          upsert: false,
        });
        if (uploadError) throw uploadError;
        uploaded = true;
      }
      const record = {
        id,
        user_id: userId,
        title: displayTitle,
        classification,
        note_text: noteText.trim() || null,
        file_name: originalName,
        mime_type: file?.type ?? null,
        byte_size: file?.size ?? null,
        storage_path: storagePath,
      };
      const { data, error: insertError } = await client.from("documents")
        .insert(record)
        .select("id,user_id,title,classification,note_text,file_name,mime_type,byte_size,storage_path,created_at")
        .single();
      if (insertError) throw insertError;
      setDocuments(previous => [data as DocumentRecord, ...previous]);
      setTitle("");
      setNoteText("");
      setFile(null);
      setClassification("");
      if (fileInput.current) fileInput.current.value = "";
      if (cameraInput.current) cameraInput.current.value = "";
      setCaptureOpen(false);
      setNotice("Saved to your private Letters & Documents library.");
    } catch (saveError) {
      if (uploaded && storagePath) await client.storage.from(DOCUMENT_BUCKET).remove([storagePath]).catch(() => undefined);
      setError(errorMessage(saveError, "This capture could not be saved."));
    } finally {
      setSaving(false);
      setBusyMessage("");
    }
  }

  function handleFileSelection(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    event.currentTarget.value = "";
    setFile(selected);
    if (selected && !title.trim()) setTitle(selected.name.replace(/\.[^.]+$/, "").slice(0, 180));
    setError("");
  }

  async function deleteDocument(document: DocumentRecord) {
    if (!window.confirm(`Delete “${document.title}” from your private library? This cannot be undone.`)) return;
    setError("");
    const client = createClient();
    try {
      if (document.storage_path) {
        const { error: removeError } = await client.storage.from(DOCUMENT_BUCKET).remove([document.storage_path]);
        if (removeError) throw removeError;
      }
      const { error: deleteError } = await client.from("documents").delete().eq("id", document.id).eq("user_id", userId);
      if (deleteError) throw deleteError;
      setDocuments(previous => previous.filter(item => item.id !== document.id));
      setPreview(current => current?.document.id === document.id ? null : current);
      setNotice("Document deleted.");
    } catch (deleteError) {
      setError(errorMessage(deleteError, "The document could not be deleted."));
    }
  }

  async function getExtractedText(document: DocumentRecord) {
    if (extracted[document.id]) return extracted[document.id];
    if (!document.storage_path || !document.mime_type) throw new Error("This note has no attached file to scan.");
    setExtractionStatus({ id: document.id, message: "Opening the private file…" });
    const { data, error: downloadError } = await createClient().storage.from(DOCUMENT_BUCKET).download(document.storage_path);
    if (downloadError || !data) throw downloadError ?? new Error("The private file could not be opened.");
    if (data.size < 1 || data.size > MAX_DOCUMENT_BYTES) throw new Error("This file is outside the supported size limit.");
    const localFile = new File([data], document.file_name ?? document.title, { type: document.mime_type });
    if (!(await hasValidSignature(localFile))) throw new Error("The stored file no longer matches its declared type.");
    const result = await extractDocumentText(localFile, message => setExtractionStatus({ id: document.id, message }));
    setExtracted(previous => ({ ...previous, [document.id]: result }));
    setExtractionStatus(null);
    return result;
  }

  async function extractText(document: DocumentRecord) {
    setError("");
    try {
      await getExtractedText(document);
      setNotice("Text extracted on this device. It has not been saved to the library.");
    } catch (extractError) {
      setError(errorMessage(extractError, "Text extraction could not be completed."));
    } finally {
      setExtractionStatus(null);
    }
  }

  async function explainDocument(document: DocumentRecord) {
    setError("");
    setExplainBusyId(document.id);
    try {
      const result = await getExtractedText(document);
      const response = await fetch("/api/documents/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: document.id, text: result.text }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(parseApiError(payload));
      if (!payload || typeof payload !== "object" || !("explanation" in payload) || !payload.explanation || typeof payload.explanation !== "object") {
        throw new Error("The AI explanation was incomplete.");
      }
      setExplanations(previous => ({ ...previous, [document.id]: payload.explanation as PartnerResponse }));
    } catch (explainError) {
      setError(errorMessage(explainError, "The document could not be explained."));
    } finally {
      setExplainBusyId(null);
      setExtractionStatus(null);
    }
  }

  function sendToPlanner(document: DocumentRecord, nextStep: string, destination: "todos" | "calendar" | "link") {
    try {
      const key = destination === "calendar" ? "aiask-document-calendar-draft" : "aiask-document-todo-draft";
      window.localStorage.setItem(key, JSON.stringify({
        title: nextStep.trim().slice(0, 240),
        description: "",
        sourceDocumentId: document.id,
        sourceDocumentTitle: document.title.slice(0, 180),
      }));
      router.push(destination === "calendar" ? "/?view=calendar&continueCalendar=1" : destination === "link" ? "/?view=todos&continue=1&linkDocument=1" : "/?view=todos&continue=1");
    } catch {
      setError("The draft could not be opened. Check this browser’s local storage and try again.");
    }
  }

  function dismissSuggestion(document: DocumentRecord, nextStep: string) {
    const key = suggestionKey(document.id, nextStep);
    const next = [...new Set([...dismissedSuggestions, key])].slice(-100);
    setDismissedSuggestions(next);
    try { window.localStorage.setItem("aiask-dismissed-document-suggestions", JSON.stringify(next)); }
    catch { setError("This suggestion was dismissed for this page only because browser storage is unavailable."); }
  }

  function discussWithTeam(document: DocumentRecord, explanation: PartnerResponse) {
    try {
      window.localStorage.setItem("aiask-document-team-context", JSON.stringify({
        id: document.id,
        title: document.title.slice(0, 180),
        classification: document.classification,
        perspective: explanation.perspective.slice(0, 1800),
        questions: explanation.questions.slice(0, 3),
        risks: explanation.risks.slice(0, 3),
        nextStep: explanation.nextStep.slice(0, 1000),
        uncertainty: explanation.uncertainty.slice(0, 3),
      }));
      router.push("/partners?documentContext=1");
    } catch {
      setError("The explanation could not be opened in AI Team. Check this browser’s local storage and try again.");
    }
  }

  const currentDocuments = userId === ownerId ? documents : [];
  const currentPreview = userId === ownerId ? preview : null;
  const visibleDocuments = currentDocuments.filter(document => `${document.title} ${document.classification} ${document.file_name ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));

  return <main className="documents-page wrap" translate="no">
    <button className="planner-back" type="button" onClick={() => router.push("/")}><ArrowLeft size={14}/> Back to AIASK</button>
    <header className="documents-heading">
      <div><div className="section-kicker">PRIVATE FILES, READY WHEN YOU NEED THEM</div><h1>Letters &amp; <em>Documents.</em></h1><p>Save a letter, document, or note. Scan and explain it only when you choose.</p></div>
      <button type="button" className="button button-dark" onClick={() => { setError(""); setCaptureOpen(true); }} disabled={!userId || userId !== ownerId}><ImagePlus size={15}/> Quick Capture</button>
    </header>

    {!isSupabaseConfigured() && <div className="documents-message" role="status">Connect Supabase to enable private document storage. Documents are not saved in this browser.</div>}
    {isSupabaseConfigured() && accountReady && !userId && !error && <div className="documents-message" role="status">Sign in to open your private document library.</div>}
    {notice && <div className="documents-message success" role="status"><Check size={15}/>{notice}<button type="button" onClick={() => setNotice("")} aria-label="Dismiss"><X size={14}/></button></div>}
    {error && <div className="documents-message error" role="alert">{error}<button type="button" onClick={() => setError("")} aria-label="Dismiss"><X size={14}/></button></div>}

    <section className="documents-panel" aria-labelledby="documents-list-title">
      <div className="documents-toolbar"><div><div className="section-kicker">YOUR PRIVATE LIBRARY</div><h2 id="documents-list-title">Saved captures <span>{currentDocuments.length}</span></h2></div>
        <label className="documents-search"><Search size={15}/><span className="sr-only">Search documents</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search your library" /></label>
      </div>
      {loading ? <p className="documents-empty" role="status">Loading your private library…</p>
        : visibleDocuments.length === 0 ? <div className="documents-empty"><span className="documents-empty-icon"><FileText size={21}/></span><h3>{currentDocuments.length ? "No documents match this search." : "Your private library is ready."}</h3><p>{currentDocuments.length ? "Try another search." : "Capture a letter, photo, PDF, or Note & Idea to get started."}</p>{userId === ownerId && userId && <button type="button" className="button button-outline-light" onClick={() => setCaptureOpen(true)}>Start a Quick Capture <ArrowRight size={14}/></button>}</div>
        : <div className="documents-list">{visibleDocuments.map(document => {
          const explanation = explanations[document.id];
          const extraction = extracted[document.id];
          return <article className="document-item" key={document.id}>
            <button type="button" className="document-open" onClick={() => void openPreview(document)} aria-label={`Preview ${document.title}`}>
              <span className="document-icon">{document.mime_type?.startsWith("image/") ? <ImagePlus size={18}/> : <FileText size={18}/>}</span>
              <span className="document-copy"><strong>{document.title}</strong><span>{document.classification} · {document.created_at ? new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(document.created_at)) : ""}</span><small>{document.file_name ?? "Text note"} · {readableSize(document.byte_size)}</small></span>
              <ArrowRight size={15} aria-hidden="true" />
            </button>
            <div className="document-actions">
              {document.storage_path && <button type="button" onClick={() => void extractText(document)} disabled={extractionStatus?.id === document.id || explainBusyId === document.id}><Search size={13}/><span>{extractionStatus?.id === document.id ? extractionStatus.message : extraction ? "Text extracted" : "Extract text"}</span></button>}
              {document.storage_path && <button type="button" onClick={() => void explainDocument(document)} disabled={explainBusyId === document.id || extractionStatus?.id === document.id}>{explainBusyId === document.id ? <LoaderCircle className="documents-spinner" size={13}/> : <Sparkles size={13}/>}<span>Explain with AI</span></button>}
              <button type="button" className="document-delete" onClick={() => void deleteDocument(document)}><Trash2 size={13}/><span>Delete</span></button>
            </div>
            {extraction && <details className="document-extracted"><summary>{extraction.method} · Show extracted text</summary><pre>{extraction.text}</pre></details>}
            {explanation && <div className="document-explanation"><div className="document-explanation-title"><Sparkles size={14}/>AI Knowledge Partner</div><p>{explanation.perspective}</p>
              {explanation.questions.length > 0 && <div><strong>Questions to check</strong><ul>{explanation.questions.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></div>}
              {explanation.risks.length > 0 && <div><strong>Uncertainties</strong><ul>{explanation.risks.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></div>}
              <div className="document-next-step"><strong>AI Team</strong><p>Discuss this explanation with an existing AI partner. Only this selected summary is shared; the full extracted text is not.</p><div><button type="button" onClick={() => discussWithTeam(document, explanation)}>Discuss in AI Team</button></div></div>
              {explanation.nextStep && !dismissedSuggestions.includes(suggestionKey(document.id, explanation.nextStep)) && <div className="document-next-step"><strong>Suggested next step</strong><p>{explanation.nextStep}</p><div><button type="button" onClick={() => sendToPlanner(document, explanation.nextStep, "todos")}>Create To-do</button><button type="button" onClick={() => sendToPlanner(document, explanation.nextStep, "calendar")}><CalendarDays size={13}/>Add to Calendar</button><button type="button" onClick={() => sendToPlanner(document, explanation.nextStep, "link")}>Link existing task</button><button type="button" onClick={() => dismissSuggestion(document, explanation.nextStep)}>Dismiss suggestion</button></div><small>Review and edit the details in the planner. Nothing is created until you submit the form. Dates and reminders are left for you to choose.</small></div>}
            </div>}
          </article>;
        })}</div>}
    </section>

    {clientMounted && captureOpen && userId === ownerId && createPortal(<div className="modal-backdrop documents-modal-backdrop" onClick={() => !saving && setCaptureOpen(false)}><section className="documents-capture-modal" role="dialog" aria-modal="true" aria-labelledby="documents-capture-title" onClick={event => event.stopPropagation()}>
      <button type="button" className="modal-close" onClick={() => !saving && setCaptureOpen(false)} aria-label="Close"><X size={18}/></button>
      <span className="modal-symbol"><UploadCloud size={20}/></span><div className="section-kicker">QUICK CAPTURE</div><h2 id="documents-capture-title">Save it for when you need it.</h2><p className="modal-copy">Choose a photo or PDF, then confirm how you want it classified.</p>
      <form id="document-capture-form" onSubmit={saveCapture}>
        <label htmlFor="document-classification">Classification</label><select id="document-classification" required value={classification} onChange={event => setClassification(event.target.value as DocumentClassification | "")}><option value="" disabled>Choose one</option>{DOCUMENT_CLASSIFICATIONS.map(value => <option key={value} value={value}>{value}</option>)}</select>
        <label htmlFor="document-file">Photo or PDF <span>Optional for Note &amp; Idea</span></label>
        <div className="documents-file-choices">
          <button type="button" className="documents-camera-trigger" onClick={() => cameraInput.current?.click()}><Camera size={16}/>Take photo</button>
          <input ref={fileInput} id="document-file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={handleFileSelection} />
          <input ref={cameraInput} className="documents-camera-input" type="file" accept="image/*" capture="environment" onChange={handleFileSelection} tabIndex={-1} aria-hidden="true" />
        </div>
        {file && <p className="document-file-selected"><Check size={14}/>{safeFileName(file.name)} · {readableSize(file.size)}</p>}
        <label htmlFor="document-title">Title <span>Optional</span></label><input id="document-title" maxLength={180} value={title} onChange={event => setTitle(event.target.value)} placeholder="Give this capture a useful name" />
        <label htmlFor="document-note">Note or context <span>Optional</span></label><textarea id="document-note" maxLength={4000} value={noteText} onChange={event => setNoteText(event.target.value)} placeholder="Add a short note for later…" rows={3}/>
        <p className="documents-privacy-note">Files stay in private storage. Text extraction runs on this device; text is sent to AI only when you choose Explain with AI.</p>
        {!accountReady && <p className="documents-auth-help" role="status">Checking your sign-in…</p>}
        {accountReady && (!userId || userId !== ownerId) && !error && isSupabaseConfigured() && <div className="documents-auth-help" role="status"><p>Sign in to save this capture. After signing in, choose the file again.</p><button type="button" onClick={() => router.push(`/login?next=${encodeURIComponent("/?view=documents&captureDocument=1")}`)}>Sign in to continue <ArrowRight size={13}/></button></div>}
        {error && <p className="storage-error" role="alert">{error}</p>}
      </form>
      <div className="form-foot"><span>Maximum file size: 10 MB.</span><button className="button button-dark" type="submit" form="document-capture-form" disabled={saving || !userId || userId !== ownerId || !classification}>{saving ? busyMessage || "Saving…" : "Save capture"}<ArrowRight size={14}/></button></div>
    </section></div>, document.body)}

    {currentPreview && <div className="modal-backdrop" onClick={() => setPreview(null)}><section className="document-preview-modal" role="dialog" aria-modal="true" aria-label={`Preview ${currentPreview.document.title}`} onClick={event => event.stopPropagation()}>
      <header><div><div className="section-kicker">{currentPreview.document.classification}</div><h2>{currentPreview.document.title}</h2></div><button type="button" onClick={() => setPreview(null)} aria-label="Close preview"><X size={18}/></button></header>
      {currentPreview.document.note_text && <p className="document-preview-note">{currentPreview.document.note_text}</p>}
      {currentPreview.url && currentPreview.document.mime_type?.startsWith("image/") && <img src={currentPreview.url} alt={currentPreview.document.title} />}
      {currentPreview.url && currentPreview.document.mime_type === "application/pdf" && <iframe title={`PDF preview: ${currentPreview.document.title}`} src={currentPreview.url} />}
      {!currentPreview.url && <p>This Note &amp; Idea contains text only.</p>}
    </section></div>}
  </main>;
}
