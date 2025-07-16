import nodemailer from 'nodemailer';

export default async function handler(req, res) {
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
    const { 
      to, 
      subject, 
      content, 
      fromAccount, 
      campaignId,
      isHtml = true 
    } = req.body;

    // Validate required fields
    if (!to || !subject || !content || !fromAccount) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: to, subject, content, fromAccount' 
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(to)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid email format' 
      });
    }

    // Get SMTP configuration
    const smtpConfig = {
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: false, // true for 465, false for other ports
      auth: {
        user: process.env.SMTP_USER || fromAccount.email,
        pass: process.env.SMTP_PASSWORD || fromAccount.password
      },
      tls: {
        rejectUnauthorized: false
      }
    };

    // Create transporter
    const transporter = nodemailer.createTransporter(smtpConfig);

    // Verify connection
    await transporter.verify();

    // Send email
    const mailOptions = {
      from: {
        name: fromAccount.name || 'Email Marketing Tool',
        address: fromAccount.email || process.env.SMTP_USER
      },
      to: to,
      subject: subject,
      ...(isHtml ? { html: content } : { text: content }),
      headers: {
        'X-Campaign-ID': campaignId || 'single-email',
        'X-Mailer': 'Email Marketing Pro'
      }
    };

    const result = await transporter.sendMail(mailOptions);

    // Log successful send
    console.log(`Email sent successfully to ${to}, Message ID: ${result.messageId}`);

    return res.status(200).json({ 
      success: true, 
      messageId: result.messageId,
      recipient: to,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Email sending error:', error);
    
    // Return specific error messages
    let errorMessage = 'Failed to send email';
    if (error.code === 'EAUTH') {
      errorMessage = 'Authentication failed. Check your email credentials.';
    } else if (error.code === 'ECONNECTION') {
      errorMessage = 'Connection failed. Check your SMTP settings.';
    } else if (error.responseCode === 550) {
      errorMessage = 'Recipient email address rejected.';
    } else if (error.message) {
      errorMessage = error.message;
    }

    return res.status(500).json({ 
      success: false, 
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}