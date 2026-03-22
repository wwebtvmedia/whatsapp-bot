// answerGenerator.js
import fetch from 'node-fetch';

export async function queryWithOllama(context, query, model = "qwen2:7b", url = "http://localhost:11434/api/chat") {
  const payload = {
    model,
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: `Context: ${context}\nQuestion: ${query}` }
    ],
    stream: false,
    temperature: 0.7,
    max_tokens: 150
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  return data.message?.content || "⚠️ No reply generated.";
}

export async function generateAutoReply(inputText, chromaCollection) {
  const results = await chromaCollection.query({
    queryTexts: [inputText],
    nResults: 3
  });

  const memoryContext = (results.documents?.[0] || []).join('\n');
  return await queryWithOllama(memoryContext, inputText);
}
