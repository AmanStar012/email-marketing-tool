const { kv } = require("@vercel/kv");
const { cors } = require("./_shared");

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST only" });

  try {
    const activeId = await kv.get("auto:campaign:active");
    if (!activeId) return res.status(200).json({ success: true, message: "No active campaign" });

    const campaignKey = `auto:campaign:${activeId}`;
    const campaign = await kv.get(campaignKey);
    if (!campaign) {
      await kv.del("auto:campaign:active");
      return res.status(200).json({ success: true, message: "Campaign not found; cleared active pointer" });
    }

    campaign.status = "stopped";
    campaign.updatedAt = Date.now();
    await kv.set(campaignKey, campaign);

    // Keep data (you asked: do not delete)
    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};
