const nodemailer = require('nodemailer');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: 'sandbox.smtp.mailtrap.io',
      port: 2525,
      secure: false,
      auth: {
        user: 'c2418473e9f491',
        pass: '3320713de2d339'
      }
    });

    await transporter.verify();

    return res.status(200).json({ 
      success: true, 
      message: 'Connection successful'
    });

  } catch (error) {
    return res.status(400).json({ 
      success: false, 
      error: error.message
    });
  }
};