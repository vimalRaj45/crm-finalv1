import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(process.cwd(), ".env") });

async function testMistral() {
  const apiKey = process.env.MISTRAL_API_KEY;
  console.log("==================================================");
  console.log("            MISTRAL AI KEY DIAGNOSTIC             ");
  console.log("==================================================");
  console.log(`API Key: ${apiKey ? apiKey.slice(0, 6) + "..." + apiKey.slice(-4) : "MISSING"}\n`);

  if (!apiKey) {
    console.error("ERROR: MISTRAL_API_KEY is not set in .env");
    return;
  }

  // Test 1: List Available Models
  console.log("[Test 1] Testing /v1/models endpoint...");
  try {
    const res = await fetch("https://api.mistral.ai/v1/models", {
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}` }
    });
    console.log(`   Status: ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (res.ok) {
      console.log("   Available Models:", data.data?.map(m => m.id).slice(0, 10).join(", "));
    } else {
      console.error("   Error details:", JSON.stringify(data));
    }
  } catch (err) {
    console.error("   Fetch error:", err.message);
  }

  // Test 2: Chat Completion with mistral-small-latest
  console.log("\n[Test 2] Testing chat completion with 'mistral-small-latest'...");
  try {
    const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "mistral-small-latest",
        messages: [{ role: "user", content: "Respond with JSON: {\"status\": \"ok\"}" }],
        response_format: { type: "json_object" }
      })
    });
    console.log(`   Status: ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (res.ok) {
      console.log("   Response:", data.choices?.[0]?.message?.content);
    } else {
      console.error("   Error details:", JSON.stringify(data));
    }
  } catch (err) {
    console.error("   Fetch error:", err.message);
  }

  // Test 3: Chat Completion with open-mistral-7b
  console.log("\n[Test 3] Testing chat completion with 'open-mistral-7b'...");
  try {
    const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "open-mistral-7b",
        messages: [{ role: "user", content: "Hello" }]
      })
    });
    console.log(`   Status: ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (res.ok) {
      console.log("   Response:", data.choices?.[0]?.message?.content?.slice(0, 60));
    } else {
      console.error("   Error details:", JSON.stringify(data));
    }
  } catch (err) {
    console.error("   Fetch error:", err.message);
  }
}

testMistral();
