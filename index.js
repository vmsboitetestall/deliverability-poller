const { createClient } = require('@supabase/supabase-js');
const Imap = require('imap');
const { simpleParser } = require('mailparser');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_KEY environment variables.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
console.log("SUPABASE_URL:", supabaseUrl);

async function startPolling() {
  console.log("Starting Mailbox Deliverability Poller...");
  // Poll every 60 seconds
  setInterval(checkAllMailboxes, 10000); 
  checkAllMailboxes();
}

async function checkAllMailboxes() {
  console.log("Fetching mailboxes from Supabase...");
  const { data: mailboxes, error } = await supabase.from('mailboxes').select('*');
  
  if (error) {
    console.error("Error fetching mailboxes from Supabase:", error.message);
    return;
  }

  if (!mailboxes || mailboxes.length === 0) {
    console.log("No mailboxes found in the database.");
    return;
  }

  console.log(`Found ${mailboxes.length} mailbox(es). Processing...`);

  for (const mailbox of mailboxes) {
    // Identify Gmail mailboxes by checking the domain
    const isGmail = mailbox.email.toLowerCase().endsWith('@gmail.com');
    
    if (isGmail) {
      // Fallback: If auth_data.password is empty, use the string stored in the 'provider' field
      const password = mailbox.auth_data?.password || mailbox.provider;
      
      if (!password || password.trim() === "") {
        console.warn(`Skipping ${mailbox.email}: No password found in auth_data or provider fields.`);
        continue;
      }

      // Check both 'INBOX' and '[Gmail]/Spam'
      pollGmailIMAPFolder(mailbox, password, 'INBOX');
      pollGmailIMAPFolder(mailbox, password, '[Gmail]/Spam');
    } else {
      console.log(`Skipping non-Gmail mailbox: ${mailbox.email}`);
    }
  }
}

function pollGmailIMAPFolder(mailbox, password, folderName) {
  const imap = new Imap({
    user: mailbox.email,
    password: password,
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
  });

  imap.once('ready', () => {
    imap.openBox(folderName, true, (err, box) => {
      if (err) {
        console.error(`Error opening folder "${folderName}" for ${mailbox.email}:`, err.message);
        imap.end();
        return;
      }

      // Search for emails containing "TEST-" in the subject
      imap.search([['SUBJECT', 'TEST-']], (err, results) => {
        if (err) {
          console.error(`Search error on ${mailbox.email} in ${folderName}:`, err.message);
          imap.end();
          return;
        }

        if (!results || results.length === 0) {
          // No matching emails in this folder
          imap.end();
          return;
        }

        const f = imap.fetch(results, { bodies: '' });
        
        f.on('message', (msg, seqno) => {
          msg.on('body', (stream, info) => {
            simpleParser(stream, async (err, parsed) => {
              if (err) return;

                  const subject = parsed.subject || "";

                console.log("================================");
                console.log("Email Subject:", subject);

                const match = subject.match(/TEST-\d{8}-\d+/);

               console.log("Regex Match:", match);

              if (match) {
              const testRunId = match[0];
              const displayFolder = folderName === '[Gmail]/Spam' ? 'Spam' : 'Inbox';

              console.log("Calling reportResult with:", {
                  testRunId,
                  mailboxId: mailbox.id,
                folder: displayFolder
                });

    await reportResult(testRunId, mailbox.id, displayFolder);
}
            });
          });
        });

        f.once('end', () => {
          imap.end();
        });
      });
    });
  });

  imap.once('error', (err) => {
    console.error(`IMAP connection error on ${mailbox.email} for folder ${folderName}:`, err.message);
  });

  imap.connect();
}

async function reportResult(testRunId, mailboxId, folder) {
  try {
    // Check if this result is already recorded
    const { data, error: selectError } = await supabase
      .from('deliverability_results')
      .select('id')
      .eq('test_run_id', testRunId)
      .eq('mailbox_id', mailboxId)
      .limit(1);

    if (selectError) {
      console.error(`Error checking duplicates for ${testRunId}:`, selectError.message);
      return;
    }

    if (data && data.length > 0) {
      // Result is already recorded
      return;
    }

    // Insert new result
    const { error: insertError } = await supabase
      .from('deliverability_results')
      .insert({
        test_run_id: testRunId,
        mailbox_id: mailboxId,
        folder: folder
      });

    if (insertError) {
  console.error("========== INSERT ERROR ==========");
  console.error("Code:", insertError.code);
  console.error("Message:", insertError.message);
  console.error("Details:", insertError.details);
  console.error("Hint:", insertError.hint);
  console.error("Full error:", JSON.stringify(insertError, null, 2));
} else {
      console.log(`[Success] Reported: ${testRunId} found in ${folder} for mailbox ID ${mailboxId}`);
    }
  } catch (err) {
    console.error(`Unexpected error reporting result:`, err);
  }
}

startPolling();
