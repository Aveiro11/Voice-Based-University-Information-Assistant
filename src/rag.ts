import { QdrantClient } from "@qdrant/js-client-rest";
import OpenAI from "openai";

export const COLLECTION = "syllabus";
export const VECTOR_SIZE = 384;

export const qdrant = new QdrantClient({ host: "localhost", port: 6333 });

// ollama speaks the openai api; the flag is only needed once this runs in the browser
export const openai = new OpenAI({
  baseURL: "http://localhost:11434/v1/",
  apiKey: "ollama",
  dangerouslyAllowBrowser: true,
});

export async function embed(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: "qwen3-embedding",
    input: text,
    dimensions: VECTOR_SIZE,
  });
  return res.data[0].embedding;
}

export type Chunk = {
  text: string;
  page: number;
  chunkIndex: number;
  sourceUrl: string;
  score: number;
};

export async function retrieve(question: string, limit = 5): Promise<Chunk[]> {
  const res = await qdrant.query(COLLECTION, {
    query: await embed(question),
    limit,
    with_payload: true,
  });
  return res.points.map((p) => {
    const pl = p.payload as any;
    return {
      text: pl.text,
      page: pl.page,
      chunkIndex: pl.chunk_index,
      sourceUrl: pl.source_url,
      score: p.score,
    };
  });
}

export const CHAT_MODEL = "llama3.1:latest";

export async function generateAnswer(question: string, chunks: Chunk[]): Promise<string> {
  const excerpts = chunks.map((c) => `[page ${c.page}]\n${c.text}`).join("\n\n");

  const res = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.2, // low, we want it to stick to the text
    messages: [
      {
        role: "system",
        content: `You are a voice assistant answering questions about the Master in Language Technology programme (H2LTG) at the University of Gothenburg.
Answer using ONLY the syllabus excerpts below.

SYLLABUS EXCERPTS START
${excerpts}
SYLLABUS EXCERPTS END

Rules:
- Your answer will be read out loud: one to three short sentences, plain words, no lists, no markdown, no course codes.
- Never add facts that are not in the excerpts. No guessing about dates, fees, deadlines or application details.
- If the excerpts do not answer the question, say so briefly. This syllabus is the 2024 version and does not cover tuition fees, deadlines or timetables. Point the person to the study counselling email mlt-info@flov.gu.se.
- - If the question is too vague to answer (for example "the course" without saying which one), do not answer. Ask one short question about what they want to know.`,
      },
      { role: "user", content: question },
    ],
  });
    return (res.choices[0].message.content ?? "").replace(/[*_#`]/g, "").trim();
}