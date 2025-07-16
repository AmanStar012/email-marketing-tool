const nodemailer = require('nodemailer');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { email, password, host, port } = req.body;

    if (!email || !password) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email and password required' 
      });
    }

    const smtpConfig = {
      host: host || 'smtp.gmail.com',
      port: parseInt(port) || 587,
      secure: false,
      auth: {
        user: email,
        pass: password
      }
    };

    // Create transporter - THIS IS THE FIX
    const transporter = nodemailer.createTransporter(smtpConfig);
    
    // Test connection
    await transporter.verify();

    return res.status(200).json({ 
      success: true, 
      message: 'Connection successful'
    });

  } catch (error) {
    console.error('Connection test error:', error);
    return res.status(400).json({ 
      success: false, 
      error: error.message
    });
  }
};