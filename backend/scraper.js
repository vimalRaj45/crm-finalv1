import dotenv from "dotenv";
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(process.cwd(), ".env") });

// Ensure Playwright looks for browsers inside the project directory for Render persistence,
// but fall back to the default global cache when running locally if the folder doesn't exist.
const localBrowsersPath = path.resolve(process.cwd(), ".playwright-browsers");
if (fs.existsSync(localBrowsersPath)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowsersPath;
}

// Module-level cache for company employee count and LinkedIn URL lookup
const companyCache = new Map();

function getCacheKey(companyName) {
  if (!companyName) return "";
  return companyName
    .toLowerCase()
    .replace(/[^\w]/g, "")
    .replace(/(privatelimited|limited|ltd|incorporated|inc|corporation|corp|gmbh|co|llc)$/g, "");
}

// Load cached company info from existing databases to prevent hitting LinkedIn repeatedly
function loadCompanyCache() {
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
            const companyName = (item.company || item.company_name || "").trim();
            const employees = typeof item.employees === "number" ? item.employees : parseInt(item.employees) || null;
            const linkedin = item.linkedin || "";
            const key = getCacheKey(companyName);
            if (key && employees !== null) {
              const existing = companyCache.get(key);
              if (!existing || (employees && (!existing.employees || employees > existing.employees))) {
                companyCache.set(key, { employees, linkedin });
              }
            }
          });
        }
      } catch (err) {
        console.warn(`[companyCache] Warning: Could not parse database ${dbFile} for caching:`, err.message);
      }
    }
  }
  if (companyCache.size > 0) {
    console.log(`[companyCache] Loaded ${companyCache.size} unique company details into cache from existing databases.`);
  }
}

// Automatically load the cache when scraper.js is imported
try {
  loadCompanyCache();
} catch (e) {
  console.warn("[companyCache] Initial cache loading failed:", e.message);
}

// List of modern User Agents for browser context rotation
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edge/121.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
];

// Helper to parse employee counts from LinkedIn page text or metadata
function parseLinkedInEmployeeCount(text) {
  if (!text) return null;
  
  // 1. Range pattern: e.g. "5,001-10,000 employees" or "500-1000 employees"
  const rangeMatch = text.match(/(\d+[\d,]*)\s*-\s*(\d+[\d,]*)\s+employees/i) || 
                     text.match(/(\d+[\d,]*)\s*-\s*(\d+[\d,]*)\s+people/i);
  if (rangeMatch && rangeMatch[1]) {
    const low = parseInt(rangeMatch[1].replace(/,/g, ""), 10);
    const high = parseInt(rangeMatch[2].replace(/,/g, ""), 10);
    if (!isNaN(high)) return high;
    if (!isNaN(low)) return low;
  }
  
  // 2. See all pattern: e.g. "See all 12,345 employees"
  const seeAllMatch = text.match(/See all\s+(\d+[\d,]*)\s+employees/i);
  if (seeAllMatch && seeAllMatch[1]) {
    return parseInt(seeAllMatch[1].replace(/,/g, ""), 10);
  }
  
  // 3. Simple count pattern: e.g. "12,345 employees" or "10,001+ employees"
  const simpleMatch = text.match(/(\d+[\d,]*)\+?\s+employees/i) ||
                      text.match(/(\d+[\d,]*)\+?\s+people/i) ||
                      text.match(/(\d+[\d,]*)\+?\s+on LinkedIn/i);
  if (simpleMatch && simpleMatch[1]) {
    return parseInt(simpleMatch[1].replace(/,/g, ""), 10);
  }

  return null;
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
  if (lowercaseUrl.includes("bebee.com")) {
    return "bebee";
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
    .replace(/[^\w\s&]/g, " ")
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
      if (text && !text.includes("Jobs in") && !text.includes("jobs in")) {
        title = text;
        break;
      }
    }
  }

  let company = "";
  let companyLinkedin = "";
  for (const selector of [".topcard__org-name-link", "[data-tracking-control-name='public_jobs_topcard-org-name']"]) {
    const el = await page.$(selector);
    if (el) {
      company = (await el.innerText()).trim();
      try {
        const href = await el.getAttribute("href");
        if (href) {
          let cleanHref = href.split("?")[0].trim();
          if (cleanHref.startsWith("/")) {
            cleanHref = "https://www.linkedin.com" + cleanHref;
          }
          companyLinkedin = cleanHref;
        }
      } catch (e) {
        console.warn("[parseLinkedIn] Could not extract href from company link:", e.message);
      }
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

  if (!company) {
    const docTitle = await page.title().catch(() => "");
    if (docTitle.includes(" | LinkedIn")) {
      const base = docTitle.split(" | LinkedIn")[0];
      company = base.split(":")[0].trim();
    } else if (docTitle.includes(" | ")) {
      company = docTitle.split(" | ")[0].trim();
    } else if (docTitle.includes(" - ")) {
      company = docTitle.split(" - ")[0].trim();
    }
  }

  return { title, company, location, description, platform: "LinkedIn", url, companyLinkedin };
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

// Helper to extract schema.org/JobPosting JSON-LD
async function extractJsonLdJobPosting(page) {
  try {
    const jsonLdTexts = await page.$$eval('script[type="application/ld+json"]', scripts => 
      scripts.map(s => s.textContent)
    );
    
    for (const text of jsonLdTexts) {
      if (!text) continue;
      try {
        const data = JSON.parse(text);
        const schemas = Array.isArray(data) ? data : (data['@graph'] ? data['@graph'] : [data]);
        
        for (const schema of schemas) {
          if (schema && (schema['@type'] === 'JobPosting' || schema['type'] === 'JobPosting')) {
            const title = schema.title || "";
            let company = "";
            if (schema.hiringOrganization) {
              if (typeof schema.hiringOrganization === 'string') {
                company = schema.hiringOrganization;
              } else if (schema.hiringOrganization.name) {
                company = schema.hiringOrganization.name;
              }
            }
            
            let location = "";
            if (schema.jobLocation) {
              if (typeof schema.jobLocation === 'string') {
                location = schema.jobLocation;
              } else if (schema.jobLocation.address) {
                const addr = schema.jobLocation.address;
                if (typeof addr === 'string') {
                  location = addr;
                } else {
                  const parts = [
                    addr.addressLocality,
                    addr.addressRegion,
                    addr.addressCountry
                  ].filter(Boolean);
                  location = parts.join(", ");
                }
              }
            }
            
            let description = schema.description || "";
            description = description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            
            if (title || company) {
              return { title, company, location, description };
            }
          }
        }
      } catch (e) {
        // Ignore single parse error
      }
    }
  } catch (err) {
    console.error("Failed to extract JSON-LD:", err.message);
  }
  return null;
}

// BeBee Parser
async function parseBeBee(page, url) {
  const jsonLd = await extractJsonLdJobPosting(page);
  if (jsonLd) {
    return {
      title: jsonLd.title || "",
      company: jsonLd.company || "",
      location: jsonLd.location || "Not specified",
      description: jsonLd.description || "",
      platform: "BeBee",
      url
    };
  }

  let title = "";
  const titleEl = await page.$("h1");
  if (titleEl) title = (await titleEl.innerText()).trim();
  if (!title) title = await page.title();

  let company = "";
  const companyEl = await page.$(".job-company, .company-name, .company, [itemprop='hiringOrganization']");
  if (companyEl) company = (await companyEl.innerText()).trim();
  if (!company) {
    const metaSite = await page.$("meta[property='og:site_name']");
    if (metaSite) {
      const siteName = await metaSite.getAttribute("content");
      if (siteName && siteName.toLowerCase() !== "bebee") {
        company = siteName;
      }
    }
  }
  if (!company) {
    const docTitle = await page.title();
    company = docTitle.split(" - ")[0] || "Unknown Company";
  }

  let location = "Not specified";
  const locEl = await page.$(".job-location, .location, [itemprop='jobLocation']");
  if (locEl) location = (await locEl.innerText()).trim();

  let description = "";
  const descEl = await page.$(".job-description, .description, #job-description, [itemprop='description']");
  if (descEl) {
    description = (await descEl.innerText()).trim();
  } else {
    const bodyEl = await page.$("body");
    if (bodyEl) {
      const text = await bodyEl.innerText();
      description = text.trim().substring(0, 1500) + "...";
    }
  }

  return { title, company, location, description, platform: "BeBee", url };
}

// Generic Parser
async function parseGeneric(page, url) {
  const jsonLd = await extractJsonLdJobPosting(page);
  if (jsonLd) {
    return {
      title: jsonLd.title || "",
      company: jsonLd.company || "",
      location: jsonLd.location || "Not specified",
      description: jsonLd.description || "",
      platform: "Generic/Other",
      url
    };
  }

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
    const searchDelay = 1000 + Math.random() * 1500;
    await page.waitForTimeout(searchDelay);
    
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    
    const content = await page.content();
    if (content.includes("anomaly-modal")) {
      console.warn("[Playwright Search] html.duckduckgo.com returned a bot challenge. Falling back to JS-enabled search...");
      const jsSearchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
      await page.goto(jsSearchUrl, { waitUntil: "networkidle", timeout: 25000 });
      
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

// Helper to validate if a LinkedIn URL actually belongs to the given company name
function isValidCompanyLinkedinUrl(url, companyName) {
  if (!url || !companyName) return false;
  try {
    const urlObj = new URL(url);
    if (!urlObj.hostname.includes("linkedin.com")) return false;
    if (!urlObj.pathname.startsWith("/company/")) return false;

    const paths = urlObj.pathname.split("/").filter(Boolean);
    if (paths.length < 2 || paths[0] !== "company") return false;

    const originalVanity = paths[1].toLowerCase();
    const vanityClean = originalVanity.replace(/[^\w]/g, "");

    const companyClean = companyName.toLowerCase().replace(/[^\w]/g, "")
      .replace(/(privatelimited|limited|ltd|incorporated|inc|corporation|corp|gmbh|co|llc)$/g, "");

    if (!vanityClean || !companyClean) return false;

    if (vanityClean.includes(companyClean) || companyClean.includes(vanityClean)) {
      return true;
    }

    const vanityAcronym = originalVanity.split(/[-_]+/).map(w => w[0]).filter(Boolean).join("");
    if (vanityAcronym === companyClean) {
      return true;
    }

    const companyWords = companyName.toLowerCase().split(/[^\w]+/).filter(Boolean);
    const companyAcronym = companyWords.map(w => w[0]).filter(Boolean).join("");
    if (companyAcronym === vanityClean || companyAcronym.replace(/(privatelimited|limited|ltd|incorporated|inc|corporation|corp|gmbh|co|llc)$/g, "") === vanityClean) {
      return true;
    }

    if (companyWords.length > 1) {
      const matchAnyWord = companyWords.some(word => {
        const cleanWord = word.replace(/(privatelimited|limited|ltd|incorporated|inc|corporation|corp|gmbh|co|llc)$/g, "");
        return cleanWord.length >= 3 && (vanityClean === cleanWord || vanityClean.includes(cleanWord));
      });
      if (matchAnyWord) return true;
    }

    console.log(`[LinkedIn Validation] Mismatch: "${originalVanity}" does not match company "${companyName}"`);
    return false;
  } catch (e) {
    return false;
  }
}

// Search Google via Serper API
async function searchCompanyLinkedin(companyName, page) {
  const apiKey = process.env.SERPER_API_KEY;
  const query = `${companyName} linkedin`;
  
  console.log(`[LinkedIn Filter] Querying LinkedIn company page via Serper: "${query}"`);
  if (apiKey) {
    try {
      const searchUrl = `https://google.serper.dev/search?q=${encodeURIComponent(query)}&apiKey=${apiKey}`;
      const res = await fetch(searchUrl);
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.organic)) {
          const links = data.organic.map(item => item.link).filter(Boolean);
          const linkedinLink = links.find(u => isValidCompanyLinkedinUrl(u, companyName));
          if (linkedinLink) {
            return linkedinLink;
          }
        }
      }
    } catch (err) {
      console.warn("[Scraper] Serper search for LinkedIn company page failed:", err.message);
    }
  }
  return null;
}

// Fallback helper to search and scrape a company's LinkedIn page details and employee count
export async function scrapeCompanyLinkedinDetails(companyName) {
  if (!companyName || companyName === "Unknown Company") return null;

  console.log(`[LinkedIn Filter] [Fallback Search] Attempting fallback LinkedIn lookup for company: "${companyName}"`);
  const cacheKey = getCacheKey(companyName);
  const cachedEntry = companyCache.get(cacheKey);
  if (cachedEntry && cachedEntry.employees !== null) {
    console.log(`[LinkedIn Filter] [Cache Hit] Found cached employee details for "${companyName}": ${cachedEntry.employees} employees.`);
    return { employees: cachedEntry.employees, linkedin: cachedEntry.linkedin };
  }

  let browser = null;
  let context = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox"
      ]
    });
    const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    context = await browser.newContext({ userAgent: randomUserAgent });
    const page = await context.newPage();

    await page.route("**/*", route => {
      const type = route.request().resourceType();
      if (["image", "font", "media"].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    const companyLinkedinUrl = await searchCompanyLinkedin(companyName, page);
    if (companyLinkedinUrl) {
      console.log(`[LinkedIn Filter] [Fallback Search] Found LinkedIn company page: ${companyLinkedinUrl}. Navigating...`);
      await page.waitForTimeout(1000 + Math.random() * 1000);
      await page.goto(companyLinkedinUrl, { referer: "https://www.google.com/", waitUntil: "domcontentloaded", timeout: 25000 });

      const metaDescEl = await page.$("meta[name='description']");
      let metaDesc = "";
      if (metaDescEl) {
        metaDesc = await metaDescEl.getAttribute("content");
      }
      const bodyText = await page.innerText("body");
      const employees = parseLinkedInEmployeeCount(metaDesc) || parseLinkedInEmployeeCount(bodyText);
      console.log(`[LinkedIn Filter] [Fallback Search] Extracted employee count: ${employees}`);

      if (employees !== null) {
        companyCache.set(cacheKey, { employees, linkedin: companyLinkedinUrl });
        return { employees, linkedin: companyLinkedinUrl };
      }
    }
  } catch (err) {
    console.warn(`[LinkedIn Filter] [Fallback Search] Fallback LinkedIn lookup failed for "${companyName}":`, err.message);
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
  return null;
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

    const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const viewportWidth = 1200 + Math.floor(Math.random() * 240);
    const viewportHeight = 800 + Math.floor(Math.random() * 100);
    
    console.log(`Creating browser context (User-Agent: ${randomUserAgent.substring(0, 40)}..., Viewport: ${viewportWidth}x${viewportHeight})`);

    context = await browser.newContext({
      userAgent: randomUserAgent,
      viewport: { width: viewportWidth, height: viewportHeight },
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9,en-GB;q=0.8"
      }
    });

    const page = await context.newPage();

    let selectedUrl = "";
    let selectionReason = "";

    if (query.trim().startsWith("http://") || query.trim().startsWith("https://")) {
      selectedUrl = query.trim();
      selectionReason = "Direct URL execution (bypassed search)";
    } else {
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
        else if (lowerUrl.includes("naukri.com")) {
          const isNaukriJob = lowerUrl.includes("/job-listings-") || lowerUrl.includes("/job/");
          if (isNaukriJob) {
            score = 9;
            reason = "Preference 1: Naukri Job Posting";
          } else {
            return { url, score: 0, reason: "Excluded: Non-job Naukri URL" };
          }
        }
        else if (lowerUrl.includes("indeed.com") || lowerUrl.includes("indeed.co.in")) {
          const isIndeedJob = lowerUrl.includes("/viewjob") || lowerUrl.includes("/rc/clk") || lowerUrl.includes("/job/");
          if (isIndeedJob) {
            score = 8;
            reason = "Preference 1: Indeed Job Posting";
          } else {
            return { url, score: 0, reason: "Excluded: Non-job Indeed URL" };
          }
        }
        else if (lowerUrl.includes("simplyhired.com")) {
          const isSimplyHiredJob = lowerUrl.includes("/job/") || lowerUrl.includes("/view/");
          if (isSimplyHiredJob) {
            score = 7;
            reason = "Preference 1: SimplyHired Job Posting";
          } else {
            return { url, score: 0, reason: "Excluded: Non-job SimplyHired URL" };
          }
        }
        else if (lowerUrl.includes("bebee.com")) {
          score = 6;
          reason = "Preference 1: BeBee Job Posting";
        }

        return { url, score, reason };
      }).filter(item => item.score > 0);

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

    await page.route("**/*", route => {
      const type = route.request().resourceType();
      if (["image", "font", "media"].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    let success = false;
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const navDelay = 1500 + Math.random() * 2000;
        console.log(`Waiting ${Math.round(navDelay) / 1000}s before page navigation...`);
        await page.waitForTimeout(navDelay);

        console.log(`Navigating to job page (Attempt ${attempt}/${maxRetries})...`);
        await page.goto(selectedUrl, { 
          referer: "https://www.google.com/",
          waitUntil: "domcontentloaded", 
          timeout: 30000 
        });
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

    await page.waitForTimeout(2500);

    const pageText = await page.innerText("body").catch(() => "");
    const closedPatterns = [
      /no longer accepting applications/i,
      /this job is closed/i,
      /this position is closed/i,
      /job posting has expired/i
    ];
    if (closedPatterns.some(pattern => pattern.test(pageText))) {
      console.warn(`[Scraper] Job page at ${selectedUrl} indicates the job is closed or no longer accepting applications. Proceeding anyway as requested.`);
    }

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
        case "bebee":
          jobDetails = await parseBeBee(page, selectedUrl);
          break;
        default:
          jobDetails = await parseGeneric(page, selectedUrl);
          break;
      }
    } catch (parseError) {
      console.error("Error occurred while parsing page. Falling back to generic parser.", parseError);
      jobDetails = await parseGeneric(page, selectedUrl);
    }

    if (jobDetails && jobDetails.description) {
      jobDetails.description = jobDetails.description.trim();
    }

    let employees = null;
    let cachedLinkedinUrl = "";
    let companyLinkedinUrl = "";
    if (jobDetails && jobDetails.company && jobDetails.company !== "Unknown Company") {
      const companyName = jobDetails.company;
      const cacheKey = getCacheKey(companyName);
      const cachedEntry = companyCache.get(cacheKey);

      companyLinkedinUrl = jobDetails.companyLinkedin || "";

      if (cachedEntry && cachedEntry.employees !== null) {
        console.log(`[LinkedIn Filter] [Cache Hit] Using cached employee details for "${companyName}": ${cachedEntry.employees} employees.`);
        employees = cachedEntry.employees;
        cachedLinkedinUrl = cachedEntry.linkedin;
        companyLinkedinUrl = cachedEntry.linkedin || companyLinkedinUrl;
      } else {
        if (!companyLinkedinUrl) {
          console.log(`[LinkedIn Filter] Searching for LinkedIn company page for "${companyName}"...`);
          try {
            const delayMs = 2000 + Math.random() * 2000;
            await page.waitForTimeout(delayMs);

            companyLinkedinUrl = await searchCompanyLinkedin(companyName, page);
          } catch (searchErr) {
            console.warn(`[LinkedIn Filter] Company page search failed:`, searchErr.message);
          }
        }
        
        if (companyLinkedinUrl) {
          console.log(`[LinkedIn Filter] Found company page: ${companyLinkedinUrl}. Navigating to extract employee count...`);
          try {
            await page.waitForTimeout(1500 + Math.random() * 1500);

            await page.goto(companyLinkedinUrl, { referer: "https://www.google.com/", waitUntil: "domcontentloaded", timeout: 25000 });
            
            const metaDescEl = await page.$("meta[name='description']");
            let metaDesc = "";
            if (metaDescEl) {
              metaDesc = await metaDescEl.getAttribute("content");
              console.log(`[LinkedIn Filter] Meta Description: "${metaDesc}"`);
            }
            
            const bodyText = await page.innerText("body");
            
            employees = parseLinkedInEmployeeCount(metaDesc) || parseLinkedInEmployeeCount(bodyText);
            console.log(`[LinkedIn Filter] Extracted employee count: ${employees}`);

            if (employees !== null) {
              companyCache.set(cacheKey, { employees, linkedin: companyLinkedinUrl });
            }
          } catch (err) {
            console.warn(`[LinkedIn Filter] Failed to scrape LinkedIn company employees:`, err.message);
          }
        } else {
          console.log(`[LinkedIn Filter] No LinkedIn company page found for "${companyName}".`);
        }
      }
    }
    
    if (jobDetails) {
      jobDetails.employees = employees;
      jobDetails.company_linkedin_page = companyLinkedinUrl || cachedLinkedinUrl || "";
    }

  } catch (error) {
    console.error("Execution error occurred during Playwright scraping:", error);
  } finally {
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
