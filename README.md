# WorkMind — Local Personal Knowledge Base

A private, fully local AI assistant that indexes your codebases and documents so you can ask questions about them in plain English. **No cloud, no API keys, 100% runs on your machine.**

## How it works

1. **Feed Data** — drop files or a whole folder into a project.  
2. **Ask** — the AI searches your indexed files and synthesises answers from the actual content.  
3. **Stay private** — everything lives in a local SQLite database (`workmind.db`).

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 18+ | https://nodejs.org |
| Ollama | latest | https://ollama.com |

Install Ollama from here https://github.com/ollama/ollama/releases/download/v0.17.7/OllamaSetup.exe if latest ver is not stable
---

## Setup (3 steps)

### 1 · Install Ollama & pull a model

```bash
# macOS / Linux
curl -fsSL https://ollama.com/install.sh | sh

# Pull the default model (small, fast, supports tool calling)
ollama pull llama3.2
```

> **Windows:** download the installer from https://ollama.com and then run `ollama pull llama3.2` in a terminal.

Other supported models (all free, just swap in `.env`):

| Model | Size | Notes |
|-------|------|-------|
| `llama3.2` | 2 GB | ✅ Default — fast, great tool use |
| `qwen2.5` | 4.7 GB | Best code reasoning |
| `llama3.1` | 4.7 GB | Larger, more thorough |
| `mistral` | 4.1 GB | Fast, good overall |

### 2 · Configure environment

```bash
cp .env.example .env
# Edit .env if you want a different model or port — defaults work out of the box
```

### 3 · Install dependencies & start

```bash
npm install
npm run dev
```

Open **http://localhost:3000** in your browser.

---

## Usage

| Action | How |
|--------|-----|
| Create a project | Click **Add Work Folder** in the sidebar |
| Index files | Click **Feed Data** on a project card → pick files or a whole folder |
| Ask a question | Go to **Assistant** tab and type anything |
| View indexed files | Click the 🔍 icon on a project card |
| Rename / delete project | Pencil / trash icons on the project card |

### Example questions

- *"What am I currently working on?"*
- *"Explain how the authentication works in my backend project"*
- *"Search my code for database queries"*
- *"What did I work on in the last 3 months?"*

---

## Configuration

All settings live in `.env`:

```env
OLLAMA_BASE_URL=http://localhost:11434   # Ollama server URL
OLLAMA_MODEL=llama3.2                   # Model name
DB_PATH=workmind.db                     # SQLite file path
PORT=3000                               # Web server port
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, Tailwind CSS, Framer Motion |
| Backend | Node.js, Express |
| Database | SQLite (better-sqlite3) |
| AI | Ollama (local LLM, OpenAI-compatible API) |

---

## Troubleshooting

**"Cannot reach Ollama"**  
→ Make sure the Ollama app is running. On macOS you should see it in the menu bar; on Linux run `ollama serve`.

**Model doesn't use tools / ignores files**  
→ Try `qwen2.5` or `llama3.1` — they have stronger tool-following than smaller models.

**Slow responses**  
→ Use `llama3.2` (2 GB) for best speed. Larger models need more RAM/VRAM.

**Port already in use**  
→ Change `PORT=3001` in `.env`.
