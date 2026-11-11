async function testGroqModelStreaming() {
    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      console.error("Missing GROQ_API_KEY environment variable.");
      return;
    }
  
    try {
      console.log("Testing Groq API with openai/gpt-oss-20b (streaming)...");
  
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${groqApiKey}`
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-20b",
          messages: [
            { role: "user", content: "hi\n" },
            { role: "assistant", content: "I'm not sure I understand what you're looking for. Could you please provide a bit more detail or clarify your request?" },
            { role: "user", content: "Return a JSON object with a single field 'status' set to 'ok'." }
          ],
          temperature: 1,
          max_completion_tokens: 2048,
          top_p: 1,
          reasoning_effort: "medium",
          stream: true,
          stop: null
        })
      });
  
      if (!response.ok) {
        const errText = await response.text();
        console.error("HTTP error:", response.status, errText);
        return;
      }
  
      // Read the SSE stream chunk by chunk
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let fullContent = "";
  
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
  
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop(); // keep incomplete line for next chunk
  
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
  
          const dataStr = trimmed.replace(/^data:\s*/, "");
          if (dataStr === "[DONE]") continue;
  
          try {
            const parsed = JSON.parse(dataStr);
            const delta = parsed.choices?.[0]?.delta?.content || "";
            process.stdout.write(delta); // live print, like Python's print(end="")
            fullContent += delta;
          } catch (e) {
            // partial JSON chunk, ignore
          }
        }
      }
  
      console.log("\n\n--- Final content ---");
      console.log(fullContent);
  
    } catch (err) {
      console.error("Request failed:", err);
    }
  }
  
  testGroqModelStreaming();