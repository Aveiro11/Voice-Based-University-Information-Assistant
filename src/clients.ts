import { QdrantClient } from "@qdrant/js-client-rest";
import OpenAI from "openai";

export const COLLECTION = "programmes";
export const VECTOR_SIZE = 384;

export const qdrant = new QdrantClient({ host: "localhost", port: 6333 });

// ollama speaks the openai api; the flag is only needed in the browser
export const openai = new OpenAI({
  baseURL: "http://localhost:11434/v1/",
  apiKey: "ollama",
  dangerouslyAllowBrowser: true,
  maxRetries: 0, // fail right away, retrying a dead tunnel only adds waiting
});

export async function embed(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: "qwen3-embedding",
    input: text,
    dimensions: VECTOR_SIZE,
  });
  return res.data[0].embedding;
}