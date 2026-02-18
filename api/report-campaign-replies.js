const { createClient } = require("redis");
const { ImapFlow } = require("imapflow");
const { cors, loadAccountsConfig, redisGet, redisSet, redisSetNx, redisDel } = require("./_shared");

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

function getNamespace() {
  return process.env.REDIS_NAMESPACE || "default";
}

function ns(key) {
  return `${getNamespace()}:${key}`;
}

function normalizeSubject(subject) {
  let s = String(subject || "").toLowerCase().trim();
  s = s.replace(/\s+/g, " ");
  while (/^(re|fw|fwd)\s*:\s*/i.test(s)) {
    s = s.replace(/^(re|fw|fwd)\s*:\s*/i, "").trim();
  }
  return s;
}

function isLikelySystemMail(subject, fromAddr) {
  const s = String(subject || "").toLowerCase();
  const f = String(fromAddr || "").toLowerCase();
  if (s.includes("delivery status notification")) return true;
  if (s.includes("undelivered mail")) return true;
  if (s.includes("mail delivery")) return true;
  if (f.includes("mailer-daemon")) return true;
  if (f.includes("postmaster")) return true;
  return false;
}

const REPLY_SNAPSHOT_KEY = "report:replies:snapshot:v1";
const REPLY_PROCESSED_KEY = "report:replies:processed:v1";
const REPLY_PROCESSED_MAX = 50000;
const REPLY_SCAN_LOCK_KEY = "report:replies:scan:lock";
const REPLY_SCAN_LOCK_TTL_MS = 15 * 60 * 1000;

async function listSentEvents(redisClient) {
  const sent = [];
  const namespacePrefix = `${getNamespace()}:`;
  const pattern = ns("auto:campaign:*:events");
  let cursor = "0";

  do {
    const reply = await redisClient.scan(cursor, { MATCH: pattern, COUNT: 500 });
    cursor = reply.cursor;

    for (const fullKey of reply.keys || []) {
      const escapedPrefix = namespacePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m = fullKey.match(new RegExp(`^${escapedPrefix}auto:campaign:([^:]+):events$`));
      if (!m) continue;
      const campaignId = m[1];

      const rawCampaign = await redisClient.get(ns(`auto:campaign:${campaignId}`));
      let campaign = {};
      try {
        campaign = rawCampaign ? JSON.parse(rawCampaign) : {};
      } catch {
        campaign = {};
      }
      const campaignName = String(campaign.campaignName || campaignId);

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
        const ts = Number(ev.ts || 0);
        const from = String(ev.from || "").trim().toLowerCase();
        const to = String(ev.to || "").trim().toLowerCase();
        const subject = String(ev.subject || "").trim();
        if (!ts || !from || !to || !subject) continue;
        sent.push({
          id: `${campaignId}|${from}|${to}|${normalizeSubject(subject)}|${ts}`,
          campaignId,
          campaignName,
          from,
          to,
          subject,
          subjectNorm: normalizeSubject(subject),
          ts
        });
      }
    }
  } while (cursor !== "0");

  return sent;
}

async function scanReplies(accounts, sinceDate, processedSet) {
  const allReplies = [];
  const newProcessedIds = [];
  const maxPerAccount = Number(process.env.REPLY_SCAN_MAX_MESSAGES || 500);

  for (const account of accounts) {
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
      let uids = await client.search({ seen: false, since: sinceDate });
      if (!Array.isArray(uids) || uids.length === 0) continue;
      if (uids.length > maxPerAccount) {
        uids = uids.slice(uids.length - maxPerAccount);
      }

      for await (const msg of client.fetch(uids, { uid: true, envelope: true, internalDate: true })) {
        const env = msg.envelope || {};
        const msgId = `${String(account.email || "").trim().toLowerCase()}|${String(msg.uid || "")}`;
        if (processedSet.has(msgId)) continue;

        const fromAddr = String(env.from?.[0]?.address || "").trim().toLowerCase();
        const subjectNorm = normalizeSubject(env.subject || "");
        if (!fromAddr || !subjectNorm) continue;
        if (isLikelySystemMail(env.subject || "", fromAddr)) continue;

        const ts = new Date(env.date || msg.internalDate || Date.now()).getTime();
        allReplies.push({
          accountEmail: String(account.email || "").trim().toLowerCase(),
          fromAddr,
          subjectNorm,
          ts
        });
        newProcessedIds.push(msgId);
      }
    } finally {
      await client.logout();
    }
  }

  return { allReplies, newProcessedIds };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  let redisClient = null;
  let scanLockAcquired = false;
  try {
    const refresh = String(req.query?.refresh || "") === "1";

    if (refresh) {
      scanLockAcquired = await redisSetNx(
        REPLY_SCAN_LOCK_KEY,
        { ts: Date.now() },
        REPLY_SCAN_LOCK_TTL_MS
      );
      if (!scanLockAcquired) {
        return res.status(429).json({
          success: false,
          error: "Reply scan already in progress. Please wait and try again."
        });
      }

      const redisUrl = process.env.REDIS_URL;
      if (!redisUrl) throw new Error("Missing REDIS_URL env var");
      redisClient = createClient({ url: redisUrl });
      await redisClient.connect();

      const sentAll = await listSentEvents(redisClient);
      const processedList = (await redisGet(REPLY_PROCESSED_KEY)) || [];
      const processedSet = new Set(Array.isArray(processedList) ? processedList : []);
      const runtime = (await redisGet("accounts:runtime")) || {};
      const accounts = loadAccountsConfig()
        .filter((a) => runtime[String(a.id)]?.connected !== false)
        .filter((a) => a.email && a.pass);

      const earliestTs = sentAll.length
        ? Math.min(...sentAll.map((s) => s.ts))
        : Date.now() - 30 * 24 * 60 * 60 * 1000;
      const { allReplies: replies, newProcessedIds } = await scanReplies(accounts, new Date(earliestTs), processedSet);

      const sentByKey = {};
      for (const s of sentAll) {
        const key = `${s.from}|${s.to}|${s.subjectNorm}`;
        sentByKey[key] ||= [];
        sentByKey[key].push(s);
      }
      Object.values(sentByKey).forEach((arr) => arr.sort((a, b) => a.ts - b.ts));

      const repliedSentIds = new Set();
      for (const r of replies) {
        const key = `${r.accountEmail}|${r.fromAddr}|${r.subjectNorm}`;
        const candidates = sentByKey[key];
        if (!candidates || candidates.length === 0) continue;

        let best = null;
        for (const s of candidates) {
          if (s.ts > r.ts) continue;
          if (!best || s.ts > best.ts) best = s;
        }
        if (best) repliedSentIds.add(best.id);
      }

      const repliedEvents = sentAll
        .filter((s) => repliedSentIds.has(s.id))
        .map((s) => ({
          campaignId: s.campaignId,
          campaignName: s.campaignName,
          senderEmail: s.from,
          recipientEmail: s.to,
          sentTs: s.ts
        }));

      await redisSet(REPLY_SNAPSHOT_KEY, {
        lastScannedAt: Date.now(),
        repliedEvents
      });

      // Keep processed unread message ids so re-scan does not double count.
      for (const id of newProcessedIds) processedSet.add(id);
      const processedTrimmed = Array.from(processedSet);
      if (processedTrimmed.length > REPLY_PROCESSED_MAX) {
        processedTrimmed.splice(0, processedTrimmed.length - REPLY_PROCESSED_MAX);
      }
      await redisSet(REPLY_PROCESSED_KEY, processedTrimmed);
    }

    const snapshot = (await redisGet(REPLY_SNAPSHOT_KEY)) || { lastScannedAt: null, repliedEvents: [] };
    return res.status(200).json({
      success: true,
      lastScannedAt: snapshot.lastScannedAt || null,
      repliedEvents: Array.isArray(snapshot.repliedEvents) ? snapshot.repliedEvents : []
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  } finally {
    if (scanLockAcquired) {
      try {
        await redisDel(REPLY_SCAN_LOCK_KEY);
      } catch (_) {
        // no-op
      }
    }
    if (redisClient) {
      try {
        await redisClient.quit();
      } catch (_) {
        // no-op
      }
    }
  }
};
