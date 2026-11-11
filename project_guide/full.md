# 🚀 Salesforge AI Lead Intelligence & CRM Portal: Complete System Documentation

Welcome to the comprehensive technical documentation for the **Salesforge AI Lead Intelligence & CRM Portal**. This document details the entire architectural blueprint, backend services, AI qualification pipelines, web scraping engines, database schema, cold outreach automation, CRM core entities, API specifications, and deployment workflows.

---

## Table of Contents
1. [Executive Summary & High-Level Architecture](#1-executive-summary--high-level-architecture)
2. [End-to-End Architectural Diagrams](#2-end-to-end-architectural-diagrams)
3. [Technology Stack & Core Components](#3-technology-stack--core-components)
4. [Database Schema & PostgreSQL Data Models](#4-database-schema--postgresql-data-models)
5. [The 7-Stage AI Lead Ingestion & Qualification Pipeline](#5-the-7-stage-ai-lead-ingestion--qualification-pipeline)
6. [Cold Outreach & Automated Drip Sequence Engine](#6-cold-outreach--automated-drip-sequence-engine)
7. [Full CRM Operations Suite](#7-full-crm-operations-suite)
8. [Role-Based Access Control (RBAC) & Team Management](#8-role-based-access-control-rbac--team-management)
9. [Automated Cron Jobs & Background Schedulers](#9-automated-cron-jobs--background-schedulers)
10. [Comprehensive REST API Reference](#10-comprehensive-rest-api-reference)
11. [Frontend Interface Architecture & User Experience](#11-frontend-interface-architecture--user-experience)
12. [Environment Variables & System Configuration (.env)](#12-environment-variables--system-configuration-env)
13. [Installation, Local Setup & Production Deployment Guide](#13-installation-local-setup--production-deployment-guide)

---

## 1. Executive Summary & High-Level Architecture

The **Salesforge AI Lead Intelligence & CRM Portal** is an enterprise-grade autonomous prospecting, intelligence extraction, cold outreach, and CRM pipeline. It bridges the gap between raw job notification emails and structured, revenue-generating enterprise sales operations.

### Core Capabilities:
- **Autonomous Lead Ingestion**: Monitors connected Gmail accounts via IMAP and Google OAuth2 Gmail API, extracting job postings from authorized job alert senders.
- **Dual-Stage Mistral AI Intelligence**: Uses **Mistral Small (`mistral-small-latest`)** for ultra-fast, high-accuracy entity extraction from unstructured emails, and **Mistral Large (`mistral-large-latest`)** for in-depth job description evaluation, fit scoring (0–100), and personalized cold outreach messaging.
- **Stealth Headless Web Scraping**: Leverages **Playwright Chromium** with user-agent rotation, randomized viewport fingerprinting, and jitter delays to extract live job descriptions from LinkedIn, Naukri, Indeed, SimplyHired, and BeBee.
- **Automated Drip Outreach Engine**: Manages multi-step automated email outreach sequences (Day 0 initial pitch $\rightarrow$ Day 3 follow-up $\rightarrow$ Day 7 final note $\rightarrow$ Day 14 auto-archive).
- **Active Reply Detection & Multi-Channel Alerts**: Continuously monitors connected Gmail inboxes for prospect responses, instantly updating lead statuses and dispatching alerts via **Brevo Email** and **Green-API WhatsApp**.
- **Complete CRM Suite**: 1-click lead conversion into **Accounts**, **Contacts**, **Deals** (Kanban Board), **Tasks**, and commercial **Quotations** with automated client proposal generation.
- **Modern Responsive Glassmorphic UI**: High-performance single-page web app built with Vanilla JavaScript and modern CSS tokens with live real-time server log streaming via **Server-Sent Events (SSE)**.

---

## 2. End-to-End Architectural Diagrams

### 2.1 Lead Ingestion & AI Intelligence Flow

```mermaid
flowchart TD
    subgraph Email_Sources["1. Ingestion Sources"]
        A1[Gmail Inbox via IMAP] 
        A2[Gmail API via OAuth2 Token]
    end

    subgraph Extraction["2. Entity Extraction & Discovery"]
        B[email-ingest.js: Fetch Unread Emails]
        C[Mistral Small LLM: mistral-small-latest]
        D[Google Serper.dev Search API]
    end

    subgraph Scraping_AI["3. Scraping & AI Qualification"]
        E[scraper.js: Deduplication & Cache Check]
        F[Playwright Headless Chromium]
        G[Mistral AI Large Evaluation Engine]
    end

    subgraph Persistence["4. Storage & Multi-Platform Sync"]
        H[(PostgreSQL Database)]
        I[Google Sheets API Sync]
        J[Real-Time SSE Server Stream]
    end

    subgraph CRM_Portal["5. Sales Dashboard & Outreach"]
        K[Salesforge CRM Web App]
        L[Multi-step Outreach Engine]
        M[Accounts / Deals / Quotes Engine]
    end

    A1 --> B
    A2 --> B
    B -->|Cleaned Email Content| C
    C -->|Extracted Job Title & Company| D
    D -->|Job Post URL Selection| E
    E -->|Anti-fingerprint Headless Browser| F
    F -->|Raw JD & Company Data| G
    G -->|Fit Score, Bio, Outreach Message| H
    G -->|Append Row| I
    B -->|Stream Live Progress| J
    J --> K
    H --> K
    K --> L
    K --> M
```

### 2.2 Cold Outreach Sequence & Reply Detection Lifecycle

```mermaid
sequenceDiagram
    autonumber
    actor User as Sales Rep / Automated Cron
    participant API as Express Server (/api/outreach)
    participant Gmail as Gmail OAuth2 / Brevo API
    participant DB as PostgreSQL (outreach_contacts)
    participant Prospect as Prospect Inbox
    participant Cron as Reply Detector Cron
    participant WA as Green-API WhatsApp

    User->>API: Send Day 0 Outreach Email
    API->>Gmail: Dispatch Email via Gmail API
    Gmail->>Prospect: Deliver Personalized Pitch
    API->>DB: Insert record (status: 'emailed', sent_at: NOW)
    
    opt No reply in 3 Days
        Cron->>API: Trigger runFollowUpJob()
        API->>Gmail: Send Follow-Up #1 (Re: subject)
        API->>DB: Update status to 'followed_up_1'
    end

    opt No reply in 7 Days
        Cron->>API: Trigger runFollowUpJob()
        API->>Gmail: Send Final Follow-Up #2
        API->>DB: Update status to 'followed_up_2'
    end

    Prospect->>Gmail: Replies to Outreach Email
    Cron->>API: Trigger processReplyDetection()
    API->>Gmail: Scan user messages (from: prospect_email)
    API->>DB: Update status to 'replied', replied_at = NOW
    API->>User: Dispatch Alert Email via Brevo
    API->>WA: Push WhatsApp Notification via Green-API
```

---

## 3. Technology Stack & Core Components

| Component Layer | Technology / Service | Role & Responsibility |
| :--- | :--- | :--- |
| **Runtime Environment** | Node.js (ES Modules `import/export`) | Server-side runtime running asynchronous tasks and child processes |
| **Backend Framework** | Express.js v5 | RESTful API server, static asset server, and SSE log broadcaster |
| **Database** | PostgreSQL (`pg` pool) | Relational store for leads, accounts, contacts, deals, tasks, quotations, and RBAC |
| **LLM Reasoning & Extraction** | Mistral AI API (`mistral-small-latest`) | Ultra-fast token parsing from unstructured raw job email alerts |
| **LLM Deep Evaluation** | Mistral AI API (`mistral-large-latest`) | Fit scoring (0–100), ICP validation, company overview synthesis, and tailored outreach |
| **Search Engine API** | Google Serper.dev API | Organic SERP retrieval for precise job posting URLs without search CAPTCHAs |
| **Web Scraping Engine** | Playwright Chromium | Stealth headless browser automation for extracting full JD text and company sizes |
| **Email Protocol & API** | `imapflow`, `googleapis` (Gmail v1), Brevo | IMAP monitoring, OAuth2 Gmail direct sending/scanning, and Brevo SMTP notifications |
| **WhatsApp Notifications** | Green-API | Instant mobile WhatsApp push alerts upon lead ingest completion and prospect replies |
| **Job Scheduling** | `node-cron` | Configurable background cron triggers for ingestion, drip follow-ups, and inbox scans |
| **Frontend Architecture** | HTML5, Vanilla JavaScript, CSS3 Design Tokens | High-aesthetic glassmorphic single-page dashboard with zero heavy bundle overhead |
| **Cloud Spreadsheets** | Google Sheets API v4 (Service Account JWT) | Automated mirrored spreadsheet sync for executive reporting and secondary backups |

---

## 4. Database Schema & PostgreSQL Data Models

The system automatically verifies and creates all necessary tables and columns on startup (`backend/db.js`).

```mermaid
erDiagram
    USERS ||--o{ EMAIL_CONNECTIONS : owns
    USERS ||--o{ LEADS : owns
    USERS ||--o{ ACCOUNTS : owns
    USERS ||--o{ CONTACTS : owns
    USERS ||--o{ DEALS : owns
    USERS ||--o{ TASKS : owns
    USERS ||--o{ QUOTATIONS : owns
    USERS ||--o{ OUTREACH_CONTACTS : manages

    ACCOUNTS ||--o{ CONTACTS : contains
    ACCOUNTS ||--o{ DEALS : has
    ACCOUNTS ||--o{ TASKS : associated
    CONTACTS ||--o{ DEALS : primary_contact
    CONTACTS ||--o{ TASKS : assigned
    DEALS ||--o{ TASKS : requires
    DEALS ||--o{ QUOTATIONS : generates
    LEADS ||--o| ACCOUNTS : converts_to
    LEADS ||--o| DEALS : generates
```

### Table Definitions:

#### 1. `leads`
Stores all parsed and AI-evaluated job postings.
```sql
CREATE TABLE leads (
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
    notes TEXT
);
```

#### 2. `email_connections`
Maintains Google OAuth2 tokens per user for automatic mailbox ingestion and cold email sending.
```sql
CREATE TABLE email_connections (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expiry_date BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    owner_email VARCHAR(255)
);
```

#### 3. `users`
Defines role-based access for leaders and members.
```sql
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    role VARCHAR(50) DEFAULT 'member', -- 'leader' | 'member'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### 4. `settings`
Dynamic runtime configuration key-value pairs manageable directly from the leader dashboard.
```sql
CREATE TABLE settings (
    key VARCHAR(255) PRIMARY KEY,
    value TEXT NOT NULL
);
```
*Keys stored include:* `allowed_senders`, `sector_filter`, `min_employee_count`, `rd_signals`, `excluded_sectors`, `min_fit_score`, `extract_prompt` / `mistral_extract_prompt`, `mistral_evaluate_prompt`.

#### 5. `outreach_contacts`
Tracks cold email outreach lifecycles and follow-up drip schedules.
```sql
CREATE TABLE outreach_contacts (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER,
    lead_company VARCHAR(255),
    contact_name VARCHAR(255),
    contact_email VARCHAR(255) NOT NULL,
    day0_subject TEXT,
    day0_body TEXT,
    status VARCHAR(50) DEFAULT 'emailed', -- 'emailed' | 'followed_up_1' | 'followed_up_2' | 'replied' | 'no_response'
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    followup1_sent_at TIMESTAMP,
    followup2_sent_at TIMESTAMP,
    replied_at TIMESTAMP,
    owner_email VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### 6. `accounts`
CRM organization records.
```sql
CREATE TABLE accounts (
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
```

#### 7. `contacts`
Individual buyer personas and hiring decision-makers.
```sql
CREATE TABLE contacts (
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
```

#### 8. `deals`
Sales pipeline revenue opportunities.
```sql
CREATE TABLE deals (
    id SERIAL PRIMARY KEY,
    account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    lead_id INTEGER,
    title VARCHAR(255) NOT NULL,
    amount NUMERIC(12,2) DEFAULT 0,
    stage VARCHAR(50) DEFAULT 'lead', -- 'lead' | 'contacted' | 'quotation' | 'negotiation' | 'won' | 'lost'
    probability INTEGER DEFAULT 20,
    close_date DATE,
    notes TEXT,
    owner_email VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### 9. `tasks`
Sales reminders and follow-up task tracking.
```sql
CREATE TABLE tasks (
    id SERIAL PRIMARY KEY,
    deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
    account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    lead_id INTEGER,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    due_date TIMESTAMP,
    priority VARCHAR(50) DEFAULT 'medium', -- 'low' | 'medium' | 'high'
    status VARCHAR(50) DEFAULT 'pending', -- 'pending' | 'completed'
    owner_email VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### 10. `quotations`
Commercial pricing proposals and quote generation.
```sql
CREATE TABLE quotations (
    id SERIAL PRIMARY KEY,
    deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
    quotation_number VARCHAR(100) NOT NULL,
    items TEXT NOT NULL, -- JSON array of items: [{description, quantity, unit_price}]
    subtotal NUMERIC(12,2) DEFAULT 0,
    tax NUMERIC(12,2) DEFAULT 0,
    discount NUMERIC(12,2) DEFAULT 0,
    total_amount NUMERIC(12,2) DEFAULT 0,
    valid_until DATE,
    status VARCHAR(50) DEFAULT 'draft', -- 'draft' | 'sent' | 'accepted' | 'declined'
    owner_email VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 5. The 7-Stage AI Lead Ingestion & Qualification Pipeline

Located in `backend/email-ingest.js` and `backend/scraper.js`.

```
[ Gmail Inbox ] ──► [ 1. IMAP/OAuth Ingest ] ──► [ 2. Mistral Small Extraction ] ──► [ 3. Serper Search ]
                                                                                   │
[ PostgreSQL / Sheet ] ◄── [ 6. Mistral AI Qualify ] ◄── [ 5. Playwright Scraping ] ◄── [ 4. Deduplication ]
```

### Stage 1: Mailbox Polling & Sender Whitelisting
- Connects to Gmail via IMAP or checks connected Google OAuth2 inboxes.
- Filters messages matching target date ranges (default: last 24h, unread).
- Validates sender against the dynamic whitelist in `settings` (e.g. `notify-noreply@google.com`, `jobalerts-noreply@linkedin.com`).

### Stage 2: Mistral Small Fast Entity Extraction
- Email HTML is stripped, sanitized, and fed into **Mistral's `mistral-small-latest`** model.
- Dynamic system prompts from the `settings` table instruct the model to extract:
  - Full exact job position title.
  - Company name (strictly filtered against sector rules and exclusions).
  - Geographic location.

### Stage 3: Google Serper Organic Search Resolution
- Formulates a targeted search query: `"[Company]" "[Job Title]" hiring`.
- Queries the Google Serper.dev API to obtain direct search engine results without encountering bot challenges.
- Filters candidate URLs against verified job board URL patterns (LinkedIn `/jobs/view/`, Naukri `/job-listings-`, Indeed `/viewjob`, SimplyHired `/job/`, BeBee).

### Stage 4: Unique Deduplication & Company Cache
- Normalizes URLs (extracts LinkedIn job IDs or strips UTM/tracking params).
- Compares against existing database keys to skip previously scraped positions immediately.
- Queries the in-memory `companyCache` (populated from existing databases) to reuse known employee counts and LinkedIn vanity URLs without triggering redundant lookups.

### Stage 5: Playwright Stealth Browser Scraping
- Launches Playwright Chromium with browser rotation techniques:
  - Random modern desktop User-Agents.
  - Randomized screen viewports.
  - Jitter delay timers (1.5s to 3.5s) between navigations.
- Navigates to the posting page and extracts:
  - Full job description text.
  - Verification that the role is currently open and accepting applications.
  - Company employee headcount from LinkedIn company profiles.

### Stage 6: Mistral AI Large Deep Evaluation
- The full job description, company overview, and employee counts are sent to **Mistral Large**.
- Mistral evaluates the lead against the Ideal Customer Profile (ICP) rules:
  1. **Fit Score**: Computed from 0 to 100 based on sector alignment and R&D signals.
  2. **Minimum Headcount**: Ensures the organization meets threshold criteria (e.g. $\ge 500$ employees).
  3. **Role Summary & Company Bio**: Synthesizes 1–2 sentence executive briefs.
  4. **Decision Maker Link**: Constructs `linkedin.com/company/[vanity-name]/people/` URL.
  5. **Outreach Message**: Automatically crafts a bespoke, highly personalized sales outreach message.

### Stage 7: Persistence & Multi-Channel Broadcast
- Inserts qualified lead record into PostgreSQL with `is_fit = true` (or `false` if below score threshold).
- Appends qualified rows to the configured **Google Sheet** (12-column standardized schema).
- Streams live progress telemetry to all connected web clients via **SSE**.
- Dispatches a summary notification via **Green-API WhatsApp**.

---

## 6. Cold Outreach & Automated Drip Sequence Engine

The cold outreach engine automates multi-stage email communications directly from the user's connected Gmail account:

### Drip Sequence Timeline:
1. **Day 0 (Initial Pitch)**: Sent via `/api/outreach`. Uses AI-generated or custom copy. Creates an `outreach_contacts` record with status `emailed` and auto-advances any associated Deal to the `contacted` stage.
2. **Day 3 (Follow-up #1)**: Auto-dispatched by the background cron if no reply has been received after 3 days. Sets status to `followed_up_1`.
3. **Day 7 (Final Follow-up #2)**: Polished closing note sent if no reply after 7 days. Sets status to `followed_up_2`.
4. **Day 14 (Auto-Archive)**: Marks unresponsive campaigns as `no_response`.

### Dual-Channel Sending Strategy:
- **Primary**: Direct Google Gmail API (`gmail.users.messages.send`) using the user's authorized OAuth2 token with automatic token refresh.
- **Fallback**: **Brevo SMTP API** (`https://api.brevo.com/v3/smtp/email`) if Gmail is not connected or requires re-authorization.

### Automated Reply Detection Scanner:
- Cron job runs every 1 hour (configurable in Scheduler settings).
- Scans user inbox using `from:prospect_email` queries.
- When an inbound message is detected with a timestamp after the outreach send date:
  1. Updates contact status to `replied`.
  2. Logs reply timestamp.
  3. Sends instant email alert to the lead owner.
  4. Sends mobile alert to team leader via WhatsApp.

---

## 7. Full CRM Operations Suite

The portal includes a full CRM workspace to turn qualified leads into enterprise revenue:

```
[ Qualified Lead ] ──► [ 1-Click Convert ] ──► [ Account & Contact Created ]
                                                         │
[ Deal Closed ] ◄── [ Quotation Sent ] ◄── [ Deal Board (Kanban) ]
```

### 1. Lead-to-CRM 1-Click Conversion (`/api/leads/:id/convert`)
- Converts any qualified lead directly into an **Account**, **Contact**, **Deal** (initial value: $15,000), and an automatic **Follow-up Task** in a single ACID transaction.

### 2. Accounts & Contacts Directory
- View and manage corporate accounts and linked contacts with company bios, employee size, LinkedIn links, and aggregate revenue metrics.

### 3. Deals Kanban Pipeline (`/api/deals`)
- Visual drag-and-drop / stage-switching pipeline:
  - `lead` (30% probability)
  - `contacted` (40% probability)
  - `quotation` (60% probability)
  - `negotiation` (80% probability)
  - `won` (100% probability)
  - `lost` (0% probability)
- Real-time pipeline metrics: Total Pipeline Value, Won Revenue, Lost Revenue, Win Rate percentage.

### 4. Tasks & Reminders (`/api/tasks`)
- Priority-ranked tasks (`low`, `medium`, `high`) linked directly to deals, accounts, and contacts with due date filters.

### 5. Commercial Quotation Generator (`/api/quotations`)
- Create formal commercial proposals with itemized line items, quantities, unit prices, taxes, and discounts.
- 1-Click **"Send Proposal via Email"** generates a branded HTML proposal and emails it to the client contact, auto-advancing the deal stage to `quotation`.

---

## 8. Role-Based Access Control (RBAC) & Team Management

The system enforces strict permission boundaries between **Leaders** and **Members**:

| Feature / Action | Team Leader (`leader`) | Team Member (`member`) |
| :--- | :---: | :---: |
| **View Leads, Accounts, Deals & Tasks** | ✅ All Data / Multi-user Filter | ✅ Own Records Only |
| **Trigger Lead Ingestion Pipeline** | ✅ Allowed | ✅ Allowed |
| **Perform Cold Email Outreach** | ✅ Allowed | ✅ Allowed |
| **Manage CRM Entities & Quotations** | ✅ Allowed | ✅ Allowed |
| **Configure Cron & Scheduler Settings** | ✅ Allowed | ❌ Read-Only |
| **Edit AI Prompts & Ingestion Rules** | ✅ Allowed | ❌ Forbidden |
| **Invite / Revoke Team Members** | ✅ Allowed | ❌ Forbidden |
| **Dispatch Test Sample Alert Emails** | ✅ Allowed | ❌ Forbidden |

### Team Invitation Flow:
1. Leader inputs a member's email address in the **Team Access** sidebar.
2. System inserts user into PostgreSQL with role `member`.
3. Automated transactional invitation email is dispatched via **Brevo** with login instructions.
4. Member logs in using their Google account via OAuth2 Single Sign-On.

---

## 9. Automated Cron Jobs & Background Schedulers

Controlled via `cron-config.json` and configurable in the **Cron Settings** dashboard:

```json
{
  "enabled": true,
  "cronExpression": "0 9 * * *",
  "time": "09:00",
  "followUpEnabled": true,
  "followUpInterval": "2h",
  "followUpCronExpression": "0 */2 * * *",
  "replyEnabled": true,
  "replyInterval": "1h",
  "replyCronExpression": "0 * * * *"
}
```

### Active Schedulers:
1. **Lead Ingestion Cron (`ingestionCronTask`)**:
   - Executes daily at configured time (default `09:00`).
   - Cycles through all connected user inboxes, fetching and qualifying new leads.
2. **Follow-Up Dispatcher Cron (`followUpCronTask`)**:
   - Runs on interval (default every 2 hours: `0 */2 * * *`).
   - Evaluates active campaigns and sends Day 3 and Day 7 follow-up emails.
3. **Reply Detector Cron (`replyCronTask`)**:
   - Runs on interval (default every 1 hour: `0 * * * *`).
   - Scans inboxes for customer responses and pushes instant alerts.

---

## 10. Comprehensive REST API Reference

All protected endpoints require either `Authorization: Bearer <session_token>` header or `?token=<session_token>` query parameter.

### 10.1 Authentication & User Management

#### `GET /api/auth/me`
- **Access**: Protected
- **Description**: Returns authenticated user profile and role (`leader` or `member`).

#### `GET /api/users`
- **Access**: Protected
- **Description**: Returns list of all authorized team members.

#### `POST /api/users`
- **Access**: Leader Only
- **Body**: `{ "email": "colleague@company.com", "role": "member" }`
- **Description**: Authorizes a new user and sends an invitation email.

#### `DELETE /api/users/:email`
- **Access**: Leader Only
- **Description**: Revokes user access and invalidates active sessions.

---

### 10.2 Pipeline & Ingestion Controls

#### `POST /api/fetch-and-qualify`
- **Access**: Protected
- **Body**: `{ "fetchMode": "last24h", "onlyUnread": true, "fromDate": null, "toDate": null }`
- **Description**: Starts the asynchronous lead extraction and scraping pipeline.

#### `GET /api/status`
- **Access**: Protected
- **Description**: Returns `{ isRunning: boolean, lastRun: string, progress: object }`.

#### `GET /api/logs/stream`
- **Access**: Public / Session Param
- **Description**: Server-Sent Events (SSE) stream for real-time log output and progress updates.

---

### 10.3 Leads Intelligence

#### `GET /api/leads`
- **Access**: Protected
- **Query Parameters**: `type=qualified|unqualified`, `user=email@domain.com` (Leader only)
- **Description**: Returns array of lead records.

#### `GET /api/leads/:id`
- **Access**: Protected
- **Description**: Returns full detailed dossier for a single lead.

#### `PATCH /api/leads/:id/notes`
- **Access**: Protected
- **Body**: `{ "notes": "Followed up on LinkedIn. Target hiring manager identified." }`
- **Description**: Updates sticky notes for a lead.

#### `POST /api/leads/:id/convert`
- **Access**: Protected
- **Description**: 1-Click converts lead into Account, Contact, Deal, and Task.

---

### 10.4 Cold Outreach & Drip Follow-ups

#### `POST /api/outreach`
- **Access**: Protected
- **Body**:
```json
{
  "lead_id": 12,
  "lead_company": "Toyota Motors",
  "contact_name": "John Doe",
  "contact_email": "johndoe@toyota.com",
  "day0_subject": "Partnership Inquiry: Process Innovation R&D",
  "day0_body": "Hi John,\n\nI noticed Toyota's focus on process innovation..."
}
```
- **Description**: Creates outreach record, dispatches Day 0 email via Gmail API, and advances deal stage.

#### `GET /api/outreach`
- **Access**: Protected
- **Description**: Lists all active outreach campaigns.

#### `GET /api/outreach/lead/:leadId`
- **Access**: Protected
- **Description**: Returns outreach campaign associated with a specific lead ID.

#### `POST /api/outreach/:id/send-followup`
- **Access**: Protected
- **Body**: `{ "subject": "Re: Follow-up", "body": "Hi John, checking in..." }`
- **Description**: Sends a custom edited follow-up email.

#### `POST /api/outreach/check-replies`
- **Access**: Protected
- **Description**: Manually triggers inbox scan for customer replies.

---

### 10.5 CRM Core Endpoints (Accounts, Contacts, Deals, Tasks, Quotations)

#### Accounts:
- `GET /api/accounts`: List accounts with associated metrics.
- `POST /api/accounts`: Create new account.
- `PUT /api/accounts/:id`: Update account details.
- `DELETE /api/accounts/:id`: Delete account.

#### Contacts:
- `GET /api/contacts`: List all contacts with parent company names.
- `POST /api/contacts`: Create new contact.
- `PUT /api/contacts/:id`: Update contact.
- `DELETE /api/contacts/:id`: Delete contact.

#### Deals:
- `GET /api/deals`: List all deals.
- `GET /api/deals/metrics`: Summary metrics (Total Pipeline Value, Won Revenue, Lost Revenue, Win Rate).
- `POST /api/deals`: Create deal.
- `PUT /api/deals/:id`: Update deal details.
- `PATCH /api/deals/:id/stage`: Update deal stage (`lead`, `contacted`, `quotation`, `negotiation`, `won`, `lost`).
- `DELETE /api/deals/:id`: Delete deal.

#### Tasks:
- `GET /api/tasks`: List tasks (optional filter `?status=pending|completed`).
- `POST /api/tasks`: Create task.
- `PATCH /api/tasks/:id/status`: Update status (`pending` $\leftrightarrow$ `completed`).
- `DELETE /api/tasks/:id`: Delete task.

#### Quotations:
- `GET /api/quotations`: List all commercial quotes.
- `POST /api/quotations`: Create quote proposal.
- `POST /api/quotations/:id/send-email`: Send proposal email to client contact.

---

### 10.6 System Settings & Schedulers

#### `GET /api/settings` & `POST /api/settings`
- **Access**: Leader Only for POST
- **Description**: Retrieve or update ICP filtering rules, sector whitelists, employee count thresholds, and AI prompt templates.

#### `GET /api/cron/config` & `POST /api/cron/config`
- **Access**: Leader Only for POST
- **Description**: Manage ingestion, follow-up, and reply scanner cron schedules.

#### `POST /api/test/send-samples`
- **Access**: Leader Only
- **Description**: Dispatches 5 realistic test job alert emails to the user's inbox to verify parsing accuracy.

---

## 11. Frontend Interface Architecture & User Experience

The frontend is located in `/frontend` and consists of lightweight, high-performance static files:

| File | Role & Page Description |
| :--- | :--- |
| **`index.html`** | **Main CRM & Intelligence Dashboard**: Includes Qualified/Unqualified Leads tables, Outreach Pipeline manager, Accounts & Contacts directory, Deals Kanban Board, Quotations manager, Tasks manager, BI Analytics charts, Cron Settings, and live SSE terminal. |
| **`detail.html`** | **Lead Deep-Dive Dossier**: Displays full scraped job description, company overview, ICP fit reasons, employee counts, decision-maker people links, 1-click CRM conversion, and inline email outreach sender. |
| **`login.html`** | **Authentication Portal**: Secure Google OAuth2 Single Sign-On screen with instant role verification and unauthorized access guards. |
| **`flow.html`** | **Interactive Pipeline Visualizer**: Visual walkthrough of data moving from email ingestion through AI models and into the CRM. |
| **`choose.html`** | Quick navigation menu for switching between system views. |
| **`oauth-callback.html`** | Client-side OAuth2 handshake receiver for Google authentication flows. |
| **`config.js`** | Dynamically updated on server boot with the active `API_BASE_URL`. |

---

## 12. Environment Variables & System Configuration (.env)

Create a `.env` file in the project root directory with the following variables:

```env
# Server & Network Configuration
PORT=3000
USE_TUNNEL=false
TUNNEL_URL=

# PostgreSQL Database Connection
DATABASE_URL=postgres://user:password@localhost:5432/leadcrm

# Google OAuth2 Credentials (Gmail API & Google SSO)
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/api/email/oauth-callback

# Gmail IMAP Authentication (Alternative Ingestion Channel)
GMAIL_USER_EMAIL=your-inbox@gmail.com
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx

# Google Service Account (Google Sheets Sync)
GOOGLE_SPREADSHEET_ID=your-spreadsheet-id
GOOGLE_SERVICE_ACCOUNT_KEY_PATH=service-account.json

# AI Model API Keys
MISTRAL_API_KEY=your_mistral_api_key

# Search Engine API Key
SERPER_API_KEY=your_serper_dev_api_key

# Brevo Transactional Email API (Notifications & Fallback)
BREVO_API_KEY=xkeysib-your-brevo-api-key
BREVO_SENDER=notifications@yourdomain.com

# Baileys WhatsApp Gateway (Self-hosted Multi-Device Socket)
WHATSAPP_RECIPIENT_PHONE=919876543210

# Team Seeding Whitelist (Comma-separated emails assigned Leader role on first start)
USERS=leader1@domain.com,leader2@domain.com
```

---

## 13. Installation, Local Setup & Production Deployment Guide

### 13.1 Prerequisites
- **Node.js**: v18.0.0 or higher
- **PostgreSQL**: v14.0 or higher (or cloud instances like Supabase, Neon, AWS RDS)
- **Google Cloud Console Project**: With Gmail API, Google Sheets API, and OAuth2 Client enabled.

### 13.2 Installation Steps
1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd test-crm
   ```

2. **Install Node Dependencies**:
   ```bash
   npm install
   ```

3. **Install Playwright Browsers**:
   ```bash
   npx playwright install chromium
   # or run project installer:
   npm run build
   ```

4. **Configure Environment Variables**:
   - Copy `.env.example` (or create `.env` as documented above).
   - Ensure `service-account.json` is placed in the project root if using Google Sheets sync.

5. **Start the Application**:
   ```bash
   npm start
   ```
   The application will automatically:
   - Synchronize `frontend/config.js`.
   - Initialize PostgreSQL database tables.
   - Boot background cron schedulers.
   - Open `http://localhost:3000` in your default browser.

### 13.3 Production Deployment via Docker

#### 1. Quick Launch with Docker Compose
```bash
docker compose up -d --build
```

#### 2. Standalone Docker Run
```bash
# Build Image
docker build -t salesforge-crm .

# Run Container with Persistent Baileys WhatsApp Session
docker run -d \
  --name salesforge-crm \
  -p 3000:3000 \
  --env-file .env \
  -v salesforge_whatsapp:/app/backend/baileys_auth_info \
  salesforge-crm
```

#### 3. Key Docker Configurations
- **Playwright Chromium**: Pre-installed with all Linux system dependencies in the container image.
- **Persistent WhatsApp Session**: The `/app/backend/baileys_auth_info` volume mount ensures WhatsApp pairing remains active across container restarts and updates.
- **Tunnels / Cloudflare / Reverse Proxy**: Set `USE_TUNNEL=true` and `TUNNEL_URL=https://crm.yourdomain.com` if hosting behind custom domains or SSL load balancers.


---

*Documentation maintained by the Engineering & Product Team. For inquiries or updates, consult the repository leads.*
