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
    const { 
      contacts, 
      template, 
      fromAccount, 
      campaignId,
      batchSize = 5,
      delayBetweenBatches = 2000
    } = req.body;

    if (!contacts || !template || !fromAccount) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: contacts, template, fromAccount' 
      });
    }

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Contacts must be a non-empty array' 
      });
    }

    // SMTP configuration
    const smtpConfig = {
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER || fromAccount.email,
        pass: process.env.SMTP_PASSWORD || fromAccount.password
      },
      tls: {
        rejectUnauthorized: false
      }
    };

    // Create transporter - FIXED
    const transporter = nodemailer.createTransporter(smtpConfig);
    await transporter.verify();

    const results = {
      total: contacts.length,
      sent: 0,
      failed: 0,
      errors: [],
      startTime: new Date().toISOString()
    };

    // Process emails in batches
    for (let i = 0; i < contacts.length; i += batchSize) {
      const batch = contacts.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (contact) => {
        try {
          if (!contact.email) {
            throw new Error('Contact missing email address');
          }

          const personalizedSubject = personalizeTemplate(template.subject, contact);
          const personalizedContent = personalizeTemplate(template.content, contact);

          const mailOptions = {
            from: {
              name: fromAccount.name || 'Email Marketing Tool',
              address: fromAccount.email || process.env.SMTP_USER
            },
            to: contact.email,
            subject: personalizedSubject,
            html: personalizedContent,
            headers: {
              'X-Campaign-ID': campaignId || 'bulk-campaign',
              'X-Contact-ID': contact.id || contact.email
            }
          };

          const result = await transporter.sendMail(mailOptions);
          results.sent++;
          
          return { 
            success: true, 
            email: contact.email, 
            messageId: result.messageId 
          };

        } catch (error) {
          results.failed++;
          results.errors.push({
            email: contact.email || 'unknown',
            error: error.message
          });
          
          return { 
            success: false, 
            email: contact.email || 'unknown', 
            error: error.message 
          };
        }
      });

      await Promise.all(batchPromises);

      if (i + batchSize < contacts.length) {
        await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
      }
    }

    results.endTime = new Date().toISOString();
    results.successRate = results.total > 0 ? Math.round((results.sent / results.total) * 100) : 0;

    return res.status(200).json({ 
      success: true, 
      results: results
    });

  } catch (error) {
    console.error('Bulk email error:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};

function personalizeTemplate(template, contact) {
  if (!template || typeof template !== 'string') {
    return template;
  }
  
  let personalized = template;
  Object.keys(contact).forEach(key => {
    const regex = new RegExp(`{{${key}}}`, 'g');
    personalized = personalized.replace(regex, contact[key] || '');
  });
  
  personalized = personalized.replace(/{{[^}]*}}/g, '');
  
  return personalized;
}