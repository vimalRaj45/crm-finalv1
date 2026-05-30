import "dotenv/config";
import { google } from "googleapis";
import fs from "fs";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { runScraper } from "./scraper.js";

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
  // If it contains HTML tags, strip them out
  if (/<[a-z][\s\S]*>/i.test(body)) {
    text = body
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"');
  }

  // Normalize whitespaces and line breaks to minimize token footprint
  text = text.replace(/\s+/g, " ").trim();

  // Truncate to a safe length (12000 chars is ~3000 tokens)
  const maxLength = 12000;
  if (text.length > maxLength) {
    console.log(`[Cleaner] Truncating body from ${text.length} to ${maxLength} characters to fit within Groq token limits.`);
    text = text.substring(0, maxLength) + "... [Truncated]";
  }

  return text;
}

// Clean and decode DuckDuckGo/Bing redirect URLs
function cleanUrl(rawUrl) {
  if (!rawUrl) return "";
  let url = rawUrl.replace(/&amp;/g, "&");
  if (url.startsWith("//")) {
    url = "https:" + url;
  }
  try {
    // 1. DuckDuckGo Redirect
    if (url.includes("duckduckgo.com/l/?uddg=")) {
      const urlObj = new URL(url);
      const uddg = urlObj.searchParams.get("uddg");
      if (uddg) {
        return decodeURIComponent(uddg);
      }
    }

    // 2. Bing Redirect
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

// Extract potential company keywords from the query to match official domains
function getCompanyKeywords(query) {
  const stopWords = new Set([
    "associate", "director", "manager", "lead", "engineer", "developer", "specialist", "analyst", "co",
    "process", "innovation", "automation", "dharwad", "karnataka", "india", "bebee", "linkedin", "jobs",
    "job", "career", "careers", "internship", "via", "of", "and", "in", "for", "the", "a", "an", "with",
    "&", "enterprise", "inc", "ltd", "group", "solutions", "services", "global", "systems", "technologies"
  ]);

  const words = query.toLowerCase()
    .replace(/[^\w\s&]/g, " ") // replace punctuation with spaces
    .split(/\s+/)
    .filter(w => w && !stopWords.has(w));

  return words;
}

// Perform Google search using Serper API
async function searchSerperAPI(query) {
  const apiKey = process.env.SERPER_API_KEY || "6e3394cf8d659c84441b42a3e2b7ef8f51df5c14";
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
  const path = url.toLowerCase();
  
  // Block general career page endings/keywords
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

  if (genericPatterns.some(pattern => pattern.test(path))) {
    return true;
  }

  // Block base portals of ATS sites (which just list all jobs)
  if (path.includes("greenhouse.io") && !path.includes("/jobs/") && !path.includes("?gh_jid=")) {
    return true;
  }
  if (path.includes("lever.co") && (path.endsWith("lever.co") || path.endsWith("lever.co/"))) {
    return true;
  }
  if (path.includes("smartrecruiters.com") && !path.includes("/jobs/") && !path.includes("/show/")) {
    return true;
  }
  if (path.includes("myworkdayjobs.com") && !path.includes("/job/")) {
    return true;
  }
  
  return false;
}

// Rank and select candidate URL based on preferences
function selectBestUrl(urls, query) {
  const companyKeywords = getCompanyKeywords(query);
  const rankedUrls = urls.map(url => {
    const lowerUrl = url.toLowerCase();
    
    // Explicitly exclude generic careers directories/listings
    if (isGenericCareersPage(url)) {
      return { url, score: 0, reason: "Excluded: Generic Careers Directory" };
    }

    let score = 0;
    let reason = "";

    // Rank 1: LinkedIn (Highest preference)
    if (lowerUrl.includes("linkedin.com")) {
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
    // Rank 2: Naukri (Specialized Job Board)
    else if (lowerUrl.includes("naukri.com")) {
      const isNaukriJob = lowerUrl.includes("/job-listings-") || lowerUrl.includes("/job/");
      if (isNaukriJob) {
        score = 9;
        reason = "Preference 1: Naukri Job Posting";
      } else {
        return { url, score: 0, reason: "Excluded: Non-job Naukri URL" };
      }
    }
    // Rank 3: Indeed
    else if (lowerUrl.includes("indeed.com") || lowerUrl.includes("indeed.co.in")) {
      const isIndeedJob = lowerUrl.includes("/viewjob") || lowerUrl.includes("/rc/clk") || lowerUrl.includes("/job/");
      if (isIndeedJob) {
        score = 8;
        reason = "Preference 1: Indeed Job Posting";
      } else {
        return { url, score: 0, reason: "Excluded: Non-job Indeed URL" };
      }
    }
    // Rank 4: SimplyHired
    else if (lowerUrl.includes("simplyhired.com")) {
      const isSimplyHiredJob = lowerUrl.includes("/job/") || lowerUrl.includes("/view/");
      if (isSimplyHiredJob) {
        score = 7;
        reason = "Preference 1: SimplyHired Job Posting";
      } else {
        return { url, score: 0, reason: "Excluded: Non-job SimplyHired URL" };
      }
    }


    return { url, score, reason };
  }).filter(item => item.score > 0);

  // Choose the first URL in the search result order that matches any of our preferences
  return rankedUrls[0] || null;
}

// Main Ingestion Pipeline Runner
async function runPipeline() {
  const serviceAccountPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || "service-account.json";
  if (!fs.existsSync(serviceAccountPath)) {
    console.error(`Error: Service account key file not found at ${serviceAccountPath}`);
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
  const targetUserEmail = process.env.GMAIL_USER_EMAIL;
  const appPassword = process.env.GMAIL_APP_PASSWORD;
  const allowedSendersRaw = process.env.ALLOWED_SENDERS || "";
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const mistralApiKey = process.env.MISTRAL_API_KEY;
  const groqApiKey = process.env.GROQ_API_KEY;

  if (!targetUserEmail || !allowedSendersRaw || !spreadsheetId || !mistralApiKey || !groqApiKey) {
    console.error("Error: Missing required variables in .env file.");
    console.error("Please verify GMAIL_USER_EMAIL, ALLOWED_SENDERS, GOOGLE_SPREADSHEET_ID, MISTRAL_API_KEY, and GROQ_API_KEY are configured.");
    process.exit(1);
  }

  console.log("--------------------------------------------------");
  console.log("Starting R&D Intelligence Pipeline (IMAP Flow)");
  console.log(`Target Inbox:    ${targetUserEmail}`);
  console.log(`Allowed Senders: ${allowedSendersRaw}`);
  console.log(`Spreadsheet ID:  ${spreadsheetId}`);
  console.log("--------------------------------------------------\n");

  // 1. Authenticate Google Sheets Client
  console.log("Initializing Google Sheets Auth client...");
  const authSheets = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  const sheets = google.sheets({ version: "v4", auth: authSheets });

  // Ensure Sheet Header is set up
  try {
    const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId });
    const sheetName = sheetMeta.data.sheets[0].properties.title || "Sheet1";
    
    const readRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:Z1`
    });

    if (!readRes.data.values || readRes.data.values.length === 0) {
      console.log("Initializing Sheet Headers...");
      const headers = [
        "Company Name", "Position", "Role Summary", "Company Bio", "Posted Date", 
        "Domain", "Email", "LinkedIn", "Fit Score", "Fit Reason", 
        "Decision Link", "Wikipedia", "Outreach Message", 
        "Scraped URL", "Scraped Title", "Scraped Location", "Scraped Description"
      ];
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [headers] }
      });
      console.log("Headers created successfully.");
    }
  } catch (sheetErr) {
    console.error("Failed to check or initialize Google Sheet. Make sure the sheet is shared with the service account.", sheetErr.message);
    process.exit(1);
  }

  // 2. Fetch Emails via IMAP
  const emailList = [];
  
  if (!appPassword) {
    console.error("Error: GMAIL_APP_PASSWORD is not set. IMAP credentials missing.");
    process.exit(1);
  }

  console.log("Connecting to Gmail via IMAP...");
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: targetUserEmail,
      pass: appPassword.replace(/\s+/g, "")
    },
    logger: false
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    
    try {
      console.log("Fetching all messages from the last 1 hour...");
      const sinceDate = new Date(Date.now() - 1 * 60 * 60 * 1000);
      
      // Fetch all messages from the last 1 hour only
      const fetchGen = client.fetch({ since: sinceDate }, { source: true });
      
      const senders = allowedSendersRaw.split(",").map(s => s.trim().toLowerCase());
      const matchedUids = [];

      for await (const message of fetchGen) {
        const parsed = await simpleParser(message.source);
        const fromAddress = parsed.from?.value?.[0]?.address || "";
        
        if (!senders.includes(fromAddress.toLowerCase())) {
          console.log(`Skipping message from unauthorized sender: ${fromAddress}`);
          continue;
        }

        console.log(`Matched email: "${parsed.subject || "No Subject"}" from ${fromAddress}`);
        
        const rawBody = parsed.text || parsed.html || "";
        const cleanedBody = cleanEmailBody(rawBody);

        emailList.push({
          subject: parsed.subject || "No Subject",
          body: cleanedBody
        });

        matchedUids.push(message.uid);
      }

      // Mark as read after the fetch loop completes to prevent deadlock
      if (matchedUids.length > 0) {
        console.log(`Marking ${matchedUids.length} matched emails as read...`);
        for (const uid of matchedUids) {
          await client.messageFlagsAdd({ uid }, ["\\Seen"]);
        }
      }
    } finally {
      lock.release();
    }
    
    await client.logout();
    console.log("IMAP session closed successfully.");
  } catch (imapErr) {
    console.error("IMAP connection or parsing failed! Detailed trace:");
    console.error(imapErr);
    process.exit(1);
  }

  console.log(`\nRetrieved ${emailList.length} new unread emails to process.`);

  if (emailList.length === 0) {
    console.log("No new emails. Pipeline finished.");
    process.exit(0);
  }

  const allProcessedLeads = [];

  // 3. Process each email's body
  for (const email of emailList) {
    console.log(`\n==================================================`);
    console.log(`Processing Email: "${email.subject}"`);
    console.log(`==================================================`);

    console.log("Stage 1: Extracting job titles/companies from email via Mistral...");

    // Stage 1 Prompt: Raw Extraction with strict R&D filtering
    const extractPrompt = `You are a specialized R&D Intelligence Agent. Extract job listings (full detailed job title, company name, and location if mentioned) mentioned in the email body that match the rules:

RULES:
- Extract the FULL, COMPLETE, and DETAILED job title exactly as written in the email (e.g. "Associate Director of Process Innovation & Automation" instead of a shortened/simplified "Associate Director"). Do not simplify, truncate, or omit any part of the position name.
- ONLY extract if they are in the sectors: Manufacturing, Automotive, Aerospace, Pharma, MedTech, Global Capability Centers (GCC).
- MUST have R&D signals (e.g. engineering, scientist, researcher, developer, innovation, technology, patent, etc.).
- STRICTLY EXCLUDE:
  * IT Services (such as TCS, Infosys, Wipro, HCL, Cognizant, Accenture, etc.)
  * Retail, gig economy, or logistics (such as Starbucks, Uber, delivery roles, distributors, etc.)
  * Consulting, law firms, legal services, IP consulting, advisory, recruitment, staffing, outsourcing, BPO, KPO.

Return a clean JSON array of objects with keys "position", "company_name", and "location". If location is not mentioned, use an empty string.
Do not include any conversational text or explanation. Only return valid JSON.

EMAIL TO ANALYZE:
${email.body}`;

    let candidateJobs = [];
    try {
      console.log("Calling Groq API for Stage 1 extraction...");
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${groqApiKey}`
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          messages: [{ role: "user", content: extractPrompt }],
          temperature: 0.1,
          response_format: { type: "json_object" }
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Groq API returned status ${response.status}: ${response.statusText}. Details: ${errText}`);
      }

      const resJson = await response.json();
      const rawContent = resJson.choices[0].message.content;
      const parsedRes = cleanAndParseJson(rawContent);

      if (Array.isArray(parsedRes)) {
        candidateJobs = parsedRes;
      } else {
        const keyWithArray = Object.keys(parsedRes).find(k => Array.isArray(parsedRes[k]));
        if (keyWithArray) candidateJobs = parsedRes[keyWithArray];
      }
    } catch (err) {
      console.error("Failed to parse candidates in Stage 1:", err.message);
      continue;
    }

    console.log(`Found ${candidateJobs.length} candidate job listings to scrape.`);

    // 4. For each job, search/scrape, and then evaluate via Mistral
    for (const job of candidateJobs) {
      console.log(`\nCandidate: ${job.position} at ${job.company_name}${job.location ? ` in ${job.location}` : ""}`);

      // Construct search query exactly as: Company + Job hiring
      const searchQuery = `"${job.company_name}" "${job.position}" hiring`;
      console.log(`Constructed Search Query: "${searchQuery}"`);

      let selectedUrl = "";
      let selectedReason = "";

      try {
        // Perform Google search via Serper API inside pipeline
        let urls = await searchSerperAPI(searchQuery);
        
        // Fallback to broader search without quotes if exact quote search returns no results
        if (urls.length === 0) {
          const broaderQuery = `${job.company_name} ${job.position} hiring`;
          console.log(`No results with exact quotes. Retrying broader: "${broaderQuery}"`);
          urls = await searchSerperAPI(broaderQuery);
        }

        const cleanUrls = urls.map(cleanUrl).filter(url => url && url.startsWith("http"));
        console.log(`Serper API returned ${cleanUrls.length} candidate URLs.`);
        
        const bestMatch = selectBestUrl(cleanUrls, searchQuery);
        if (bestMatch) {
          selectedUrl = bestMatch.url;
          selectedReason = bestMatch.reason;
        }
      } catch (searchErr) {
        console.error("Serper API search encountered an error:", searchErr.message);
      }

      if (!selectedUrl) {
        console.warn("Could not find a valid LinkedIn or official job page on Google. Skipping scraping.");
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
        continue;
      }

      console.log("Stage 2: Evaluating fetched Job Description via Mistral AI...");

      // Stage 2 Prompt: Evaluate full JD
      const evaluatePrompt = `You are a specialized R&D Intelligence Agent. Evaluate this job posting and extract lead details:

REQUIRED FIELDS (return for this lead):
1. company_name: Organization name (string)
2. position: Job title/role (string)
3. role_summary: 1-2 sentence summary of responsibilities (string)
4. company_bio: 1-2 sentence company overview (string)
5. posted_date: Original posting date if mentioned (string or empty)
6. domain: Official website like \"tesla.com\" (string or empty)
7. email: Contact email if found or guess format like \"careers@company.com\" (string or empty)
8. linkedin: Official Company LinkedIn URL in format: https://www.linkedin.com/company/[vanity-name]. RULES: 1. Verify it is correct. 2. Remove legal suffixes. EXAMPLES: 'Tesla Inc' -> https://www.linkedin.com/company/tesla, 'Microsoft Corporation' -> https://www.linkedin.com/company/microsoft, '3M' -> https://www.linkedin.com/company/3m, 'GSK' -> https://www.linkedin.com/company/gsk (string or empty)
9. score: Fit score 0-100 based on: Manufacturing/Auto/Aerospace/Pharma/MedTech/GCC + 500+ employees + R&D signals (number)
10. fit_reason: CONCISE 1-sentence explanation WHY this lead matches. MUST cite: (1) sector match, (2) employee size signal if available, (3) specific R&D keyword found in description.
11. decision_link: LinkedIn URL to see all employees/people of this company. Use the exact same vanity-name from the linkedin field and append /people/ (e.g., https://www.linkedin.com/company/tesla/people/) (string or empty)
12. wikipedia: Wikipedia URL if company has one (string or empty)
13. outreach_msg: Company specific outreach message, personalized based on their profile and R&D signals (string)
14. is_fit: boolean (true if the company fits the sector filter and does not match any exclude rules, false otherwise)

SECTOR FILTER (ONLY extract if matches):
- Manufacturing, Automotive, Aerospace, Pharma, MedTech, Global Capability Centers (GCC)
- Companies with 500+ employees
- Signals: technology roadmap, R&D strategy, IP analyst, patent portfolio, innovation manager, TRIZ, NPD

EXCLUDE:
- IT Services (TCS, Infosys, Wipro, etc.), Trading, Startups <5 years, Distributors, Retail chains, Law firms, Consulting firms, IP services

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
        const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${mistralApiKey}`
          },
          body: JSON.stringify({
            model: "mistral-large-latest",
            messages: [{ role: "user", content: evaluatePrompt }],
            temperature: 0.1,
            response_format: { type: "json_object" }
          })
        });

        if (!response.ok) {
          throw new Error(`Mistral API returned status ${response.status}: ${response.statusText}`);
        }

        const resJson = await response.json();
        const rawContent = resJson.choices[0].message.content;
        evaluatedLead = cleanAndParseJson(rawContent);
      } catch (err) {
        console.error("Failed to evaluate lead in Stage 2:", err.message);
        continue;
      }

      // Filter out low scores or explicit non-matches
      if (evaluatedLead.is_fit === false || (evaluatedLead.score && evaluatedLead.score < 50)) {
        console.log(`Lead "${evaluatedLead.position}" at "${evaluatedLead.company_name}" rejected (is_fit: ${evaluatedLead.is_fit}, score: ${evaluatedLead.score}/100). Skipping Sheets append.`);
        continue;
      }

      // Merge data
      const mergedLead = {
        ...evaluatedLead,
        scraped_url: scrapedDetails.url,
        scraped_title: scrapedDetails.title,
        scraped_location: scrapedDetails.location,
        scraped_description: scrapedDetails.description
      };

      allProcessedLeads.push(mergedLead);

      // Append row to Google Sheet
      const rowValues = [
        mergedLead.company_name || "",
        mergedLead.position || "",
        mergedLead.role_summary || "",
        mergedLead.company_bio || "",
        mergedLead.posted_date || "",
        mergedLead.domain || "",
        mergedLead.email || "",
        mergedLead.linkedin || "",
        mergedLead.score || 0,
        mergedLead.fit_reason || "",
        mergedLead.decision_link || "",
        mergedLead.wikipedia || "",
        mergedLead.outreach_msg || "",
        mergedLead.scraped_url || "",
        mergedLead.scraped_title || "",
        mergedLead.scraped_location || "",
        mergedLead.scraped_description || ""
      ];

      try {
        console.log("Appending lead to Google Sheet...");
        const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId });
        const sheetName = sheetMeta.data.sheets[0].properties.title || "Sheet1";
        
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: `${sheetName}!A:Q`,
          valueInputOption: "RAW",
          requestBody: { values: [rowValues] }
        });
        console.log("Successfully appended row to Google Sheet.");
      } catch (sheetAppendErr) {
        console.error("Failed to append lead to Google Sheet:", sheetAppendErr.message);
      }

      // Throttle slightly between scrapes
      await new Promise(r => setTimeout(r, 4000));
    }
  }

  // 5. Consolidate results in local jobs-db.json file
  let existingData = [];
  if (fs.existsSync("jobs-db.json")) {
    try {
      existingData = JSON.parse(fs.readFileSync("jobs-db.json", "utf8"));
      if (!Array.isArray(existingData)) existingData = [];
    } catch (e) {
      existingData = [];
    }
  }

  const updatedData = [...existingData, ...allProcessedLeads];
  fs.writeFileSync("jobs-db.json", JSON.stringify(updatedData, null, 2));
  console.log(`\nSaved/Updated ${allProcessedLeads.length} leads in local database: jobs-db.json`);
  console.log("Pipeline execution finished successfully.");
}

runPipeline().catch(console.error);
