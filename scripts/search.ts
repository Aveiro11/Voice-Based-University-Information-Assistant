import { retrieve } from "../src/rag.js";

const question = process.argv.slice(2).join(" ");
if (!question) {
  console.error('usage: npm run search -- "your question"');
  process.exit(1);
}

for (const c of await retrieve(question)) {
  console.log(`\n[${c.score.toFixed(3)}] page ${c.page}, chunk ${c.chunkIndex}`);
  console.log(c.text);
}