const { kv } = require("@vercel/kv");
const { cors } = require("./_shared");

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST only" });

  try {
    const { contacts, template, brandName } = req.body || {};
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ success: false, error: "contacts[] required" });
    }
    if (!template?.subject || !template?.content) {
      return res.status(400).json({ success: false, error: "template.subject and template.content required" });
    }
    if (!brandName || typeof brandName !== "string") {
      return res.status(400).json({ success: false, error: "brandName required" });
    }

    const campaignId = `auto_${Date.now()}`;
    const campaign = {
      id: campaignId,
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),

      brandName,
      template,
      contacts,
      cursor: 0,

      // Controls
      emailsPerAccountPerHour: 40,
      perEmailDelayMs: 1000
    };

    await kv.set(`auto:campaign:${campaignId}`, campaign);
    await kv.set("auto:campaign:active", campaignId);

    return res.status(200).json({ success: true, campaignId });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};
