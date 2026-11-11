import pg from "pg";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(process.cwd(), ".env") });

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("[Database] Error: DATABASE_URL is not set in the environment.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Prevent unhandled error events on idle PostgreSQL clients from crashing the server
pool.on('error', (err) => {
  console.warn('[Database Pool Notice] Idle client connection reset/error:', err.message);
});

// Helper function to initialize database tables
export async function initDb() {
  const client = await pool.connect();
  try {
    console.log("[Database] Checking and initializing database schema...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        date DATE DEFAULT CURRENT_DATE,
        company_name VARCHAR(255) NOT NULL,
        position VARCHAR(255),
        company_bio TEXT,
        posted_date VARCHAR(255),
        domain VARCHAR(255),
        linkedin VARCHAR(255),
        score INTEGER DEFAULT 0,
        wikipedia VARCHAR(255),
        message_id VARCHAR(255),
        fit_reason TEXT,
        scraped_url TEXT,
        scraped_description TEXT,
        employees INTEGER,
        company_linkedin_page VARCHAR(255),
        scraped_location VARCHAR(255),
        email VARCHAR(255),
        outreach_msg TEXT,
        is_fit BOOLEAN DEFAULT TRUE,
        owner_email VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_connections (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expiry_date BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        owner_email VARCHAR(255)
      );
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        role VARCHAR(50) DEFAULT 'member',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Schema Migrations (for existing databases)
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS owner_email VARCHAR(255);`);
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS notes TEXT;`);
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`);
    await client.query(`ALTER TABLE email_connections ADD COLUMN IF NOT EXISTS owner_email VARCHAR(255);`);

    // ── High-Performance Indexes for RAG & Core Speed ──
    await client.query(`CREATE INDEX IF NOT EXISTS idx_leads_score_id_desc ON leads (score DESC, id DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_leads_is_fit_score ON leads (is_fit, score DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_leads_created_at_desc ON leads (created_at DESC NULLS LAST);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_leads_company_name_lower ON leads (lower(company_name));`);

    try {
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_leads_fts ON leads USING gin(
          to_tsvector('english', coalesce(company_name, '') || ' ' || coalesce(company_bio, '') || ' ' || coalesce(fit_reason, '') || ' ' || coalesce(scraped_location, ''))
        );
      `);
    } catch (ftsErr) {
      // Non-fatal if GIN index syntax varies
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS outreach_contacts (
        id SERIAL PRIMARY KEY,
        lead_id INTEGER,
        lead_company VARCHAR(255),
        contact_name VARCHAR(255),
        contact_email VARCHAR(255) NOT NULL,
        day0_subject TEXT,
        day0_body TEXT,
        status VARCHAR(50) DEFAULT 'emailed',
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        followup1_sent_at TIMESTAMP,
        followup2_sent_at TIMESTAMP,
        replied_at TIMESTAMP,
        owner_email VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // CRM Core Entities: Accounts, Contacts, Deals
    await client.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        company_name VARCHAR(255) NOT NULL,
        domain VARCHAR(255),
        industry VARCHAR(255),
        employees INTEGER DEFAULT 0,
        company_bio TEXT,
        linkedin VARCHAR(255),
        wikipedia VARCHAR(255),
        owner_email VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        phone VARCHAR(100),
        job_title VARCHAR(255),
        linkedin VARCHAR(255),
        owner_email VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS deals (
        id SERIAL PRIMARY KEY,
        account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
        contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
        lead_id INTEGER,
        title VARCHAR(255) NOT NULL,
        amount NUMERIC(12,2) DEFAULT 0,
        stage VARCHAR(50) DEFAULT 'lead',
        probability INTEGER DEFAULT 20,
        close_date DATE,
        notes TEXT,
        owner_email VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
        contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
        account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
        lead_id INTEGER,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        due_date TIMESTAMP,
        priority VARCHAR(50) DEFAULT 'medium',
        status VARCHAR(50) DEFAULT 'pending',
        owner_email VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS quotations (
        id SERIAL PRIMARY KEY,
        deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
        quotation_number VARCHAR(100) NOT NULL,
        items TEXT NOT NULL,
        subtotal NUMERIC(12,2) DEFAULT 0,
        tax NUMERIC(12,2) DEFAULT 0,
        discount NUMERIC(12,2) DEFAULT 0,
        total_amount NUMERIC(12,2) DEFAULT 0,
        valid_until DATE,
        status VARCHAR(50) DEFAULT 'draft',
        owner_email VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ── Relational Foreign Key & Query Performance Indexes ──
    await client.query(`CREATE INDEX IF NOT EXISTS idx_contacts_account_id ON contacts (account_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_deals_account_id ON deals (account_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals (stage);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks (status, due_date ASC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_outreach_status_sent ON outreach_contacts (status, sent_at DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_quotations_deal_id ON quotations (deal_id);`);

    // Check if users table is empty and seed it from whitelist
    const userCountRes = await client.query(`SELECT COUNT(*) FROM users`);
    if (parseInt(userCountRes.rows[0].count) === 0) {
      console.log("[Database] Users table is empty. Seeding from environment USERS whitelist...");
      const allowedEmails = (process.env.USERS || "vimalraj5207@gmail.com").split(",").map(e => e.trim().toLowerCase());
      for (const email of allowedEmails) {
        if (email) {
          await client.query(
            `INSERT INTO users (email, role) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING`,
            [email, 'leader']
          );
        }
      }
      console.log(`[Database] Seeded ${allowedEmails.length} users into the database.`);
    }
    // Create settings table
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(255) PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Seed settings if not present
    const defaultSettings = {
      allowed_senders: process.env.ALLOWED_SENDERS || "notify-noreply@google.com,jobalerts-noreply@linkedin.com",
      sector_filter: process.env.SECTOR_FILTER || "Manufacturing, Automotive, Aerospace, Pharma, MedTech, Global Capability Centers (GCC)",
      min_employee_count: process.env.MIN_EMPLOYEE_COUNT || "500",
      rd_signals: process.env.RD_SIGNALS || "technology roadmap, R&D strategy, IP analyst, patent portfolio, innovation manager, TRIZ, NPD",
      excluded_sectors: process.env.EXCLUDED_SECTORS || "IT Services (TCS, Infosys, Wipro, etc.), Trading, Startups <5 years, Retail chains, Gig economy, Distributors, Law firms, Consulting firms, IP services, BPO, KPO, recruitment, staffing, outsourcing",
      min_fit_score: process.env.MIN_FIT_SCORE || "50",
      extract_prompt: `You are a specialized Job Listings Intelligence Agent. Extract job listings (full detailed job title, company name, location, and the platform the job is from if mentioned) mentioned in the email body that match the rules:

RULES:
- Extract the FULL, COMPLETE, and DETAILED job title exactly as written in the email (e.g. "Associate Director of Process Innovation" instead of a shortened/simplified "Associate Director"). Do not simplify, truncate, or omit any part of the position name.
- ONLY extract if they are in the sectors: {{SECTOR_FILTER}}.
- MUST have fit signals (e.g. engineering, scientist, researcher, developer, innovation, technology, patent, etc.).
- STRICTLY EXCLUDE:
  * {{EXCLUDED_SECTORS}}
- DISTINGUISH COMPANY FROM LOCATION AND POSITION:
  * A city, state, region, or country name (e.g., "Bengaluru", "Mumbai", "London", "USA", "Thane", "Kolar") must NEVER be extracted as the "company_name". Location names must always go into the "location" field.
  * The "company_name" must be the actual hiring organization or employer.
  * Do not merge the company name into the "position" field. The "position" should only contain the job title.`,

      mistral_extract_prompt: `You are a specialized Job Listings Intelligence Agent. Extract job listings (full detailed job title, company name, location, and the platform the job is from if mentioned) mentioned in the email body that match the rules:

RULES:
- Extract the FULL, COMPLETE, and DETAILED job title exactly as written in the email (e.g. "Associate Director of Process Innovation" instead of a shortened/simplified "Associate Director"). Do not simplify, truncate, or omit any part of the position name.
- ONLY extract if they are in the sectors: {{SECTOR_FILTER}}.
- MUST have fit signals (e.g. engineering, scientist, researcher, developer, innovation, technology, patent, etc.).
- STRICTLY EXCLUDE:
  * {{EXCLUDED_SECTORS}}
- DISTINGUISH COMPANY FROM LOCATION AND POSITION:
  * A city, state, region, or country name (e.g., "Bengaluru", "Mumbai", "London", "USA", "Thane", "Kolar") must NEVER be extracted as the "company_name". Location names must always go into the "location" field.
  * The "company_name" must be the actual hiring organization or employer.
  * Do not merge the company name into the "position" field. The "position" should only contain the job title.`,

      groq_extract_prompt: `You are a specialized Job Listings Intelligence Agent. Extract job listings (full detailed job title, company name, location, and the platform the job is from if mentioned) mentioned in the email body that match the rules:

RULES:
- Extract the FULL, COMPLETE, and DETAILED job title exactly as written in the email (e.g. "Associate Director of Process Innovation" instead of a shortened/simplified "Associate Director"). Do not simplify, truncate, or omit any part of the position name.
- ONLY extract if they are in the sectors: {{SECTOR_FILTER}}.
- MUST have fit signals (e.g. engineering, scientist, researcher, developer, innovation, technology, patent, etc.).
- STRICTLY EXCLUDE:
  * {{EXCLUDED_SECTORS}}
- DISTINGUISH COMPANY FROM LOCATION AND POSITION:
  * A city, state, region, or country name (e.g., "Bengaluru", "Mumbai", "London", "USA", "Thane", "Kolar") must NEVER be extracted as the "company_name". Location names must always go into the "location" field.
  * The "company_name" must be the actual hiring organization or employer.
  * Do not merge the company name into the "position" field. The "position" should only contain the job title.`,

      mistral_evaluate_prompt: `You are a specialized Job Listings Intelligence Agent. Evaluate this job posting and extract lead details:

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
- {{EXCLUDED_SECTORS}}`,

      alert_email_enabled: "true",
      alert_email_recipients: process.env.USERS ? process.env.USERS.split(',')[0].trim() : "vimalraj5207@gmail.com",
      alert_whatsapp_enabled: "true",
      alert_whatsapp_recipients: process.env.GREEN_API_RECIPIENT_PHONE || "918807099288",
      alert_trigger_ingest: "true",
      alert_trigger_replies: "true",
      alert_trigger_followups: "true",
      alert_trigger_errors: "true"
    };

    for (const [key, val] of Object.entries(defaultSettings)) {
      const settingExists = await client.query(`SELECT 1 FROM settings WHERE key = $1`, [key]);
      if (settingExists.rows.length === 0) {
        await client.query(`INSERT INTO settings (key, value) VALUES ($1, $2)`, [key, val]);
      }
    }
    
    console.log("[Database] Database initialized and tables are ready.");
  } catch (err) {
    console.error("[Database] Database initialization failed:", err.message);
    throw err;
  } finally {
    client.release();
  }
}

export default pool;
