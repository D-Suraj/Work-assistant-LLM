/**
 * aiService.ts
 * Thin client — sends message + history to the backend.
 * All Gemini API calls and tool execution happen server-side.
 */
export async function chatWithAssistant(
  message: string,
  history: { role: string; content: string }[] = []
): Promise<string> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data.response as string;
}
