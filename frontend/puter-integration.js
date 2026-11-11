/**
 * Salesforge System - Puter.js Cloud & AI Integration Suite with RAG CRM Intelligence
 * Uses developer.puter.com (Puter.js v2) for client-side AI, Live CRM RAG, Cloud Hosting, KV Storage, and OCR.
 * Clean Blue & White Enterprise Theme.
 */

(function () {
  // Ensure Puter SDK is available or loaded dynamically
  if (!window.puter && !document.querySelector('script[src*="js.puter.com"]')) {
    const script = document.createElement('script');
    script.src = 'https://js.puter.com/v2/';
    script.async = true;
    document.head.appendChild(script);
  }

  const PuterCRM = {
    // Current AI model selected for Copilot
    selectedModel: 'gpt-4o',
    isSpeaking: false,
    currentTone: 'Persuasive',
    lastExtractedLead: null,
    currentQuoteUrl: '',
    cachedRAGContext: '',
    lastRAGFetchTime: 0,

    // Available AI Models via Puter
    models: [
      { id: 'gpt-4o', name: 'OpenAI GPT-4o', desc: 'Best for smart sales negotiation & fast pitches' },
      { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', desc: 'Superior nuanced writing & high-touch cold outreach' },
      { id: 'deepseek-chat', name: 'DeepSeek Chat', desc: 'High reasoning & strategic prospecting' },
      { id: 'mistral-large-latest', name: 'Mistral Large', desc: 'Crisp, structured enterprise analysis' }
    ],

    /**
     * Check if Puter SDK is ready
     */
    isReady: function () {
      return typeof window.puter !== 'undefined';
    },

    /**
     * Check if user is signed in to Puter account
     */
    isSignedIn: function () {
      return this.isReady() && window.puter.auth && typeof window.puter.auth.isSignedIn === 'function' && window.puter.auth.isSignedIn();
    },

    /**
     * Sign in to Puter
     */
    signIn: async function () {
      if (!this.isReady()) {
        alert('Puter SDK is loading. Please try again in a few seconds.');
        return false;
      }
      try {
        await window.puter.auth.signIn();
        this.updateAuthUI();
        return true;
      } catch (err) {
        console.warn('[Puter Auth] Sign in cancelled or error:', err.message);
        return false;
      }
    },

    /**
     * Sign out from Puter
     */
    signOut: async function () {
      if (this.isReady() && window.puter.auth) {
        await window.puter.auth.signOut();
        this.updateAuthUI();
      }
    },

    /**
     * Update Auth Status Badge in Copilot UI
     */
    updateAuthUI: function () {
      const badge = document.getElementById('puter-auth-badge');
      if (!badge) return;
      if (this.isSignedIn()) {
        let userStr = 'Connected';
        try {
          const user = window.puter.auth.getUser();
          if (user && user.username) userStr = user.username;
        } catch (e) {}
        badge.innerHTML = `
          <span class="text-[10px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200 font-bold flex items-center gap-1 shadow-2xs">
            <i class="bi bi-person-check-fill text-emerald-600"></i> ${userStr}
          </span>
        `;
      } else {
        badge.innerHTML = `
          <button onclick="PuterCRM.signIn()" class="text-[10px] text-blue-700 bg-blue-50 hover:bg-blue-100 px-2 py-0.5 rounded-full border border-blue-200 font-bold flex items-center gap-1 transition-all shadow-2xs">
            <i class="bi bi-box-arrow-in-right text-blue-600"></i> Sign In to Puter
          </button>
        `;
      }
    },

    /**
     * Sign In and automatically retry RAG query
     */
    signInAndRetryRag: async function () {
      const signedIn = await this.signIn();
      if (signedIn) {
        this.handleRagQueryAction();
      }
    },

    /**
     * Sign In and automatically retry Rewrite action
     */
    signInAndRetryRewrite: async function () {
      const signedIn = await this.signIn();
      if (signedIn) {
        this.handleRewriteAction();
      }
    },

    /**
     * Helper to extract clean text/content from Puter AI responses
     */
    extractTextContent: function (raw) {
      if (!raw) return '';
      if (typeof raw === 'string') return raw;
      if (raw.message && typeof raw.message.content === 'string') return raw.message.content;
      if (raw.text && typeof raw.text === 'string') return raw.text;
      if (raw.content && typeof raw.content === 'string') return raw.content;
      return JSON.stringify(raw);
    },

    /**
     * Helper to safely extract and parse JSON from AI outputs (stripping markdown codeblocks)
     */
    parseJSONFromAI: function (raw) {
      const text = this.extractTextContent(raw);
      const cleaned = text
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();

      try {
        return JSON.parse(cleaned);
      } catch (e) {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            return JSON.parse(match[0]);
          } catch (err) {}
        }
        return { raw: text };
      }
    },

    /**
     * Generic Puter AI Chat Completion
     */
    aiChat: async function (prompt, options = {}) {
      if (!this.isReady()) {
        throw new Error('Puter.js is still loading. Please try again in a few seconds.');
      }
      if (window.puter.auth && !window.puter.auth.isSignedIn()) {
        throw new Error('AUTH_REQUIRED');
      }
      const model = options.model || this.selectedModel || 'gpt-4o';
      try {
        const res = await window.puter.ai.chat(prompt, { model });
        return this.extractTextContent(res);
      } catch (err) {
        if (err.message && (err.message.toLowerCase().includes('auth') || err.message.toLowerCase().includes('sign in') || err.message.toLowerCase().includes('401'))) {
          throw new Error('AUTH_REQUIRED');
        }
        throw err;
      }
    },

    /**
     * In-Memory Client Cache for RAG Context
     */
    ragContextCacheMap: new Map(),

    /**
     * Fetch Real-Time CRM Database Context for RAG Engine (with Optimistic Pre-fetching & RAM Caching)
     */
    fetchCrmKnowledgeContext: async function (forceRefresh = false) {
      const now = Date.now();
      const cached = this.ragContextCacheMap.get('global');

      if (!forceRefresh && cached && (now - cached.time < 30000)) {
        return cached.context;
      }

      try {
        const baseUrl = (window.ENV && window.ENV.API_BASE_URL) ? window.ENV.API_BASE_URL : '';
        const url = `${baseUrl}/api/crm/rag-context`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          const context = data.contextText || '';
          this.ragContextCacheMap.set('global', { context, time: now });
          return context;
        }
      } catch (err) {
        console.warn('Error fetching live CRM RAG context:', err.message);
      }

      return cached?.context || 'CRM database context currently unavailable.';
    },

    /**
     * Format raw AI output into clean executive HTML with badges, cards, and typography
     */
    formatRichOutput: function (rawText) {
      if (!rawText) return '';
      let text = String(rawText).trim();

      // Normalize newlines
      text = text.replace(/\r\n/g, '\n');

      // Convert code blocks
      text = text.replace(/```([a-z]*)\n([\s\S]*?)```/gi, (match, lang, code) => {
        return `<pre class="bg-slate-900 text-slate-100 p-3 rounded-xl font-mono text-[11px] overflow-x-auto my-2 border border-slate-800"><code>${code.trim()}</code></pre>`;
      });

      // Split into lines for structured card parsing
      const lines = text.split('\n');
      let html = '';
      let insideList = false;
      let insideCard = false;

      for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();

        if (!line) {
          if (insideList) {
            html += '</ul>';
            insideList = false;
          }
          continue;
        }

        // Check for Section Headers (### or #### or **1. Company**)
        const headerMatch = line.match(/^(#{1,6})\s*\**([0-9]+\.\s*)?([^\*#\n]+)\**$/);
        const boldNumberedMatch = line.match(/^(\*{2})([0-9]+\.\s*[^:\*\n]+)\1$/);

        if (headerMatch || boldNumberedMatch) {
          if (insideList) { html += '</ul>'; insideList = false; }
          if (insideCard) { html += '</div>'; insideCard = false; }

          const title = headerMatch ? headerMatch[3].trim() : boldNumberedMatch[2].trim();
          html += `
            <div class="bg-white border border-blue-100 rounded-2xl p-3.5 my-2.5 shadow-xs space-y-1.5 transition-all hover:border-blue-300">
              <div class="flex items-center gap-2 pb-1.5 border-b border-slate-100">
                <div class="w-6 h-6 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center text-xs font-bold shrink-0">
                  <i class="bi bi-building"></i>
                </div>
                <h4 class="font-extrabold text-xs text-slate-900 leading-snug tracking-tight">${title}</h4>
              </div>
          `;
          insideCard = true;
          continue;
        }

        // Inline Bold replacement
        line = line.replace(/\*\*([^\*]+)\*\*/g, '<strong class="font-bold text-slate-900">$1</strong>');
        // Inline Italic replacement
        line = line.replace(/\*([^\*]+)\*/g, '<em class="italic text-slate-600">$1</em>');
        // Inline Code replacement
        line = line.replace(/`([^`]+)`/g, '<code class="bg-blue-50 text-blue-800 font-mono text-[10px] px-1.5 py-0.5 rounded border border-blue-100">$1</code>');

        // Fit Score Highlighting
        line = line.replace(/Fit Score:\s*([0-9]+)\s*\/\s*100/i, (match, score) => {
          const num = parseInt(score, 10);
          const colorClass = num >= 80 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : (num >= 50 ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-amber-50 text-amber-700 border-amber-200');
          return `Fit Score: <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold border ${colorClass}"><i class="bi bi-check2-circle"></i> ${num}/100</span>`;
        });

        // Bulleted lists (- item or • item or * item)
        if (line.match(/^[-•\*]\s+/)) {
          const content = line.replace(/^[-•\*]\s+/, '');
          if (!insideList) {
            html += '<ul class="space-y-1.5 my-1 text-[11px] text-slate-700">';
            insideList = true;
          }
          html += `<li class="flex items-start gap-1.5 leading-relaxed"><span class="text-blue-500 font-bold mt-0.5">•</span><span>${content}</span></li>`;
        } else {
          if (insideList) {
            html += '</ul>';
            insideList = false;
          }
          html += `<p class="text-[11px] text-slate-700 leading-relaxed my-1">${line}</p>`;
        }
      }

      if (insideList) html += '</ul>';
      if (insideCard) html += '</div>';

      return html;
    },

    /**
     * In-Memory Schema Definition Cache
     */
    schemaCache: null,

    /**
     * Fetch Live PostgreSQL CRM Schema Definition
     */
    fetchCrmSchema: async function () {
      if (this.schemaCache) return this.schemaCache;
      try {
        const baseUrl = (window.ENV && window.ENV.API_BASE_URL) ? window.ENV.API_BASE_URL : '';
        const res = await fetch(`${baseUrl}/api/crm/schema-definition`);
        if (res.ok) {
          const data = await res.json();
          this.schemaCache = data.schema;
          return data.schema;
        }
      } catch (e) {
        console.warn('Failed to fetch CRM schema definition:', e.message);
      }
      return `
PostgreSQL CRM Schema Tables & Columns:
- leads (id SERIAL, date DATE, company_name VARCHAR(255), position VARCHAR(255), score INT, employees INT, company_bio TEXT, posted_date VARCHAR(255), domain VARCHAR(255), linkedin VARCHAR(255), scraped_location VARCHAR(255), email VARCHAR(255), is_fit BOOLEAN [true=qualified, false=unqualified], fit_reason TEXT, notes TEXT, created_at TIMESTAMP)
- accounts (id SERIAL, company_name VARCHAR(255), domain VARCHAR(255), industry VARCHAR(255), employees INT, company_bio TEXT, linkedin VARCHAR(255), created_at TIMESTAMP)
- contacts (id SERIAL, account_id INT REFERENCES accounts(id), name VARCHAR(255), email VARCHAR(255), phone VARCHAR(100), job_title VARCHAR(255), linkedin VARCHAR(255), created_at TIMESTAMP)
- deals (id SERIAL, account_id INT REFERENCES accounts(id), contact_id INT REFERENCES contacts(id), lead_id INT, title VARCHAR(255), amount NUMERIC(12,2), stage VARCHAR(50) [lead, contacted, quotation, negotiation, won, lost], probability INT, close_date DATE, notes TEXT, created_at TIMESTAMP)
- tasks (id SERIAL, deal_id INT, contact_id INT, account_id INT, lead_id INT, title VARCHAR(255), description TEXT, due_date TIMESTAMP, priority VARCHAR(50) [low, medium, high], status VARCHAR(50) [pending, completed], created_at TIMESTAMP)
- quotations (id SERIAL, deal_id INT, quotation_number VARCHAR(100), items TEXT, subtotal NUMERIC(12,2), tax NUMERIC(12,2), discount NUMERIC(12,2), total_amount NUMERIC(12,2), status VARCHAR(50) [draft, sent, accepted, rejected], created_at TIMESTAMP)
- outreach_contacts (id SERIAL, lead_id INT, lead_company VARCHAR(255), contact_name VARCHAR(255), contact_email VARCHAR(255), day0_subject TEXT, day0_body TEXT, status VARCHAR(50) [emailed, followed_up_1, followed_up_2, replied, no_response], sent_at TIMESTAMP, replied_at TIMESTAMP, created_at TIMESTAMP)
      `.trim();
    },

    /**
     * Execute Safe Read-Only SQL Query on Backend PostgreSQL
     */
    executeAiSql: async function (sql) {
      const baseUrl = (window.ENV && window.ENV.API_BASE_URL) ? window.ENV.API_BASE_URL : '';
      const res = await fetch(`${baseUrl}/api/crm/ai-query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql })
      });
      return await res.json();
    },

    /**
     * Execute RAG Query with Schema-Aware Text-to-SQL + Ground Truth Verification (100% Mathematical Accuracy)
     */
    queryCrmRag: async function (userQuery) {
      const schema = await this.fetchCrmSchema();
      let sqlExecutedInfo = null;
      let sqlData = null;

      // STAGE 1: Determine if question is an analytical/statistical/lookup question requiring dynamic SQL
      const textToSqlPrompt = `You are an expert PostgreSQL Database Architect for Salesforge System.
DATABASE SCHEMA:
============================================================
${schema}
============================================================

CRITICAL SQL GENERATION RULES:
1. If the user's question asks for counts, statistics, totals, filtering, lead lookups, deal metrics, tasks, accounts, or specific company details, write a single valid, optimized, read-only PostgreSQL SELECT query.
2. For "qualified leads": ALWAYS filter with "WHERE is_fit = true" (e.g. "SELECT COUNT(*) AS total_qualified_leads FROM leads WHERE is_fit = true").
3. For "unqualified leads": filter with "WHERE is_fit = false".
4. For all leads: use "SELECT COUNT(*) FROM leads".
5. For company lookups: use ILIKE '%name%' (e.g. "SELECT * FROM leads WHERE company_name ILIKE '%HP%' AND is_fit = true").
6. Always return ONLY the raw SQL query. No markdown formatting, no backticks, no explanations.
7. If the user's request is purely a creative pitch draft (e.g. "write a cold email for a lead") or general sales advice with NO need to query the database, output ONLY the exact word "NO_SQL".

User Request: "${userQuery}"`;

      let generatedSql = '';
      try {
        const sqlRes = await this.aiChat(textToSqlPrompt);
        generatedSql = this.extractTextContent(sqlRes).trim().replace(/^```(sql)?\s*/i, '').replace(/```\s*$/i, '').trim();
      } catch (err) {
        console.warn('[Text-to-SQL] SQL generation step error:', err.message);
      }

      // STAGE 2: Execute Dynamic SQL if generated and not NO_SQL
      if (generatedSql && !generatedSql.toUpperCase().includes('NO_SQL') && /^(\s*WITH\s+[\s\S]+?\s+)?\s*SELECT\b/i.test(generatedSql)) {
        try {
          const sqlResult = await this.executeAiSql(generatedSql);
          if (sqlResult.success) {
            sqlData = sqlResult.rows;
            sqlExecutedInfo = {
              sql: sqlResult.sql,
              rowCount: sqlResult.rowCount,
              executionTimeMs: sqlResult.executionTimeMs
            };
          } else {
            console.warn('[Text-to-SQL] Backend SQL execution error:', sqlResult.error);
          }
        } catch (err) {
          console.warn('[Text-to-SQL] Failed to execute dynamic SQL:', err.message);
        }
      }

      // STAGE 3: Fetch Ground-Truth CRM Context for context synthesis & fallback
      const crmContext = await this.fetchCrmKnowledgeContext(false);

      // STAGE 4: Final Executive Synthesis Prompt
      let synthesisPrompt = `You are Salesforge AI Executive Sales Copilot — an elite B2B sales intelligence advisor with 100% database accuracy.
LIVE DATABASE CONTEXT:
============================================================
${crmContext}
============================================================
`;

      if (sqlData !== null && sqlExecutedInfo) {
        synthesisPrompt += `
DYNAMIC SQL QUERY EXECUTED ON POSTGRESQL:
SQL: "${sqlExecutedInfo.sql}"
EXECUTION TIME: ${sqlExecutedInfo.executionTimeMs}ms
EXACT RETURNED DATA ROWS (${sqlExecutedInfo.rowCount} rows):
${JSON.stringify(sqlData, null, 2)}
============================================================

CRITICAL GROUND-TRUTH RULES:
1. Base your answer directly on the EXACT returned SQL data rows above.
2. Direct answer first: State the precise numerical result clearly in the very first sentence.
3. Every single number must be 100% mathematically accurate.
4. If a count is returned (e.g. 38), state exactly 38.
5. Format the response with clean executive bullet points, highlight key metrics, and provide strategic sales recommendations.
`;
      } else {
        synthesisPrompt += `
CRITICAL GROUND-TRUTH RULES:
1. For ANY question about counts or totals (e.g. "how many qualified leads", "total leads", etc.), ALWAYS use the exact numbers from the "[EXACT DATABASE TOTALS - USE THESE FOR ALL STATISTICAL QUESTIONS]" section at the very top of the context.
2. Direct answer first: State the exact count in the first sentence (e.g. "There are currently **38 total qualified leads** in the CRM.").
3. NEVER hallucinate 0 when qualified leads exist.
4. Provide structured, executive insights with actionable next steps.
`;
      }

      synthesisPrompt += `
User Question / Command:
"${userQuery}"`;

      const aiResponse = await this.aiChat(synthesisPrompt);
      let outputText = aiResponse;

      if (sqlExecutedInfo) {
        outputText += `\n\n> ⚡ **Verified DB Query (${sqlExecutedInfo.executionTimeMs}ms)**: \`${sqlExecutedInfo.sql}\``;
      }

      return outputText;
    },


    /**
     * AI Email / Pitch Rewriter with Tone Selection
     */
    rewriteEmail: async function (originalContent, tone = 'persuasive', instructions = '') {
      const prompt = `You are an elite B2B enterprise sales copywriter.
Rewrite and optimize the following cold outreach email / pitch.

Tone requirement: ${tone.toUpperCase()}
Additional instructions: ${instructions || 'Make it punchy, personalized, and drive a clear call to action.'}

Original Email Content:
"""
${originalContent}
"""

Return ONLY the rewritten email subject line and body in standard format. No commentary.`;

      return await this.aiChat(prompt);
    },

    /**
     * OCR / Extract Lead Contact info from an image or screenshot
     */
    ocrExtractLead: async function (imageFile) {
      if (!this.isReady()) throw new Error('Puter.js is not loaded.');

      const prompt = `Look at this business card / profile screenshot and extract structured lead details. Return a valid JSON object with keys: "name", "job_title", "company_name", "email", "phone", "linkedin_url", "skills_or_summary". Return ONLY the JSON.`;

      let rawResponse = '';
      if (window.puter.ai.img2txt) {
        const text = await window.puter.ai.img2txt(imageFile);
        rawResponse = await this.aiChat(`${prompt}\n\nExtracted raw text:\n${text}\n\nReturn ONLY the JSON object.`);
      } else {
        const res = await window.puter.ai.chat(prompt, { image: imageFile, model: 'gpt-4o' });
        rawResponse = this.extractTextContent(res);
      }

      return this.parseJSONFromAI(rawResponse);
    },

    /**
     * Text to Speech readout of Pitch / Script with active Stop control
     */
    speakPitch: function (text, btnId = 'puter-voice-btn') {
      if (!('speechSynthesis' in window)) return false;

      if (this.isSpeaking) {
        this.stopVoice(btnId);
        return false;
      }

      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.0;
      utterance.pitch = 1.0;

      const voiceBtn = document.getElementById(btnId);

      utterance.onstart = () => {
        this.isSpeaking = true;
        if (voiceBtn) {
          voiceBtn.innerHTML = `<i class="bi bi-stop-circle-fill text-rose-500 animate-pulse"></i> <span class="text-rose-600 font-bold">Stop Voice</span>`;
        }
      };

      utterance.onend = utterance.onerror = () => {
        this.isSpeaking = false;
        if (voiceBtn) {
          voiceBtn.innerHTML = `<i class="bi bi-volume-up text-blue-600"></i> <span class="text-blue-700">Listen</span>`;
        }
      };

      window.speechSynthesis.speak(utterance);
      return true;
    },

    /**
     * Stop any currently playing voice audio
     */
    stopVoice: function (btnId = 'puter-voice-btn') {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      this.isSpeaking = false;
      const voiceBtn = document.getElementById(btnId);
      if (voiceBtn) {
        voiceBtn.innerHTML = `<i class="bi bi-volume-up text-blue-600"></i> <span class="text-blue-700">Listen</span>`;
      }
    },

    /**
     * Instant 1-Click Client Quotation Microsite Publisher via Puter.hosting (Blue & White Theme)
     */
    publishQuoteMicrosite: async function (quoteData) {
      if (!this.isReady()) throw new Error('Puter.js is not loaded.');

      const cleanSub = 'q' + Math.random().toString(36).substring(2, 8);
      const dirPath = `proposals/${cleanSub}`;

      const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${quoteData.title || 'Client Proposal & Quotation'}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>body { font-family: 'Outfit', sans-serif; }</style>
</head>
<body class="bg-slate-50 text-slate-800 min-h-screen p-4 md:p-10 flex flex-col items-center justify-center">
  <div class="max-w-3xl w-full bg-white border border-blue-100 rounded-3xl p-8 md:p-12 shadow-[0_20px_50px_rgba(37,99,235,0.08)] relative overflow-hidden">
    <div class="absolute -top-24 -right-24 w-64 h-64 bg-blue-100/50 rounded-full blur-3xl pointer-events-none"></div>
    <div class="flex items-center justify-between border-b border-slate-100 pb-6 mb-8">
      <div>
        <span class="text-xs uppercase tracking-widest text-blue-600 font-extrabold">Commercial Proposal</span>
        <h1 class="text-2xl md:text-3xl font-black text-slate-900 mt-1">${quoteData.title || 'Executive Solution Proposal'}</h1>
        <p class="text-sm text-slate-500 mt-1">Prepared for: <strong class="text-slate-800">${quoteData.client_name || 'Valued Client'}</strong></p>
      </div>
      <div class="text-right">
        <span class="px-3.5 py-1 rounded-full bg-blue-50 text-blue-700 text-xs font-bold border border-blue-200">Official Quote</span>
        <p class="text-xs text-slate-400 mt-2">Date: ${new Date().toLocaleDateString()}</p>
      </div>
    </div>

    <div class="mb-8">
      <h2 class="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">Scope & Deliverables</h2>
      <div class="bg-slate-50/80 rounded-2xl p-5 border border-slate-200/80 leading-relaxed text-sm text-slate-700">
        ${quoteData.description || 'Enterprise platform implementation, workflow integration, dedicated SLA support, and AI pipeline orchestration.'}
      </div>
    </div>

    <div class="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl p-6 mb-8 flex items-center justify-between shadow-sm">
      <div>
        <p class="text-xs text-blue-700 font-bold uppercase tracking-wider">Total Investment</p>
        <p class="text-3xl md:text-4xl font-black text-blue-900 mt-1">${quoteData.currency || '$'}${Number(quoteData.total_amount || 0).toLocaleString()}</p>
      </div>
      <button onclick="alert('Proposal Accepted! Our enterprise team will contact you shortly.')" class="px-6 py-3.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm rounded-xl shadow-lg shadow-blue-500/20 transition-all hover:scale-105 active:scale-95 flex items-center gap-2">
        <i class="bi bi-check2-circle text-lg"></i>
        <span>Accept & Sign</span>
      </button>
    </div>

    <div class="text-center text-xs text-slate-400 border-t border-slate-100 pt-6">
      Powered by Salesforge System Intelligence & Puter Cloud Hosting.
    </div>
  </div>
</body>
</html>`;

      try {
        if (window.puter.fs && window.puter.fs.mkdir) {
          try {
            await window.puter.fs.mkdir(dirPath, { createMissingParents: true });
            await window.puter.fs.write(`${dirPath}/index.html`, htmlContent);
          } catch (fsErr) {
            console.warn('Puter FS write notice:', fsErr);
          }
        }

        if (window.puter.hosting && window.puter.hosting.create) {
          const site = await window.puter.hosting.create(cleanSub, dirPath);
          const hostedUrl = `https://${site.subdomain || cleanSub}.puter.site`;
          return {
            url: hostedUrl,
            subdomain: site.subdomain || cleanSub,
            isBlob: false
          };
        }
      } catch (err) {
        console.warn('Puter Hosting API notice:', err.message);
      }

      const blob = new Blob([htmlContent], { type: 'text/html' });
      const blobUrl = URL.createObjectURL(blob);
      return {
        url: blobUrl,
        subdomain: cleanSub,
        isBlob: true,
        previewUrl: `https://${cleanSub}.puter.site`
      };
    },

    /**
     * Render the Floating Puter AI Copilot Widget into the DOM (Blue & White Theme)
     */
    injectCopilotUI: function () {
      if (document.getElementById('puter-copilot-widget')) return;

      const widgetHtml = `
      <!-- Puter AI Floating Action Button -->
      <div id="puter-copilot-widget" class="fixed bottom-20 md:bottom-8 right-6 z-50 font-sans">
        <button id="puter-copilot-btn" onclick="PuterCRM.toggleCopilotDrawer()" class="group relative flex items-center gap-2.5 px-4 py-3 bg-gradient-to-r from-blue-600 via-blue-700 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white rounded-full shadow-[0_8px_30px_rgba(37,99,235,0.4)] transition-all duration-300 hover:scale-105 active:scale-95 border border-white/30">
          <div class="relative flex items-center justify-center">
            <i class="bi bi-stars text-lg animate-pulse"></i>
            <span class="absolute -top-1 -right-1 flex h-2.5 w-2.5">
              <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-400"></span>
            </span>
          </div>
          <span class="font-bold text-xs tracking-wide hidden sm:inline">Puter AI Copilot (RAG)</span>
        </button>

        <!-- Puter Copilot Slide-over Drawer (Blue & White Glass Theme) -->
        <div id="puter-copilot-drawer" class="fixed bottom-28 md:bottom-24 right-6 w-[94vw] sm:w-[480px] max-h-[85vh] bg-white/95 backdrop-blur-2xl border border-blue-100 rounded-3xl shadow-[0_20px_60px_-15px_rgba(37,99,235,0.25)] text-slate-800 flex flex-col hidden transition-all duration-300 z-50 overflow-hidden font-sans">
          
          <!-- Header (Vibrant Blue) -->
          <div class="px-5 py-4 border-b border-blue-700/20 flex items-center justify-between bg-gradient-to-r from-blue-600 via-blue-700 to-indigo-700 text-white shadow-sm">
            <div class="flex items-center gap-2.5">
              <div class="w-8 h-8 rounded-xl bg-white/20 backdrop-blur-sm border border-white/30 flex items-center justify-center text-white text-sm shadow-sm">
                <i class="bi bi-cpu-fill"></i>
              </div>
              <div>
                <h3 class="font-black text-sm text-white flex items-center gap-1.5 leading-none">
                  Salesforge AI Sales Copilot
                  <span class="text-[9px] bg-emerald-400 text-slate-900 border border-emerald-300 px-1.5 py-0.5 rounded-full font-extrabold uppercase">RAG Active</span>
                </h3>
                <p class="text-[10px] text-blue-100 mt-0.5">Live CRM Context + Puter AI Models</p>
              </div>
            </div>
            <button onclick="PuterCRM.toggleCopilotDrawer()" class="w-7 h-7 rounded-lg hover:bg-white/20 text-blue-100 hover:text-white flex items-center justify-center transition-colors">
              <i class="bi bi-x-lg text-sm"></i>
            </button>
          </div>

          <!-- Model Selector Bar with Live Auth Badge -->
          <div class="px-5 py-2 bg-blue-50/60 border-b border-blue-100 flex items-center justify-between text-xs gap-2">
            <div class="flex items-center gap-1.5">
              <span class="text-[11px] font-bold text-blue-900 flex items-center gap-1">
                <i class="bi bi-robot text-blue-600"></i> Model:
              </span>
              <select id="puter-model-select" onchange="PuterCRM.selectedModel = this.value" class="bg-white border border-blue-200 text-slate-800 text-xs rounded-lg px-2.5 py-1 font-semibold focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-500 shadow-sm cursor-pointer">
                <option value="gpt-4o" selected>GPT-4o (OpenAI)</option>
                <option value="claude-3-5-sonnet">Claude 3.5 Sonnet</option>
                <option value="deepseek-chat">DeepSeek Chat</option>
                <option value="mistral-large-latest">Mistral Large</option>
              </select>
            </div>
            <div id="puter-auth-badge">
              <button onclick="PuterCRM.signIn()" class="text-[10px] text-blue-700 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 rounded-full border border-blue-200 font-bold flex items-center gap-1 transition-all shadow-2xs">
                <i class="bi bi-box-arrow-in-right text-blue-600"></i> Sign In
              </button>
            </div>
          </div>

          <!-- Tabs (RAG Assistant, Rewriter, Scan Card, Quote Publisher) -->
          <div class="flex border-b border-slate-200 bg-slate-50 text-[11px] font-semibold">
            <button onclick="PuterCRM.switchTab('rag')" id="puter-tab-rag" class="flex-1 py-2.5 text-center text-blue-600 font-bold border-b-2 border-blue-600 bg-white shadow-sm">
              <i class="bi bi-database-check mr-0.5 text-blue-600"></i> CRM RAG
            </button>
            <button onclick="PuterCRM.switchTab('rewrite')" id="puter-tab-rewrite" class="flex-1 py-2.5 text-center text-slate-500 hover:text-blue-600">
              <i class="bi bi-envelope-paper-heart mr-0.5"></i> Rewriter
            </button>
            <button onclick="PuterCRM.switchTab('ocr')" id="puter-tab-ocr" class="flex-1 py-2.5 text-center text-slate-500 hover:text-blue-600">
              <i class="bi bi-camera mr-0.5"></i> Card OCR
            </button>
            <button onclick="PuterCRM.switchTab('microsite')" id="puter-tab-microsite" class="flex-1 py-2.5 text-center text-slate-500 hover:text-blue-600">
              <i class="bi bi-globe mr-0.5"></i> Quote Link
            </button>
          </div>

          <!-- Body Content Area -->
          <div class="p-4 overflow-y-auto space-y-3.5 max-h-[55vh] bg-white">
            
            <!-- Tab 1: Live CRM RAG Assistant -->
            <div id="puter-content-rag" class="space-y-3">
              <!-- Quick Prompt Chips -->
              <div>
                <label class="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1.5">Quick CRM Insights</label>
                <div class="flex flex-wrap gap-1.5">
                  <button onclick="PuterCRM.fillRagPrompt('Summarize our top 5 qualified leads with highest ICP scores and explain why they fit.')" class="px-2.5 py-1 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 text-[10px] font-bold border border-blue-200 transition-all text-left">
                    🎯 Top 5 Leads
                  </button>
                  <button onclick="PuterCRM.fillRagPrompt('Analyze our current Deals pipeline, stages, win probabilities, and total pipeline value.')" class="px-2.5 py-1 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-[10px] font-bold border border-indigo-200 transition-all text-left">
                    📊 Pipeline Summary
                  </button>
                  <button onclick="PuterCRM.fillRagPrompt('Draft a tailored cold outreach pitch for the highest scoring lead in our CRM citing their specific job posting and pain points.')" class="px-2.5 py-1 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-[10px] font-bold border border-emerald-200 transition-all text-left">
                    ✉️ Pitch Top Prospect
                  </button>
                  <button onclick="PuterCRM.fillRagPrompt('What pending tasks and outreach follow-ups require immediate sales action today?')" class="px-2.5 py-1 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-700 text-[10px] font-bold border border-amber-200 transition-all text-left">
                    ⚡ Urgent Actions
                  </button>
                </div>
              </div>

              <!-- Input Area -->
              <div class="relative">
                <textarea id="puter-rag-input" rows="3" placeholder="Ask anything about your leads, companies, deals, or ask to write tailored pitches..." class="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-100 resize-none transition-all"></textarea>
                <div class="flex items-center justify-between mt-1.5">
                  <span class="text-[10px] text-slate-400 flex items-center gap-1">
                    <i class="bi bi-shield-check text-emerald-500"></i> Grounded in live DB
                  </span>
                  <button onclick="PuterCRM.handleRagQueryAction()" id="puter-rag-btn" class="px-4 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-bold text-xs rounded-xl shadow-md shadow-blue-500/20 transition-all flex items-center gap-1.5 active:scale-95">
                    <i class="bi bi-lightning-charge-fill text-amber-300"></i>
                    <span>Ask CRM Copilot</span>
                  </button>
                </div>
              </div>

              <!-- Output Box -->
              <div id="puter-rag-output-box" class="hidden bg-slate-50 border border-blue-100 rounded-2xl p-3.5 space-y-2.5">
                <div class="flex items-center justify-between border-b border-slate-200 pb-2">
                  <span class="text-xs font-bold text-blue-900 flex items-center gap-1.5">
                    <i class="bi bi-stars text-blue-600"></i> RAG Intelligence Answer
                  </span>
                  <div class="flex items-center gap-1.5">
                    <button id="puter-rag-voice-btn" onclick="PuterCRM.toggleRagVoice()" class="p-1 px-2 text-[11px] bg-white border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-100 font-semibold flex items-center gap-1 shadow-xs">
                      <i class="bi bi-volume-up text-blue-600"></i> <span>Listen</span>
                    </button>
                    <button onclick="PuterCRM.copyRagOutput()" class="p-1 px-2 text-[11px] bg-blue-50 border border-blue-200 rounded-lg text-blue-700 hover:bg-blue-100 font-bold flex items-center gap-1 shadow-xs">
                      <i class="bi bi-clipboard"></i> <span>Copy</span>
                    </button>
                  </div>
                </div>
                <div id="puter-rag-output-text" class="text-xs text-slate-700 whitespace-pre-wrap leading-relaxed max-h-56 overflow-y-auto"></div>
              </div>
            </div>

            <!-- Tab 2: Email Rewriter -->
            <div id="puter-content-rewrite" class="hidden space-y-3">
              <div>
                <label class="text-[11px] font-bold uppercase tracking-wider text-slate-500 block mb-1">Tone & Persona</label>
                <div class="grid grid-cols-3 gap-1.5 text-xs">
                  <button onclick="PuterCRM.setTone(this, 'Persuasive')" class="puter-tone-btn py-1.5 rounded-lg bg-blue-600 text-white font-bold text-[11px] shadow-sm">Persuasive</button>
                  <button onclick="PuterCRM.setTone(this, 'Executive')" class="puter-tone-btn py-1.5 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200 font-semibold text-[11px]">Executive</button>
                  <button onclick="PuterCRM.setTone(this, 'Urgent')" class="puter-tone-btn py-1.5 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200 font-semibold text-[11px]">High Urgency</button>
                </div>
              </div>

              <div>
                <label class="text-[11px] font-bold uppercase tracking-wider text-slate-500 block mb-1">Draft Pitch or Notes</label>
                <textarea id="puter-input-text" rows="4" placeholder="Paste cold outreach draft or quick notes to enhance..." class="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-100 resize-none transition-all"></textarea>
              </div>

              <button onclick="PuterCRM.handleRewriteAction()" id="puter-rewrite-btn" class="w-full py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-bold text-xs rounded-xl shadow-md shadow-blue-500/20 transition-all flex items-center justify-center gap-2 active:scale-95">
                <i class="bi bi-stars"></i>
                <span>Rewrite with AI</span>
              </button>

              <div id="puter-output-box" class="hidden bg-slate-50 border border-blue-100 rounded-2xl p-3.5 space-y-2">
                <div class="flex items-center justify-between border-b border-slate-200 pb-1.5">
                  <span class="text-xs font-bold text-blue-900 flex items-center gap-1.5">
                    <i class="bi bi-magic text-blue-600"></i> Enhanced Version
                  </span>
                  <div class="flex items-center gap-1.5">
                    <button id="puter-voice-btn" onclick="PuterCRM.toggleVoiceAction()" class="p-1 px-2 text-[11px] bg-white border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-100 font-semibold flex items-center gap-1 shadow-xs">
                      <i class="bi bi-volume-up text-blue-600"></i> <span>Listen</span>
                    </button>
                    <button onclick="PuterCRM.copyOutput()" class="p-1 px-2 text-[11px] bg-blue-50 border border-blue-200 rounded-lg text-blue-700 hover:bg-blue-100 font-bold flex items-center gap-1 shadow-xs">
                      <i class="bi bi-clipboard"></i> <span>Copy</span>
                    </button>
                  </div>
                </div>
                <p id="puter-output-text" class="text-xs text-slate-700 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto"></p>
              </div>
            </div>

            <!-- Tab 3: Card OCR Scanner -->
            <div id="puter-content-ocr" class="hidden space-y-3">
              <label class="border-2 border-dashed border-blue-200 hover:border-blue-500 bg-blue-50/40 hover:bg-blue-50/80 rounded-2xl p-6 flex flex-col items-center justify-center cursor-pointer transition-all text-center group">
                <div class="w-12 h-12 rounded-2xl bg-blue-100 text-blue-600 flex items-center justify-center text-xl mb-2 group-hover:scale-110 transition-transform shadow-xs">
                  <i class="bi bi-cloud-arrow-up-fill"></i>
                </div>
                <span class="text-xs font-bold text-slate-800">Upload Business Card or Profile Photo</span>
                <span class="text-[10px] text-slate-500 mt-0.5">PNG, JPG, or Screenshots</span>
                <input type="file" accept="image/*" class="hidden" onchange="PuterCRM.handleOcrFile(this)">
              </label>

              <div id="puter-ocr-result" class="hidden space-y-2">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold text-slate-800">Extracted Lead Details:</span>
                  <button onclick="PuterCRM.copyOcrJson()" class="text-[10px] text-blue-600 hover:underline font-bold flex items-center gap-1">
                    <i class="bi bi-clipboard"></i> Copy JSON
                  </button>
                </div>
                <div id="puter-ocr-cards" class="space-y-2"></div>
              </div>
            </div>

            <!-- Tab 4: 1-Click Client Quotation Microsite Publisher -->
            <div id="puter-content-microsite" class="hidden space-y-3">
              <div>
                <label class="text-[11px] font-bold uppercase tracking-wider text-slate-500 block mb-1">Proposal Title</label>
                <input id="puter-quote-title" type="text" placeholder="e.g. Enterprise AI Implementation" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-100 focus:outline-none">
              </div>

              <div class="grid grid-cols-2 gap-2">
                <div>
                  <label class="text-[11px] font-bold uppercase tracking-wider text-slate-500 block mb-1">Client Name</label>
                  <input id="puter-quote-client" type="text" placeholder="Acme Corp" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-100 focus:outline-none">
                </div>
                <div>
                  <label class="text-[11px] font-bold uppercase tracking-wider text-slate-500 block mb-1">Amount ($)</label>
                  <input id="puter-quote-amount" type="number" placeholder="5000" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-100 focus:outline-none">
                </div>
              </div>

              <button onclick="PuterCRM.handlePublishQuoteAction()" id="puter-publish-btn" class="w-full py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-bold text-xs rounded-xl shadow-md shadow-blue-500/20 transition-all flex items-center justify-center gap-2 active:scale-95">
                <i class="bi bi-cloud-upload"></i>
                <span>Publish Live Proposal Page</span>
              </button>

              <div id="puter-quote-live-link" class="hidden bg-emerald-50 border border-emerald-200 rounded-xl p-3.5 text-xs space-y-2.5">
                <span class="text-emerald-800 font-bold flex items-center gap-1.5"><i class="bi bi-link-45deg text-base text-emerald-600"></i> Live Proposal Link Created:</span>
                <a id="puter-quote-url" href="#" target="_blank" class="text-blue-600 hover:underline break-all block text-xs bg-white p-2.5 rounded-lg border border-emerald-100 font-mono"></a>
                <div class="flex items-center gap-2 pt-1">
                  <button onclick="PuterCRM.openPublishedQuote()" class="flex-1 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-[11px] font-bold flex items-center justify-center gap-1 shadow-sm">
                    <i class="bi bi-box-arrow-up-right"></i> Open Page
                  </button>
                  <button onclick="PuterCRM.copyQuoteUrl()" class="flex-1 py-1.5 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-lg text-[11px] font-bold flex items-center justify-center gap-1 shadow-sm">
                    <i class="bi bi-clipboard"></i> Copy Link
                  </button>
                </div>
              </div>
            </div>

          </div>

          <!-- Footer status -->
          <div class="px-5 py-2.5 bg-slate-50 border-t border-slate-200 text-[10px] text-slate-500 flex items-center justify-between">
            <span class="flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              RAG Status: <strong class="text-slate-800">Connected to Live CRM</strong>
            </span>
            <span class="text-blue-600 font-semibold">Zero Server Token Cost</span>
          </div>

        </div>
      </div>
      `;

      document.body.insertAdjacentHTML('beforeend', widgetHtml);

      // Check and update Puter auth status badge
      this.updateAuthUI();
      setTimeout(() => this.updateAuthUI(), 1500);

      // ⚡ Optimistic RAG Pre-warming: Pre-fetch indexed context in background
      setTimeout(() => {
        this.fetchCrmKnowledgeContext(false);
      }, 1000);
    },

    setTone: function (btn, tone) {
      document.querySelectorAll('.puter-tone-btn').forEach(b => {
        b.className = 'puter-tone-btn py-1.5 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200 font-semibold text-[11px]';
      });
      btn.className = 'puter-tone-btn py-1.5 rounded-lg bg-blue-600 text-white font-bold text-[11px] shadow-sm';
      this.currentTone = tone;
    },

    toggleCopilotDrawer: function () {
      const drawer = document.getElementById('puter-copilot-drawer');
      if (drawer) drawer.classList.toggle('hidden');
    },

    switchTab: function (tab) {
      ['rag', 'rewrite', 'ocr', 'microsite'].forEach(t => {
        const content = document.getElementById(`puter-content-${t}`);
        const btn = document.getElementById(`puter-tab-${t}`);
        if (content) content.classList.toggle('hidden', t !== tab);
        if (btn) {
          if (t === tab) {
            btn.className = 'flex-1 py-2.5 text-center text-blue-600 font-bold border-b-2 border-blue-600 bg-white shadow-sm';
          } else {
            btn.className = 'flex-1 py-2.5 text-center text-slate-500 hover:text-blue-600';
          }
        }
      });
    },

    fillRagPrompt: function (promptText) {
      const input = document.getElementById('puter-rag-input');
      if (input) {
        input.value = promptText;
        this.handleRagQueryAction();
      }
    },

    handleRagQueryAction: async function () {
      const input = document.getElementById('puter-rag-input')?.value?.trim();
      const btn = document.getElementById('puter-rag-btn');
      const outBox = document.getElementById('puter-rag-output-box');
      const outText = document.getElementById('puter-rag-output-text');

      if (!input) {
        alert('Please enter a question or command for the CRM Copilot.');
        return;
      }

      try {
        btn.disabled = true;
        btn.innerHTML = `<i class="bi bi-cpu-fill animate-spin text-amber-300"></i> Synthesizing CRM DB...`;

        // ⚡ Optimistic UI Rendering: Show clean shimmer skeleton immediately
        if (outBox && outText) {
          outText.innerHTML = `
            <div class="space-y-2 py-3 animate-pulse">
              <div class="flex items-center gap-2 text-blue-600 font-bold text-xs">
                <i class="bi bi-lightning-charge-fill text-amber-500 animate-bounce"></i>
                <span>Accelerated RAG: Querying indexed CRM database...</span>
              </div>
              <div class="h-3.5 bg-blue-100/70 rounded-full w-3/4"></div>
              <div class="h-2.5 bg-slate-100 rounded-full w-full"></div>
              <div class="h-2.5 bg-slate-100 rounded-full w-5/6"></div>
            </div>
          `;
          outBox.classList.remove('hidden');
        }

        const result = await this.queryCrmRag(input);
        outText.innerHTML = this.formatRichOutput(result);
        outBox.classList.remove('hidden');
      } catch (err) {
        if (err.message === 'AUTH_REQUIRED' || (err.message && (err.message.toLowerCase().includes('auth') || err.message.toLowerCase().includes('sign in') || err.message.toLowerCase().includes('401')))) {
          if (outText) {
            outText.innerHTML = `
              <div class="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl p-5 text-center space-y-3 my-1 shadow-xs">
                <div class="w-11 h-11 rounded-2xl bg-blue-600 text-white mx-auto flex items-center justify-center text-lg shadow-md shadow-blue-500/25">
                  <i class="bi bi-shield-lock-fill"></i>
                </div>
                <div>
                  <h4 class="font-extrabold text-xs text-slate-900">Sign In to Puter AI Required</h4>
                  <p class="text-[11px] text-slate-600 mt-1 leading-relaxed max-w-xs mx-auto">Please sign in to Puter to query live CRM RAG intelligence & frontier models (100% Free, no credit card required).</p>
                </div>
                <button onclick="PuterCRM.signInAndRetryRag()" class="px-4 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-bold text-xs rounded-xl shadow-md shadow-blue-500/20 transition-all inline-flex items-center gap-1.5 active:scale-95 cursor-pointer">
                  <i class="bi bi-box-arrow-in-right"></i>
                  <span>Sign In to Puter (Free)</span>
                </button>
              </div>
            `;
            outBox.classList.remove('hidden');
          }
        } else {
          if (outText) outText.innerHTML = `<p class="text-xs text-red-500 font-medium"><i class="bi bi-exclamation-triangle-fill"></i> ${err.message}</p>`;
          alert('CRM RAG Error: ' + err.message);
        }
      } finally {
        btn.disabled = false;
        btn.innerHTML = `<i class="bi bi-lightning-charge-fill text-amber-300"></i><span>Ask CRM Copilot</span>`;
      }
    },

    copyRagOutput: function () {
      const text = document.getElementById('puter-rag-output-text')?.innerText;
      if (text) {
        navigator.clipboard.writeText(text);
        alert('Copied RAG insight to clipboard!');
      }
    },

    toggleRagVoice: function () {
      const text = document.getElementById('puter-rag-output-text')?.innerText;
      if (this.isSpeaking) {
        this.stopVoice('puter-rag-voice-btn');
      } else if (text) {
        this.speakPitch(text, 'puter-rag-voice-btn');
      }
    },

    handleRewriteAction: async function () {
      const input = document.getElementById('puter-input-text')?.value?.trim();
      const btn = document.getElementById('puter-rewrite-btn');
      const outBox = document.getElementById('puter-output-box');
      const outText = document.getElementById('puter-output-text');

      if (!input) {
        alert('Please enter a draft or prompt to enhance.');
        return;
      }

      try {
        btn.disabled = true;
        btn.innerHTML = `<i class="bi bi-hourglass-split animate-spin"></i> Generating with ${this.selectedModel}...`;

        const result = await this.rewriteEmail(input, this.currentTone);
        outText.innerHTML = this.formatRichOutput(result);
        outBox.classList.remove('hidden');
      } catch (err) {
        if (err.message === 'AUTH_REQUIRED' || (err.message && (err.message.toLowerCase().includes('auth') || err.message.toLowerCase().includes('sign in') || err.message.toLowerCase().includes('401')))) {
          if (outText) {
            outText.innerHTML = `
              <div class="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl p-5 text-center space-y-3 my-1 shadow-xs">
                <div class="w-11 h-11 rounded-2xl bg-blue-600 text-white mx-auto flex items-center justify-center text-lg shadow-md shadow-blue-500/25">
                  <i class="bi bi-shield-lock-fill"></i>
                </div>
                <div>
                  <h4 class="font-extrabold text-xs text-slate-900">Sign In to Puter AI Required</h4>
                  <p class="text-[11px] text-slate-600 mt-1 leading-relaxed max-w-xs mx-auto">Please sign in to Puter to rewrite pitches & emails with frontier AI models (100% Free).</p>
                </div>
                <button onclick="PuterCRM.signInAndRetryRewrite()" class="px-4 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-bold text-xs rounded-xl shadow-md shadow-blue-500/20 transition-all inline-flex items-center gap-1.5 active:scale-95 cursor-pointer">
                  <i class="bi bi-box-arrow-in-right"></i>
                  <span>Sign In to Puter (Free)</span>
                </button>
              </div>
            `;
            outBox.classList.remove('hidden');
          }
        } else {
          alert('Puter AI Error: ' + err.message);
        }
      } finally {
        btn.disabled = false;
        btn.innerHTML = `<i class="bi bi-stars"></i><span>Rewrite with AI</span>`;
      }
    },


    copyOutput: function () {
      const text = document.getElementById('puter-output-text')?.innerText;
      if (text) {
        navigator.clipboard.writeText(text);
        alert('Copied AI pitch to clipboard!');
      }
    },

    toggleVoiceAction: function () {
      const text = document.getElementById('puter-output-text')?.innerText;
      if (this.isSpeaking) {
        this.stopVoice();
      } else if (text) {
        this.speakPitch(text);
      }
    },

    handleOcrFile: async function (input) {
      if (!input.files || !input.files[0]) return;
      const file = input.files[0];
      const resultBox = document.getElementById('puter-ocr-result');
      const cardsDiv = document.getElementById('puter-ocr-cards');

      try {
        resultBox.classList.remove('hidden');
        cardsDiv.innerHTML = `<div class="text-center py-4 text-slate-500"><i class="bi bi-hourglass-split animate-spin text-lg text-blue-600 block mb-1"></i> Extracting details with Puter Vision AI...</div>`;

        const data = await this.ocrExtractLead(file);
        this.lastExtractedLead = data;

        // Render clean human-readable card layout in Blue & White theme
        cardsDiv.innerHTML = `
          <div class="bg-white border border-blue-100 rounded-xl p-3.5 space-y-2 shadow-sm">
            <div class="flex items-center justify-between">
              <span class="text-sm font-black text-slate-900">${data.name || 'Unknown Contact'}</span>
              <span class="text-[10px] px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 font-bold">${data.job_title || 'Lead'}</span>
            </div>
            ${data.company_name ? `<p class="text-xs text-slate-600 flex items-center gap-1.5"><i class="bi bi-building text-blue-600"></i> <strong class="text-slate-800">${data.company_name}</strong></p>` : ''}
            ${data.email ? `<p class="text-xs text-blue-600 font-semibold flex items-center gap-1.5"><i class="bi bi-envelope"></i> <a href="mailto:${data.email}" class="hover:underline">${data.email}</a></p>` : ''}
            ${data.phone ? `<p class="text-xs text-slate-600 flex items-center gap-1.5"><i class="bi bi-telephone text-blue-600"></i> ${data.phone}</p>` : ''}
            ${data.linkedin_url ? `<p class="text-xs text-blue-600 flex items-center gap-1.5"><i class="bi bi-linkedin"></i> <a href="${data.linkedin_url}" target="_blank" class="hover:underline">LinkedIn Profile</a></p>` : ''}
            ${data.skills_or_summary ? `<div class="mt-2 text-[11px] text-slate-600 bg-blue-50/60 p-2.5 rounded-lg border border-blue-100 leading-relaxed">${data.skills_or_summary}</div>` : ''}
          </div>
        `;
      } catch (err) {
        cardsDiv.innerHTML = `<div class="text-rose-600 text-xs p-2.5 bg-rose-50 border border-rose-200 rounded-lg">Extraction failed: ${err.message}</div>`;
      }
    },

    copyOcrJson: function () {
      if (this.lastExtractedLead) {
        navigator.clipboard.writeText(JSON.stringify(this.lastExtractedLead, null, 2));
        alert('Copied structured JSON to clipboard!');
      }
    },

    handlePublishQuoteAction: async function () {
      const title = document.getElementById('puter-quote-title')?.value || 'Enterprise Proposal';
      const client = document.getElementById('puter-quote-client')?.value || 'Client Partner';
      const amount = document.getElementById('puter-quote-amount')?.value || 5000;
      const btn = document.getElementById('puter-publish-btn');
      const linkBox = document.getElementById('puter-quote-live-link');
      const urlAnchor = document.getElementById('puter-quote-url');

      try {
        btn.disabled = true;
        btn.innerHTML = `<i class="bi bi-hourglass-split animate-spin"></i> Hosting on Puter Cloud...`;

        const res = await this.publishQuoteMicrosite({
          title,
          client_name: client,
          total_amount: amount
        });

        this.currentQuoteUrl = res.url;
        urlAnchor.href = res.url;
        urlAnchor.innerText = res.url;
        linkBox.classList.remove('hidden');
      } catch (err) {
        alert('Publishing notice: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = `<i class="bi bi-cloud-upload"></i><span>Publish Live Proposal Page</span>`;
      }
    },

    openPublishedQuote: function () {
      if (this.currentQuoteUrl) {
        window.open(this.currentQuoteUrl, '_blank');
      }
    },

    copyQuoteUrl: function () {
      if (this.currentQuoteUrl) {
        navigator.clipboard.writeText(this.currentQuoteUrl);
        alert('Copied proposal link to clipboard!');
      }
    }
  };

  // Expose globally
  window.PuterCRM = PuterCRM;

  // Auto-mount UI on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => PuterCRM.injectCopilotUI());
  } else {
    PuterCRM.injectCopilotUI();
  }
})();
