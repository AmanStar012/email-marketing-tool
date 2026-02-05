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
        email: 'oravi8937@gmail.com',
        password: 'vvqxkbraclqzclgu',
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
        email: 'mirakhan9880@gmail.com',
        password: 'cnkovpqzebmcirja',
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
email: 'dmalvika301@gmail.com',
password: 'tsboiaiwyoyxrepc',
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
email: 'kunal789arora@gmail.com',
password: 'qkauojxcdgtdunud',
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
email: 'sanjaytalentmanager@gmail.com',
password: 'bwoekhfrcmkxcyqq',
active: false
},
{
id: 22,
name: 'Account 22',
email: 'mukultalentmanager@gmail.com',
password: 'xjpgbwetasfxoevz',
active: false
},
{
id: 23,
name: 'Account 23',
email: 'albaabtalentmanager@gmail.com',
password: 'ekankglzkqxjrcgk',
active: false
},
{
id: 24,
name: 'Account 24',
email: 'haidertalentmanager@gmail.com',
password: 'hhjrdircmjvgvjmj',
active: false
},
{
id: 25,
name: 'Account 25',
email: 'gonikatalentmanager@gmail.com',
password: 'iayiyikuozwsexqm',
active: false
},
{
id: 26,
name: 'Account 26',
email: 'muskantalentmanager@gmail.com',
password: 'bvwhuicgikwkxzpg',
active: false
},
{
id: 27,
name: 'Account 27',
email: 'nidatalentmanager@gmail.com',
password: 'njsfqibmlwcxfbyk',
active: false
},
{
id: 28,
name: 'Account 28',
email: 'arshadtalentmanager@gmail.com',
password: 'ylfyjzfrhofwkuoj',
active: false
},
{
id: 29,
name: 'Account 29',
email: 'divyanshutalentmanager@gmail.com',
password: 'xnmbulytpsiofnwn',
active: false
},
{
id: 30,
name: 'Account 30',
email: 'nilamtalentmanager@gmail.com',
password: 'bdkscfgtlgxhvvmw',
active: false
},
{
id: 31,
name: 'Account 31',
email: 'faiztalentmanager@gmail.com',
password: 'nojkuxcnywydbdim',
active: false
},
{
id: 32,
name: 'Account 32',
email: 'mayanktalentmanager@gmail.com',
password: 'fyqhfnafbofaoapw',
active: false
},
{
id: 33,
name: 'Account 33',
email: 'krishnatalentmanager@gmail.com',
password: 'uvdpmxwkwsmtggzr',
active: false
},
{
id: 34,
name: 'Account 34',
email: 'ojastalentmanager@gmail.com',
password: 'pihrnsbigntorpwf',
active: false
},
{      
id: 35,
name: 'Account 35',
email: 'haiderr12124@gmail.com',
password: 'zfxpjdjospolazoy',
active: false
},   
{
id: 36,
name: 'Account 36',
email: 'hussaintalentmanager@gmail.com',
password: 'vopujcibukkhhwcz',
active: false
},
{
id: 37,
name: 'Account 37',
email: 'samsertalentmanager@gmail.com',
password: 'iupvrrmgberxbxcm',
active: false
},
{
id: 38,
name: 'Account 38',
email: 'kamrentalentmanager@gmail.com',
password: 'ouop fpzs cauz xdov',
active: false
},
{
id: 39,
name: 'Account 39',
email: 'sufiyatalentmanager@gmail.com',
password: 'pliz fbzr sobh krqm',
active: false
},
{
id: 40,
name: 'Account 40',
email: 'devatalentmanager@gmail.com',
password: 'lfxc pqez dllj kegw',
active: false
},
{
id: 41,
name: 'Account 41',
email: 'neelamtalentmanager@gmail.com',
password: 'vzyh ubnk feyg bcpy',
active: false
},   
{
id: 42,
name: 'Account 42',
email: 'neetutalentmanager@gmail.com',
password: 'nrnh gtxr nsce euws',
active: false
},
{
id: 43,
name: 'Account 43',
email: 'susmitatalentmanager@gmail.com',
password: 'zpme bywv alqt uvhg',
active: false
}, 
{
id: 44,
name: 'Account 44',
email: 'nehatalentmanager@gmail.com',
password: 'riiz zglw mgza xpwx',
active: false
}, 
{
id: 45,
name: 'Account 45',
email: 'veertalentmanager@gmail.com',
password: 'tbhn mpof ejfo ynio',
active: false
}, 
{
id: 46,
name: 'Account 46',
email: 'devitalentmanager@gmail.com',
password: 'jklr sbul lzih gcfx',
active: false
},
{
id: 47,
name: 'Account 47',
email: 'goldytalentmanager@gmail.com',
password: 'xkov lazp yzmo lqwi',
active: false
},
{
id: 48,
name: 'Account 48',
email: 'sumittalentmanager@gmail.com',
password: 'qkrh qvpc ejys yped',
active: false
},
{
id: 49,
name: 'Account 49',
email: 'sushanttalentmanager@gmail.com',
password: 'ffof jury mrwq tuax',
active: false
},
{
id: 50,
name: 'Account 50',
email: 'gitatalentmanager@gmail.com',
password: 'jrbj udor jtdi nwjj',
active: false
},
{
id: 51,
name: 'Account 51',
email: 'shimatalentmanager@gmail.com',
password: 'xjkv sbhz lqet xvqt',
active: false
},
{
id: 52,
name: 'Account 52',
email: 'ayushtalentmanager@gmail.com',
password: 'xjkv sbhz lqet xvqt',
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
