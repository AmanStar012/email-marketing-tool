const nodemailer = require('nodemailer');

module.exports = async function handler(req, res) {
  // Set CORS headers
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
    const { email, password, host, port, security } = req.body;

    if (!email || !password) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email and password are required' 
      });
    }

    const smtpConfig = {
      host: host || 'smtp.gmail.com',
      port: parseInt(port) || 587,
      secure: security === 'ssl' ? true : false,
      auth: {
        user: email,
        pass: password
      },
      tls: {
        rejectUnauthorized: false
      }
    };

    // Create transporter - FIXED
    const transporter = nodemailer.createTransporter(smtpConfig);
    
    await transporter.verify();

    return res.status(200).json({ 
      success: true, 
      message: 'Connection successful',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Connection test error:', error);
    
    let errorMessage = 'Connection failed';
    if (error.code === 'EAUTH') {
      errorMessage = 'Authentication failed. Check your credentials.';
    } else if (error.code === 'ECONNECTION') {
      errorMessage = 'Unable to connect to SMTP server.';
    } else if (error.code === 'ETIMEDOUT') {
      errorMessage = 'Connection timed out. Check your network.';
    } else if (error.message) {
      errorMessage = error.message;
    }

    return res.status(400).json({ 
      success: false, 
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};