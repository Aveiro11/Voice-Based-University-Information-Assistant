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