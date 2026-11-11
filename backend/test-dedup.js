import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Normalization function used in email-ingest.js
function getJobStringKey(company, position) {
  if (!company || !position) return "";
  const c = company.toLowerCase().replace(/[^a-z0-9]/g, "");
  const p = position.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${c}|${p}`;
}

console.log("==================================================");
console.log("DEMONSTRATION: Company + Position Deduplication");
console.log("==================================================\n");

// 1. Define sample database items (simulating jobs-db.json or job.json)
const mockDatabase = [
  {
    company: "Tata Electronics",
    position: "IP & Patent Manager",
    url: "https://www.linkedin.com/jobs/view/12345"
  },
  {
    company: "UPL",
    position: "Patent Analyst_IPD",
    url: "https://www.linkedin.com/jobs/view/67890"
  }
];

console.log("--- MOCK DATABASE ---");
mockDatabase.forEach(item => {
  console.log(`- Company: "${item.company}", Position: "${item.position}"`);
});
console.log("");

// 2. Populate the duplicate prevention set (using same logic as email-ingest.js)
const existingJobsSet = new Set();
mockDatabase.forEach(item => {
  const key = getJobStringKey(item.company || item.company_name, item.position);
  existingJobsSet.add(key);
});

console.log("--- GENERATED DEDUPLICATION KEYS ---");
existingJobsSet.forEach(key => {
  console.log(`Normalized Key: "${key}"`);
});
console.log("");

// 3. Test Cases (Candidates extracted from Stage 1 Groq API)
const candidates = [
  // Exact duplicate
  {
    company_name: "Tata Electronics",
    position: "IP & Patent Manager"
  },
  // Case/spacing variation (should still match)
  {
    company_name: "  TATA ELECTRONICS  ",
    position: "ip & patent manager"
  },
  // Punctuation variation (should still match)
  {
    company_name: "U.P.L.",
    position: "Patent Analyst IPD"
  },
  // New listing (should proceed)
  {
    company_name: "ARTEMIS LAW ASSOCIATES",
    position: "PATENT Associate"
  }
];

console.log("--- TESTING EXTRACTED CANDIDATES ---");
candidates.forEach((job, idx) => {
  const jobStringKey = getJobStringKey(job.company_name, job.position);
  console.log(`[Candidate #${idx + 1}] Checking: Company: "${job.company_name}", Position: "${job.position}"`);
  console.log(`  Normalized Key: "${jobStringKey}"`);
  
  if (existingJobsSet.has(jobStringKey)) {
    console.log(`  \x1b[31m[Duplicate Job] Job "${job.position}" at "${job.company_name}" has already been processed. Skipping.\x1b[0m\n`);
  } else {
    console.log(`  \x1b[32m[New Job] Job "${job.position}" at "${job.company_name}" is new. Proceeding to search/scrapers.\x1b[0m\n`);
  }
});

console.log("==================================================");
console.log("Demonstration complete.");
console.log("==================================================");
