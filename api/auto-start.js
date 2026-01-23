const { cors, redisGet, redisSet } = require("./_shared");

module.exports = async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const { contacts, brandName, template } = req.body || {};
    const now = Date.now();

    // ✅ FIX 1: CSV validation (unchanged but critical)
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({
        success: false,
        error: "contacts array is required"
      });
    }

    // ✅ FIX 2: brandName validation (STRING OR ARRAY)
    const validBrand =
      Array.isArray(brandName)
        ? brandName.length > 0
        : typeof brandName === "string" && brandName.trim().length > 0;

    if (!validBrand) {
      return res.status(400).json({
        success: false,
        error: "brandName is required"
      });
    }

    // ✅ FIX 3: template validation (STRING OR ARRAY)
    if (!template || typeof template !== "object") {
      return res.status(400).json({
        success: false,
        error: "template is required"
      });
    }

    const validSubject =
      Array.isArray(template.subject)
        ? template.subject.length > 0
        : typeof template.subject === "string" && template.subject.trim().length > 0;

    const validContent =
      Array.isArray(template.content)
        ? template.content.length > 0
        : typeof template.content === "string" && template.content.trim().length > 0;

    if (!validSubject || !validContent) {
      return res.status(400).json({
        success: false,
        error: "template.subject and template.content are required"
      });
    }

    // ✅ FIX 4: create campaign (CSV STORED HERE)
    const campaignId = `c_${Date.now()}`;

    const campaign = {
      id: campaignId,
      status: "running",
      contacts,      // ✅ CSV SAVED
      brandName,     // string OR array
      template,      // subject/content string OR array
      cursor: 0,
      total: contacts.length,
      createdAt: now,
      updatedAt: now
    };

    await redisSet(`auto:campaign:${campaignId}`, campaign);
    await redisSet("auto:campaign:active", campaignId);
    await redisSet("auto:campaign:last", campaignId);

    await redisSet(`auto:campaign:${campaignId}:stats`, {
      campaignId,
      totalSent: 0,
      totalFailed: 0,
      byAccount: {}
    });

    await redisSet(`auto:campaign:${campaignId}:events`, [
      {
        ts: now,
        status: "campaign_started",
        campaignId,
        total: contacts.length
      }
    ]);

    return res.status(200).json({
      success: true,
      campaignId
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
};
