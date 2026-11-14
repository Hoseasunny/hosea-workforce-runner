const fs = require("node:fs");
const path = require("node:path");

const API_URL = (process.env.WORKFORCE_API_URL || "https://hosea-ai-workforce.hatchable.site/api").replace(/\/+$/, "");

const TOKEN = process.env.WORKFORCE_RUNNER_TOKEN;

const WORKER_ID = process.env.WORKFORCE_WORKER_ID || "hosea-laptop";

const POLL_MS = Number(process.env.WORKFORCE_POLL_MS || 15000);
const MODEL_RETRY_MS = Number(process.env.MODEL_RETRY_MS || 30000);
const { generateWithModel, getModelStatus } = require("./model-router.cjs");



if (!TOKEN) {

   console.error("WORKFORCE_RUNNER_TOKEN is not configured.");

   process.exit(1);

}



async function integrationRequest(service, operation, payload = {}) {

   const response = await fetch(`${API_URL}/integrations`, {

      method: "POST",

      headers: {

         "Content-Type": "application/json",

         "Authorization": `Bearer ${TOKEN}`

      },

      body: JSON.stringify({

         worker_id: WORKER_ID,

         service,

         operation,

         ...payload

      }),

      signal: AbortSignal.timeout(30000)

   });



   const body = await response.json().catch(() => ({}));



   if (!response.ok || body.ok === false) {

      throw new Error(

         body.error || body.message || `Integration HTTP ${response.status}`

      );

   }



   return body;

}

async function generateAgentResponse(task, context, agent) {
  const systemPrompt = [
    "You are a specialist worker inside Hosea AI Workforce.",
    "Produce a useful, clear, task-specific response.",
    "Use only the task details and supplied context. Do not invent facts, tests, files, actions, sources, or results.",
    "If information is missing, state what is missing and give the next practical step.",
    "When source URLs are supplied, preserve them exactly and attach them to the relevant claims. Never invent URLs.",
    "Do not claim that code was changed, software was tested, a deployment happened, or an external action succeeded unless the supplied context proves it.",
    "Keep the response structured with useful headings and actionable steps."
  ].join(" ");

  const userPrompt = [
    `Assigned agent: ${agent}`,
    `Task title: ${String(task.title || "Untitled task")}`,
    `Task description: ${String(task.description || "No description supplied.")}`,
    "",
    "Existing task context, evidence or planning outline:",
    String(context || "No additional context supplied.").slice(0, 9000),
    "",
    "Collaboration context from completed predecessor agents:",
    String(task.collaboration_context || "No predecessor reports supplied.").slice(0, 9000),
    "",
    "Now produce the final response for this task. Be specific and do not repeat generic filler."
  ].join("\n");

  while (true) {
    try {
      return await generateWithModel({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        agent,
        allowCloud: false
      });
    } catch (error) {
      if (/Local Ollama is unavailable|No free model is currently available/i.test(error.message)) {
        console.error(
          `[Model] Local engine unavailable for task #${task.id}. ` +
          `Waiting ${Math.round(MODEL_RETRY_MS / 1000)} seconds; no cloud or paid fallback will be used.`
        );
        await new Promise(resolve => setTimeout(resolve, MODEL_RETRY_MS));
        continue;
      }
      throw error;
    }
  }
}

async function saveResearchToNotion(task, result) {
   const parentId = process.env.NOTION_PARENT_PAGE_ID;
   if (!parentId) {
      throw new Error("NOTION_PARENT_PAGE_ID is missing from .env.txt");
   }

   const agent = String(task.assigned_agent_id || "research");
   const taskTitle = String(task.title || "Research").slice(0, 75);
   const pageTitle = `Task ${task.id} - ${agent} - ${taskTitle}`;

   // Search first so retries do not create duplicate report pages.
   const search = await integrationRequest("notion", "search", {
      query: pageTitle
   });
   const pages = search?.result?.data?.results || [];

   function getPageTitle(page) {
      const properties = page?.properties || {};
      for (const property of Object.values(properties)) {
         if (property?.type === "title" && Array.isArray(property.title)) {
            return property.title
               .map(item => item.plain_text || item.text?.content || "")
               .join("");
         }
      }
      return "";
   }

   const existingPage = pages.find(page => getPageTitle(page) === pageTitle);
   if (existingPage) {
      if (!existingPage.id || !existingPage.url) {
         throw new Error("A matching Notion report was found, but its page ID or URL was missing.");
      }
      return `existing report verified: ${existingPage.url}`;
   }

   // The integration endpoint accepts at most 10 paragraphs. Keep metadata
   // in one paragraph and split the findings into bounded paragraphs.
   const metadata = [
      "HOSEA AI WORKFORCE RESEARCH REPORT",
      `Agent: ${agent}`,
      `Task ID: ${task.id}`,
      `Task: ${taskTitle}`,
      `Worker: ${WORKER_ID}`,
      `Generated: ${new Date().toISOString()}`
   ].join(" | ");

   const findings = String(result || "No findings were returned.")
      .replace(/\r\n?/g, "\n")
      .trim();
   const chunks = [];
   const chunkSize = 1400;
   for (let offset = 0; offset < findings.length && chunks.length < 8; offset += chunkSize) {
      chunks.push(findings.slice(offset, offset + chunkSize));
   }
   const omittedChars = Math.max(0, findings.length - chunks.length * chunkSize);
   if (omittedChars > 0) {
      const last = chunks.length - 1;
      chunks[last] = chunks[last].slice(0, 1250) +
         `\n[Report truncated; ${omittedChars} additional characters omitted.]`;
   }

   const content = [
      metadata,
      "RESEARCH FINDINGS",
      ...chunks
   ].join("\n\n");

   const created = await integrationRequest("notion", "create_page", {
      parent_page_id: parentId,
      title: pageTitle,
      content
   });

   // The API can return HTTP success without a usable page object. Do not
   // report success unless Notion returns both the page ID and its URL.
   const page = created?.result?.page;
   if (!page?.id || !page?.url) {
      throw new Error("Notion did not confirm page creation (page ID or URL missing). The report was not marked as saved.");
   }

   return `report created and verified: ${page.url}`;
}

async function researchTask(task) {

   const description = String(task.description || "");

   const marker = description.indexOf("Your responsibility:");



   let objective = description.startsWith("Parent objective:")

      ? description.slice(

            "Parent objective:".length,

            marker >= 0 ? marker : undefined

         )

      : description;



   objective = objective

      .replace(/^[\s\\n]+|[\s\\n]+$/g, "")

      .trim();



   if (!objective) objective = task.title;



   const query = (

      objective

         .replace(/^(research|compare|investigate|find|identify|gather|prepare)\s+/i, "")

         .split(/[.!?\r\n]/)[0]

         .replace(/\s+/g, " ")

         .trim()

         .slice(0, 160) || String(task.title || "web application security")

   );



   async function fetchJson(url) {

      const response = await fetch(url, {

         headers: {

            "Accept": "application/json",

            "User-Agent": "HoseaAIWorkforce/1.0"

         },

         signal: AbortSignal.timeout(15000)

      });



      if (!response.ok) {

         throw new Error(`Source returned HTTP ${response.status}`);

      }



      return response.json();

   }



   function cleanText(value) {

      return String(value || "")

         .replace(/<[^>]*>/g, " ")

         .replace(/&quot;/g, '"')

         .replace(/&#39;/g, "'")

         .replace(/&amp;/g, "&")

         .replace(/&lt;/g, "<")

         .replace(/&gt;/g, ">")

         .replace(/\s+/g, " ")

         .trim();

   }



   function reconstructAbstract(index) {

      if (!index || typeof index !== "object") return "";



      const words = [];



      for (const [word, positions] of Object.entries(index)) {

         for (const position of positions) {

            words[position] = word;

         }

      }



      return words.filter(Boolean).join(" ");

   }



   const wikipediaUrl =

      "https://en.wikipedia.org/w/api.php?action=query" +

      "&list=search&srsearch=" + encodeURIComponent(query) +

      "&srlimit=5&format=json&utf8=1";



   const openAlexUrl =

      "https://api.openalex.org/works?search=" +

      encodeURIComponent(query) +

      "&per-page=5" +

      "&select=title,doi,publication_year,authorships,primary_location,abstract_inverted_index";



   const [wikiResult, academicResult, firecrawlResult] = await Promise.allSettled([

      fetchJson(wikipediaUrl),

      fetchJson(openAlexUrl),

      integrationRequest("firecrawl", "search", {

         query,

         limit: 5

      })

   ]);



   const lines = [

      "RESEARCH EVIDENCE BRIEF",

      "=======================",

      "",

      `Research question: ${query}`,

      `Generated: ${new Date().toISOString()}`,

      ""

   ];



   let sourceCount = 0;



   if (wikiResult.status === "fulfilled") {

      const articles = wikiResult.value.query?.search || [];



      lines.push("1. PUBLIC BACKGROUND SOURCES");

      lines.push("");



      for (const [index, article] of articles.entries()) {

         const title = cleanText(article.title);

         const snippet = cleanText(article.snippet);

         const link =

            "https://en.wikipedia.org/wiki/" +

            encodeURIComponent(title.replace(/ /g, "_"));



         lines.push(`${index + 1}. ${title}`);

         lines.push(`    Finding: ${snippet}`);

         lines.push(`    Source: ${link}`);

         lines.push("");

         sourceCount++;

      }



      if (!articles.length) {

         lines.push("No matching Wikipedia articles found.");

         lines.push("");

      }

   } else {

      lines.push("Wikipedia unavailable: " + wikiResult.reason.message);

      lines.push("");

   }



   if (academicResult.status === "fulfilled") {

      const works = academicResult.value.results || [];



      lines.push("2. SCHOLARLY PUBLICATIONS");

      lines.push("");



      for (const [index, work] of works.entries()) {

         const title = cleanText(work.title || "Untitled publication");

         const year = work.publication_year || "Year unavailable";



         const authors = (work.authorships || [])

            .slice(0, 3)

            .map(item => item.author?.display_name)

            .filter(Boolean)

            .join(", ");



         const abstract = reconstructAbstract(

            work.abstract_inverted_index

         );



         const link =

            work.doi ||

            work.primary_location?.landing_page_url ||

            work.id ||

            "Link unavailable";



         lines.push(`${index + 1}. ${title}`);

         lines.push(`    Year: ${year}`);



         if (authors) lines.push(`    Authors: ${authors}`);



         lines.push(

            `    Abstract: ${

               abstract

                  ? abstract.slice(0, 900)

                  : "No abstract available in public metadata."

            }`

         );



         lines.push(`    Source: ${link}`);

         lines.push("");

         sourceCount++;

      }



      if (!works.length) {

         lines.push("No matching publications found.");

         lines.push("");

      }

   } else {

      lines.push("OpenAlex unavailable: " + academicResult.reason.message);

      lines.push("");

   }



   if (firecrawlResult.status === "fulfilled") {

      const payload = firecrawlResult.value?.result?.data;

      const webResults = Array.isArray(payload?.data) ? payload.data : [];



      lines.push("3. WEB RESEARCH SOURCES (FIRECRAWL)");

      lines.push("");



      for (const [index, result] of webResults.entries()) {

         const title = cleanText(result.title || "Untitled source");

         const description = cleanText(result.description || "");

         const url = String(result.url || "");



         if (!url.startsWith("https://") && !url.startsWith("http\://")) {

            continue;

         }



         lines.push(`${index + 1}. ${title}`);

         if (description) {

            lines.push(`    Finding: ${description.slice(0, 700)}`);

         }

         lines.push(`    Source: ${url}`);

         lines.push("");

         sourceCount++;

      }



      if (!webResults.length) {

         lines.push("Firecrawl returned no matching web sources.");

         lines.push("");

      }

   } else {

      lines.push("Firecrawl unavailable: " + firecrawlResult.reason.message);

      lines.push("");

   }

   if (sourceCount === 0) {

      throw new Error(

         "No usable research sources were retrieved. Check internet access and retry."

      );

   }



   lines.push("3. RESEARCH NOTES");

   lines.push("");

   lines.push(

      `Retrieved ${sourceCount} source records from public information services.`

   );

   lines.push(

      "Review the linked sources before relying on individual claims."

   );

   lines.push(

      "This automated report collects and organises evidence; it does not independently verify every claim."

   );



   return lines.join("\n");

}



async function webResearchTask(task) {

   const agent = task.assigned_agent_id;

   const description = String(task.description || "");

   const marker = description.indexOf("Your responsibility:");



   let objective = description.startsWith("Parent objective:")

      ? description.slice("Parent objective:".length, marker >= 0 ? marker : undefined)

      : description;



   objective = objective.trim() || String(task.title || "Research");



   const modifiers = {

      "security-research": "OWASP NIST CISA official web application security defensive controls",

      "opportunities": "Kenya scholarships internships grants competitions eligibility official application",

      "freelance": "remote freelance jobs projects hiring platforms application requirements",

      "business-dev": "Kenya business market research customers leads service opportunities",

      "learning": "free official learning resources courses labs tutorials"

   };



   const query = (objective + " " + (modifiers[agent] || ""))

      .replace(/\s+/g, " ")

      .trim()

      .slice(0, 300);



   const response = await integrationRequest("firecrawl", "search", {

      query,

      limit: 5

   });



   const payload = response?.result?.data;

   const results = Array.isArray(payload?.data) ? payload.data : [];



   if (!results.length) {

      throw new Error("Firecrawl returned no usable sources for: " + query);

   }



   const lines = [

      "SPECIALIST EVIDENCE REPORT",

      "==========================",

      "",

      "Agent: " + agent,

      "Task: " + task.title,

      "Research query: " + query,

      "Generated: " + new Date().toISOString(),

      "",

      "PUBLIC SOURCES",

      ""

   ];



   let count = 0;



   for (const item of results) {

      const url = String(item.url || "").trim();

      if (!/^https?:\/\//i.test(url)) continue;



      lines.push((count + 1) + ". " + String(item.title || "Untitled source"));

      lines.push("Finding: " + String(item.description || "No description available").replace(/\s+/g, " ").slice(0, 900));

      lines.push("Source: " + url);

      lines.push("");

      count++;

   }



   if (!count) throw new Error("No valid source URLs were returned.");



   lines.push("RESULTS: " + count + " public sources retrieved.");

   lines.push("Review the source links before relying on individual claims.");



   if (agent === "opportunities" || agent === "freelance") {

      lines.push("");

      lines.push("VERIFICATION: These are leads, not guaranteed offers. Verify the employer, eligibility, deadlines and fees. Never pay to apply without independently checking legitimacy.");

   }



   if (agent === "security-research") {

      lines.push("");

      lines.push("SAFETY: These are research references, not proof of vulnerabilities. Test only systems for which you have permission.");

   }



   return lines.join("\n");

}



const handlers = {

   "research": researchTask,



   "project-manager": task => [

      "PROJECT MANAGEMENT PLAN",

      `Task: ${task.title}`,

      "",

      "1. Clarify the expected outcome.",

      "2. Break the work into measurable milestones.",

      "3. Identify dependencies and risks.",

      "4. Assign responsibilities.",

      "5. Define completion criteria.",

      "",

      "Planning only; no project changes were made."

   ].join("\n"),



   "learning": webResearchTask,

   "security-research": webResearchTask,

   "opportunities": webResearchTask,

   "freelance": webResearchTask,

   "business-dev": webResearchTask,



   "data-analyst": task => [
      "DATA ANALYSIS PLAN",
      `Task: ${task.title}`,
      "",
      "1. Define the question, decision and measurable outcome.",
      "2. Identify required datasets, owners, formats and collection limits.",
      "3. Check missing values, duplicates, outliers and data quality.",
      "4. Select suitable descriptive statistics and visualisations.",
      "5. State assumptions, limitations and reproducible validation steps.",
      "",
      "Planning only; no datasets were accessed or modified."
   ].join("\n"),

   "finance": task => [
      "FINANCE AND EARNINGS TRACKING PLAN",
      `Task: ${task.title}`,
      "",
      "1. Define the financial objective and reporting period.",
      "2. List income sources, expenses and relevant evidence.",
      "3. Separate confirmed transactions from estimates and forecasts.",
      "4. Calculate totals, net cash flow and category-level trends.",
      "5. Flag missing records, risks and decisions requiring human approval.",
      "",
      "Planning only; no accounts were accessed and no transactions were made."
   ].join("\n"),

   "qa": task => [

      "QA TEST PLAN",

      `Task: ${task.title}`,

      "",

      "1. Identify expected behaviour.",

      "2. List normal usage scenarios.",

      "3. List invalid-input scenarios.",

      "4. Check error handling.",

      "5. Record defects and reproduction steps.",

      "",

      "Planning only; no application was tested."

   ].join("\n"),



   "frontend": task => [

      "FRONTEND IMPLEMENTATION PLAN",

      `Task: ${task.title}`,

      "",

      "1. Inspect the existing frontend structure.",

      "2. Identify relevant components.",

      "3. Check responsive behaviour.",

      "4. Plan the requested interface changes.",

      "5. Check accessibility and browser behaviour.",

      "",

      "Planning only; no source files were changed."

   ].join("\n"),



   "backend": task => [

      "BACKEND IMPLEMENTATION PLAN",

      `Task: ${task.title}`,

      "",

      "1. Identify required API behaviour.",

      "2. Review existing routes and validation.",

      "3. Check authentication and authorization.",

      "4. Plan error handling.",

      "5. Define endpoint tests.",

      "",

      "Planning only; no backend code was changed."

   ].join("\n"),



   "database": task => [

      "DATABASE PLAN",

      `Task: ${task.title}`,

      "",

      "1. Identify required data.",

      "2. Review the existing schema.",

      "3. Plan tables and relationships.",

      "4. Check constraints and indexes.",

      "5. Prepare and test a migration.",

      "",

      "Planning only; no database changes were made."

   ].join("\n"),



   "devops": task => [

      "DEVOPS PLAN",

      `Task: ${task.title}`,

      "",

      "1. Inspect the deployment environment.",

      "2. Review configuration and dependencies.",

      "3. Check build and test requirements.",

      "4. Prepare a deployment checklist.",

      "5. Require human approval before deployment.",

      "",

      "Planning only; nothing was deployed or modified."

   ].join("\n"),



   "pentest": task => [

      "PENETRATION TESTING SAFETY CHECK",

      `Task: ${task.title}`,

      "",

      "Testing is blocked until written authorization and scope are provided.",

      "Required: target assets, permitted techniques, testing window,",

      "excluded systems, emergency contact, and owner approval.",

      "",

      "No scanning, exploitation, or access attempts were performed."

   ].join("\n")

};



const OUTBOX_PATH = path.join(__dirname, "runner-outbox.json");

function readOutbox() {
  try {
    const parsed = JSON.parse(fs.readFileSync(OUTBOX_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    console.error("[Outbox] Could not read outbox:", error.message);
    throw error;
  }
}

function writeOutbox(items) {
  const temporaryPath = OUTBOX_PATH + ".tmp";
  fs.writeFileSync(temporaryPath, JSON.stringify(items, null, 2), "utf8");
  fs.renameSync(temporaryPath, OUTBOX_PATH);
}

function queueReport(report) {
  const items = readOutbox().filter(item => Number(item.task_id) !== Number(report.task_id));
  items.push({ ...report, queued_at: new Date().toISOString() });
  writeOutbox(items);
}

async function sendReport(report) {
  queueReport(report);
  try {
    const response = await request("report", report);
    const remaining = readOutbox().filter(item =>
      !(Number(item.task_id) === Number(report.task_id) && item.status === report.status)
    );
    writeOutbox(remaining);
    return response;
  } catch (error) {
    console.error(`[Outbox] Task #${report.task_id} saved locally; server submission will be retried: ${error.message}`);
    return { queued: true };
  }
}

async function flushOutbox() {
  const pending = readOutbox();
  if (!pending.length) return;
  console.log(`[Outbox] Retrying ${pending.length} saved report(s).`);
  for (const report of pending) {
    try {
      const response = await request("report", report);
      const remaining = readOutbox().filter(item =>
        !(Number(item.task_id) === Number(report.task_id) && item.status === report.status)
      );
      writeOutbox(remaining);
      console.log(`[Outbox] Task #${report.task_id} accepted: ${response.note || response.task?.status || "OK"}`);
    } catch (error) {
      console.error(`[Outbox] Task #${report.task_id} remains saved: ${error.message}`);
    }
  }
}

async function request(action, extra = {}) {

   const response = await fetch(`${API_URL}/runner`, {

      method: "POST",

      headers: {

         "Content-Type": "application/json",

         "Authorization": `Bearer ${TOKEN}`

      },

      body: JSON.stringify({

         action,

         worker_id: WORKER_ID,

         ...extra

      }),
      signal: AbortSignal.timeout(20000)

   });



   const text = await response.text();

   let data;



   try {

      data = JSON.parse(text);

   } catch {

      throw new Error(`API returned non-JSON response (HTTP ${response.status}). Check project access.`);

   }



   if (!response.ok) {

      throw new Error(`API error ${response.status}: ${data.error || text}`);

   }



   return data;

}



async function processTask(task) {
   console.log(`Claimed task #${task.id}: ${task.title}`);
   const agent = task.assigned_agent_id;
   const handler = handlers[agent];
   let heartbeatBusy = false;

   const heartbeat = setInterval(async () => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      try {
         await request("heartbeat", { task_id: task.id });
         console.log(`[Heartbeat] Task #${task.id} lease renewed.`);
      } catch (error) {
         console.error(`[Heartbeat] Task #${task.id} renewal failed: ${error.message}`);
      } finally {
         heartbeatBusy = false;
      }
   }, 60000);

   try {
      if (!handler) {
         await sendReport({
            task_id: task.id,
            status: "blocked",
            error: `No local handler is configured for agent: ${agent}`
         });
         console.log(`Task #${task.id} blocked: unsupported agent.`);
         return;
      }

      let result = await handler(task);
      if (agent !== "pentest") {
         const sourceContext = result;
         const modelResult = await generateAgentResponse(task, sourceContext, agent);
         console.log(`[Model] Task #${task.id} answered by ${modelResult.provider}/${modelResult.model}.`);
         result = modelResult.text;

         const evidenceAgents = [
            "research", "security-research", "opportunities",
            "freelance", "business-dev", "learning"
         ];
         if (evidenceAgents.includes(agent)) {
            result += "\n\n--- SOURCE EVIDENCE RETRIEVED BY THE RUNNER ---\n" + sourceContext;
         }
      }

      const persistentAgents = [
         "research", "security-research", "opportunities",
         "freelance", "business-dev", "learning"
      ];
      if (persistentAgents.includes(agent)) {
         try {
            const saveStatus = await saveResearchToNotion(task, result);
            console.log(`Task #${task.id}: Notion ${saveStatus}.`);
         } catch (notionError) {
            console.error(`Task #${task.id}: Notion save failed:`, notionError.message);
            result += "\n\nNOTION STORAGE WARNING: " + notionError.message +
               ". The workforce task result was still submitted.";
         }
      }

      await sendReport({ task_id: task.id, status: "completed", result });
      console.log(`Task #${task.id}: result accepted or safely queued.`);
   } catch (error) {
      try {
         await sendReport({ task_id: task.id, status: "failed", error: error.message });
      } catch (reportError) {
         console.error("Could not safely queue failure report:", reportError.message);
      }
      console.error(`Task #${task.id} failed:`, error.message);
   } finally {
      clearInterval(heartbeat);
   }
}


async function main() {

   console.log("Hosea AI Workforce local runner");

   console.log(`Worker: ${WORKER_ID}`);

   console.log(`Polling every ${POLL_MS} ms`);

   console.log("Press Ctrl+C to stop.");
  console.log("AI policy: local Ollama only; cloud AI disabled; no paid fallback.");
  console.log(`Model retry interval: ${MODEL_RETRY_MS} ms`);

  const modelStatus = await getModelStatus();
  console.log(
    `[Model] Mode: ${modelStatus.mode}; configured local model: ` +
    `${modelStatus.local.configured_model}; available: ${modelStatus.local.available}`
  );
  if (!modelStatus.local.available) {
    console.log("[Model] Tasks requiring AI will wait until the local model is available.");
  }

  while (true) {

      try {

         await flushOutbox();
         const data = await request("claim");



         if (data.task) {

            await processTask(data.task);

         } else {

            console.log("No queued tasks. Waiting...");

         }

      } catch (error) {

         console.error("Runner:", error.message);

      }



      await new Promise(resolve => setTimeout(resolve, POLL_MS));

   }

}



main().catch(error => {

   console.error(error);

   process.exit(1);

});








