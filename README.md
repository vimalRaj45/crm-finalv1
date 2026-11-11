# 🚀 SalesForge AI | Autonomous AI Lead Intelligence & Revenue Execution Hub

A full-stack, enterprise AI lead prospecting, cold outreach automation, and CRM platform built with **Node.js, Express, PostgreSQL, Mistral AI (Small & Large), Playwright Chromium, and Google OAuth2**.

---

## 📖 Complete Documentation
The full system documentation with detailed architecture diagrams, database schemas, processing pipelines, cold email drip sequences, REST API references, and deployment guides can be found at:

👉 **[Complete System Documentation (project_guide/full.md)](project_guide/full.md)**

---

## ⚡ Quick Start

### 1. Prerequisites
- **Node.js**: v18.0.0 or higher
- **PostgreSQL**: v14.0 or higher

### 2. Install Dependencies
```bash
npm install
npm run build # Installs Playwright Chromium browser binaries
```

### 3. Configure Environment Variables
Create a `.env` file in the root folder (see [Environment Variables Guide](project_guide/full.md#12-environment-variables--system-configuration-env)):
```env
PORT=3000
DATABASE_URL=postgres://user:password@localhost:5432/leadcrm
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
MISTRAL_API_KEY=your_mistral_key
SERPER_API_KEY=your_serper_key
BREVO_API_KEY=your_brevo_key
```

### 4. Start the Application
```bash
npm start
```
The server will initialize PostgreSQL tables, boot background schedulers, and open **`http://localhost:3000`** in your default browser.

---

### 🐳 Run with Docker (Recommended for Production)

#### Option A: Docker Compose (Single Command)
```bash
docker compose up -d --build
```

#### Option B: Standalone Docker
```bash
# 1. Build Image
docker build -t salesforge-ai .

docker run -d -p 3000:3000 \
  --env-file .env \
  --name salesforge-crm \
  --restart unless-stopped \
  -v salesforge_whatsapp:/app/backend/baileys_auth_info \
  salesforge-ai
```
Visit **`http://localhost:3000`** in your browser.

---

## 🛠️ Key Features

- 🤖 **Autonomous Lead Ingestion**: Monitors Gmail via IMAP / OAuth2 Gmail API and extracts job postings from authorized job alert senders.
- ⚡ **Resilient Multi-Model AI Pipeline**: Fast entity extraction and deep ICP fit evaluation (0–100 scoring & outreach messaging) via **Groq AI (Llama 3.3 70B)**, **Google Gemini 2.0 Flash**, and **Mistral AI**.
- 🕷️ **Stealth Browser Scraping**: Automated job description & employee headcount extraction using **Playwright** with anti-fingerprint rotation.
- 📧 **Cold Outreach & Drip Sequences**: Automated Day 0 $\rightarrow$ Day 3 $\rightarrow$ Day 7 follow-up drip sequences with direct Gmail API sending.
- 🎯 **Active Reply Detection**: Automatic inbox scanning for customer responses with instant **Brevo Email** and **Baileys WhatsApp Gateway** push alerts.
- 💼 **Full CRM Operations Suite**: 1-click lead conversion into **Accounts, Contacts, Deals (Kanban Pipeline), Tasks, and Commercial Quotations**.
- 👥 **Role-Based Access Control**: Google OAuth2 SSO with Team Leader vs Member permissions.
