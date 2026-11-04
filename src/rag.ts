import { openai, qdrant, embed, COLLECTION } from "./clients";
import { CATEGORY, PROGRAMMES } from "./programmes";

export const CHAT_MODEL = "llama3.1:latest";

export type Chunk = {
  text: string;
  programmeCode: string;
  programmeName: string;
  sourceType: string; // "syllabus" | "programme_page" | "overview"
  page: number | null;
  sourceUrl: string;
  score: number;
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// other ways people (and the speech recogniser) refer to a programme
const ALIASES: Record<string, string[]> = {
  T2HAI: ["human centered ai", "human centred ai", "hai"],
  S2IOL: ["it and learning"],
  N2ASE: ["software engineering", "ai engineering"],
  N2GDT: ["game design"],
};

export function mentionedProgrammes(question: string): string[] {
  const q = ` ${norm(question)} `;
  return PROGRAMMES.filter((p) =>
    [p.name, ...(ALIASES[p.code] ?? [])].some((n) => q.includes(` ${norm(n)} `)),
  ).map((p) => p.code);
}

export async function retrieve(question: string, limit = 6): Promise<Chunk[]> {
  const codes = mentionedProgrammes(question);
  const res = await qdrant.query(COLLECTION, {
    query: await embed(question),
    limit,
    with_payload: true,
    // if the question names a programme, only look inside it
    filter: codes.length
      ? { must: [{ key: "programme_code", match: { any: codes } }] }
      : undefined,
  });
  return res.points.map((p) => {
    const pl = p.payload as any;
    return {
      text: pl.text,
      programmeCode: pl.programme_code,
      programmeName: pl.programme_name,
      sourceType: pl.source_type,
      page: pl.page,
      sourceUrl: pl.source_url,
      score: p.score,
    };
  });
}

export async function generateAnswer(question: string, chunks: Chunk[]): Promise<string> {
  const excerpts = chunks
    .map((c) => {
      const where = c.page ? `, page ${c.page}` : "";
      return `[${c.programmeName}, ${c.sourceType.replace("_", " ")}${where}]\n${c.text}`;
    })
    .join("\n\n");
  const list = PROGRAMMES.map((p) => p.name).join(", ");

  const res = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: `You are a voice assistant for the master's programmes in ${CATEGORY} at the University of Gothenburg.
The programmes in this field are: ${list}.
Answer using ONLY the excerpts below.

EXCERPTS START
${excerpts}
EXCERPTS END

Rules:
- Your answer will be read out loud: one to three short sentences, plain words, no lists, no markdown, no course codes.
- Never add facts that are not in the excerpts. No guessing.
- Name the programme you are talking about.
- Fees and application dates come from the programme web page as it was when collected, so say briefly that they may have changed.
- Do not say whether someone is allowed or eligible unless the excerpts say so directly.
- If the question is about requirements, courses, fees or deadlines but does not say which programme, do not answer. Ask which programme they mean and name two or three of the programmes above.
- If the excerpts do not answer the question, say so briefly and suggest the programme page or the university's study counselling.`,
      },
      { role: "user", content: question },
    ],
  });
  return (res.choices[0].message.content ?? "").replace(/[*_#`]/g, "").trim();
}

// words that only make sense for one particular programme
const PROGRAMME_TOPICS =
  /entry|admission|requirement|eligib|apply|application|deadline|tuition|fee|cost|course|semester|credit|syllabus|curriculum|duration/i;

// name of the first programme mentioned in the text, or "" if none
export function programmeIn(text: string): string {
  const code = mentionedProgrammes(text)[0];
  return PROGRAMMES.find((p) => p.code === code)?.name ?? "";
}

export const needsProgramme = (question: string) =>
  !programmeIn(question) && PROGRAMME_TOPICS.test(question);