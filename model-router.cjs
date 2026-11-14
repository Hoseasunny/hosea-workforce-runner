const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

function envFlag(name) {
  return String(process.env[name] || "").trim().toLowerCase() === "true";
}

function getConfig() {
  return {
    ollamaUrl: (process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_URL).replace(/\/+$/, ""),
    ollamaModel: process.env.OLLAMA_MODEL || "qwen2.5:0.5b",
    mode: (process.env.MODEL_ROUTING_MODE || "local_only").toLowerCase(),
    cloudEnabled: envFlag("ALLOW_FREE_CLOUD_AI"),
    cloudConfirmedFree: envFlag("GEMINI_FREE_TIER_CONFIRMED"),
    geminiKey: process.env.GEMINI_API_KEY || "",
    geminiModel: process.env.GEMINI_MODEL || "gemini-3.1-flash-lite",
    cloudAgents: (process.env.CLOUD_ALLOWED_AGENTS || "research,learning,opportunities,business-dev")
      .split(",").map(x => x.trim()).filter(Boolean)
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Model endpoint returned non-JSON data (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const message = data.error?.message || data.error || data.message || `HTTP ${response.status}`;
    throw new Error(String(message).slice(0, 500));
  }
  return data;
}

async function getModelStatus() {
  const config = getConfig();
  const status = {
    mode: config.mode,
    local: {
      url: config.ollamaUrl,
      configured_model: config.ollamaModel,
      available: false,
      installed_models: []
    },
    cloud: {
      provider: "Google Gemini API",
      model: config.geminiModel,
      enabled: config.cloudEnabled && config.cloudConfirmedFree && Boolean(config.geminiKey),
      free_tier_confirmation_required: !config.cloudConfirmedFree,
      api_key_configured: Boolean(config.geminiKey)
    },
    paid_fallback: false
  };

  try {
    const data = await fetchWithTimeout(`${config.ollamaUrl}/api/tags`, {}, 5000);
    status.local.installed_models = (data.models || []).map(model => model.name);
    status.local.available = status.local.installed_models.some(
      name => name === config.ollamaModel || name.startsWith(`${config.ollamaModel}:`)
    );
  } catch (error) {
    status.local.error = error.message;
  }

  return status;
}

async function callOllama(messages, config) {
  const data = await fetchWithTimeout(`${config.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.ollamaModel,
      messages,
      stream: false,
      keep_alive: "5m",
      options: { temperature: 0.2 }
    })
  });

  const text = data.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Ollama returned an empty response.");
  }
  return { provider: "ollama", model: config.ollamaModel, text: text.trim() };
}

function containsSensitiveMaterial(messages) {
  const text = messages.map(item => String(item.content || "")).join("\n");
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_ -]?key|access[_ -]?token|password|client[_ -]?secret)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+=]{8,}/i.test(text);
}

async function callGemini(messages, config) {
  if (!config.cloudEnabled || !config.cloudConfirmedFree || !config.geminiKey) {
    throw new Error("Cloud AI is disabled. Enable it only after confirming the Google project has no billing account attached.");
  }

  const system = messages
    .filter(item => item.role === "system")
    .map(item => String(item.content || ""))
    .join("\n\n");

  const contents = messages
    .filter(item => item.role !== "system")
    .map(item => ({
      role: item.role === "assistant" ? "model" : "user",
      parts: [{ text: String(item.content || "") }]
    }));

  const data = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.geminiKey
      },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents,
        generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
      })
    }
  );

  const text = (data.candidates?.[0]?.content?.parts || [])
    .map(part => part.text || "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Gemini returned no text. The request may have been blocked or the free-tier quota may be exhausted.");
  }
  return { provider: "gemini-free-tier", model: config.geminiModel, text };
}

/**
 * Model routing policy:
 * - local_only (default): Ollama only.
 * - local_first: Ollama first; cloud only when explicitly allowed for this call.
 * - cloud_first: Gemini only when all free-tier safety switches are enabled; otherwise local.
 *
 * Cloud calls require BOTH ALLOW_FREE_CLOUD_AI=true and
 * GEMINI_FREE_TIER_CONFIRMED=true, a Gemini key, allowCloud:true, and an
 * agent listed in CLOUD_ALLOWED_AGENTS. Sensitive-looking credentials are blocked.
 * There is no paid provider and no paid fallback in this module.
 */
async function generateWithModel({ messages, agent = "general", allowCloud = false }) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages must be a non-empty array.");
  }

  const config = getConfig();
  const canUseCloud =
    allowCloud &&
    config.cloudEnabled &&
    config.cloudConfirmedFree &&
    Boolean(config.geminiKey) &&
    config.cloudAgents.includes(agent) &&
    !containsSensitiveMaterial(messages);

  if (config.mode === "cloud_first" && canUseCloud) {
    try {
      return await callGemini(messages, config);
    } catch (error) {
      // A cloud failure never triggers a paid service. Local fallback is free.
      console.warn("Free cloud model unavailable; trying local Ollama:", error.message);
    }
  }

  try {
    return await callOllama(messages, config);
  } catch (localError) {
    if (canUseCloud && config.mode !== "local_only") {
      try {
        return await callGemini(messages, config);
      } catch (cloudError) {
        throw new Error(
          `No free model is currently available. Ollama: ${localError.message}. Gemini free tier: ${cloudError.message}. Task should wait for an engine; no paid fallback was attempted.`
        );
      }
    }

    throw new Error(
      `Local Ollama is unavailable (${localError.message}). Cloud AI is disabled or not approved for this task. No paid fallback was attempted.`
    );
  }
}

module.exports = { getModelStatus, generateWithModel };
