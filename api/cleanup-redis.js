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

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      return res.status(500).json({ success: false, error: "Missing REDIS_URL env var" });
    }

    // Full namespace cleanup to reclaim all Redis space for this project.
    const patterns = [withNamespace("*")];

    const client = createClient({ url: redisUrl });
    await client.connect();

    const deletedByPattern = {};
    let totalDeleted = 0;

    for (const pattern of patterns) {
      let cursor = "0";
      deletedByPattern[pattern] = 0;

      do {
        const reply = await client.scan(cursor, { MATCH: pattern, COUNT: 500 });
        cursor = reply.cursor;
        const keys = reply.keys || [];
        if (keys.length > 0) {
          const deleted = await client.del(keys);
          deletedByPattern[pattern] += deleted;
          totalDeleted += deleted;
        }
      } while (cursor !== "0");
    }

    await client.quit();

    return res.status(200).json({
      success: true,
      totalDeleted,
      deletedByPattern
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};
