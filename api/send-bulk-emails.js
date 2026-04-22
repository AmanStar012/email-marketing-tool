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
    const { contacts, template, selectedAccount } = req.body;

    // 8 Gmail accounts configuration
    const emailAccounts = [
      {
        id: 1,
        name: 'Account 1',
        email: 'lalit.singh691w@gmail.com',
        password: 'crrdjxjnsmpwbgny',
        active: true
      },
      {
        id: 2,
        name: 'Account 2',
        email: 'arjunmywall@gmail.com',
        password: 'gbpq umqn rrcw djdv',
        active: false
      },
      {
        id: 3,
        name: 'Account 3',
        email: 'kavitathappar@gmail.com',
        password: 'smgqmkpskbvhgzpb',
        active: false
      },
      {
        id: 4,
        name: 'Account 4',
        email: 'hitesh.singh08876@gmail.com',
        password: 'fsblmovdsuawhedw',
        active: false
      },
      {
        id: 5,
        name: 'Account 5',
        email: 'virajgupta211@gmail.com',
        password: 'xqeocvxkpvasefcy',
        active: false
      },
      {
        id: 6,
        name: 'Account 6',
        email: 'kavyamywall@gmail.com',
        password: 'gzdi rrtg hvqg ciyz',
        active: false
      },
      {
        id: 7,
        name: 'Account 7',
        email: 'amanfrommywall@gmail.com',
        password: 'yiboyxsjzjplptbb',
        active: false
      },
      {
        id: 8,
        name: 'Account 8',
        email: 'fardeenkhandigital0@gmail.com',
        password: 'iciborahoifdhuzf',
        active: false
      },
      {
        id: 9,
        name: 'Account 9',
        email: 'abhijeet04.grynow@gmail.com',
        password: 'fpxrvzqepfcvatcd',
        active: false
      },
      {
        id: 10,
        name: 'Account 10',
        email: 'singhzorawar513@gmail.com',
        password: 'gtduzranvqwcgzgc',
        active: false
      },
      {
id: 11,
name: 'Account 11',
email: 'aaanshi10@gmail.com',
password: 'wdntgnoeopbdslpl',
active: false
},
{
id: 12,
name: 'Account 12',
email: 'anshi271801@gmail.com',
password: 'dofqevoypcwedyac',
active: false
},
{
id: 13,
name: 'Account 13',
email: 'lokeshmywall@gmail.com',
password: 'htli kzsi oluh hujv',
active: false
},
{
id: 14,
name: 'Account 14',
email: 'kriiitiii3030@gmail.com',
password: 'jpwstyifxvavauxf',
active: false
},
{
id: 15,
name: 'Account 15',
email: 'mohitmywall@gmail.com',
password: 'khct czvo gaza nmbk',
active: false
},
{
id: 16,
name: 'Account 16',
email: 'nayub.malik.grynow@gmail.com',
password: 'aaflymyvpvojiral',
active: false
},
{
id: 17,
name: 'Account 17',
email: 'workwithahad2311@gmail.com',
password: 'yehproowlzszvrss',
active: false
},
{
id: 18,
name: 'Account 18',
email: 'sakshi031singh@gmail.com',
password: 'lbrqsjwubszrzolv',
active: false
},
{
id: 19,
name: 'Account 19',
email: 'khandelwalsanya3@gmail.com',
password: 'suflbridlirfcaeb',
active: false
},
{
id: 20,
name: 'Account 20',
email: 'sharma.pradeep00978@gmail.com',
password: 'zfopymcqssrmmqby',
active: false
},
{
id: 21,
name: 'Account 21',
email: 'albaabtalentmanager@gmail.com',
password: 'ekankglzkqxjrcgk',
active: false
},
{
id: 22,
name: 'Account 22',
email: 'divyanshutalentmanager@gmail.com',
password: 'xnmbulytpsiofnwn',
active: false
},
{      
id: 23,
name: 'Account 23',
email: 'haiderr12124@gmail.com',
password: 'zfxpjdjospolazoy',
active: false
},   
{      
id: 24,
name: 'Account 24',
email: 'arshadmywall@gmail.com',
password: 'zyuj jske zlxh drbq',
active: false
},
{      
id: 25,
name: 'Account 25',
email: 'samsertalentmanager@gmail.com',
password: 'iupvrrmgberxbxcm',
active: false
},
{      
id: 26,
name: 'Account 26',
email: 'goldytalentmanager@gmail.com',
password: 'xkov lazp yzmo lqwi',
active: false
},
{      
id: 27,
name: 'Account 27',
email: 'sushanttalentmanager@gmail.com',
password: 'ffof jury mrwq tuax',
active: false
},
{      
id: 28,
name: 'Account 28',
email: 'shimatalentmanager@gmail.com',
password: 'xjkv sbhz lqet xvqt',
active: false
},
{      
id: 29,
name: 'Account 29',
email: 'merajtalentmanager@gmail.com',
password: 'ajyq ripo szpo zvit',
active: false
},
{
id: 30,
name: 'Account 30',
email: 'roshantalentmanager@gmail.com',
password: 'ajvc flfp ltmg wxoi',
active: false
},
{
id: 31,
name: 'Account 31',
email: 'gauravmywall@gmail.com',
password: 'hcou thke iznx dfym',
active: false
},
{
id: 32,
name: 'Account 32',
email: 'himanshumywall@gmail.com',
password: 'wstd cjqa zlwl mroq',
active: false
},
    ];

    // Select account based on frontend selection or use first active
    let currentAccount;
    if (selectedAccount) {
      currentAccount = emailAccounts.find(acc => acc.id === selectedAccount);
    } else {
      currentAccount = emailAccounts.find(acc => acc.active);
    }

    if (!currentAccount) {
      return res.status(400).json({ 
        success: false, 
        error: 'No active email account found' 
      });
    }

    console.log(`🚀 Using account: ${currentAccount.email}`);

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: currentAccount.email,
        pass: currentAccount.password
      }
    });

    const results = {
      total: contacts.length,
      sent: 0,
      failed: 0,
      errors: [],
      usedAccount: currentAccount.email,
      accountSwitches: []
    };

    // Auto-rotation settings
    const emailsPerAccount = 40; // Gmail safe limit per hour
    let emailsSentFromCurrentAccount = 0;
    let currentAccountIndex = emailAccounts.findIndex(acc => acc.id === currentAccount.id);

    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      
      try {
        // Auto-switch account if limit reached
        if (emailsSentFromCurrentAccount >= emailsPerAccount && emailAccounts.length > 1) {
          console.log(`📧 Switching account after ${emailsSentFromCurrentAccount} emails`);
          
          // Find next available account
          currentAccountIndex = (currentAccountIndex + 1) % emailAccounts.length;
          currentAccount = emailAccounts[currentAccountIndex];
          emailsSentFromCurrentAccount = 0;
          
          // Create new transporter for new account
          const newTransporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
              user: currentAccount.email,
              pass: currentAccount.password
            }
          });
          
          results.accountSwitches.push({
            switchAt: i,
            newAccount: currentAccount.email
          });
          
          console.log(`🔄 Switched to: ${currentAccount.email}`);
        }

        // Personalize email content
        let personalizedSubject = template.subject;
        let personalizedContent = template.content;
        
        Object.keys(contact).forEach(key => {
          const regex = new RegExp(`{{${key}}}`, 'g');
          personalizedSubject = personalizedSubject.replace(regex, contact[key] || '');
          personalizedContent = personalizedContent.replace(regex, contact[key] || '');
        });

        // ADDED: Convert text to HTML with preserved spacing
        const htmlContent = convertTextToHTML(personalizedContent);

        // Send email
        await transporter.sendMail({
          from: currentAccount.email,
          to: contact.email,
          subject: personalizedSubject,
          html: htmlContent  // Use HTML with preserved formatting
        });

        results.sent++;
        emailsSentFromCurrentAccount++;
        console.log(`✅ Email ${i + 1}/${contacts.length} sent to ${contact.email} from ${currentAccount.email}`);
        
        // Delay between emails (1 second)
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        results.failed++;
        results.errors.push({
          email: contact.email || 'unknown',
          error: error.message,
          account: currentAccount.email
        });
        console.log(`❌ Failed: ${contact.email} - ${error.message}`);
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

// ADDED: Function to convert text to HTML with preserved spacing
function convertTextToHTML(text) {
  if (!text) return '';
  
  return text
    // Convert line breaks to <br> tags
    .replace(/\r?\n/g, '<br>')
    // Convert multiple spaces to &nbsp; to preserve spacing
    .replace(/  +/g, function(spaces) {
      return '&nbsp;'.repeat(spaces.length);
    })
    // Wrap in a div with proper CSS for spacing preservation
    .replace(/^/, '<div style="white-space: pre-wrap; font-family: Arial, sans-serif; line-height: 1.6; color: #333;">')
    .replace(/$/, '</div>');
}
