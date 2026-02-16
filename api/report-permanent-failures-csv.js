const { createClient } = require("redis");
const { ImapFlow } = require("imapflow");
const { cors, loadAccountsConfig, redisGet } = require("./_shared");

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

function getNamespace() {
  return process.env.REDIS_NAMESPACE || "default";
}

function ns(key) {
  return `${getNamespace()}:${key}`;
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function parseDateParam(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function extractRecipient(raw) {
  const finalMatch = raw.match(/Final-Recipient:\s*rfc822;\s*([^\s\r\n;]+)/i);
  if (finalMatch) return finalMatch[1].trim().toLowerCase();
  const origMatch = raw.match(/Original-Recipient:\s*rfc822;\s*([^\s\r\n;]+)/i);
  if (origMatch) return origMatch[1].trim().toLowerCase();
  const forMatch = raw.match(/\bfor\s*<([^>]+)>/i);
  if (forMatch) return forMatch[1].trim().toLowerCase();
  return "";
}

function extractFailureCode(raw) {
  const statusMatch = raw.match(/Status:\s*(5\.\d\.\d)/i);
  if (statusMatch) return statusMatch[1];
  const smtpMatch = raw.match(/\b(5\d\d)\b/);
  return smtpMatch ? smtpMatch[1] : "";
}

function isPermanentFailureDsn(subject, raw) {
  const s = String(subject || "").toLowerCase();
  const text = raw.toLowerCase();
  const isDelay =
    s.includes("(delay)") ||
    text.includes("temporary problem delivering") ||
    text.includes("will retry") ||
    /status:\s*4\.\d\.\d/i.test(raw);
  if (isDelay) return false;

  const hasFailureSubject =
    s.includes("delivery status notification (failure)") ||
    s.includes("mail delivery failed") ||
    s.includes("undelivered mail returned to sender");
  const hasPermanentStatus =
    /status:\s*5\.\d\.\d/i.test(raw) || /\b5\d\d\b/.test(raw);
  return hasFailureSubject || hasPermanentStatus;
}

async function fetchPermanentFailuresForAccount(account, sinceDate, maxMessages) {
  const rows = [];
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: account.email,
      pass: account.pass
    },
    logger: false
  });

  await client.connect();
  try {
    await client.mailboxOpen("INBOX", { readOnly: true });

    const search = sinceDate
      ? { seen: false, since: sinceDate }
      : { seen: false };
    let uids = await client.search(search);
    if (!Array.isArray(uids) || uids.length === 0) return rows;

    if (uids.length > maxMessages) {
      uids = uids.slice(uids.length - maxMessages);
    }

    for await (const msg of client.fetch(uids, {
      uid: true,
      envelope: true,
      source: true,
      internalDate: true
    })) {
      const sourceBuf = Buffer.isBuffer(msg.source) ? msg.source : Buffer.from(msg.source || "");
      const raw = sourceBuf.toString("utf8");
      const subject = msg.envelope?.subject || "";
      if (!isPermanentFailureDsn(subject, raw)) continue;

      const recipient = extractRecipient(raw);
      if (!recipient) continue;

      rows.push({
        senderEmail: String(account.email || "").trim().toLowerCase(),
        recipientEmail: recipient,
        failureType: "permanent",
        failureCode: extractFailureCode(raw),
        failureSubject: String(subject || "").trim(),
        failureTime: new Date(msg.envelope?.date || msg.internalDate || Date.now()).toISOString()
      });
    }
  } finally {
    await client.logout();
  }

  return rows;
}

async function listSentEventsForMatching(redisClient) {
  const sent = [];
  const nsPrefix = `${getNamespace()}:`;
  let cursor = "0";
  const eventsPattern = ns("auto:campaign:*:events");
  const campaignCache = {};

  do {
    const reply = await redisClient.scan(cursor, { MATCH: eventsPattern, COUNT: 500 });
    cursor = reply.cursor;
    for (const fullKey of reply.keys || []) {
      const m = fullKey.match(new RegExp(`^${nsPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}auto:campaign:([^:]+):events$`));
      if (!m) continue;
      const campaignId = m[1];

      if (!campaignCache[campaignId]) {
        const rawCampaign = await redisClient.get(ns(`auto:campaign:${campaignId}`));
        let campaign = null;
        try {
          campaign = rawCampaign ? JSON.parse(rawCampaign) : null;
        } catch {
          campaign = null;
        }
        campaignCache[campaignId] = campaign || {};
      }
      const campaignName = String(campaignCache[campaignId].campaignName || campaignId);

      const rawEvents = await redisClient.get(fullKey);
      if (!rawEvents) continue;
      let events = [];
      try {
        events = JSON.parse(rawEvents);
      } catch {
        events = [];
      }
      if (!Array.isArray(events)) continue;

      for (const ev of events) {
        if (ev?.status !== "sent") continue;
        const from = String(ev.from || "").trim().toLowerCase();
        const to = String(ev.to || "").trim().toLowerCase();
        const ts = Number(ev.ts || 0);
        if (!from || !to || !ts) continue;
        sent.push({
          campaignId,
          campaignName,
          from,
          to,
          ts
        });
      }
    }
  } while (cursor !== "0");

  return sent;
}

function attachCampaignMatch(failures, sentEvents) {
  return failures.map((row) => {
    const failureTs = new Date(row.failureTime).getTime();
    let best = null;
    for (const ev of sentEvents) {
      if (ev.from !== row.senderEmail || ev.to !== row.recipientEmail) continue;
      if (ev.ts > failureTs) continue;
      if (!best || ev.ts > best.ts) best = ev;
    }
    return {
      ...row,
      campaignName: best?.campaignName || "",
      campaignId: best?.campaignId || "",
      originalSendTime: best?.ts ? new Date(best.ts).toISOString() : ""
    };
  });
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  let redisClient = null;
  try {
    const fromDate = parseDateParam(req.query?.fromDate);
    const toDate = parseDateParam(req.query?.toDate);
    const campaignQuery = String(req.query?.campaignQuery || "").trim().toLowerCase();
    const sinceDays = Number(req.query?.sinceDays || 30);
    const maxMessages = Number(req.query?.maxMessagesPerAccount || 300);

    const runtime = (await redisGet("accounts:runtime")) || {};
    const accounts = loadAccountsConfig().filter((a) => runtime[String(a.id)]?.connected !== false);
    const usableAccounts = accounts.filter((a) => a.email && a.pass);
    if (!usableAccounts.length) {
      return res.status(400).json({ success: false, error: "No connected accounts with credentials" });
    }

    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) throw new Error("Missing REDIS_URL env var");
    redisClient = createClient({ url: redisUrl });
    await redisClient.connect();

    const sentEvents = await listSentEventsForMatching(redisClient);
    const sinceDate = new Date(Date.now() - Math.max(1, sinceDays) * 24 * 60 * 60 * 1000);

    let failures = [];
    for (const account of usableAccounts) {
      try {
        const rows = await fetchPermanentFailuresForAccount(account, sinceDate, Math.max(50, maxMessages));
        failures.push(...rows);
      } catch (e) {
        failures.push({
          senderEmail: String(account.email || "").trim().toLowerCase(),
          recipientEmail: "",
          failureType: "scan_error",
          failureCode: "",
          failureSubject: `IMAP error: ${e.message}`,
          failureTime: new Date().toISOString()
        });
      }
    }

    failures = attachCampaignMatch(failures, sentEvents);

    const filtered = failures.filter((row) => {
      const day = row.failureTime ? row.failureTime.slice(0, 10) : "";
      if (fromDate && day && day < fromDate.toISOString().slice(0, 10)) return false;
      if (toDate && day && day > toDate.toISOString().slice(0, 10)) return false;
      if (campaignQuery) {
        const hay = `${row.campaignName} ${row.campaignId}`.toLowerCase();
        if (!hay.includes(campaignQuery)) return false;
      }
      return true;
    });

    const headers = [
      "campaignName",
      "campaignId",
      "senderEmail",
      "recipientEmail",
      "failureType",
      "failureCode",
      "failureSubject",
      "failureTime",
      "originalSendTime"
    ];
    const lines = [headers.join(",")];
    for (const row of filtered) {
      lines.push([
        row.campaignName || "",
        row.campaignId || "",
        row.senderEmail || "",
        row.recipientEmail || "",
        row.failureType || "",
        row.failureCode || "",
        row.failureSubject || "",
        row.failureTime || "",
        row.originalSendTime || ""
      ].map(csvEscape).join(","));
    }

    const fileDate = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=\"permanent-failures-${fileDate}.csv\"`);
    return res.status(200).send(lines.join("\n"));
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  } finally {
    if (redisClient) {
      try {
        await redisClient.quit();
      } catch (_) {
        // no-op
      }
    }
  }
};
