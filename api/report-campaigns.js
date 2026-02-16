const { createClient } = require("redis");
const { cors } = require("./_shared");

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

function getNamespace() {
  return process.env.REDIS_NAMESPACE || "default";
}

function withNamespace(key) {
  return `${getNamespace()}:${key}`;
}

function isValidDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function parseDailyKey(fullKey) {
  const nsPrefix = `${getNamespace()}:`;
  const raw = fullKey.startsWith(nsPrefix) ? fullKey.slice(nsPrefix.length) : fullKey;
  const match = raw.match(/^report:campaign:(.+):daily:(\d{4}-\d{2}-\d{2}):sender:(.+)$/);
  if (!match) return null;
  return { campaignKey: match[1], date: match[2] };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  let client = null;
  try {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      return res.status(500).json({ success: false, error: "Missing REDIS_URL env var" });
    }

    client = createClient({ url: redisUrl });
    await client.connect();

    const fromDate = String(req.query?.fromDate || "");
    const toDate = String(req.query?.toDate || "");
    if (fromDate && !isValidDateKey(fromDate)) {
      return res.status(400).json({ success: false, error: "Invalid fromDate format (YYYY-MM-DD)" });
    }
    if (toDate && !isValidDateKey(toDate)) {
      return res.status(400).json({ success: false, error: "Invalid toDate format (YYYY-MM-DD)" });
    }

    const timelines = new Map();
    let cursor = "0";
    const pattern = withNamespace("report:campaign:*:daily:*:sender:*");

    do {
      const reply = await client.scan(cursor, { MATCH: pattern, COUNT: 500 });
      cursor = reply.cursor;

      for (const key of reply.keys || []) {
        const parsed = parseDailyKey(key);
        if (!parsed) continue;

        const existing = timelines.get(parsed.campaignKey);
        if (!existing) {
          timelines.set(parsed.campaignKey, { startDate: parsed.date, endDate: parsed.date });
        } else {
          if (parsed.date < existing.startDate) existing.startDate = parsed.date;
          if (parsed.date > existing.endDate) existing.endDate = parsed.date;
        }
      }
    } while (cursor !== "0");

    const campaigns = [];
    for (const [campaignKey, range] of timelines.entries()) {
      if (fromDate && range.endDate < fromDate) continue;
      if (toDate && range.startDate > toDate) continue;

      const nameRaw = await client.get(withNamespace(`report:campaign:${campaignKey}:name`));
      const name = String(nameRaw || campaignKey).trim();
      campaigns.push({
        name,
        campaignKey,
        startDate: range.startDate,
        endDate: range.endDate
      });
    }

    campaigns.sort((a, b) => a.name.localeCompare(b.name));

    return res.status(200).json({
      success: true,
      campaigns,
      names: campaigns.map((c) => c.name)
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  } finally {
    if (client) {
      try {
        await client.quit();
      } catch (_) {
        // no-op
      }
    }
  }
};
