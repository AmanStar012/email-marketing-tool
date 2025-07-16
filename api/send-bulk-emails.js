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
    const { contacts, template, fromAccount, campaignId, batchSize = 5 } = req.body;

    if (!contacts || !template) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields' 
      });
    }

    console.log('=== MAILTRAP BULK EMAIL SENDING ===');
    console.log('Total contacts:', contacts.length);

    const smtpConfig = {
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT),
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD
      }
    };

    const transporter = nodemailer.createTransport(smtpConfig);

    const results = {
      total: contacts.length,
      sent: 0,
      failed: 0,
      errors: []
    };

    // Send emails
    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      
      try {
        if (!contact.email) {
          throw new Error('No email address');
        }

        // Personalize template
        let personalizedSubject = template.subject;
        let personalizedContent = template.content;
        
        Object.keys(contact).forEach(key => {
          const regex = new RegExp(`{{${key}}}`, 'g');
          personalizedSubject = personalizedSubject.replace(regex, contact[key] || '');
          personalizedContent = personalizedContent.replace(regex, contact[key] || '');
        });

        const mailOptions = {
          from: 'test@example.com',
          to: contact.email,
          subject: personalizedSubject,
          html: personalizedContent
        };

        await transporter.sendMail(mailOptions);
        results.sent++;
        console.log(`✅ Email sent to ${contact.email}`);
        
        // Small delay between emails
        if (i < contacts.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }

      } catch (error) {
        results.failed++;
        results.errors.push({
          email: contact.email || 'unknown',
          error: error.message
        });
        console.log(`❌ Failed to send to ${contact.email}: ${error.message}`);
      }
    }

    results.successRate = results.total > 0 ? Math.round((results.sent / results.total) * 100) : 0;

    return res.status(200).json({ 
      success: true, 
      results: results
    });

  } catch (error) {
    console.error('Bulk email error:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
};