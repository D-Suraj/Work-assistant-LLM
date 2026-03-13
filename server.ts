import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import * as lancedb from "@lancedb/lancedb";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Config ────────────────────────────────────────────────────────────────────
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL    = process.env.OLLAMA_MODEL    || "llama3.2";

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database("workmind.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    name TEXT,
    path TEXT,
    content TEXT,
    last_modified DATETIME,
    FOREIGN KEY(project_id) REFERENCES projects(id)
  );
  CREATE TABLE IF NOT EXISTS work_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    activity TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_files_project_path
    ON files(project_id, path);
`);

// ── Tool definitions (OpenAI-compatible format Ollama understands) ─────────────
const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_projects",
      description: "List all projects the user has worked on.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recent_work",
      description: "Get a summary of what the user has been working on in the past 3 months.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_file_content",
      description: "Search for specific information or code snippets within indexed project files. Use this to find which files contain the logic you are looking for.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The keyword or phrase to search for in file contents." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full content of a specific file by its path or name.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "The path or filename to read." },
        },
        required: ["filePath"],
      },
    },
  },
];

const SYSTEM_PROMPT = `You are WorkMind, a friendly and professional Personal Work Assistant. 
Help the user understand and navigate their indexed codebases and documents.

You can handle general conversation, greetings, and compliments naturally.
Be polite, helpful, and concise.

You have these tools:
1. list_projects       — list all projects
2. get_recent_work     — list files modified in the last 3 months
3. search_file_content — keyword search across all indexed file contents
4. read_file           — read the full content of a specific file

Strategy:
- For code/project questions, use search_file_content then read_file.
- Synthesize answers from actual content.
- If you can't find an answer after searching, say: "I couldn't find any information about that in your indexed projects. Could you provide more details or try a different search?"

CRITICAL: 
- Never mention internal tool names (like "search_file_content") or technical processes to the user.
- Avoid showing raw file paths unless they are directly relevant to the answer.
- If a tool fails, explain it simply without technical jargon (e.g., "I'm having trouble searching your files right now").`;

// ── Execute tool directly against SQLite ──────────────────────────────────────
// FIX: Added 'async' keyword here
async function executeTool(name: string, args: Record<string, string>): Promise<unknown> {
  if (name === "list_projects") {
    return db.prepare("SELECT name, description FROM projects").all();
  }
  
  if (name === "search_file_content") {
    const query = args.query || "";
    
    const embRes = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method: "POST",
      body: JSON.stringify({ 
        model: process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text", 
        prompt: query 
      })
    });
    const { embedding } = await embRes.json();

    const lancedbConn = await lancedb.connect("data/vector-store");
    try {
      // Get all available project tables
      const tableNames = await lancedbConn.tableNames();
      if (tableNames.length === 0) return { error: "No projects have been indexed yet." };

      // For a simple fix, we search the most recently created project table
      // In a more advanced version, you'd search all tables or the one the user is viewing
      const table = await lancedbConn.openTable(tableNames[0]); 
      const results = await table.search(embedding).limit(5).toArray();
      
      return results.map(r => ({
        name: r.fileName,
        path: r.filePath,
        content: r.text 
      }));
    } catch (e) {
      console.error("Search Error:", e);
      return { error: "Search failed. Please ensure your project is fully indexed." };
    }
  }

  if (name === "get_recent_work") {
    return db.prepare(`
      SELECT p.name as project, f.name as file, f.path, f.last_modified
      FROM files f JOIN projects p ON f.project_id = p.id
      WHERE f.last_modified > date('now', '-3 months')
      ORDER BY f.last_modified DESC LIMIT 50
    `).all();
  }

  if (name === "read_file") {
    const fp = args.filePath || "";
    return db.prepare(
      "SELECT name, path, content FROM files WHERE path = ? OR name = ? LIMIT 1"
    ).get(fp, fp) || { error: "File not found" };
  }
  return { error: `Unknown tool: ${name}` };
}

function chunkFile(content: string, size = 1000, overlap = 200): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < content.length) {
    const end = start + size;
    chunks.push(content.slice(start, end));
    start += (size - overlap);
  }
  return chunks;
}

// ── Ollama agentic chat loop ───────────────────────────────────────────────────
async function chatWithOllama(
  userMessage: string,
  history: { role: string; content: string }[]
): Promise<string> {
  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map(h => ({ role: h.role === "model" ? "assistant" : h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  for (let round = 0; round < 6; round++) {
    const res = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, messages, tools: TOOLS, stream: false }),
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Ollama error ${res.status}: ${txt}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    if (!choice) throw new Error("Empty response from Ollama");

    const msg = choice.message;

    // No tool calls → we have the final answer
    if (choice.finish_reason !== "tool_calls" || !msg.tool_calls?.length) {
      return msg.content || "Done.";
    }

    // Push assistant message then execute each tool
    messages.push(msg);

    for (const call of msg.tool_calls) {
      let fnArgs: Record<string, string> = {};
      try { fnArgs = JSON.parse(call.function.arguments || "{}"); } catch { /* ignore */ }

      const result = await executeTool(call.function.name, fnArgs as Record<string, string>);

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  throw new Error("Exceeded maximum tool-call rounds.");
}

// ── Express server ────────────────────────────────────────────────────────────
async function startServer() {

  if (!fs.existsSync("data/vector-store")) {
    fs.mkdirSync("data/vector-store", { recursive: true });
  }

  const app = express();
  app.use(express.json({ limit: "50mb" }));
  const PORT = 3000;

  app.get("/api/projects", (_req, res) => {
    res.json(db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all());
  });

  app.post("/api/projects", (req, res) => {
    const { name, description } = req.body;
    try {
      const info = db.prepare("INSERT INTO projects (name, description) VALUES (?, ?)").run(name, description);
      res.json({ id: info.lastInsertRowid });
    } catch {
      res.status(400).json({ error: "Project already exists" });
    }
  });

  app.patch("/api/projects/:id", (req, res) => {
    const { name, description } = req.body;
    try {
      db.prepare("UPDATE projects SET name = ?, description = ? WHERE id = ?").run(name, description, req.params.id);
      res.json({ success: true });
    } catch {
      res.status(400).json({ error: "Failed to update project" });
    }
  });

  app.delete("/api/projects/:id", (req, res) => {
    const id = req.params.id;
    db.transaction(() => {
      db.prepare("DELETE FROM files WHERE project_id = ?").run(id);
      db.prepare("DELETE FROM work_logs WHERE project_id = ?").run(id);
      db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    })();
    res.json({ success: true });
  });

  app.get("/api/projects/:id/files", (req, res) => {
    res.json(db.prepare("SELECT id, name, path, last_modified FROM files WHERE project_id = ?").all(req.params.id));
  });

  app.post("/api/files/index", async (req, res) => {
    const { projectId, files } = req.body;
    const vectorDb = await lancedb.connect("data/vector-store");
    const tableName = `project_${projectId}`;
    const allRecords: { vector: number[]; text: string; filePath: string; fileName: string }[] = [];
    const embedModel = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

    const upsertFile = db.prepare(`
      INSERT INTO files (project_id, name, path, content, last_modified)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, path) DO UPDATE SET
        name = excluded.name,
        content = excluded.content,
        last_modified = excluded.last_modified
    `);

    for (const file of files) {
      try {
        upsertFile.run(
          projectId,
          file.name,
          file.path,
          file.content,
          file.lastModified || new Date().toISOString()
        );
      } catch (e) {
        console.error("Failed to upsert file metadata", e);
      }

      const chunks = chunkFile(file.content);

      for (const chunk of chunks) {
        try {
          const embRes = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
            method: "POST",
            body: JSON.stringify({ model: embedModel, prompt: chunk })
          });

          if (!embRes.ok) {
            const txt = await embRes.text();
            console.error("Embedding request failed:", embRes.status, txt);
            continue;
          }

          const { embedding } = await embRes.json();
          if (!embedding) {
            console.error("No embedding returned for chunk");
            continue;
          }

          allRecords.push({
            vector: embedding,
            text: chunk,
            filePath: file.path,
            fileName: file.name
          });
        } catch (e) {
          console.error("Error generating embedding", e);
        }
      }
    }

    if (allRecords.length > 0) {
      await vectorDb.createTable(tableName, allRecords, { mode: "overwrite" });
    }
    res.json({ success: true });
  });

  app.get("/api/work-logs", (_req, res) => {
    res.json(db.prepare(`
      SELECT wl.*, p.name as project_name FROM work_logs wl
      JOIN projects p ON wl.project_id = p.id ORDER BY wl.timestamp DESC
    `).all());
  });

  app.post("/api/work-logs", (req, res) => {
    const { projectId, activity } = req.body;
    db.prepare("INSERT INTO work_logs (project_id, activity) VALUES (?, ?)").run(projectId, activity);
    res.json({ success: true });
  });

  // ── Chat — Ollama + tool loop fully server-side ───────────────────────────
  app.post("/api/chat", async (req, res) => {
    const { message, history = [] } = req.body;
    if (!message) return res.status(400).json({ error: "message is required" });
    try {
      const response = await chatWithOllama(message, history);
      res.json({ response });
    } catch (err: any) {
      console.error("[chat]", err.message);
      if (err.message.includes("ECONNREFUSED") || err.message.includes("fetch failed")) {
        return res.status(503).json({
          error: `Cannot reach Ollama at ${OLLAMA_BASE_URL}. Make sure Ollama is running: https://ollama.com`,
        });
      }
      res.status(500).json({ error: err.message });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "dist", "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n✅  WorkMind → http://localhost:${PORT}`);
    console.log(`🤖  Ollama   → ${OLLAMA_MODEL} @ ${OLLAMA_BASE_URL}\n`);
  });
}

startServer();
