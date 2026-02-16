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

function parseReportKey(fullKey) {
  const nsPrefix = `${getNamespace()}:`;
  const raw = fullKey.startsWith(nsPrefix) ? fullKey.slice(nsPrefix.length) : fullKey;
  const match = raw.match(/^report:campaign:(.+):daily:(\d{4}-\d{2}-\d{2}):sender:(.+)$/);
  if (!match) return null;
  return {
    campaignKey: match[1],
    date: match[2],
    senderEmail: decodeURIComponent(match[3] || "")
  };
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

    const campaignQuery = String(req.query?.campaignQuery || "").trim().toLowerCase();
    const fromDate = String(req.query?.fromDate || "");
    const toDate = String(req.query?.toDate || "");

    if (fromDate && !isValidDateKey(fromDate)) {
      return res.status(400).json({ success: false, error: "Invalid fromDate format (YYYY-MM-DD)" });
    }
    if (toDate && !isValidDateKey(toDate)) {
      return res.status(400).json({ success: false, error: "Invalid toDate format (YYYY-MM-DD)" });
    }

    client = createClient({ url: redisUrl });
    await client.connect();

    const pattern = withNamespace("report:campaign:*:daily:*:sender:*");
    const campaignNameCache = {};
    const rows = [];
    const campaignSet = new Set();
    let totalSent = 0;
    let cursor = "0";

    do {
      const reply = await client.scan(cursor, { MATCH: pattern, COUNT: 500 });
      cursor = reply.cursor;

      for (const fullKey of reply.keys || []) {
        const parsed = parseReportKey(fullKey);
        if (!parsed) continue;

        if (fromDate && parsed.date < fromDate) continue;
        if (toDate && parsed.date > toDate) continue;

        if (!campaignNameCache[parsed.campaignKey]) {
          const nameKey = withNamespace(`report:campaign:${parsed.campaignKey}:name`);
          campaignNameCache[parsed.campaignKey] = (await client.get(nameKey)) || parsed.campaignKey;
        }
        const campaignName = campaignNameCache[parsed.campaignKey];

        if (campaignQuery) {
          const haystack = `${parsed.campaignKey} ${campaignName}`.toLowerCase();
          if (!haystack.includes(campaignQuery)) continue;
        }

        const sent = Number(await client.get(fullKey)) || 0;
        rows.push({
          campaignKey: parsed.campaignKey,
          campaignName,
          date: parsed.date,
          senderEmail: parsed.senderEmail,
          sent
        });
        totalSent += sent;
        campaignSet.add(parsed.campaignKey);
      }
    } while (cursor !== "0");

    rows.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      if (a.campaignName !== b.campaignName) return a.campaignName.localeCompare(b.campaignName);
      return a.senderEmail.localeCompare(b.senderEmail);
    });

    return res.status(200).json({
      success: true,
      rows,
      totals: {
        totalSent,
        totalRows: rows.length,
        totalCampaigns: campaignSet.size
      }
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
