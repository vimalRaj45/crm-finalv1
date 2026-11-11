import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import pool from "./db.js";
import fs from "fs";
import { ImapFlow } from "imapflow";
import { google } from "googleapis";
import { simpleParser } from "mailparser";
import { runScraper, scrapeCompanyLinkedinDetails } from "./scraper.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(process.cwd(), ".env") });

// Clean and parse JSON returned by LLM (stripping potential markdown backticks)
function cleanAndParseJson(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.substring(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.substring(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.substring(0, cleaned.length - 3);
  }
  return JSON.parse(cleaned.trim());
}

// Clean and truncate email body to fit LLM token limits
function cleanEmailBody(body) {
  if (!body) return "";

  let text = body;
  if (/<[a-z][\s\S]*>/i.test(body)) {
    text = body
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<\/(div|p|tr|td|li|h1|h2|h3|h4|h5|h6|ul|ol|table)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"');
  }

  text = text
    .replace(/[ \t]+/g, " ")
    .replace(/([\r\n]\s*)+/g, "\n")
    .trim();

  const maxLength = 12000;
  if (text.length > maxLength) {
    console.log(`[Cleaner] Truncating body from ${text.length} to ${maxLength} characters to fit within token limits.`);
    text = text.substring(0, maxLength) + "... [Truncated]";
  }

  return text;
}

// Active working Mistral model memoization to eliminate 429 retries
let activeMistralModel = "ministral-8b-latest";
let lastAiCallTime = 0;

// Helper for resilient AI Completions (Groq Fast Engine -> Gemini Flash -> Mistral AI Cascade)
async function callAiCompletions(prompt, modelType = "large") {
  const groqKeys = [process.env.GROQ_API_KEY, process.env.GROQ_SECONDARY_API_KEY].filter(Boolean);
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const mistralApiKey = process.env.MISTRAL_API_KEY;

  // Rate-limit safety pace (ensure min 600ms between calls)
  const now = Date.now();
  const timeSinceLast = now - lastAiCallTime;
  if (timeSinceLast < 600) {
    await new Promise(r => setTimeout(r, 600 - timeSinceLast));
  }
  lastAiCallTime = Date.now();

  // 1. Primary Engine: Groq AI (Ultra-fast ~500 t/s, high RPM, strict JSON schema)
  for (const key of groqKeys) {
    const groqModels = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];
    for (const model of groqModels) {
      try {
        console.log(`[AI Engine] Calling Groq AI (${model})...`);
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${key}`
          },
          body: JSON.stringify({
            model: model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.1,
            response_format: { type: "json_object" }
          })
        });

        if (response.ok) {
          const resJson = await response.json();
          console.log(`[AI Engine] Success from Groq AI (${model})`);
          return resJson.choices[0].message.content;
        }

        const errText = await response.text();
        console.warn(`[AI Engine] Groq (${model}) status ${response.status}: ${errText.slice(0, 100)}`);
        if (response.status === 429) {
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch (err) {
        console.warn(`[AI Engine] Groq API call error: ${err.message}`);
      }
    }
  }

  // 2. Secondary Engine: Google Gemini Flash (Generous quotas, low latency)
  if (geminiKey) {
    const geminiModels = ["gemini-2.0-flash", "gemini-1.5-flash"];
    for (const model of geminiModels) {
      try {
        console.log(`[AI Engine] Calling Gemini AI fallback (${model})...`);
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.1,
              responseMimeType: "application/json"
            }
          })
        });

        if (response.ok) {
          const resJson = await response.json();
          const text = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            console.log(`[AI Engine] Success from Gemini AI (${model})`);
            return text;
          }
        }
        const errText = await response.text();
        console.warn(`[AI Engine] Gemini (${model}) status ${response.status}: ${errText.slice(0, 100)}`);
      } catch (err) {
        console.warn(`[AI Engine] Gemini API call error: ${err.message}`);
      }
    }
  }

  // 3. Tertiary Engine: Mistral AI (Prioritize ministral-8b-latest and open-mistral-nemo)
  if (mistralApiKey) {
    // Put currently working model first, followed by best-quota alternatives
    const mistralCandidates = ["ministral-8b-latest", "open-mistral-nemo", "open-mistral-7b", "codestral-latest", "mistral-small-latest"];
    const mistralModels = [activeMistralModel, ...mistralCandidates.filter(m => m !== activeMistralModel)];

    for (const mistralModel of mistralModels) {
      try {
        console.log(`[AI Engine] Calling Mistral AI (${mistralModel})...`);
        const payload = {
          model: mistralModel,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1
        };
        if (!mistralModel.includes("open-mistral")) {
          payload.response_format = { type: "json_object" };
        }

        const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${mistralApiKey}`
          },
          body: JSON.stringify(payload)
        });

        if (response.ok) {
          const resJson = await response.json();
          console.log(`[AI Engine] Success from Mistral AI (${mistralModel})`);
          activeMistralModel = mistralModel; // Remember working model for subsequent calls
          return resJson.choices[0].message.content;
        }

        const errText = await response.text();
        console.warn(`[AI Engine] Mistral model '${mistralModel}' status ${response.status}: ${errText.slice(0, 100)}`);
        if (response.status === 429) {
          await new Promise(r => setTimeout(r, 1200));
        }
      } catch (err) {
        console.warn(`[AI Engine] Mistral API error (${mistralModel}): ${err.message}`);
      }
    }
  }

  throw new Error("All AI Providers (Groq, Gemini, Mistral) exhausted or rate-limited. Please verify API keys in .env.");
}



// Clean and decode DuckDuckGo/Bing redirect URLs
function cleanUrl(rawUrl) {
  if (!rawUrl) return "";
  let url = rawUrl.replace(/&amp;/g, "&");
  if (url.startsWith("//")) {
    url = "https:" + url;
  }
  try {
    if (url.includes("duckduckgo.com/l/?uddg=")) {
      const urlObj = new URL(url);
      const uddg = urlObj.searchParams.get("uddg");
      if (uddg) {
        return decodeURIComponent(uddg);
      }
    }

    if (url.includes("bing.com/ck/a?!")) {
      const urlObj = new URL(url);
      const u = urlObj.searchParams.get("u");
      if (u) {
        const base64Str = u.substring(2);
        const decoded = Buffer.from(base64Str, 'base64').toString('utf8');
        return decoded;
      }
    }
  } catch (e) {
    // Return original if parsing fails
  }
  return url;
}

// Helper to extract LinkedIn Job ID from standard job URLs
function extractLinkedInJobId(url) {
  if (!url) return null;
  const viewMatch = url.match(/\/jobs\/view\/(\d+)/);
  if (viewMatch) return viewMatch[1];
  const paramMatch = url.match(/currentJobId=(\d+)/);
  if (paramMatch) return paramMatch[1];
  return null;
}

// Normalizes URLs for accurate deduplication checks
function normalizeJobUrl(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    const jobId = extractLinkedInJobId(url);
    if (jobId) {
      return `linkedin-job-${jobId}`;
    }
    let normalized = parsed.origin + parsed.pathname.replace(/\/$/, "");
    return normalized.toLowerCase();
  } catch (e) {
    return url.toLowerCase().trim();
  }
}

// Normalizes company and position to prevent duplicate processing
function getJobStringKey(company, position) {
  if (!company || !position) return "";
  const c = company.toLowerCase().replace(/[^a-z0-9]/g, "");
  const p = position.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${c}|${p}`;
}

// Extract potential company keywords from the query to match official domains
function getCompanyKeywords(query) {
  const stopWords = new Set([
    "associate", "director", "manager", "lead", "engineer", "developer", "specialist", "analyst", "co",
    "process", "innovation", "automation", "dharwad", "karnataka", "india", "bebee", "linkedin", "jobs",
    "job", "career", "careers", "internship", "via", "of", "and", "in", "for", "the", "a", "an", "with",
    "&", "enterprise", "inc", "ltd", "group", "solutions", "services", "global", "systems", "technologies"
  ]);

  const words = query.toLowerCase()
    .replace(/[^\w\s&]/g, " ")
    .split(/\s+/)
    .filter(w => w && !stopWords.has(w));

  return words;
}

// Perform Google search using Serper API
async function searchSerperAPI(query) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    console.warn(`[Serper Search] SERPER_API_KEY is not set.`);
    return [];
  }
  const searchUrl = `https://google.serper.dev/search?q=${encodeURIComponent(query)}&apiKey=${apiKey}`;
  console.log(`[Serper Search] Querying Serper.dev API...`);
  
  try {
    const res = await fetch(searchUrl);
    if (!res.ok) {
      throw new Error(`Serper API returned status ${res.status}: ${res.statusText}`);
    }
    const data = await res.json();
    if (data && Array.isArray(data.organic)) {
      const links = data.organic.map(item => item.link).filter(Boolean);
      console.log(`[Serper Search] Fetched ${links.length} URLs from Serper API:`);
      links.forEach((link, idx) => console.log(`  [${idx + 1}] ${link}`));
      return links;
    }
    return [];
  } catch (err) {
    console.error(`[Serper Search] Error querying Serper API: ${err.message}`);
    return [];
  }
}

// Helper to detect if a URL is a generic careers listing page rather than a specific job description
function isGenericCareersPage(url) {
  const pathStr = url.toLowerCase();
  
  const genericPatterns = [
    /careers\/?$/,
    /careers\/all\/?$/,
    /careers\.html\/?$/,
    /jobs\/?$/,
    /jobs-search\/?$/,
    /search-jobs\/?$/,
    /career-opportunities\/?$/,
    /join-us\/?$/,
    /work-with-us\/?$/,
    /all-jobs\/?$/
  ];

  if (genericPatterns.some(pattern => pattern.test(pathStr))) {
    return true;
  }

  if (pathStr.includes("greenhouse.io") && !pathStr.includes("/jobs/") && !pathStr.includes("?gh_jid=")) {
    return true;
  }
  if (pathStr.includes("lever.co") && (pathStr.endsWith("lever.co") || pathStr.endsWith("lever.co/"))) {
    return true;
  }
  if (pathStr.includes("smartrecruiters.com") && !pathStr.includes("/jobs/") && !pathStr.includes("/show/")) {
    return true;
  }
  if (pathStr.includes("myworkdayjobs.com") && !pathStr.includes("/job/")) {
    return true;
  }
  
  return false;
}

// Helper to check if a URL matches the specified 'via' platform name
function urlMatchesVia(url, via) {
  if (!via) return false;
  const lowerUrl = url.toLowerCase();
  const cleanVia = via.toLowerCase()
    .replace(/\bvia\b/g, "")
    .replace(/\bjob\b/g, "")
    .replace(/\bboard\b/g, "")
    .replace(/\bcareers?\b/g, "")
    .replace(/\bhiring\b/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .trim();
  const words = cleanVia.split(/\s+/).filter(w => w.length > 2 && w !== "and" && w !== "for" && w !== "the");
  if (words.length === 0) return false;
  return words.every(word => lowerUrl.includes(word));
}

// Rank and select candidate URL based on preferences
function selectBestUrl(urls, query, via = "") {
  const companyKeywords = getCompanyKeywords(query);
  const rankedUrls = urls.map(url => {
    const lowerUrl = url.toLowerCase();
    
    if (isGenericCareersPage(url)) {
      return { url, score: 0, reason: "Excluded: Generic Careers Directory" };
    }

    let score = 0;
    let reason = "";

    if (via && urlMatchesVia(url, via)) {
      score = 12;
      reason = `Preference: Matches Google Alert "via" (${via})`;
    }
    else if (lowerUrl.includes("linkedin.com")) {
      const isLinkedInJob = (lowerUrl.includes("/jobs/view/") || lowerUrl.includes("/jobs/viewdetail") || (lowerUrl.includes("/jobs/search") && lowerUrl.includes("currentjobid="))) &&
                            !lowerUrl.includes("/in/") &&
                            !lowerUrl.includes("/company/") &&
                            !lowerUrl.includes("/school/") &&
                            !lowerUrl.includes("/pulse/") &&
                            !lowerUrl.includes("/posts/") &&
                            !lowerUrl.includes("/groups/");
      if (isLinkedInJob) {
        score = 10;
        reason = "Preference 1: LinkedIn Job Posting";
      } else {
        return { url, score: 0, reason: "Excluded: Non-job LinkedIn URL" };
      }
    }
    else if (lowerUrl.includes("indeed.com") || lowerUrl.includes("indeed.co.in")) {
      const isIndeedJob = lowerUrl.includes("/viewjob") || lowerUrl.includes("/rc/clk") || lowerUrl.includes("/job/");
      if (isIndeedJob) {
        score = 9;
        reason = "Preference 2: Indeed Job Posting";
      } else {
        return { url, score: 0, reason: "Excluded: Non-job Indeed URL" };
      }
    }
    else if (lowerUrl.includes("naukri.com")) {
      const isNaukriJob = lowerUrl.includes("/job-listings-") || lowerUrl.includes("/job/");
      if (isNaukriJob) {
        score = 8;
        reason = "Preference 3: Naukri Job Posting";
      } else {
        return { url, score: 0, reason: "Excluded: Non-job Naukri URL" };
      }
    }
    else if (lowerUrl.includes("bebee.com")) {
      score = 7;
      reason = "Preference 4: BeBee Job Posting";
    }
    else if (lowerUrl.includes("simplyhired.com")) {
      const isSimplyHiredJob = lowerUrl.includes("/job/") || lowerUrl.includes("/view/");
      if (isSimplyHiredJob) {
        score = 6;
        reason = "Preference 5: SimplyHired Job Posting";
      } else {
        return { url, score: 0, reason: "Excluded: Non-job SimplyHired URL" };
      }
    }
    else {
      const looksLikeJob = lowerUrl.includes("/job/") || lowerUrl.includes("/jobs/") || lowerUrl.includes("/careers/") || lowerUrl.includes("/vacancy/") || lowerUrl.includes("/vacancies/") || lowerUrl.includes("/career/");
      if (looksLikeJob) {
        score = 5;
        reason = "Fallback: General Job Page or Company Careers Detail";
      }
    }

    return { url, score, reason };
  }).filter(item => item.score > 0);

  rankedUrls.sort((a, b) => b.score - a.score);
  return rankedUrls[0] || null;
}

// Main Ingestion Pipeline Runner
export async function runPipeline(options = {}) {
  const fetchMode = options.fetchMode || "last24h";
  const onlyUnread = options.onlyUnread !== false;
  const fromDate = options.fromDate;
  const toDate = options.toDate;
  const targetInboxEmail = options.targetInboxEmail || null;
  const ownerEmail = options.ownerEmail || null;

  let targetUserEmail = null;
  let oauthAccessToken = null;

  try {
    let queryStr = "SELECT id, email, access_token, refresh_token, expiry_date, created_at, owner_email FROM email_connections ORDER BY created_at DESC LIMIT 1";
    let queryParams = [];
    if (targetInboxEmail) {
      queryStr = "SELECT id, email, access_token, refresh_token, expiry_date, created_at, owner_email FROM email_connections WHERE email = $1 LIMIT 1";
      queryParams = [targetInboxEmail.trim().toLowerCase()];
    } else if (ownerEmail) {
      queryStr = "SELECT id, email, access_token, refresh_token, expiry_date, created_at, owner_email FROM email_connections WHERE owner_email = $1 LIMIT 1";
      queryParams = [ownerEmail.trim().toLowerCase()];
    }

    const { rows } = await pool.query(queryStr, queryParams);
    if (rows.length > 0) {
      const connection = rows[0];
      targetUserEmail = connection.email;
      let accessToken = connection.access_token;
      let expiryDate = parseInt(connection.expiry_date);

      if (Date.now() + 5 * 60 * 1000 >= expiryDate) {
        console.log(`[OAuth2] Access token for ${targetUserEmail} is expired or close to expiry. Refreshing...`);
        const oauth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET,
          process.env.GOOGLE_REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/api/email/oauth-callback`
        );
        oauth2Client.setCredentials({
          refresh_token: connection.refresh_token
        });
        const { credentials } = await oauth2Client.refreshAccessToken();
        accessToken = credentials.access_token;
        expiryDate = credentials.expiry_date;

        await pool.query(
          `UPDATE email_connections 
           SET access_token = $1, expiry_date = $2 
           WHERE email = $3`,
          [accessToken, expiryDate, targetUserEmail]
        );
        console.log(`[OAuth2] Refreshed token for ${targetUserEmail} successfully.`);
      }
      oauthAccessToken = accessToken;
    }
  } catch (dbErr) {
    console.warn("Warning: Could not check or refresh OAuth credentials from DB. Falling back to env variables:", dbErr.message);
  }

  if (!targetUserEmail) {
    targetUserEmail = process.env.GMAIL_USER_EMAIL;
  }

  const appPassword = process.env.GMAIL_APP_PASSWORD;
  let allowedSendersRaw = process.env.ALLOWED_SENDERS || "notify-noreply@google.com,jobalerts-noreply@linkedin.com";
  const mistralApiKey = process.env.MISTRAL_API_KEY;

  let minScore = parseInt(process.env.MIN_FIT_SCORE) || 50;
  let minEmployees = parseInt(process.env.MIN_EMPLOYEE_COUNT) || 500;
  let sectorFilter = process.env.SECTOR_FILTER || "Manufacturing, Automotive, Aerospace, Pharma, MedTech, Global Capability Centers (GCC)";
  let rdSignals = process.env.RD_SIGNALS || "technology roadmap, R&D strategy, IP analyst, patent portfolio, innovation manager, TRIZ, NPD";
  let excludedSectors = process.env.EXCLUDED_SECTORS || "IT Services (TCS, Infosys, Wipro, etc.), Trading, Startups <5 years, Retail chains, Gig economy, Distributors, Law firms, Consulting firms, IP services, BPO, KPO, recruitment, staffing, outsourcing";
  let dbExtractPrompt = null;
  let dbMistralPrompt = null;

  try {
    const { rows } = await pool.query("SELECT key, value FROM settings");
    const dbSettings = {};
    rows.forEach(r => {
      dbSettings[r.key] = r.value;
    });

    if (dbSettings.min_fit_score !== undefined) minScore = parseInt(dbSettings.min_fit_score) || minScore;
    if (dbSettings.min_employee_count !== undefined) minEmployees = parseInt(dbSettings.min_employee_count) || minEmployees;
    if (dbSettings.sector_filter !== undefined) sectorFilter = dbSettings.sector_filter;
    if (dbSettings.rd_signals !== undefined) rdSignals = dbSettings.rd_signals;
    if (dbSettings.excluded_sectors !== undefined) excludedSectors = dbSettings.excluded_sectors;
    if (dbSettings.extract_prompt !== undefined) dbExtractPrompt = dbSettings.extract_prompt;
    else if (dbSettings.mistral_extract_prompt !== undefined) dbExtractPrompt = dbSettings.mistral_extract_prompt;
    else if (dbSettings.groq_extract_prompt !== undefined) dbExtractPrompt = dbSettings.groq_extract_prompt;
    if (dbSettings.mistral_evaluate_prompt !== undefined) dbMistralPrompt = dbSettings.mistral_evaluate_prompt;
    if (dbSettings.allowed_senders !== undefined) allowedSendersRaw = dbSettings.allowed_senders;
  } catch (settingsErr) {
    console.warn("Warning: Could not fetch pipeline configuration from settings table. Falling back to env variables:", settingsErr.message);
  }

  if (!targetUserEmail) {
    throw new Error("No target email account found. Please link an email account in the dashboard or configure GMAIL_USER_EMAIL in .env.");
  }
  if (!allowedSendersRaw || (!mistralApiKey && !process.env.GROQ_API_KEY)) {
    throw new Error("Missing required variables in .env file. Please verify ALLOWED_SENDERS and an AI API key (MISTRAL_API_KEY or GROQ_API_KEY) are configured.");
  }

  console.log("--------------------------------------------------");
  console.log("Starting R&D Intelligence Pipeline (IMAP Flow)");
  console.log(`Target Inbox:    ${targetUserEmail}`);
  console.log(`Allowed Senders: ${allowedSendersRaw}`);
  console.log("Database:        PostgreSQL");
  console.log("--------------------------------------------------\n");

  const logUnqualifiedLead = async (unqualLead, emailObj) => {
    try {
      console.log(`Inserting unqualified lead into PostgreSQL...`);
      await pool.query(`
        INSERT INTO leads (
          company_name, position, company_bio, posted_date, domain, linkedin, score, 
          wikipedia, message_id, fit_reason, scraped_url, scraped_description, 
          employees, company_linkedin_page, scraped_location, email, outreach_msg, is_fit,
          owner_email
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      `, [
        unqualLead.company_name || "",
        unqualLead.position || "",
        unqualLead.company_bio || "",
        unqualLead.posted_date || "",
        unqualLead.domain || "",
        unqualLead.linkedin || "",
        unqualLead.score || 0,
        unqualLead.wikipedia || "",
        emailObj.id || "",
        unqualLead.reason || "",
        unqualLead.scraped_url || "",
        unqualLead.scraped_description || "",
        unqualLead.employees ? parseInt(unqualLead.employees) : null,
        unqualLead.company_linkedin_page || "",
        unqualLead.scraped_location || unqualLead.location || "",
        unqualLead.email || "",
        unqualLead.outreach_msg || "",
        false,
        ownerEmail
      ]);
      console.log("Successfully inserted unqualified lead into PostgreSQL.");
    } catch (dbErr) {
      console.error("Failed to insert unqualified lead into PostgreSQL:", dbErr.message);
    }
  };

  const existingMessageIds = new Set();
  const existingJobKeys = new Set();
  const existingJobsSet = new Set();

  const dbFiles = [
    path.join(process.cwd(), "jobs-db.json"),
    path.join(process.cwd(), "job.json")
  ];
  for (const dbFile of dbFiles) {
    if (fs.existsSync(dbFile)) {
      try {
        const content = fs.readFileSync(dbFile, "utf8");
        const items = JSON.parse(content);
        if (Array.isArray(items)) {
          items.forEach(item => {
            if (item.url) existingJobKeys.add(normalizeJobUrl(item.url));
            if (item.scraped_url) existingJobKeys.add(normalizeJobUrl(item.scraped_url));
            
            const companyName = item.company || item.company_name;
            const positionName = item.position;
            if (companyName && positionName) {
              existingJobsSet.add(getJobStringKey(companyName, positionName));
            }
          });
        }
      } catch (err) {
        console.warn(`Warning: Could not read or parse ${dbFile} for deduplication keys:`, err.message);
      }
    }
  }

  try {
    console.log("Fetching existing leads from PostgreSQL to check for duplicates...");
    const { rows } = await pool.query(
      "SELECT company_name, position, message_id, scraped_url FROM leads"
    );
    rows.forEach(row => {
      const company = row.company_name;
      const position = row.position;
      const msgId = row.message_id;
      const sourceUrl = row.scraped_url;

      if (company && position) existingJobsSet.add(getJobStringKey(company, position));
      if (msgId) existingMessageIds.add(msgId.trim());
      if (sourceUrl) existingJobKeys.add(normalizeJobUrl(sourceUrl));
    });
    console.log(`Loaded ${existingJobsSet.size} unique company-position combos from PostgreSQL.`);
    console.log(`Loaded ${existingMessageIds.size} message IDs from PostgreSQL.`);
    console.log(`Loaded ${existingJobKeys.size} job keys from PostgreSQL.`);
  } catch (dbReadErr) {
    console.warn("Warning: Could not read existing data from PostgreSQL. Proceeding anyway.", dbReadErr.message);
  }

  const emailList = [];
  
  if (options.onProgress) {
    options.onProgress({ phase: "Connecting", current: 0, total: 100, details: "Connecting to Gmail and fetching emails..." });
  }

  console.log("Connecting to Gmail via IMAP...");
  const imapAuth = { user: targetUserEmail };
  if (oauthAccessToken) {
    imapAuth.accessToken = oauthAccessToken;
  } else if (appPassword) {
    imapAuth.pass = appPassword.replace(/\s+/g, "");
  } else {
    throw new Error("No email credentials available. Please link your email account in the dashboard or configure GMAIL_APP_PASSWORD.");
  }

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: imapAuth,
    logger: false
  });

  const senders = allowedSendersRaw.split(",").map(s => s.trim().toLowerCase());
  const matchedUids = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    
    try {
      const parseLocalDate = (dateStr) => {
        if (!dateStr) return null;
        const parts = dateStr.split("-");
        if (parts.length === 3) {
          const year = parseInt(parts[0], 10);
          const month = parseInt(parts[1], 10) - 1;
          const day = parseInt(parts[2], 10);
          const d = new Date(year, month, day);
          if (!isNaN(d.getTime())) return d;
        }
        return null;
      };

      let sinceDate = null;
      let beforeDate = null;
      if (fetchMode === "custom") {
        const from = parseLocalDate(fromDate);
        if (from) sinceDate = from;
        const to = parseLocalDate(toDate);
        if (to) beforeDate = new Date(to.getTime() + 24 * 60 * 60 * 1000);
        console.log(`[IMAP] Custom timeframe range: ${sinceDate ? sinceDate.toLocaleDateString() : "Anytime"} to ${beforeDate ? beforeDate.toLocaleDateString() : "Anytime"}. Only Unread: ${onlyUnread}`);
      } else {
        sinceDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
        console.log(`[IMAP] Last 24 Hours timeframe selected. Only Unread: ${onlyUnread}`);
      }

      for (const sender of senders) {
        console.log(`Searching mailbox server-side for emails from: ${sender}...`);
        
        const searchCriteria = {
          from: sender
        };
        if (onlyUnread) {
          searchCriteria.seen = false;
        }
        if (sinceDate) {
          searchCriteria.since = sinceDate;
        }
        if (beforeDate) {
          searchCriteria.before = beforeDate;
        }

        const fetchGen = client.fetch(searchCriteria, { source: true, flags: true });
        
        for await (const message of fetchGen) {
          if (onlyUnread && message.flags && message.flags.has('\\Seen')) {
            continue;
          }
          const parsed = await simpleParser(message.source);
          const emailId = parsed.messageId || `uid-${message.uid}`;
          const rawBody = parsed.text || parsed.html || "";
          const cleanedBody = cleanEmailBody(rawBody);

          emailList.push({
            id: emailId,
            uid: message.uid,
            subject: parsed.subject || "No Subject",
            date: parsed.date || new Date(),
            body: cleanedBody,
            sender: sender
          });
        }
      }
    } finally {
      lock.release();
    }
    
    await client.logout();
    console.log("IMAP session closed successfully.");
  } catch (imapErr) {
    console.error("IMAP connection or parsing failed! Detailed trace:", imapErr);
    throw new Error(`IMAP failed: ${imapErr.message}`);
  }

  if (emailList.length === 0) {
    if (options.onProgress) {
      options.onProgress({ phase: "Done", current: 0, total: 0, addedCount: 0, details: "No emails found to process." });
    }
    console.log("No emails found to process. Pipeline finished.");
    return;
  }

  emailList.sort((a, b) => b.date - a.date);

  console.log(`\nFound ${emailList.length} emails. Processing all messages:\n`);

  const emailsToProcess = emailList;
  const allProcessedLeads = [];
  let emailIndex = 0;

  for (const email of emailsToProcess) {
    emailIndex++;
    if (options.onProgress) {
      options.onProgress({
        phase: "Extracting",
        current: emailIndex,
        total: emailsToProcess.length,
        details: `Extracting job listings from email ${emailIndex}/${emailsToProcess.length}: "${email.subject}"`
      });
    }
    
    console.log(`--------------------------------------------------`);
    const dateStr = `${email.date.getDate()}/${email.date.getMonth() + 1}/${email.date.getFullYear()}`;
    console.log(`[Email #${emailIndex}] Subject: "${email.subject}" (Date: ${dateStr})`);
    console.log(`--------------------------------------------------`);

    const defaultExtractPrompt = `You are a specialized Job Listings Intelligence Agent. Extract job listings (full detailed job title, company name, location, and the platform the job is from if mentioned) mentioned in the email body that match the rules:

RULES:
- Extract the FULL, COMPLETE, and DETAILED job title exactly as written in the email (e.g. "Associate Director of Process Innovation" instead of a shortened/simplified "Associate Director"). Do not simplify, truncate, or omit any part of the position name.
- ONLY extract if they are in the sectors: {{SECTOR_FILTER}}.
- MUST have fit signals (e.g. engineering, scientist, researcher, developer, innovation, technology, patent, etc.).
- STRICTLY EXCLUDE:
  * {{EXCLUDED_SECTORS}}
- DISTINGUISH COMPANY FROM LOCATION AND POSITION:
  * A city, state, region, or country name (e.g., "Bengaluru", "Mumbai", "London", "USA", "Thane", "Kolar") must NEVER be extracted as the "company_name". Location names must always go into the "location" field.
  * The "company_name" must be the actual hiring organization or employer.
  * Do not merge the company name into the "position" field. The "position" should only contain the job title.`;

    let extractPrompt = dbExtractPrompt || process.env.EXTRACT_PROMPT || process.env.GROQ_EXTRACT_PROMPT || defaultExtractPrompt;
    extractPrompt = extractPrompt.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    extractPrompt = extractPrompt
      .split("{{SECTOR_FILTER}}").join(sectorFilter)
      .split("{{EXCLUDED_SECTORS}}").join(excludedSectors);

    const fullExtractPrompt = `${extractPrompt}

Return a valid JSON object with a "jobs" array containing objects with keys "position", "company_name", "location", and "via". In the "via" field, extract the platform name if the email body specifies "via [Platform]" (e.g., "via LinkedIn" -> "LinkedIn", "via Indeed" -> "Indeed"). If no platform is specified, use an empty string.
Do not include any conversational text or explanation. Only return valid JSON.

EMAIL TO ANALYZE:
${email.body}`;

    let candidateJobs = [];
    try {
      console.log("Calling AI Engine for Stage 1 extraction...");
      const rawContent = await callAiCompletions(fullExtractPrompt, "small");
      const parsedRes = cleanAndParseJson(rawContent);

      if (Array.isArray(parsedRes)) {
        candidateJobs = parsedRes;
      } else if (parsedRes && Array.isArray(parsedRes.jobs)) {
        candidateJobs = parsedRes.jobs;
      } else if (parsedRes && Array.isArray(parsedRes.listings)) {
        candidateJobs = parsedRes.listings;
      } else if (parsedRes && typeof parsedRes === "object") {
        const keyWithArray = Object.keys(parsedRes).find(k => Array.isArray(parsedRes[k]));
        if (keyWithArray) candidateJobs = parsedRes[keyWithArray];
      }
    } catch (err) {
      console.error(`Failed to parse candidates for Email #${emailIndex}:`, err.message);
      console.log("");
      continue;
    }

    if (candidateJobs.length === 0) {
      console.log("No valid R&D / GCC job listings matched the filter criteria in this email.\n");
      continue;
    }

    console.log(`Extracted ${candidateJobs.length} matched listings:`);
    candidateJobs.forEach((job, idx) => {
      console.log(`  [${idx + 1}] Company:  "${job.company_name}"`);
      console.log(`      Position: "${job.position}"`);
      console.log(`      Location: "${job.location || ""}"`);
    });
    console.log("");

    if (existingMessageIds.has(email.id.trim())) {
      console.log(`[Duplicate] Email Message ID "${email.id}" has already been processed and exists in the Google Sheet. Skipping search/scraping.\n`);
      continue;
    }

    matchedUids.push(email.uid);

    let jobIdx = 0;
    for (const job of candidateJobs) {
      jobIdx++;
      if (options.onProgress) {
        options.onProgress({
          phase: "Evaluating",
          current: emailIndex,
          total: emailsToProcess.length,
          jobCurrent: jobIdx,
          jobTotal: candidateJobs.length,
          details: `Evaluating job: "${job.position}" at "${job.company_name}"`
        });
      }
      console.log(`\nCandidate: ${job.position} at ${job.company_name}${job.location ? ` in ${job.location}` : ""}`);

      const jobStringKey = getJobStringKey(job.company_name, job.position);
      if (existingJobsSet.has(jobStringKey)) {
        console.log(`[Duplicate Job] Job "${job.position}" at "${job.company_name}" has already been processed. Skipping.\n`);
        continue;
      }

      const searchQuery = `"${job.company_name}" "${job.position}" hiring`;
      console.log(`Constructed Search Query: "${searchQuery}"`);

      let selectedUrl = "";
      let selectedReason = "";

      const isLinkedInPreferred = 
        (email.sender && email.sender.toLowerCase().includes("linkedin.com")) ||
        (job.via && job.via.toLowerCase().includes("linkedin"));

      let searchQueries = [];
      if (isLinkedInPreferred) {
        console.log(`[Preference] LinkedIn preference detected for job: "${job.position}" at "${job.company_name}" (sender: ${email.sender || "N/A"}, via: ${job.via || "N/A"}). Prioritizing LinkedIn search.`);
        searchQueries = [
          `"${job.company_name}" "${job.position}" site:linkedin.com/jobs`,
          `${job.company_name} ${job.position} site:linkedin.com/jobs`,
          `"${job.company_name}" "${job.position}" hiring`,
          `${job.company_name} ${job.position} hiring`
        ];
      } else if (job.via) {
        console.log(`[Preference] Via preference detected for job: "${job.position}" at "${job.company_name}" (via: ${job.via}). Prioritizing search with via platform.`);
        searchQueries = [
          `"${job.company_name}" "${job.position}" "${job.via}"`,
          `"${job.company_name}" "${job.position}" ${job.via}`,
          `${job.company_name} ${job.position} ${job.via}`,
          `"${job.company_name}" "${job.position}" hiring`,
          `${job.company_name} ${job.position} hiring`
        ];
      } else {
        searchQueries = [
          `"${job.company_name}" "${job.position}" hiring`,
          `${job.company_name} ${job.position} hiring`
        ];
      }

      try {
        let urls = [];
        for (const query of searchQueries) {
          console.log(`Serper Search Attempt: "${query}"`);
          urls = await searchSerperAPI(query);
          if (urls && urls.length > 0) {
            console.log(`Found ${urls.length} raw results for query: "${query}"`);
            break;
          }
        }

        const cleanUrls = urls.map(cleanUrl).filter(url => url && url.startsWith("http"));
        console.log(`Serper API returned ${cleanUrls.length} candidate URLs.`);
        
        const bestMatch = selectBestUrl(cleanUrls, searchQuery, job.via);
        if (bestMatch) {
          selectedUrl = bestMatch.url;
          selectedReason = bestMatch.reason;
        }
      } catch (searchErr) {
        console.error("Serper API search encountered an error:", searchErr.message);
      }

      if (!selectedUrl) {
        console.warn("Could not find a valid LinkedIn or official job page on Google. Skipping scraping.");
        await logUnqualifiedLead({
          company_name: job.company_name,
          position: job.position,
          location: job.location,
          reason: "Could not find a valid LinkedIn or official job page on Google search."
        }, email);
        existingJobsSet.add(jobStringKey);
        continue;
      }

      const jobKey = normalizeJobUrl(selectedUrl);
      if (existingJobKeys.has(jobKey)) {
        console.log(`[Duplicate Job] Job with key "${jobKey}" (URL: ${selectedUrl}) has already been processed. Skipping scraping.\n`);
        continue;
      }

      console.log(`\nSelected URL: ${selectedUrl}`);
      console.log(`Reason:       ${selectedReason}`);
      console.log("Calling Playwright Scraper...\n");
      
      let scrapedDetails = null;
      try {
        scrapedDetails = await runScraper(selectedUrl);
      } catch (scrapeErr) {
        console.error("Scraper encountered an error:", scrapeErr.message);
      }

      if (!scrapedDetails || !scrapedDetails.description) {
        console.warn("Could not retrieve Job Description (JD). Skipping parsing/logging.");
        await logUnqualifiedLead({
          company_name: job.company_name,
          position: job.position,
          location: job.location,
          scraped_url: selectedUrl,
          reason: "Could not retrieve Job Description (JD) from page."
        }, email);
        existingJobsSet.add(jobStringKey);
        existingJobKeys.add(jobKey);
        continue;
      }

      const queryCompanyNormalized = job.company_name.toLowerCase().replace(/[^\w]/g, "");
      const scrapedCompanyNormalized = (scrapedDetails.company || "").toLowerCase().replace(/[^\w]/g, "");
      const scrapedTitleNormalized = (scrapedDetails.title || "").toLowerCase().replace(/[^\w]/g, "");
      const scrapedDescNormalized = (scrapedDetails.description || "").toLowerCase().replace(/[^\w]/g, "");

      const hasCompanyInName = scrapedCompanyNormalized.includes(queryCompanyNormalized) || queryCompanyNormalized.includes(scrapedCompanyNormalized);
      const hasCompanyInText = scrapedTitleNormalized.includes(queryCompanyNormalized) || scrapedDescNormalized.includes(queryCompanyNormalized);

      if (!hasCompanyInName && !hasCompanyInText) {
        console.warn(`[Pipeline] Skipping redirect mismatch. Scraped job at "${scrapedDetails.company}" is not related to candidate company "${job.company_name}".`);
        await logUnqualifiedLead({
          company_name: job.company_name,
          position: job.position,
          location: job.location,
          scraped_url: selectedUrl,
          scraped_description: scrapedDetails.description,
          scraped_location: scrapedDetails.location,
          reason: `Redirect mismatch: Scraped company "${scrapedDetails.company}" is not related to candidate company "${job.company_name}".`
        }, email);
        existingJobsSet.add(jobStringKey);
        existingJobKeys.add(jobKey);
        continue;
      }

      console.log("Stage 2: Evaluating fetched Job Description via Mistral AI...");

      const defaultMistralPrompt = `You are a specialized Job Listings Intelligence Agent. Evaluate this job posting and extract lead details:

REQUIRED FIELDS (return for this lead):
1. company_name: Organization name (string)
2. position: Job title/role (string)
3. role_summary: 1-2 sentence summary of responsibilities (string)
4. company_bio: 1-2 sentence company overview (string)
5. posted_date: Original posting date if mentioned (string or empty)
6. domain: Official website like "tesla.com" (string or empty)
7. email: Contact email if found or guess format like "careers@company.com" (string or empty)
8. linkedin: Official Company LinkedIn URL in format: https://www.linkedin.com/company/[vanity-name]. RULES: 1. Verify it is correct. 2. Remove legal suffixes. EXAMPLES: 'Tesla Inc' -> https://www.linkedin.com/company/tesla, 'Microsoft Corporation' -> https://www.linkedin.com/company/microsoft, '3M' -> https://www.linkedin.com/company/3m, 'GSK' -> https://www.linkedin.com/company/gsk (string or empty)
9. score: Fit score 0-100 based on: {{SECTOR_FILTER}} + {{MIN_EMPLOYEES}}+ employees + fit signals (number)
10. fit_reason: CONCISE 1-sentence explanation WHY this lead matches. MUST cite: (1) sector match, (2) employee size signal if available, (3) specific keyword found in description.
11. decision_link: LinkedIn URL to see all employees/people of this company. Use the exact same vanity-name from the linkedin field and append /people/ (e.g., https://www.linkedin.com/company/tesla/people/) (string or empty)
12. wikipedia: Wikipedia URL if company has one (string or empty)
13. outreach_msg: Company specific outreach message, personalized based on their profile and fit signals (string)
14. is_fit: boolean (true if the company fits the sector filter and does not match any exclude rules, false otherwise)

SECTOR FILTER (ONLY extract if matches):
- {{SECTOR_FILTER}}
- Companies with {{MIN_EMPLOYEES}}+ employees
- Signals: {{RD_SIGNALS}}

EXCLUDE:
- {{EXCLUDED_SECTORS}}`;

      let evaluatePrompt = dbMistralPrompt || process.env.MISTRAL_EVALUATE_PROMPT || defaultMistralPrompt;
      evaluatePrompt = evaluatePrompt.replace(/\\n/g, "\n").replace(/\\"/g, '"');
      evaluatePrompt = evaluatePrompt
        .split("{{SECTOR_FILTER}}").join(sectorFilter)
        .split("{{MIN_EMPLOYEES}}").join(minEmployees)
        .split("{{RD_SIGNALS}}").join(rdSignals)
        .split("{{EXCLUDED_SECTORS}}").join(excludedSectors);

      const fullMistralPrompt = `${evaluatePrompt}

OUTPUT FORMAT (STRICT JSON OBJECT):
{"company_name":"String","position":"String","role_summary":"String","company_bio":"String","posted_date":"String","domain":"String","email":"String","linkedin":"String","score":85,"fit_reason":"String","decision_link":"String","wikipedia":"String","outreach_msg":"String","is_fit":true}

JOB DATA TO ANALYZE:
Company: ${scrapedDetails.company || job.company_name}
Position: ${scrapedDetails.title || job.position}
Location: ${scrapedDetails.location || "Unknown"}
Job URL: ${scrapedDetails.url}
Job Description (JD):
${scrapedDetails.description}`;

      let evaluatedLead = null;
      try {
        console.log("Stage 2: Evaluating fetched Job Description via AI Engine...");
        const rawContent = await callAiCompletions(fullMistralPrompt, "large");
        evaluatedLead = cleanAndParseJson(rawContent);
      } catch (err) {
        console.error("Failed to evaluate lead in Stage 2:", err.message);
        await logUnqualifiedLead({
          company_name: job.company_name,
          position: job.position,
          location: job.location,
          scraped_url: selectedUrl,
          scraped_description: scrapedDetails.description,
          scraped_location: scrapedDetails.location,
          reason: `Failed to evaluate lead details via Mistral AI: ${err.message}`
        }, email);
        existingJobsSet.add(jobStringKey);
        existingJobKeys.add(jobKey);
        continue;
      }

      const scoreValue = typeof evaluatedLead.score === 'number' ? evaluatedLead.score : parseInt(evaluatedLead.score) || 0;
      if (scoreValue < minScore) {
        const rejectReason = `Rejected due to low fit score (${scoreValue}/100 < ${minScore}). Fit evaluation reason: ${evaluatedLead.fit_reason || 'N/A'}`;
        console.log(`Lead "${evaluatedLead.position}" at "${evaluatedLead.company_name}" rejected (score: ${scoreValue}/100 < ${minScore}). Skipping Sheets append.`);
        await logUnqualifiedLead({
          ...evaluatedLead,
          scraped_url: scrapedDetails.url,
          scraped_description: scrapedDetails.description,
          scraped_location: scrapedDetails.location,
          reason: rejectReason
        }, email);
        existingJobsSet.add(jobStringKey);
        existingJobKeys.add(jobKey);
        continue;
      }

      let empCount = scrapedDetails.employees;
      let companyLinkedinPage = scrapedDetails.company_linkedin_page || "";

      if (empCount === null && evaluatedLead.company_name) {
        console.log(`[LinkedIn Filter] Employee count is null. Attempting fallback search for "${evaluatedLead.company_name}" on LinkedIn...`);
        try {
          const fallbackDetails = await scrapeCompanyLinkedinDetails(evaluatedLead.company_name);
          if (fallbackDetails) {
            empCount = fallbackDetails.employees;
            companyLinkedinPage = fallbackDetails.linkedin;
          }
        } catch (fallbackErr) {
          console.error("Fallback company lookup failed:", fallbackErr.message);
        }
      }

      console.log(`[LinkedIn Filter] Checking employee count for company "${evaluatedLead.company_name}" on LinkedIn...`);
      
      if (empCount === null || empCount < minEmployees) {
        const empCountText = empCount === null ? "not found" : empCount;
        const rejectReason = `Rejected due to headcount filter (Employee count is ${empCountText} < ${minEmployees}).`;
        console.log(`Lead "${evaluatedLead.position}" at "${evaluatedLead.company_name}" rejected (LinkedIn Filter: employee count is ${empCountText} < ${minEmployees}). Skipping Sheets append.`);
        await logUnqualifiedLead({
          ...evaluatedLead,
          employees: empCount,
          company_linkedin_page: companyLinkedinPage || evaluatedLead.linkedin || "",
          scraped_url: scrapedDetails.url,
          scraped_description: scrapedDetails.description,
          scraped_location: scrapedDetails.location,
          reason: rejectReason
        }, email);
        existingJobsSet.add(jobStringKey);
        existingJobKeys.add(jobKey);
        continue;
      } else {
        console.log(`[LinkedIn Filter] Company "${evaluatedLead.company_name}" has ${empCount} employees on LinkedIn (>= ${minEmployees}). Allowed!`);
      }

      const mergedLead = {
        ...evaluatedLead,
        message_id: email.id || "",
        scraped_url: scrapedDetails.url,
        scraped_title: scrapedDetails.title,
        scraped_location: scrapedDetails.location,
        scraped_description: scrapedDetails.description,
        employees: empCount,
        company_linkedin_page: companyLinkedinPage || evaluatedLead.linkedin || ""
      };

      allProcessedLeads.push(mergedLead);
      existingJobsSet.add(jobStringKey);
      existingJobKeys.add(jobKey);

      try {
        console.log(`Inserting qualified lead into PostgreSQL...`);
        await pool.query(`
          INSERT INTO leads (
            company_name, position, company_bio, posted_date, domain, linkedin, score, 
            wikipedia, message_id, fit_reason, scraped_url, scraped_description, 
            employees, company_linkedin_page, scraped_location, email, outreach_msg, is_fit,
            owner_email
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        `, [
          mergedLead.company_name || "",
          mergedLead.position || "",
          mergedLead.company_bio || "",
          mergedLead.posted_date || "",
          mergedLead.domain || "",
          mergedLead.linkedin || "",
          mergedLead.score || 0,
          mergedLead.wikipedia || "",
          email.id || "",
          mergedLead.fit_reason || "",
          mergedLead.scraped_url || "",
          mergedLead.scraped_description || "",
          mergedLead.employees ? parseInt(mergedLead.employees) : null,
          mergedLead.company_linkedin_page || "",
          mergedLead.scraped_location || job.location || "",
          mergedLead.email || "",
          mergedLead.outreach_msg || "",
          true,
          ownerEmail
        ]);
        console.log("Successfully inserted qualified lead into PostgreSQL.");
      } catch (dbInsertErr) {
        console.error("Failed to insert qualified lead into PostgreSQL:", dbInsertErr.message);
      }

      await new Promise(r => setTimeout(r, 4000));
    }
  }

  console.log(`\nLocal JSON database logging bypassed. Leads processed: ${allProcessedLeads.length}`);

  if (matchedUids.length > 0) {
    console.log(`\nRe-connecting to Gmail to mark ${matchedUids.length} emails as read...`);
    const imapAuthRead = { user: targetUserEmail };
    if (oauthAccessToken) {
      imapAuthRead.accessToken = oauthAccessToken;
    } else if (appPassword) {
      imapAuthRead.pass = appPassword.replace(/\s+/g, "");
    }

    const readClient = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: imapAuthRead,
      logger: false
    });
    try {
      await readClient.connect();
      const lock = await readClient.getMailboxLock("INBOX");
      try {
        for (const uid of matchedUids) {
          await readClient.messageFlagsAdd({ uid }, ["\\Seen"]);
        }
        console.log("Emails successfully marked as read.");
      } finally {
        lock.release();
      }
      await readClient.logout();
    } catch (readErr) {
      console.error("Failed to mark emails as read:", readErr.message);
    }
  }

  if (options.onProgress) {
    options.onProgress({ phase: "Done", current: emailsToProcess.length, total: emailsToProcess.length, addedCount: allProcessedLeads.length, details: "Pipeline completed successfully." });
  }

  console.log("Pipeline execution finished successfully.");
  return { addedCount: allProcessedLeads.length };
}

if (process.argv[1] && (process.argv[1].endsWith("email-ingest.js") || process.argv[1].endsWith("email-ingest"))) {
  runPipeline().catch(console.error);
}
