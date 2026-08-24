"""Athens configuration, read from environment variables."""
import os

DATA_DIR = os.environ.get("ATHENS_DATA_DIR", "./data")
DB_PATH = os.environ.get("ATHENS_DB_PATH", os.path.join(DATA_DIR, "athens.db"))

# LLM provider: "mock" | "openai" (OpenAI-compatible: OpenAI, DeepSeek, Ollama /v1, LM Studio, vLLM, etc.)
LLM_PROVIDER = os.environ.get("ATHENS_LLM_PROVIDER", "mock").strip().lower()
LLM_BASE_URL = os.environ.get("ATHENS_LLM_BASE_URL", "http://localhost:11434/v1")
LLM_API_KEY = os.environ.get("ATHENS_LLM_API_KEY", "")
LLM_MODEL = os.environ.get("ATHENS_LLM_MODEL", "llama3.1")

FRONTEND_DIR = os.environ.get(
    "ATHENS_FRONTEND_DIR",
    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "frontend"),
)
