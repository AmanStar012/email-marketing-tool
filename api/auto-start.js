const { cors, redisSet } = require("./_shared");

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    const { contacts, brandName, template } = req.body || {};

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ success: false, error: "contacts array is required" });
    }
    if (!brandName) return res.status(400).json({ success: false, error: "brandName is required" });
    if (!template?.subject || !template?.content) {
      return res.status(400).json({ success: false, error: "template.subject + template.content are required" });
    }

    const campaignId = `c_${Date.now()}`;
    const now = Date.now();

    const campaign = {
      id: campaignId,
      status: "running",
      brandName,
      template,
      contacts,
      cursor: 0,
      total: contacts.length,
      emailsPerAccountPerHour: 40,
      perEmailDelayMs: 1000,
      createdAt: now,
      updatedAt: now
    };

    // Core campaign
    await redisSet(`auto:campaign:${campaignId}`, campaign);

    // Pointers
    await redisSet("auto:campaign:active", campaignId);
    await redisSet("auto:campaign:last", campaignId);

    // Stats init
    await redisSet(`auto:campaign:${campaignId}:stats`, {
      campaignId,
      totalSent: 0,
      totalFailed: 0,
      byAccount: {}
    });

    // Live init
    await redisSet(`auto:campaign:${campaignId}:live`, {
      currentAccountId: null,
      currentEmail: null,
      currentSenderName: null,
      state: "running",
      updatedAt: now
    });

    // Events init
    await redisSet(`auto:campaign:${campaignId}:events`, [
      { ts: now, status: "campaign_started", campaignId, brandName, total: contacts.length }
    ]);

    return res.status(200).json({ success: true, campaignId });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};
