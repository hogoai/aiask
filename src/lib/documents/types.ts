export const DOCUMENT_BUCKET = "aiask-private-documents";
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_EXTRACTED_CHARACTERS = 24_000;

export const DOCUMENT_CLASSIFICATIONS = ["Letter", "Document", "Note & Idea"] as const;
export type DocumentClassification = typeof DOCUMENT_CLASSIFICATIONS[number];

export const DOCUMENT_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;
export type DocumentMimeType = typeof DOCUMENT_MIME_TYPES[number];

export type DocumentRecord = {
  id: string;
  user_id: string;
  title: string;
  classification: DocumentClassification;
  note_text: string | null;
  file_name: string | null;
  mime_type: DocumentMimeType | null;
  byte_size: number | null;
  storage_path: string | null;
  created_at: string;
};
