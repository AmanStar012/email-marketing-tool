const { cors, redisGet, redisSet } = require("./_shared");

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

    // if a campaign is already active, keep it but allow overwrite by creating new id
    const campaignId = `c_${Date.now()}`;

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

      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await redisSet(`auto:campaign:${campaignId}`, campaign);
    await redisSet("auto:campaign:active", campaignId);

    return res.status(200).json({ success: true, campaignId });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};
