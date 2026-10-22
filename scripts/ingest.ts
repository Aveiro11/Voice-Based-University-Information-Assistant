import { readFile } from "node:fs/promises";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { v4 as uuidv4 } from "uuid";
import { qdrant, embed, COLLECTION, VECTOR_SIZE } from "../src/rag.js";

const dataDir = new URL("../data/", import.meta.url);
const raw = await readFile(new URL("syllabus.txt", dataDir), "utf8");
const meta = JSON.parse(await readFile(new URL("metadata.json", dataDir), "utf8"));

const MAX_CHUNK = 1200; // sections shorter than this stay in one piece

function clean(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+$/gm, "")
    // page footer, with or without the "2/4" counter after it
    .replace(/^\(H2LTG\) .*\nSecond cycle.*(\n\d{1,2}\/\d{1,2})?$/gm, "")
    // any counter left over; two digits max so "2023/3048" survives
    .replace(/^\d{1,2}\/\d{1,2}$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// the scraper put "=== PAGE n ===" markers in the text. Glue the pages back
// together (a sentence can run across a page break) but remember where each
// page began so chunks can still be tagged with a page number.
const parts = raw.split(/=== PAGE (\d+) ===\n/);
let full = "";
const pageStarts: { page: number; offset: number }[] = [];
for (let i = 1; i < parts.length; i += 2) {
  pageStarts.push({ page: Number(parts[i]), offset: full.length });
  full += clean(parts[i + 1]) + "\n";
}
const pageAt = (offset: number) =>
  pageStarts.filter((p) => p.offset <= offset).at(-1)!.page;

// cut in front of "5. Outcomes", "Semester 2" and similar headings
const sections = full.split(
  /^(?=\d+\. [A-Z]|Semester \d|General outcomes|Local outcomes)/m,
);

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1000,
  chunkOverlap: 150,
  separators: ["\n\n", "\n", ". ", " "],
});

const pieces: { text: string; page: number }[] = [];
let offset = 0;
let heading = ""; // latest numbered heading, e.g. "6. Content and structure"
for (const section of sections) {
  const page = pageAt(offset);
  offset += section.length;
  const body = section.trim();
  if (!body) continue;

  const lines = body.split("\n");
  const isNumbered = /^\d+\. /.test(lines[0]);
  if (isNumbered) heading = lines[0].trim();
  // a bare heading like "5. Outcomes" has no content, it only becomes a prefix
  if (isNumbered && lines.slice(1).join("").trim() === "") continue;

  // "Semester 2" and friends get their parent heading in front
  const text = isNumbered || !heading ? body : `${heading}\n${body}`;
  if (text.length <= MAX_CHUNK) {
    pieces.push({ text, page });
    continue;
  }
  // too long: split further, repeating the title so each piece has context
  const title = body.split("\n")[0].trim();
  for (const sub of await splitter.splitText(text)) {
    const hasTitle = sub.startsWith(title) || (heading && sub.startsWith(heading));
    pieces.push({ text: hasTitle ? sub : `${title}\n${sub}`, page });
  }
}

const points = [];
for (const [i, piece] of pieces.entries()) {
    console.log(`p${piece.page} | ${piece.text.length} chars | ${piece.text.replace(/\s+/g, " ").slice(0, 60)}`);
  points.push({
    id: uuidv4(),
    vector: await embed(piece.text),
    payload: {
      text: piece.text,
      page: piece.page,
      chunk_index: i,
      document: meta.document_name,
      source_url: meta.pdf_url,
    },
  });
}

// recreate the collection each run, otherwise re-running duplicates everything
const { collections } = await qdrant.getCollections();
if (collections.some((c) => c.name === COLLECTION)) {
  await qdrant.deleteCollection(COLLECTION);
}
await qdrant.createCollection(COLLECTION, {
  vectors: { size: VECTOR_SIZE, distance: "Cosine" },
});
await qdrant.upsert(COLLECTION, { wait: true, points });

console.log(`stored ${points.length} chunks in "${COLLECTION}"`);