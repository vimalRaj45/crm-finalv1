import { chromium } from "playwright";
import fs from "fs";
import path from "path";

// Ensure Playwright looks for browsers inside the project directory for Render persistence
process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve(process.cwd(), ".playwright-browsers");

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

// Check which platform it is based on URL or Page Source
function detectPlatform(url, htmlContent) {
  const lowercaseUrl = url.toLowerCase();
  const lowercaseHtml = htmlContent.toLowerCase();

  if (lowercaseUrl.includes("greenhouse.io") || lowercaseHtml.includes("greenhouse.io")) {
    return "greenhouse";
  }
  if (lowercaseUrl.includes("lever.co") || lowercaseHtml.includes("lever.co")) {
    return "lever";
  }
  if (lowercaseUrl.includes("myworkdayjobs.com") || lowercaseUrl.includes("workdayjobs.com") || lowercaseHtml.includes("myworkdayjobs")) {
    return "workday";
  }
  if (lowercaseUrl.includes("smartrecruiters.com") || lowercaseHtml.includes("smartrecruiters.com")) {
    return "smartrecruiters";
  }
  if (lowercaseUrl.includes("linkedin.com")) {
    return "linkedin";
  }
  if (lowercaseUrl.includes("indeed.com") || lowercaseUrl.includes("indeed.co.in")) {
    return "indeed";
  }
  if (lowercaseUrl.includes("simplyhired.com")) {
    return "simplyhired";
  }
  if (lowercaseUrl.includes("naukri.com")) {
    return "naukri";
  }
  return "generic";
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

// Greenhouse Parser
async function parseGreenhouse(page, url) {
  let title = "";
  for (const selector of ["h1.app-title", ".header-container h1", "h1"]) {
    const el = await page.$(selector);
    if (el) {
      title = (await el.innerText()).trim();
      if (title) break;
    }
  }

  let location = "";
  for (const selector of [".location", "div.location"]) {
    const el = await page.$(selector);
    if (el) {
      location = (await el.innerText()).trim();
      if (location) break;
    }
  }

  let company = "";
  for (const selector of [".company-name", ".logo-container img"]) {
    const el = await page.$(selector);
    if (el) {
      if (await el.tagName() === "IMG") {
        company = (await el.getAttribute("alt")) || "";
      } else {
        company = (await el.innerText()).trim();
      }
      if (company) break;
    }
  }
  if (!company) {
    const metaSite = await page.$("meta[property='og:site_name']");
    if (metaSite) company = await metaSite.getAttribute("content");
  }
  if (!company) {
    const docTitle = await page.title();
    if (docTitle.includes(" at ")) {
      company = docTitle.split(" at ")[1].trim();
    } else if (docTitle.includes(" - ")) {
      company = docTitle.split(" - ")[0].trim();
    }
  }

  let description = "";
  for (const selector of ["#content", ".content", ".job-body"]) {
    const el = await page.$(selector);
    if (el) {
      description = (await el.innerText()).trim();
      if (description) break;
    }
  }

  return { title, company, location, description, platform: "Greenhouse", url };
}

// Lever Parser
async function parseLever(page, url) {
  let title = "";
  for (const selector of [".posting-header h2", "h2", "h1"]) {
    const el = await page.$(selector);
    if (el) {
      title = (await el.innerText()).trim();
      if (title) break;
    }
  }

  let location = "";
  for (const selector of [".posting-categories .location", ".location"]) {
    const el = await page.$(selector);
    if (el) {
      location = (await el.innerText()).trim().replace(/^-\s*/, "");
      if (location) break;
    }
  }

  let company = "";
  const docTitle = await page.title();
  if (docTitle.includes(" - ")) {
    const parts = docTitle.split(" - ");
    if (title && parts[0].toLowerCase().includes(title.toLowerCase())) {
      company = parts[1].trim();
    } else {
      company = parts[0].trim();
    }
  }
  if (!company) {
    const metaSite = await page.$("meta[property='og:site_name']");
    if (metaSite) company = await metaSite.getAttribute("content");
  }

  let description = "";
  for (const selector of [".section.page-centered", ".job-description", ".posting-requirements"]) {
    const el = await page.$(selector);
    if (el) {
      description = (await el.innerText()).trim();
      if (description) break;
    }
  }

  return { title, company, location, description, platform: "Lever", url };
}

// Workday Parser
async function parseWorkday(page, url) {
  await page.waitForSelector('[data-automation-id="jobPostingHeader"], h1', { timeout: 8000 }).catch(() => {});

  let title = "";
  for (const selector of ['[data-automation-id="jobPostingHeader"]', "h1", "h2"]) {
    const el = await page.$(selector);
    if (el) {
      title = (await el.innerText()).trim();
      if (title) break;
    }
  }

  let location = "";
  for (const selector of ['[data-automation-id="location"]', '[data-automation-id="workdayJobLocation"]']) {
    const el = await page.$(selector);
    if (el) {
      location = (await el.innerText()).trim();
      if (location) break;
    }
  }

  let company = "";
  const companyEl = await page.$('[data-automation-id="companyName"]');
  if (companyEl) company = (await companyEl.innerText()).trim();
  
  if (!company) {
    const docTitle = await page.title();
    if (docTitle.includes(" - ")) {
      company = docTitle.split(" - ")[0].trim();
    }
  }

  let description = "";
  const descEl = await page.$('[data-automation-id="jobDescription"]');
  if (descEl) description = (await descEl.innerText()).trim();

  return { title, company, location, description, platform: "Workday", url };
}

// SmartRecruiters Parser
async function parseSmartRecruiters(page, url) {
  let title = "";
  for (const selector of ['[data-qa="job-title"]', "h1"]) {
    const el = await page.$(selector);
    if (el) {
      title = (await el.innerText()).trim();
      if (title) break;
    }
  }

  let location = "";
  for (const selector of ['[data-qa="job-location"]', ".job-location"]) {
    const el = await page.$(selector);
    if (el) {
      location = (await el.innerText()).trim();
      if (location) break;
    }
  }

  let company = "";
  const companyEl = await page.$('[data-qa="company-name"]');
  if (companyEl) company = (await companyEl.innerText()).trim();

  let description = "";
  const descEl = await page.$(".job-sections, .job-description");
  if (descEl) description = (await descEl.innerText()).trim();

  return { title, company, location, description, platform: "SmartRecruiters", url };
}

// LinkedIn Parser
async function parseLinkedIn(page, url) {
  let title = "";
  for (const selector of [".top-card-layout__title", ".topcard__title", "h1"]) {
    const el = await page.$(selector);
    if (el) {
      const text = (await el.innerText()).trim();
      // Ensure we don't extract the search summary context header
      if (text && !text.includes("Jobs in") && !text.includes("jobs in")) {
        title = text;
        break;
      }
    }
  }

  let company = "";
  for (const selector of [".topcard__org-name-link", "[data-tracking-control-name='public_jobs_topcard-org-name']"]) {
    const el = await page.$(selector);
    if (el) {
      company = (await el.innerText()).trim();
      if (company) break;
    }
  }

  let location = "";
  for (const selector of [".topcard__flavor--bullet", "[data-tracking-control-name='public_jobs_topcard-org-location']"]) {
    const el = await page.$(selector);
    if (el) {
      location = (await el.innerText()).trim();
      if (location) break;
    }
  }

  let description = "";
  const descEl = await page.$(".show-more-less-html__markup, .description__text, #job-details");
  if (descEl) description = (await descEl.innerText()).trim();

  return { title, company, location, description, platform: "LinkedIn", url };
}

// Indeed Parser
async function parseIndeed(page, url) {
  let title = "";
  const titleEl = await page.$("h1.jobsearch-JobInfoHeader-title, h1");
  if (titleEl) title = (await titleEl.innerText()).trim();

  let company = "";
  const companyEl = await page.$("div.jobsearch-InlineCompanyRating, [data-company-name='true'], .jobsearch-JobInfoHeader-subtitle");
  if (companyEl) company = (await companyEl.innerText()).split("\n")[0].trim();

  let location = "";
  const locEl = await page.$("div.jobsearch-JobInfoHeader-subtitle > div:last-child, .jobsearch-JobInfoSubtitle");
  if (locEl) location = (await locEl.innerText()).trim();

  let description = "";
  const descEl = await page.$("#jobDescriptionText");
  if (descEl) description = (await descEl.innerText()).trim();

  return { title, company, location, description, platform: "Indeed", url };
}

// SimplyHired Parser
async function parseSimplyHired(page, url) {
  let title = "";
  const titleEl = await page.$("h1, h2");
  if (titleEl) title = (await titleEl.innerText()).trim();

  let company = "";
  const companyEl = await page.$("span[data-byline='true'], .company-name");
  if (companyEl) company = (await companyEl.innerText()).trim();

  let location = "";
  const locEl = await page.$(".job-location, .location");
  if (locEl) location = (await locEl.innerText()).trim();

  let description = "";
  const descEl = await page.$(".job-description, .viewjob-description");
  if (descEl) description = (await descEl.innerText()).trim();

  return { title, company, location, description, platform: "SimplyHired", url };
}

// Naukri Parser
async function parseNaukri(page, url) {
  let title = "";
  const titleEl = await page.$("h1.jd-header-title, h1");
  if (titleEl) title = (await titleEl.innerText()).trim();

  let company = "";
  const companyEl = await page.$("a.jd-header-comp-name, .company-name");
  if (companyEl) company = (await companyEl.innerText()).trim();

  let location = "";
  const locEl = await page.$("span.location, .jd-header-comp-location");
  if (locEl) location = (await locEl.innerText()).trim();

  let description = "";
  const descEl = await page.$("section.job-desc, .job-desc");
  if (descEl) description = (await descEl.innerText()).trim();

  return { title, company, location, description, platform: "Naukri", url };
}

// Generic Parser
async function parseGeneric(page, url) {
  let title = "";
  const titleEl = await page.$("h1");
  if (titleEl) title = (await titleEl.innerText()).trim();
  if (!title) title = await page.title();

  let company = "";
  const metaSite = await page.$("meta[property='og:site_name']");
  if (metaSite) company = await metaSite.getAttribute("content");
  if (!company) {
    const docTitle = await page.title();
    company = docTitle.split(" - ")[0] || "Unknown Company";
  }

  let location = "Not specified";
  let description = "";
  const bodyEl = await page.$("body");
  if (bodyEl) {
    const text = await bodyEl.innerText();
    description = text.trim().substring(0, 1500) + "...";
  }

  return { title, company, location, description, platform: "Generic/Other", url };
}

// Perform DuckDuckGo search using Playwright to bypass headless/scraping bot detection
async function searchDuckDuckGoPlaywright(page, query) {
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  console.log(`Searching DuckDuckGo (Playwright): ${searchUrl}`);
  
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    
    // Check if CAPTCHA anomaly modal is present
    const content = await page.content();
    if (content.includes("anomaly-modal")) {
      console.warn("[Playwright Search] html.duckduckgo.com returned a bot challenge. Falling back to JS-enabled search...");
      const jsSearchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
      await page.goto(jsSearchUrl, { waitUntil: "networkidle", timeout: 25000 });
      
      // Extract from JS page
      const links = await page.evaluate(() => {
        const els = document.querySelectorAll('a[data-testid="result-title-a"], a.result__a');
        return Array.from(els).map(el => el.getAttribute('href'));
      });
      return links;
    }

    const links = await page.evaluate(() => {
      const elements = document.querySelectorAll('a.result__a');
      return Array.from(elements).map(el => el.getAttribute('href'));
    });
    return links;
  } catch (err) {
    console.error("Error occurred during Playwright DuckDuckGo search:", err.message);
    return [];
  }
}

// Core programmatic execution block
export async function runScraper(query) {
  console.log(`Starting job search for: "${query}"`);

  let browser = null;
  let context = null;
  let jobDetails = null;

  try {
    console.log("Launching browser context...");
    browser = await chromium.launch({
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox"
      ]
    });

    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    const page = await context.newPage();

    let selectedUrl = "";
    let selectionReason = "";

    if (query.trim().startsWith("http://") || query.trim().startsWith("https://")) {
      selectedUrl = query.trim();
      selectionReason = "Direct URL execution (bypassed search)";
    } else {
      // Perform the DuckDuckGo search inside the browser
      const rawUrls = await searchDuckDuckGoPlaywright(page, query);
      const urls = rawUrls.map(cleanUrl).filter(url => url && url.startsWith("http"));

      if (urls.length === 0) {
        console.warn("\nWarning: DuckDuckGo search returned no candidate URLs.");
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        return null;
      }

      console.log(`Total candidate URLs found: ${urls.length}`);

      const companyKeywords = getCompanyKeywords(query);
      console.log(`Extracted company keywords for official site matching: [${companyKeywords.join(", ")}]`);

      const rankedUrls = urls.map(url => {
        const lowerUrl = url.toLowerCase();
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
      const selectedItem = rankedUrls[0];
      if (!selectedItem) {
        console.log(`No results matching LinkedIn or official site preferences found for: "${query}". Skipping scraping.`);
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        return null;
      }

      selectedUrl = selectedItem.url;
      selectionReason = selectedItem.reason;
    }

    console.log(`\nSelected URL: ${selectedUrl}`);
    console.log(`Reason:       ${selectionReason}\n`);

    // Block unnecessary resources (images, fonts, media) only for the job description page navigation to save time
    await page.route("**/*", route => {
      const type = route.request().resourceType();
      if (["image", "font", "media"].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    // Navigate to job page with 3 retries
    let success = false;
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Navigating to job page (Attempt ${attempt}/${maxRetries})...`);
        await page.goto(selectedUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        success = true;
        break;
      } catch (err) {
        console.warn(`Attempt ${attempt} failed: ${err.message}`);
        if (attempt < maxRetries) {
          const delay = attempt * 3000;
          console.log(`Waiting ${delay / 1000}s before retrying...`);
          await page.waitForTimeout(delay);
        }
      }
    }

    if (!success) {
      console.log("Warning: Navigation failed or timed out after all retries, attempting to parse loaded state.");
    }

    // Small delay to let JS content settle
    await page.waitForTimeout(2500);

    const htmlContent = await page.content();
    const platform = detectPlatform(selectedUrl, htmlContent);
    console.log(`Detected Platform: ${platform.toUpperCase()}`);

    try {
      switch (platform) {
        case "greenhouse":
          jobDetails = await parseGreenhouse(page, selectedUrl);
          break;
        case "lever":
          jobDetails = await parseLever(page, selectedUrl);
          break;
        case "workday":
          jobDetails = await parseWorkday(page, selectedUrl);
          break;
        case "smartrecruiters":
          jobDetails = await parseSmartRecruiters(page, selectedUrl);
          break;
        case "linkedin":
          jobDetails = await parseLinkedIn(page, selectedUrl);
          break;
        case "indeed":
          jobDetails = await parseIndeed(page, selectedUrl);
          break;
        case "simplyhired":
          jobDetails = await parseSimplyHired(page, selectedUrl);
          break;
        case "naukri":
          jobDetails = await parseNaukri(page, selectedUrl);
          break;
        default:
          jobDetails = await parseGeneric(page, selectedUrl);
          break;
      }
    } catch (parseError) {
      console.error("Error occurred while parsing page. Falling back to generic parser.", parseError);
      jobDetails = await parseGeneric(page, selectedUrl);
    }

    // Limit extracted description text to 4000 characters
    if (jobDetails && jobDetails.description) {
      jobDetails.description = jobDetails.description.trim();
      if (jobDetails.description.length > 4000) {
        jobDetails.description = jobDetails.description.substring(0, 4000) + "\n... (truncated to 4000 characters)";
      }
    }

  } catch (error) {
    console.error("Execution error occurred during Playwright scraping:", error);
  } finally {
    // Proper cleanup of browser resources
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    console.log("Cleanup completed: Browser context closed.");
  }

  return jobDetails;
}

// If run directly from the command line
if (process.argv[1] && (process.argv[1].endsWith("scraper.js") || process.argv[1].endsWith("server.js"))) {
  const query = process.argv.slice(2).join(" ");
  if (query) {
    runScraper(query).then(jobDetails => {
      if (jobDetails) {
        console.log("\n=================== JOB DETAILS ===================");
        console.log(`Title:       ${jobDetails.title}`);
        console.log(`Company:     ${jobDetails.company}`);
        console.log(`Location:    ${jobDetails.location}`);
        console.log(`Platform:    ${jobDetails.platform}`);
        console.log(`URL:         ${jobDetails.url}`);
        console.log("------------------- DESCRIPTION -------------------");
        if (jobDetails.description) {
          console.log(jobDetails.description.substring(0, 500) + (jobDetails.description.length > 500 ? "\n..." : ""));
        }
        console.log("===================================================\n");
        fs.writeFileSync("job-details.json", JSON.stringify(jobDetails, null, 2));
        console.log("Saved job details to: job-details.json");
      }
    }).catch(console.error);
  }
}
