from fastapi import FastAPI, Request, HTTPException
from sentence_transformers import SentenceTransformer
import uvicorn
import logging

app = FastAPI()
logging.basicConfig(level=logging.INFO)

try:
    model = SentenceTransformer("all-MiniLM-L6-v2")
    logging.info("✅ Embedding model loaded successfully.")
except Exception as e:
    logging.exception("❌ Failed to load embedding model.")
    raise RuntimeError("Model initialization failed.") from e

@app.post("/embed")
async def embed(request: Request):
    try:
        data = await request.json()
        sentences = data.get("input")

        if not sentences or not isinstance(sentences, list):
            raise HTTPException(status_code=400, detail="`input` must be a non-empty list of strings.")

        embeddings = model.encode(sentences).tolist()
        return {"embeddings": embeddings}

    except HTTPException as he:
        raise he
    except Exception as e:
        logging.exception("❌ Failed to generate embeddings.")
        raise HTTPException(status_code=500, detail="Internal server error while generating embeddings.")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8001)
