# Sharing and Deployment Guide

Use this guide to share, distribute, or host the R&D Lead Intelligence Portal.

---

## 1. Security First: What NOT to Share
When sharing the source code, **never** include sensitive credentials. Ensure the following items are excluded from any shared zip file or git commit:
*   `.env` file (contains your API keys, email credentials, and Brevo keys).
*   `service-account.json` (grants write access to your Google Sheet).
*   `node_modules/` folder (unnecessary weight, recipients can install it locally).

---

## 2. Option 1: Sharing as Local Source Code (Recommended for Developers/Local Testing)
To package and share the application for another user to run locally on their computer:

### Step A: Package the Zip
1. Create a zip archive of the project root.
2. Exclude `node_modules`, `.env`, and `service-account.json`.
3. Include `.env.example` (or a blank template) to guide the recipient on configuring their variables.

### Step B: Instructions for the Recipient
Provide the recipient with these setup steps:
1. **Download Node.js**: Download and install Node.js (v18+) from [nodejs.org](https://nodejs.org/).
2. **Extract Files**: Extract the zip archive into a workspace folder.
3. **Install Dependencies**: Open a terminal, navigate to the folder, and run:
   ```bash
   npm install
   ```
4. **Setup Environment**:
   - Create a `.env` file using the templates in the README.
   - Request and input API keys for Mistral, Groq, Serper, and Brevo.
   - Enter their email credentials and Google Sheet ID.
5. **Setup Service Account**:
   - Create a Google Cloud Project, enable the Sheets API, create a Service Account, generate a JSON Key, rename it to `service-account.json`, and place it in the root folder.
   - Share the target Google Sheet with the Service Account email as **Editor**.
6. **Launch Portal**: Run `npm start` and visit `http://localhost:3000`.

---

## 3. Option 2: Deploying to Cloud Providers (e.g. Render / Heroku)
To host the web dashboard permanently so that team members can access it via a public URL:

### Step A: Push to GitHub
1. Initialize a git repository:
   ```bash
   git init
   ```
2. Create a `.gitignore` file to protect keys:
   ```env
   node_modules/
   .env
   service-account.json
   jobs-db.json
   job.json
   last-run.txt
   company-cache.json
   ```
3. Commit and push the code to a private GitHub repository.

### Step B: Deploy on Render.com (Web Service)
1. Log in to [Render](https://render.com/) and create a new **Web Service**.
2. Connect your GitHub repository.
3. Choose **Node** runtime.
4. Set **Start Command** to `npm start`.
5. Under **Environment Variables**, add all keys from your local `.env` file (e.g. `MISTRAL_API_KEY`, `BREVO_API_KEY`, `GOOGLE_SPREADSHEET_ID`, etc.).
6. **Deploy the Service Account Key**:
   - On Render, go to **Environment** > **Secret Files**.
   - Create a file named `service-account.json` and paste the contents of your Google credentials JSON file.
7. **Mount Persistent Disk (Optional but Recommended)**:
   - Because Render containers are ephemeral, local database files (`jobs-db.json`, `job.json`, `last-run.txt`) will reset on redeployment.
   - Create a **Disk** under the Disk settings of your service, mount it at `/app/db`, and modify the database paths in `server.js` and `email-ingest.js` to point to `/app/db/...` to persist data permanently.

---

## 4. Option 3: Managing Team Member Access
The portal is whitelisted to prevent unauthorized individuals from generating OTP emails and entering the dashboard.

### To Authorize a New Team Member to Log In:
1. Open the `.env` file (or your Cloud Provider's Environment variables page).
2. Find the `USERS` variable.
3. Add the team member's email address to the comma-separated list:
   ```env
   USERS=vimalraj5207@gmail.com,malikasaravanan774@gmail.com,vsgrps360@gmail.com,colleague@company.com
   ```
4. Restart the server. The new user can now visit the login page, enter their email, receive a secure Brevo OTP, and access the dashboard.

*(Note: If they also need to send lead alert emails to the Gmail inbox, add them to the `ALLOWED_SENDERS` variable as well).*
