import os

from fastapi import FastAPI, Request, HTTPException
from sentence_transformers import SentenceTransformer
import torch
import uvicorn
import logging

# Model is configurable so the same image can serve a lighter/heavier model per platform
MODEL_NAME = os.getenv("EMBEDDING_MODEL", "intfloat/multilingual-e5-small")

# Pick the best backend available on the platform this runs on (CUDA if present, else CPU)
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

app = FastAPI()
logging.basicConfig(level=logging.INFO)
logging.info(f"Loading embedding model '{MODEL_NAME}' on device '{DEVICE}'")

try:
    model = SentenceTransformer(MODEL_NAME, device=DEVICE)
    logging.info("✅ Embedding model loaded successfully.")
except Exception as e:
    logging.exception("❌ Failed to load embedding model.")
    raise RuntimeError("Model initialization failed.") from e

# E5-family models expect a task prefix to reach their documented quality
E5_PREFIXES = MODEL_NAME.lower().startswith(("intfloat/e5", "intfloat/multilingual-e5"))


def prepare(sentence: str, kind: str) -> str:
    if not E5_PREFIXES:
        return sentence
    return ("query: " if kind == "query" else "passage: ") + sentence


@app.post("/embed")
async def embed(request: Request):
    try:
        data = await request.json()
        sentences = data.get("input")
        kind = data.get("type", "passage")

        if not sentences or not isinstance(sentences, list):
            raise HTTPException(status_code=400, detail="`input` must be a non-empty list of strings.")
        if kind not in ("query", "passage"):
            raise HTTPException(status_code=400, detail="`type` must be 'query' or 'passage'.")

        embeddings = model.encode([prepare(s, kind) for s in sentences]).tolist()
        return {"embeddings": embeddings, "model": MODEL_NAME, "dimension": len(embeddings[0])}

    except HTTPException as he:
        raise he
    except Exception:
        logging.exception("❌ Failed to generate embeddings.")
        raise HTTPException(status_code=500, detail="Internal server error while generating embeddings.")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8001)
