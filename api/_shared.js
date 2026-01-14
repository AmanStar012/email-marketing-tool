const fs = require("fs");
const path = require("path");

// Load .env.local only when running locally
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

function loadAccountsConfig() {
  const filePath = path.join(process.cwd(), "accounts.json");

  if (!fs.existsSync(filePath)) {
    throw new Error("accounts.json file not found");
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const accounts = JSON.parse(raw);

  if (!Array.isArray(accounts)) {
    throw new Error("accounts.json must be an array");
  }

  return accounts.map((a) => ({
    ...a,
    pass: process.env[`PASS_${a.id}`] || ""
  }));
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

module.exports = { loadAccountsConfig, cors };
