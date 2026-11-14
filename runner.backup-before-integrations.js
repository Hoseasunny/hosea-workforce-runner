const API_URL = (process.env.WORKFORCE_API_URL || "https://hosea-ai-workforce.hatchable.site/api").replace(/\/+$/, "");
const TOKEN = process.env.WORKFORCE_RUNNER_TOKEN;
const WORKER_ID = process.env.WORKFORCE_WORKER_ID || "hosea-laptop";
const POLL_MS = Number(process.env.WORKFORCE_POLL_MS || 15000);

if (!TOKEN) {
  console.error("WORKFORCE_RUNNER_TOKEN is not configured.");
  process.exit(1);
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

  const [wikiResult, academicResult] = await Promise.allSettled([
    fetchJson(wikipediaUrl),
    fetchJson(openAlexUrl)
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
      lines.push(`   Finding: ${snippet}`);
      lines.push(`   Source: ${link}`);
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
      lines.push(`   Year: ${year}`);

      if (authors) lines.push(`   Authors: ${authors}`);

      lines.push(
        `   Abstract: ${
          abstract
            ? abstract.slice(0, 900)
            : "No abstract available in public metadata."
        }`
      );

      lines.push(`   Source: ${link}`);
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
    "This is a planning report only; no project changes were made."
  ].join("\n"),

  "learning": task => [
    "LEARNING PLAN",
    `Topic: ${task.title}`,
    "",
    "1. Identify the learner's current level.",
    "2. Divide the topic into smaller concepts.",
    "3. Select free learning resources.",
    "4. Practise each concept.",
    "5. Review progress with a practical exercise.",
    "",
    "This is a learning plan, not completed training."
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
    "No application was tested by this planning handler."
  ].join("\n"),

  "frontend": task => [
    "FRONTEND IMPLEMENTATION PLAN",
    `Task: ${task.title}`,
    "",
    "1. Inspect the existing frontend structure.",
    "2. Identify the relevant components.",
    "3. Check responsive behaviour.",
    "4. Implement the requested interface changes.",
    "5. Test accessibility and browser behaviour.",
    "",
    "No source files were changed."
  ].join("\n"),

  "backend": task => [
    "BACKEND IMPLEMENTATION PLAN",
    `Task: ${task.title}`,
    "",
    "1. Identify the required API behaviour.",
    "2. Review existing routes and validation.",
    "3. Check authentication and authorization.",
    "4. Plan error handling.",
    "5. Test the endpoint before deployment.",
    "",
    "No backend code was changed."
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
    "No database changes were made."
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
    "Nothing was deployed or modified."
  ].join("\n"),

  "security-research": task => [
    "SECURITY RESEARCH PLAN",
    `Task: ${task.title}`,
    "",
    "1. Define the system and research question.",
    "2. Identify relevant security standards.",
    "3. Gather authorized, public documentation.",
    "4. Record potential risks and mitigations.",
    "5. Prepare an evidence-based report.",
    "",
    "No target was scanned or accessed."
  ].join("\n"),

  "pentest": task => [
    "PENETRATION TESTING SAFETY CHECK",
    `Task: ${task.title}`,
    "",
    "Testing is blocked until written authorization and scope are provided.",
    "Required: target assets, permitted techniques, testing window,",
    "excluded systems, emergency contact, and approval from the owner.",
    "",
    "No scanning, exploitation, or access attempts were performed."
  ].join("\n")
};

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
    })
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

  if (!handler) {
    await request("report", {
      task_id: task.id,
      status: "blocked",
      error: `No local handler is configured for agent: ${agent}`
    });
    console.log(`Task #${task.id} blocked: unsupported agent.`);
    return;
  }

  try {
    const result = await handler(task);

    await request("report", {
      task_id: task.id,
      status: "completed",
      result
    });

    console.log(`Task #${task.id}: planning report saved.`);
  } catch (error) {
    await request("report", {
      task_id: task.id,
      status: "failed",
      error: error.message
    }).catch(reportError => {
      console.error("Could not submit failure report:", reportError.message);
    });

    console.error(`Task #${task.id} failed:`, error.message);
  }
}

async function main() {
  console.log("Hosea AI Workforce local runner");
  console.log(`Worker: ${WORKER_ID}`);
  console.log(`Polling every ${POLL_MS} ms`);
  console.log("Press Ctrl+C to stop.");

  while (true) {
    try {
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

