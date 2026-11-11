import { runScraper } from "./scraper.js";
import fs from "fs";

// Helper to save a single job to jobs-db.json
function saveJobToDb(jobDetails) {
  const dbFile = "jobs-db.json";
  let existingData = [];

  if (fs.existsSync(dbFile)) {
    try {
      const content = fs.readFileSync(dbFile, "utf8");
      existingData = JSON.parse(content);
      if (!Array.isArray(existingData)) {
        existingData = [];
      }
    } catch (err) {
      console.warn(`Warning: Could not parse ${dbFile}, initializing new database.`);
      existingData = [];
    }
  }

  // Avoid duplicate URLs in the database
  const isDuplicate = existingData.some(
    item => item.url && jobDetails.url && item.url.toLowerCase() === jobDetails.url.toLowerCase()
  );

  if (isDuplicate) {
    console.log(`Job already exists in database (duplicate URL): ${jobDetails.url}`);
    return;
  }

  existingData.push(jobDetails);
  fs.writeFileSync(dbFile, JSON.stringify(existingData, null, 2), "utf8");
  console.log(`Saved job to database: ${dbFile}`);
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
    // If it's a LinkedIn job URL, normalize to a standard Job ID-based string
    const jobId = extractLinkedInJobId(url);
    if (jobId) {
      return `linkedin-job-${jobId}`;
    }
    // Remove query params and trailing slashes for other job portals
    let normalized = parsed.origin + parsed.pathname.replace(/\/$/, "");
    return normalized.toLowerCase();
  } catch (e) {
    return url.toLowerCase().trim();
  }
}


// Extract potential company keywords from the query to match official domains
function getCompanyKeywords(query) {
  const stopWords = new Set([
    "associate", "director", "manager", "lead", "engineer", "developer", "specialist", "analyst", "co",
    "process", "innovation", "automation", "dharwad", "karnataka", "india", "bebee", "linkedin", "jobs",
    "job", "career", "careers", "internship", "via", "of", "and", "in", "for", "the", "a", "an", "with",
    "&", "enterprise", "inc", "ltd", "group", "solutions", "services", "global", "systems", "technologies",
    "austin", "bengaluru", "bangalore", "pune", "mumbai", "delhi", "chennai", "hyderabad", "r", "d"
  ]);

  const words = query.toLowerCase()
    .replace(/[^\w\s&]/g, " ") // replace punctuation with spaces
    .split(/\s+/)
    .filter(w => w && !stopWords.has(w));

  return words;
}

// Perform Google search using Serper API
async function searchSerperAPI(query) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    console.warn(`[test.js Serper Search] SERPER_API_KEY is not set.`);
    return [];
  }
  const searchUrl = `https://google.serper.dev/search?q=${encodeURIComponent(query)}&apiKey=${apiKey}`;
  console.log(`[test.js Serper Search] Querying Serper.dev API...`);
  
  try {
    const res = await fetch(searchUrl);
    if (!res.ok) {
      throw new Error(`Serper API returned status ${res.status}: ${res.statusText}`);
    }
    const data = await res.json();
    if (data && Array.isArray(data.organic)) {
      const links = data.organic.map(item => item.link).filter(Boolean);
      console.log(`[test.js Serper Search] Fetched ${links.length} URLs from Serper API:`);
      links.forEach((link, idx) => console.log(`  [${idx + 1}] ${link}`));
      return links;
    }
    return [];
  } catch (err) {
    console.error(`[test.js Serper Search] Error querying Serper API: ${err.message}`);
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
    // Rank 5: BeBee
    else if (lowerUrl.includes("bebee.com")) {
      score = 6;
      reason = "Preference 1: BeBee Job Posting";
    }


    return { url, score, reason };
  }).filter(item => item.score > 0);

  // Choose the first URL in the search result order that matches any of our preferences
  return rankedUrls[0] || null;
}

// Heuristic query refiner for retrying search failures
function getFallbackQueries(originalQuery) {
  const fallbacks = [];
  const cleanOriginal = originalQuery.trim();

  // 1. Replace ampersands with "and" and normalize spaces
  if (cleanOriginal.includes("&")) {
    const withoutAmp = cleanOriginal.replace(/&/g, "and").replace(/\s+/g, " ").trim();
    fallbacks.push(withoutAmp);
  }

  // 2. Normalize and clean special characters/punctuation
  const normalized = cleanOriginal.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.toLowerCase() !== cleanOriginal.toLowerCase()) {
    fallbacks.push(normalized);
  }

  // 3. For long queries, extract the first 2 words (core title) and last 3 words (company)
  const words = normalized.split(/\s+/).filter(w => w.length > 0);
  if (words.length > 5) {
    const coreTitle = words.slice(0, 2).join(" ");
    const company = words.slice(-3).join(" ");
    const fallback1 = `${coreTitle} ${company}`;
    if (!fallbacks.includes(fallback1)) {
      fallbacks.push(fallback1);
    }
    
    // 4. Try first 3 words (often full title) + last 3 words
    if (words.length > 6) {
      const longTitle = words.slice(0, 3).join(" ");
      const fallback2 = `${longTitle} ${company}`;
      if (!fallbacks.includes(fallback2)) {
        fallbacks.push(fallback2);
      }
    }
  }

  return fallbacks;
}

async function run() {
  let queries = [];
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage options:");
    console.log('  1. CLI Arguments:   node test.js "Query 1" "Query 2"');
    console.log('  2. Comma Separated: node test.js "Query 1, Query 2, Query 3"');
    console.log('  3. Text File:       node test.js queries.txt');
    console.log('  4. JSON File:       node test.js queries.json');
    process.exit(1);
  }

  const firstArg = args[0];
  if (args.length === 1 && firstArg.endsWith(".json")) {
    try {
      const data = fs.readFileSync(firstArg, "utf8");
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        queries = parsed;
      } else {
        console.error("Error: JSON file must contain an array of query strings.");
        process.exit(1);
      }
    } catch (err) {
      console.error(`Error reading or parsing JSON file: ${err.message}`);
      process.exit(1);
    }
  } else if (args.length === 1 && firstArg.endsWith(".txt")) {
    try {
      const data = fs.readFileSync(firstArg, "utf8");
      queries = data
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0);
    } catch (err) {
      console.error(`Error reading text file: ${err.message}`);
      process.exit(1);
    }
  } else {
    queries = args
      .flatMap(arg => arg.split(","))
      .map(q => q.trim())
      .filter(q => q.length > 0);
  }

  const existingJobKeys = new Set();
  const dbFiles = ["jobs-db.json", "job.json"];
  for (const dbFile of dbFiles) {
    if (fs.existsSync(dbFile)) {
      try {
        const content = fs.readFileSync(dbFile, "utf8");
        const items = JSON.parse(content);
        if (Array.isArray(items)) {
          items.forEach(item => {
            if (item.url) existingJobKeys.add(normalizeJobUrl(item.url));
            if (item.scraped_url) existingJobKeys.add(normalizeJobUrl(item.scraped_url));
          });
        }
      } catch (err) {
        console.warn(`Warning: Could not read or parse ${dbFile} for deduplication keys:`, err.message);
      }
    }
  }
  console.log(`Loaded ${existingJobKeys.size} duplicate keys for job deduplication.`);

  console.log(`\n==================================================`);
  console.log(`Starting Batch Processing: ${queries.length} queries`);
  console.log(`==================================================\n`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    console.log(`\n--------------------------------------------------`);
    console.log(`[Query ${i + 1}/${queries.length}] Processing: "${query}"`);
    console.log(`--------------------------------------------------`);

    try {
      let selectedUrl = "";
      let selectedReason = "";

      // 1. If it's already a direct URL, bypass search
      if (query.startsWith("http://") || query.startsWith("https://")) {
        selectedUrl = query;
        selectedReason = "Direct URL input";
      } else {
        // 2. Perform search via Serper API
        const urls = await searchSerperAPI(query);
        
        console.log(`Serper API returned ${urls.length} URLs`);
        const bestMatch = selectBestUrl(urls, query);
        
        if (bestMatch) {
          selectedUrl = bestMatch.url;
          selectedReason = bestMatch.reason;
        } else {
          // 3. Try Fallback Queries on Serper API
          console.log(`No direct matches found. Running query refinement...`);
          const fallbacks = getFallbackQueries(query);
          for (const fallback of fallbacks) {
            console.log(`Retrying Serper API with refined query: "${fallback}"`);
            const fbUrls = await searchSerperAPI(fallback);
            const fbBestMatch = selectBestUrl(fbUrls, fallback);
            if (fbBestMatch) {
              selectedUrl = fbBestMatch.url;
              selectedReason = fbBestMatch.reason;
              break;
            }
          }
        }
      }

      if (selectedUrl) {
        const jobKey = normalizeJobUrl(selectedUrl);
        if (existingJobKeys.has(jobKey)) {
          console.log(`[Duplicate Job] Job with key "${jobKey}" (URL: ${selectedUrl}) has already been processed. Skipping scraping.\n`);
          successCount++;
          continue;
        }

        console.log(`\nSelected URL: ${selectedUrl}`);
        console.log(`Reason:       ${selectedReason}`);
        console.log(`Calling Scraper Engine...\n`);

        const jobDetails = await runScraper(selectedUrl);
        if (jobDetails) {
          // Check for redirect mismatch: if none of the query company keywords match the scraped company, title, or description
          const companyKeywords = getCompanyKeywords(query);
          const scrapedCompanyNormalized = (jobDetails.company || "").toLowerCase().replace(/[^\w]/g, "");
          const scrapedTitleNormalized = (jobDetails.title || "").toLowerCase().replace(/[^\w]/g, "");
          const scrapedDescNormalized = (jobDetails.description || "").toLowerCase().replace(/[^\w]/g, "");

          const hasKeyword = companyKeywords.some(keyword => {
            const normalizedKeyword = keyword.toLowerCase().replace(/[^\w]/g, "");
            return scrapedCompanyNormalized.includes(normalizedKeyword) ||
                   scrapedTitleNormalized.includes(normalizedKeyword) ||
                   scrapedDescNormalized.includes(normalizedKeyword);
          });

          if (companyKeywords.length > 0 && !hasKeyword) {
            console.warn(`[test.js] Skipping redirect mismatch. Scraped job at "${jobDetails.company}" is not related to query keywords: [${companyKeywords.join(", ")}].`);
            failCount++;
            continue;
          }

          console.log(`Successfully scraped: "${jobDetails.title}" at "${jobDetails.company}"`);
          saveJobToDb(jobDetails);
          existingJobKeys.add(jobKey);
          successCount++;
        } else {
          console.log(`Failed to extract job details from: ${selectedUrl}`);
          failCount++;
        }
      } else {
        console.log(`Could not find a valid LinkedIn or official job page on Google for query: "${query}"`);
        failCount++;
      }
    } catch (err) {
      console.error(`Error processing query "${query}":`, err.message);
      failCount++;
    }

    // Throttle between searches to avoid rate limits
    if (i < queries.length - 1) {
      const delayMs = 4000;
      console.log(`\nThrottling: Waiting ${delayMs / 1000}s before next query...\n`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  console.log(`\n==================================================`);
  console.log(`Batch execution complete.`);
  console.log(`Total Success: ${successCount}`);
  console.log(`Total Failed:  ${failCount}`);
  console.log(`Database File: jobs-db.json`);
  console.log(`==================================================\n`);
}

run().catch(console.error);