import { MAX_EXTRACTED_CHARACTERS } from "./types";

export type ExtractionProgress = (message: string) => void;

function limitedText(chunks: string[]) {
  return chunks.join("\n\n").replace(/[\t ]+\n/g, "\n").trim().slice(0, MAX_EXTRACTED_CHARACTERS);
}

function textFromPdfItems(items: unknown[]) {
  return items.flatMap(item => item && typeof item === "object" && "str" in item && typeof item.str === "string" ? [item.str] : []).join(" ");
}

export async function extractDocumentText(file: File, onProgress: ExtractionProgress = () => {}) {
  async function createOcrWorker() {
    const { createWorker } = await import("tesseract.js");
    return createWorker("eng+deu+chi_sim", 1, {
      logger: message => {
        if (message.status === "recognizing text" && typeof message.progress === "number") {
          onProgress(`Reading text… ${Math.round(message.progress * 100)}%`);
        }
      },
    });
  }

  if (file.type !== "application/pdf") {
    const worker = await createOcrWorker();
    try {
      onProgress("Reading text from image…");
      const result = await worker.recognize(file);
      const text = limitedText([result.data.text]);
      if (!text) throw new Error("No readable text was found in this image.");
      return { text, method: "OCR" as const };
    } finally {
      await worker.terminate();
    }
  }

  onProgress("Reading PDF pages…");
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  if (pdf.numPages > 20) throw new Error("This PDF has more than 20 pages. Split it into smaller files and try again.");

  const textPages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    onProgress(`Reading PDF page ${pageNumber} of ${pdf.numPages}…`);
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    textPages.push(textFromPdfItems(content.items));
  }
  const embeddedText = limitedText(textPages);
  if (embeddedText.length > 80) return { text: embeddedText, method: "PDF text extraction" as const };

  const worker = await createOcrWorker();
  try {
    const ocrPages = Math.min(pdf.numPages, 6);
    const imagePages: string[] = [];
    for (let pageNumber = 1; pageNumber <= ocrPages; pageNumber += 1) {
      onProgress(`Scanning PDF page ${pageNumber} of ${ocrPages}…`);
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser could not prepare the PDF page for scanning.");
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const result = await worker.recognize(canvas);
      imagePages.push(result.data.text);
      canvas.width = 0;
      canvas.height = 0;
    }
    const text = limitedText(imagePages);
    if (!text) throw new Error("No readable text was found in the first six scanned PDF pages.");
    return { text, method: "PDF OCR" as const };
  } finally {
    await worker.terminate();
  }
}
