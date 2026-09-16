// answerGenerator.js
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { searchMemory } from './memorySearch.js';

dotenv.config();

const llmUrl = process.env.LLM_URL || "http://localhost:11434/api/chat";
const llmModel = process.env.LLM_MODEL || "qwen2:7b";
const llmType = process.env.LLM_TYPE || "ollama"; // 'ollama' or 'openai' (for llama.cpp)

export async function queryLLM(context, query) {
  // Strict grounding: retrieval over OCR'd documents carries noisy fragments
  // (stock tables, garbled pages) — the model must answer from clean passages
  // only and admit when the answer is absent, in the question's language.
  const systemPrompt = "You are a helpful assistant. Answer the user's question using ONLY the information in the context below. Ignore noisy or garbled fragments (tables, OCR artifacts). If the answer is not in the context, say that you don't know. Reply in the language of the question. Context:\n" + context;
  
  let payload;
  let url = llmUrl;

  if (llmType === "openai") {
    payload = {
      model: llmModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: query }
      ],
      stream: false,
      temperature: 0.7,
      max_tokens: 150
    };
    // Ensure the URL is the correct OpenAI-compatible endpoint
    if (!url.endsWith('/v1/chat/completions') && !url.includes('/api/chat')) {
        url = `${url.replace(/\/$/, '')}/v1/chat/completions`;
    }
  } else {
    // Ollama style
    payload = {
      model: llmModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: query }
      ],
      stream: false,
      temperature: 0.7,
      max_tokens: 150
    };
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LLM API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    
    if (llmType === "openai") {
        return data.choices?.[0]?.message?.content || "⚠️ No reply generated.";
    } else {
        return data.message?.content || "⚠️ No reply generated.";
    }
  } catch (err) {
    console.error('❌ LLM Query failed:', err.message);
    return "⚠️ Failed to generate a reply due to a server error.";
  }
}

// `context` may carry an already-computed memory context (hierarchical search);
// when absent, run the full retrieval pipeline here.
export async function generateAutoReply(inputText, context = '') {
  try {
    let memoryContext = context;
    if (!memoryContext) {
      const result = await searchMemory(inputText);
      memoryContext = result.context;
    }
    return await queryLLM(memoryContext, inputText);
  } catch (err) {
    console.error('❌ Failed to generate auto reply:', err);
    return "⚠️ Error in auto-reply generation.";
  }
}
