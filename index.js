// index.js

console.log("--- index.js script started ---");

const { Client, GatewayIntentBits, Events, Partials, Collection, PermissionsBitField, ChannelType, MessageFlags } = require('discord.js');
// const config = require('./config.json'); // For local testing if env vars not set
// const TOKEN = config.botToken || process.env.BOT_TOKEN; // Prioritize env var
const TOKEN = process.env.BOT_TOKEN; // For Fly.io

const fs = require('node:fs');
const path = require('node:path');
const { google } = require('googleapis');
const cron = require('node-cron');
const axios = require('axios');
const stream = require('stream');

// --- Configuration from Environment Variables (for Fly.io) or config.json (local fallback) ---
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Sheet1'; // Defaulting to 'Sheet1'
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const GOOGLE_CREDENTIALS_JSON_CONTENT = process.env.GOOGLE_CREDENTIALS_JSON;
const SHEETS_CREDENTIALS_PATH = path.join(__dirname, 'credentials.json'); // For local if GOOGLE_CREDENTIALS_JSON_CONTENT is not set

const API_SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file'
];

// New Sheet Structure
const DAYS_OF_WEEK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]; // Sunday is 0 in getUTCDay()
const DAY_SUB_HEADERS = [ // Labels that repeat under each day in Column A
    'Player Display Name', 'Screenshot', 'Timestamp (UTC)',
    'Verified', 'Strikes', 'Time in Server', 'Drive File ID'
];
const ROWS_PER_DAY_BLOCK = 1 + DAY_SUB_HEADERS.length; // 1 for Day Header + number of sub-headers (1 + 7 = 8)

let sheetsClient;
let driveClient;
let googleAuthClient;
let numericSheetId; // Will store the numerical ID of the target sheet

const blankTicketTimeouts = new Map(); // channelId -> TimeoutID
const EPHEMERAL_DELETE_DELAY = 10000; // 10 seconds for auto-deleting ephemeral replies

// Helper function to send and then delete an ephemeral reply
async function replyEphemeralAutoDelete(interaction, options, isFollowUp = false, isEdit = false) {
    try {
        let sentMessage;
        const currentOptions = { ...options, flags: [MessageFlags.Ephemeral] }; // Ensure flags are always set
        if (isEdit) {
            console.log(`[INTERACTION_REPLY_DEBUG] Attempting to editReply for interaction ${interaction.id}`);
            sentMessage = await interaction.editReply(currentOptions);
        } else if (isFollowUp) {
            console.log(`[INTERACTION_REPLY_DEBUG] Attempting to followUp for interaction ${interaction.id}`);
            sentMessage = await interaction.followUp(currentOptions);
        } else {
            console.log(`[INTERACTION_REPLY_DEBUG] Attempting to reply for interaction ${interaction.id}`);
            sentMessage = await interaction.reply(currentOptions);
        }
        console.log(`[INTERACTION_REPLY_DEBUG] Reply/Edit/FollowUp sent for interaction ${interaction.id}`);

        if (sentMessage && typeof sentMessage.delete === 'function') {
            setTimeout(() => {
                sentMessage.delete().catch(err => {
                    if (err.code !== 10008) { // Silently ignore "Unknown Message"
                        console.error(`[AUTO_DELETE_ERROR] Ephemeral reply ${sentMessage.id || 'unknown'} for interaction ${interaction.id}:`, err.message);
                    }
                });
            }, EPHEMERAL_DELETE_DELAY);
        }
    } catch (error) {
        console.error(`[REPLY_ERROR] Failed to send/edit/followUp or handle auto-delete for interaction ${interaction.id}:`, error.message);
    }
}

// Function to ensure Google Sheet has the correct headers and structure for daily slots
async function ensureSheetHeadersAndStructure() {
    if (!sheetsClient || !SPREADSHEET_ID || !SHEET_NAME) {
        console.log('[GSHEETS_SETUP] Sheets client/config missing for header/structure setup.');
        return;
    }
    try {
        const expectedColumnAValues = [];
        DAYS_OF_WEEK.forEach(day => {
            expectedColumnAValues.push(day); // Day Header
            DAY_SUB_HEADERS.forEach(subHeader => {
                expectedColumnAValues.push(`  ${subHeader}`); // Indent sub-headers for clarity
            });
        });

        const rangeForColumnA = `'${SHEET_NAME}'!A1:A${expectedColumnAValues.length}`;
        const getResponse = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: rangeForColumnA,
        });

        const existingColA = getResponse.data.values ? getResponse.data.values.flat() : [];
        let needsUpdate = false;
        if (existingColA.length < expectedColumnAValues.length) {
            needsUpdate = true;
        } else {
            for (let i = 0; i < expectedColumnAValues.length; i++) {
                if (existingColA[i] !== expectedColumnAValues[i]) {
                    needsUpdate = true;
                    break;
                }
            }
        }

        if (needsUpdate) {
            console.log(`[GSHEETS_SETUP] Sheet structure in '${SHEET_NAME}' needs update or creation. Writing labels to Column A.`);
            const valuesForColumnA = expectedColumnAValues.map(val => [val]);
            await sheetsClient.spreadsheets.values.update({ // Use update to write to A1 and potentially overwrite
                spreadsheetId: SPREADSHEET_ID,
                range: `'${SHEET_NAME}'!A1`, // Start writing from A1
                valueInputOption: 'USER_ENTERED',
                resource: { values: valuesForColumnA },
            });
            console.log(`[GSHEETS_SETUP] Successfully wrote labels to Column A of '${SHEET_NAME}'.`);
        } else {
            console.log(`[GSHEETS_SETUP] Column A labels in sheet '${SHEET_NAME}' are correct.`);
        }

    } catch (error) {
        console.error(`[GSHEETS_SETUP_ERROR] Failed to ensure sheet structure for '${SHEET_NAME}':`, error.message);
        if (error.response?.data?.error?.message.includes("Unable to parse range") || error.message.includes("Requested entity was not found")) {
             console.error(`[GSHEETS_SETUP_ERROR_DETAILS] Sheet named '${SHEET_NAME}' might not exist in spreadsheet '${SPREADSHEET_ID}'. Please create it manually with this name.`);
        }
    }
}

// Function to authorize Google APIs (Sheets and Drive)
async function authorizeGoogleAPIs() {
    try {
        let credentialsToUse;
        if (GOOGLE_CREDENTIALS_JSON_CONTENT) {
            try { credentialsToUse = JSON.parse(GOOGLE_CREDENTIALS_JSON_CONTENT); }
            catch (e) { console.error('[GAPI_ERROR] Failed to parse GOOGLE_CREDENTIALS_JSON from env var.', e); return false; }
        } else if (fs.existsSync(SHEETS_CREDENTIALS_PATH)) {
            console.log('[GAPI_INFO] Using local credentials.json file.');
            // credentialsToUse will be undefined, GoogleAuth will use keyFile path
        } else {
            console.error('[GAPI_ERROR] Google credentials not found (env var GOOGLE_CREDENTIALS_JSON or local file credentials.json).'); return false;
        }

        if (!SPREADSHEET_ID) { console.error('[GAPI_ERROR] SPREADSHEET_ID missing from environment variables.'); return false; }
        if (!SHEET_NAME) { console.error('[GAPI_ERROR] SHEET_NAME missing from environment variables (or default not used).'); return false; }
        if (!DRIVE_FOLDER_ID) { console.error('[GAPI_ERROR] GOOGLE_DRIVE_FOLDER_ID missing from environment variables.'); return false; }

        googleAuthClient = new google.auth.GoogleAuth({
            credentials: credentialsToUse, // Will be undefined if using keyFile path
            keyFile: credentialsToUse ? undefined : SHEETS_CREDENTIALS_PATH, // Only use keyFile if credentials object isn't provided
            scopes: API_SCOPES
        });
        const authClient = await googleAuthClient.getClient();
        
        sheetsClient = google.sheets({ version: 'v4', auth: authClient });
        console.log(`[GSHEETS] Authorized. Target Spreadsheet ID: ${SPREADSHEET_ID}, Target Sheet Name: ${SHEET_NAME}`);
        
        driveClient = google.drive({ version: 'v3', auth: authClient });
        console.log(`[GDRIVE] Authorized for Google Drive API.`);

        const spreadsheetMeta = await sheetsClient.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: 'sheets(properties(sheetId,title))' });
        const targetSheet = spreadsheetMeta.data.sheets.find(s => s.properties.title === SHEET_NAME);
        if (targetSheet) {
            numericSheetId = targetSheet.properties.sheetId;
            console.log(`[GSHEETS] Numeric sheetId for '${SHEET_NAME}' is: ${numericSheetId}`);
            await ensureSheetHeadersAndStructure(); // Ensure sheet structure after finding the sheet
        } else {
            console.error(`[GSHEETS_ERROR] Could not find sheet named '${SHEET_NAME}' in spreadsheet '${SPREADSHEET_ID}'. Please ensure it exists or the bot has permission to create it (currently not implemented).`);
            // If the sheet doesn't exist, numericSheetId will be undefined, and subsequent operations might fail.
        }
        return true; // Indicates successful authorization for APIs
    } catch (error) {
        console.error('[GAPI_ERROR_AUTH] Failed to authorize Google Sheets/Drive or process sheet metadata:', error.message);
        if (error.response?.data?.error?.message.includes("PERMISSION_DENIED")) {
            console.error("[GAPI_ERROR_AUTH] PERMISSION_DENIED. Ensure Sheets API & Drive API are enabled in your Google Cloud Project and the service account has 'Editor' permissions on the Spreadsheet and the Drive Folder.");
        }
        return false; // Indicates authorization failure
    }
}

const GUILD_CONFIGS_PATH = path.join(__dirname, 'guild-configs.json');
let guildConfigs = {};
let openTickets = {};

function loadGuildConfigs() { /* ... same ... */ }
function saveGuildConfigs() { /* ... same ... */ }

// Updated Timestamp format
function formatTimestamp(date, dateOnly = false) { // MM-DD-YY HH:mm UTC or MM-DD-YY
    const year = String(date.getUTCFullYear()).slice(-2); // YY
    const month = String(date.getUTCMonth() + 1).padStart(2, '0'); // MM
    const day = String(date.getUTCDate()).padStart(2, '0'); // DD

    if (dateOnly) return `${month}-${day}-${year}`; // MM-DD-YY

    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    return `${month}-${day}-${year} ${hours}:${minutes} UTC`; // MM-DD-YY HH:mm UTC
}

// Updated clearSheet for the new daily slot format
async function clearSheetWeekly() {
    if (!sheetsClient || !SPREADSHEET_ID || !SHEET_NAME || typeof numericSheetId === 'undefined') {
        console.log('[GSHEETS_CLEAR_WEEKLY] Sheets client/config missing. Skipping clear.'); return false;
    }
    try {
        const requests = [];
        for (let i = 0; i < DAYS_OF_WEEK.length; i++) {
            const startDataRowForDay = (i * ROWS_PER_DAY_BLOCK) + 2; // 1-based index
            const endDataRowForDay = startDataRowForDay + DAY_SUB_HEADERS.length - 1;
            // Request to clear Column B for this day's block
            requests.push({
                updateCells: {
                    range: {
                        sheetId: numericSheetId,
                        startRowIndex: startDataRowForDay - 1, // API is 0-indexed
                        endRowIndex: endDataRowForDay,
                        startColumnIndex: 1, // Column B
                        endColumnIndex: 2,   // Only Column B
                    },
                    rows: Array(DAY_SUB_HEADERS.length).fill({ values: [{ userEnteredValue: { stringValue: "" } }] }), // Set to empty strings
                    fields: "userEnteredValue" // Clear only the values, not formatting
                }
            });
        }
        
        if (requests.length > 0) {
            await sheetsClient.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                resource: { requests }
            });
        }
        console.log(`[GSHEETS_CLEAR_WEEKLY] Successfully cleared data in Column B for sheet '${SHEET_NAME}' at ${new Date().toUTCString()}`);
        return true;
    } catch (error) {
        console.error(`[GSHEETS_CLEAR_WEEKLY_ERROR] Failed to clear sheet '${SHEET_NAME}':`, error.message); return false;
    }
}

// Updated autoResizeSheetColumns for the new 2-column format
async function autoResizeSheetColumns() {
    if (!sheetsClient || !SPREADSHEET_ID || typeof numericSheetId === 'undefined') {
        console.log('[GSHEETS_RESIZE] Sheets client/config missing. Skipping resize.'); return;
    }
    try {
        await sheetsClient.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            resource: { requests: [{ autoResizeDimensions: { dimensions: { sheetId: numericSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 2 } } }] } // Resize A & B
        });
        console.log(`[GSHEETS_RESIZE] Requested auto-resize for columns A & B in sheetId ${numericSheetId}.`);
    } catch (error) {
        console.error(`[GSHEETS_RESIZE_ERROR] Failed for sheetId ${numericSheetId}:`, error.message);
    }
}

function formatDuration(ms, short = false) { /* ... same ... */ }
async function updatePromptMessage(guildId, messageId, channelId, clientInstance) { /* ... same ... */ }
async function updateAllPromptMessages(clientInstance) { /* ... same ... */ }

(async () => {
    console.log("--- Initializing Bot ---");
    if (!TOKEN || !SPREADSHEET_ID || !DRIVE_FOLDER_ID || (!GOOGLE_CREDENTIALS_JSON_CONTENT && !fs.existsSync(SHEETS_CREDENTIALS_PATH)) || !SHEET_NAME) {
        console.error("[FATAL_CONFIG_ERROR] Critical environment variables/files not set. Exiting.");
        process.exit(1);
    }
    if (!await authorizeGoogleAPIs()) {
        console.error("[FATAL] Failed to authorize Google APIs. Bot functionality will be severely limited or non-functional.");
    }
    loadGuildConfigs();
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessageReactions,
        ],
        partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    });
    client.updatePromptMessage = updatePromptMessage;
    client.commands = new Collection();
    const commandsPath = path.join(__dirname, 'commands');
    try {
        const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
        for (const file of commandFiles) {
            const filePath = path.join(commandsPath, file);
            const command = require(filePath);
            if ('data' in command && 'execute' in command) {
                client.commands.set(command.data.name, command);
                console.log(`[CMDS] Loaded command: /${command.data.name}`);
            } else {
                console.log(`[WARNING] Command at ${filePath} missing "data" or "execute".`);
            }
        }
    } catch (error) {
        console.error(`[ERROR] Could not read commands dir:`, error);
    }

    client.once(Events.ClientReady, readyClient => {
        console.log(`\nReady! Logged in as ${readyClient.user.tag}`);
        cron.schedule('0 0 * * 0', () => { console.log('[CRON] Running weekly sheet data clear job...'); clearSheetWeekly(); }, { scheduled: true, timezone: "UTC" });
        console.log('[CRON] Weekly sheet data clear scheduled for Sunday 00:00 UTC.');
        setInterval(() => updateAllPromptMessages(client), 60000);
        updateAllPromptMessages(client);
        console.log('[PROMPT_UPDATE] Periodic prompt message updates scheduled (every 1 min).');
    });

    client.on(Events.InteractionCreate, async interaction => {
        // This is the version from discord_js_index_interaction_debug for robust replies
        console.log(`[INTERACTION_DEBUG] Received interaction: Type=${interaction.type}, CustomID/CommandName=${interaction.customId || interaction.commandName}, User=${interaction.user.tag}, Guild=${interaction.guildId}`);
        if (!interaction.inGuild()) {
            console.log(`[INTERACTION_DEBUG] Interaction not in guild. Ignoring.`);
            return;
        }
        const guildConfig = guildConfigs[interaction.guildId];

        if (interaction.isChatInputCommand()) {
            const command = interaction.client.commands.get(interaction.commandName);
            if (!command) {
                replyEphemeralAutoDelete(interaction, { content: `Error: Command /${interaction.commandName} not found.` });
                return;
            }
            try {
                console.log(`[INTERACTION_DEBUG] Executing command: /${interaction.commandName}`);
                // Pass all necessary clients and configs to the command, including sheetsClient, driveClient etc.
                await command.execute(interaction, client, guildConfigs, saveGuildConfigs,
                                      clearSheetWeekly, // Pass the sheet-only clear for general use if needed
                                      replyEphemeralAutoDelete,
                                      sheetsClient, driveClient, SPREADSHEET_ID, SHEET_NAME, numericSheetId // For test commands
                                     );
            } catch (error) {
                console.error(`[INTERACTION_ERROR] Uncaught error executing /${interaction.commandName}:`, error);
                const errorReplyOptions = { content: 'Oops! Something went wrong while running that command.' };
                if (interaction.deferred) {
                    console.log(`[INTERACTION_ERROR_HANDLER] Interaction was deferred, attempting editReply.`);
                    replyEphemeralAutoDelete(interaction, errorReplyOptions, false, true);
                } else if (!interaction.replied) {
                    console.log(`[INTERACTION_ERROR_HANDLER] Interaction not replied/deferred, attempting initial reply.`);
                    replyEphemeralAutoDelete(interaction, errorReplyOptions);
                } else {
                    console.log(`[INTERACTION_ERROR_HANDLER] Interaction already replied. No further error reply sent from global handler.`);
                }
            }
        } else if (interaction.isButton()) {
            // ... (Button interaction logic from discord_js_index_interaction_debug, ensure replyEphemeralAutoDelete is used)
        }
    });

    client.on(Events.MessageCreate, async message => {
        // Logic for the NEW DAILY SLOT sheet format (from v19)
        if (message.author.bot || !message.guild) return;
        if (blankTicketTimeouts.has(message.channel.id)) {
            clearTimeout(blankTicketTimeouts.get(message.channel.id));
            blankTicketTimeouts.delete(message.channel.id);
        }

        if (!sheetsClient || !driveClient || !SPREADSHEET_ID || !SHEET_NAME || typeof numericSheetId === 'undefined' || !DRIVE_FOLDER_ID) {
            return;
        }
        const guildConfig = guildConfigs[message.guild.id];
        if (!guildConfig || !guildConfig.ticketCategoryId || message.channel.parentId !== guildConfig.ticketCategoryId || !message.channel.name.startsWith('ticket-')) return;

        if (message.attachments.size > 0) {
            const attachment = message.attachments.first();
            const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
            const isImage = imageExtensions.some(ext => attachment.name.toLowerCase().endsWith(ext)) || (attachment.contentType?.startsWith('image/'));
            
            if (isImage) {
                let uploadedFileId = null;
                let previousDriveFileIdInSlot = null;
                try {
                    const currentDate = new Date();
                    const currentDayIndex = currentDate.getUTCDay(); // 0 for Sunday
                    const dayName = DAYS_OF_WEEK[currentDayIndex];
                    const startDataRowForDay = (currentDayIndex * ROWS_PER_DAY_BLOCK) + 2;
                    const driveFileIdCellRowInSheet = startDataRowForDay + DAY_SUB_HEADERS.indexOf('Drive File ID');
                    
                    try { // Get existing Drive File ID for this day's slot to delete it later
                        const getResponse = await sheetsClient.spreadsheets.values.get({
                            spreadsheetId: SPREADSHEET_ID,
                            range: `'${SHEET_NAME}'!B${driveFileIdCellRowInSheet}`, // Drive File ID is in Column B
                        });
                        if (getResponse.data.values?.[0]?.[0]) {
                            previousDriveFileIdInSlot = getResponse.data.values[0][0];
                        }
                    } catch (err) { console.warn(`[GSHEETS_READ_WARN] Could not read existing Drive File ID for ${dayName}: ${err.message}`); }

                    console.log(`[GDRIVE_DOWNLOAD] Downloading image from Discord: ${attachment.url}`);
                    const response = await axios({ method: 'get', url: attachment.url, responseType: 'arraybuffer' });
                    const imageBuffer = Buffer.from(response.data);
                    const imageStream = new stream.PassThrough();
                    imageStream.end(imageBuffer);
                    console.log(`[GDRIVE_UPLOAD] Image downloaded. Uploading to Google Drive...`);
                    const fileMetadata = { name: `${message.author.id}-${Date.now()}-${attachment.name}`, parents: [DRIVE_FOLDER_ID] };
                    const media = { mimeType: attachment.contentType || 'image/png', body: imageStream };
                    const driveFile = await driveClient.files.create({ resource: fileMetadata, media: media, fields: 'id, webViewLink' });
                    uploadedFileId = driveFile.data.id;
                    const driveWebViewLink = driveFile.data.webViewLink;
                    console.log(`[GDRIVE_UPLOAD] Successfully uploaded. File ID: ${uploadedFileId}, Link: ${driveWebViewLink}`);
                    
                    if (previousDriveFileIdInSlot && previousDriveFileIdInSlot !== uploadedFileId) {
                        console.log(`[GDRIVE_DELETE] Replacing entry for ${dayName}. Deleting old Drive File ID: ${previousDriveFileIdInSlot}`);
                        await driveClient.files.delete({ fileId: previousDriveFileIdInSlot });
                        console.log(`[GDRIVE_DELETE] Successfully deleted old Drive file ${previousDriveFileIdInSlot}.`);
                    }
                    
                    const playerDisplayName = message.member.displayName;
                    const screenshotUrlFormula = `=HYPERLINK("${driveWebViewLink.replace(/"/g, '%22')}", "View Screenshot")`;
                    const timestamp = formatTimestamp(currentDate); // MM-DD-YY HH:mm UTC
                    const verified = "";
                    const flags = ""; // "Strikes"
                    const timeInServerFormatted = formatDuration(Date.now() - message.member.joinedTimestamp, true);

                    const dayDataForSheet = [ // 7 data points for Column B for the day's slot
                        playerDisplayName, screenshotUrlFormula, timestamp,
                        verified, flags, timeInServerFormatted, uploadedFileId // Drive File ID is the 7th sub-header
                    ];
                    const valuesToUpdate = dayDataForSheet.map(val => [val]); // API needs array of arrays for column update
                    const updateRange = `'${SHEET_NAME}'!B${startDataRowForDay}:B${startDataRowForDay + DAY_SUB_HEADERS.length - 1}`;
                    
                    console.log(`[GSHEETS_DEBUG] Updating data for ${dayName} (${message.author.tag}). Range: ${updateRange}`);
                    await sheetsClient.spreadsheets.values.update({
                        spreadsheetId: SPREADSHEET_ID, range: updateRange,
                        valueInputOption: 'USER_ENTERED', resource: { values: valuesToUpdate },
                    });
                    console.log(`[GSHEETS] Logged/Updated submission for ${message.author.tag} for ${dayName}.`);

                    await message.react('✅');
                    const thankYouMsg = await message.channel.send(`🎉 Thank you, ${message.author.toString()}! Your screenshot for **${dayName}** has been logged. This message, your original image, and this ticket channel will be removed shortly.`);
                    await autoResizeSheetColumns();

                    setTimeout(() => { /* ... message and channel deletion logic ... */ }, 7000);

                } catch (error) { /* ... error handling, including Drive orphan cleanup ... */ }
            } else { /* ... non-image attachment reply ... */ }
        } else { /* ... text only message reply ... */ }
    });

    client.on(Events.ChannelDelete, channel => { /* ... same channel delete logic ... */ });

    try {
        await client.login(TOKEN);
        console.log("Login to Discord successful!");
    } catch (error) { /* ... same login error handling ... */ }

    console.log("[INFO] Bot is running and listening for events. Process will be kept alive.");
    await new Promise(() => {});

})();

