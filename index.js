// index.js

console.log("--- index.js script started ---");

const { Client, GatewayIntentBits, Events, Partials, Collection, PermissionsBitField, ChannelType, MessageFlags } = require('discord.js');
const TOKEN = process.env.BOT_TOKEN;
const fs = require('node:fs');
const path = require('node:path');
const { google } = require('googleapis');
const cron = require('node-cron');
const axios = require('axios');
const stream = require('stream');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Sheet1';
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const GOOGLE_CREDENTIALS_JSON_CONTENT = process.env.GOOGLE_CREDENTIALS_JSON;

const API_SCOPES = [ /* ... */ ];
const EXPECTED_HEADERS = [ /* ... 9 headers ... */ ];
const COLUMN_DISCORD_TAG = 'A';
const TIMESTAMP_COLUMN_INDEX = EXPECTED_HEADERS.indexOf('Timestamp (UTC)');
const DRIVE_FILE_ID_COLUMN_INDEX = EXPECTED_HEADERS.indexOf('Drive File ID');

let sheetsClient;
let driveClient;
let googleAuthClient;
let numericSheetId;

const blankTicketTimeouts = new Map();
const EPHEMERAL_DELETE_DELAY = 10000;

async function replyEphemeralAutoDelete(interaction, options, isFollowUp = false, isEdit = false) { /* ... same as v13/interaction_debug ... */ }
async function ensureSheetHeaders() { /* ... same as v17/full_bot_env_vars_clean_v2 ... */ }
async function authorizeGoogleAPIs() { /* ... same as v17/full_bot_env_vars_clean_v2 ... */ }
const GUILD_CONFIGS_PATH = path.join(__dirname, 'guild-configs.json');
let guildConfigs = {};
let openTickets = {};
function loadGuildConfigs() { /* ... same ... */ }
function saveGuildConfigs() { /* ... same ... */ }
function formatTimestamp(date, includeSeconds = false, dateOnly = false) { /* ... same ... */ }
async function clearSheet() { /* ... same (weekly sheet-only clear) ... */ }
async function autoResizeSheetColumns() { /* ... same ... */ }
function formatDuration(ms, short = false) { /* ... same ... */ }
async function updatePromptMessage(guildId, messageId, channelId, clientInstance) { /* ... same ... */ }
async function updateAllPromptMessages(clientInstance) { /* ... same ... */ }

(async () => {
    console.log("--- Initializing Bot ---");
    if (!TOKEN || !SPREADSHEET_ID || !DRIVE_FOLDER_ID || !GOOGLE_CREDENTIALS_JSON_CONTENT || !SHEET_NAME) {
        console.error("[FATAL_CONFIG_ERROR] Critical environment variables are not set. Exiting.");
        console.log(`  BOT_TOKEN present: ${!!TOKEN}`);
        console.log(`  SPREADSHEET_ID present: ${!!SPREADSHEET_ID}`);
        console.log(`  SHEET_NAME resolved to: ${SHEET_NAME}`);
        console.log(`  GOOGLE_DRIVE_FOLDER_ID present: ${!!DRIVE_FOLDER_ID}`);
        console.log(`  GOOGLE_CREDENTIALS_JSON_CONTENT present: ${!!GOOGLE_CREDENTIALS_JSON_CONTENT}`);
        process.exit(1);
    }
    if (!await authorizeGoogleAPIs()) {
        console.error("[FATAL] Failed to authorize Google APIs. Bot functionality may be limited.");
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

    client.once(Events.ClientReady, readyClient => { /* ... same ... */ });
    client.on(Events.InteractionCreate, async interaction => { /* ... same as discord_js_index_interaction_debug ... */ });

    // --- MODIFIED Event Handler: MessageCreate (for screenshot logging) ---
    client.on(Events.MessageCreate, async message => {
        console.log(`[MSG_CREATE_DEBUG] Received message from ${message.author.tag} in #${message.channel.name} (Guild: ${message.guild?.name})`);

        if (message.author.bot || !message.guild) {
            console.log(`[MSG_CREATE_DEBUG] Message ignored (from bot or not in guild).`);
            return;
        }
        
        if (blankTicketTimeouts.has(message.channel.id)) {
            clearTimeout(blankTicketTimeouts.get(message.channel.id));
            blankTicketTimeouts.delete(message.channel.id);
            console.log(`[TICKET_ACTIVITY] User messaged in ${message.channel.name}, blank ticket deletion cancelled.`);
        }

        if (!sheetsClient || !driveClient || !SPREADSHEET_ID || !SHEET_NAME || typeof numericSheetId === 'undefined' || !DRIVE_FOLDER_ID) {
            console.log(`[MSG_CREATE_DEBUG] Google API clients or config not ready. Skipping screenshot logic.`);
            return;
        }
        
        const guildConfig = guildConfigs[message.guild.id];
        if (!guildConfig) {
            console.log(`[MSG_CREATE_DEBUG] No guild config found for guild ${message.guild.id}. Skipping screenshot logic.`);
            return;
        }
        if (!guildConfig.ticketCategoryId) {
            console.log(`[MSG_CREATE_DEBUG] ticketCategoryId not in guildConfig for ${message.guild.id}. Skipping screenshot logic.`);
            return;
        }
        if (message.channel.parentId !== guildConfig.ticketCategoryId) {
            console.log(`[MSG_CREATE_DEBUG] Message not in configured ticket category (ChannelParent: ${message.channel.parentId}, ExpectedCategory: ${guildConfig.ticketCategoryId}). Skipping.`);
            return;
        }
        if (!message.channel.name.startsWith('ticket-')) {
            console.log(`[MSG_CREATE_DEBUG] Channel name "${message.channel.name}" does not start with "ticket-". Skipping.`);
            return;
        }

        console.log(`[MSG_CREATE_DEBUG] Message is in a valid ticket channel. Checking attachments...`);

        if (message.attachments.size > 0) {
            console.log(`[MSG_CREATE_DEBUG] Message has ${message.attachments.size} attachment(s).`);
            const attachment = message.attachments.first();
            const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
            const isImage = imageExtensions.some(ext => attachment.name.toLowerCase().endsWith(ext)) || (attachment.contentType?.startsWith('image/'));
            
            console.log(`[MSG_CREATE_DEBUG] Attachment name: ${attachment.name}, contentType: ${attachment.contentType}, isImage: ${isImage}`);

            if (isImage) {
                console.log(`[MSG_CREATE_DEBUG] Image detected. Proceeding with logging for ${message.author.tag}.`);
                let uploadedFileId = null;
                let oldDriveFileIdToReplace = null;

                try {
                    // ... (rest of the Google Drive upload and Sheets logging logic from v17 remains here)
                    // Ensure this entire block is present from your last full bot code (discord_js_index_v17 or discord_js_index_full_bot_env_vars_clean_v2)
                    console.log(`[GDRIVE_DOWNLOAD] Downloading image from Discord: ${attachment.url}`);
                    const response = await axios({ method: 'get', url: attachment.url, responseType: 'arraybuffer' });
                    const imageBuffer = Buffer.from(response.data);
                    const imageStream = new stream.PassThrough();
                    imageStream.end(imageBuffer);
                    console.log(`[GDRIVE_UPLOAD] Image downloaded. Size: ${imageBuffer.length} bytes. Uploading to Google Drive...`);

                    const fileMetadata = { name: `${message.author.id}-${Date.now()}-${attachment.name}`, parents: [DRIVE_FOLDER_ID] };
                    const media = { mimeType: attachment.contentType || 'image/png', body: imageStream };

                    const discordTag = message.author.tag;
                    const currentDate = new Date();
                    const dateOnlyString = formatTimestamp(currentDate, false, true); // MM-DD-YY

                    const sheetDataRange = `'${SHEET_NAME}'!${COLUMN_DISCORD_TAG}2:${String.fromCharCode(64 + Math.max(TIMESTAMP_COLUMN_INDEX + 1, DRIVE_FILE_ID_COLUMN_INDEX + 1))}`;
                    const sheetDataResponse = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: sheetDataRange });
                    const rows = sheetDataResponse.data.values;
                    let existingRowNumber = -1;

                    if (rows && rows.length > 0) {
                        for (let i = 0; i < rows.length; i++) {
                            const row = rows[i];
                            if (row && row[0] === discordTag && typeof row[TIMESTAMP_COLUMN_INDEX] === 'string' && row[TIMESTAMP_COLUMN_INDEX].startsWith(dateOnlyString)) {
                                existingRowNumber = i + 2;
                                if (DRIVE_FILE_ID_COLUMN_INDEX >=0 && row[DRIVE_FILE_ID_COLUMN_INDEX]) oldDriveFileIdToReplace = row[DRIVE_FILE_ID_COLUMN_INDEX];
                                break;
                            }
                        }
                    }

                    const driveFile = await driveClient.files.create({ resource: fileMetadata, media: media, fields: 'id, webViewLink' });
                    uploadedFileId = driveFile.data.id;
                    const driveWebViewLink = driveFile.data.webViewLink;
                    console.log(`[GDRIVE_UPLOAD] Successfully uploaded. File ID: ${uploadedFileId}, Link: ${driveWebViewLink}`);

                    if (oldDriveFileIdToReplace && oldDriveFileIdToReplace !== uploadedFileId) {
                        console.log(`[GDRIVE_DELETE] Replacing. Deleting old Drive File ID: ${oldDriveFileIdToReplace}`);
                        await driveClient.files.delete({ fileId: oldDriveFileIdToReplace });
                        console.log(`[GDRIVE_DELETE] Successfully deleted old Drive file ${oldDriveFileIdToReplace}.`);
                    }
                    
                    const playerDisplayName = message.member.displayName;
                    const screenshotUrlFormula = `=HYPERLINK("${driveWebViewLink.replace(/"/g, '%22')}", "View Screenshot")`;
                    const fullTimestamp = formatTimestamp(currentDate, false); // MM-DD-YY HH:mm UTC
                    const verified = ""; const flags = "";
                    const timeInServerFormatted = formatDuration(Date.now() - message.member.joinedTimestamp, true);
                    const ticketChannelName = message.channel.name;
                    const newRowData = [ discordTag, playerDisplayName, screenshotUrlFormula, fullTimestamp, verified, flags, timeInServerFormatted, ticketChannelName, uploadedFileId ];

                    // Logic for new sheet format (Daily Slots)
                    const currentDayIndex = currentDate.getUTCDay(); // 0 for Sunday
                    const dayName = DAYS_OF_WEEK[currentDayIndex];
                    const startDataRowForDay = (currentDayIndex * ROWS_PER_DAY_BLOCK) + 2;
                    const dataToUpdateInSheet = [ // This should be an array of arrays for column B update
                        [playerDisplayName], [screenshotUrlFormula], [fullTimestamp],
                        [verified], [flags], [timeInServerFormatted], [uploadedFileId]
                    ];
                    const updateRange = `'${SHEET_NAME}'!B${startDataRowForDay}:B${startDataRowForDay + DAY_SUB_HEADERS.length - 1}`;
                    
                    console.log(`[GSHEETS_DEBUG] Updating data for ${dayName} (${discordTag}). Range: ${updateRange}`);
                    await sheetsClient.spreadsheets.values.update({
                        spreadsheetId: SPREADSHEET_ID, range: updateRange,
                        valueInputOption: 'USER_ENTERED', resource: { values: dataToUpdateInSheet },
                    });
                    console.log(`[GSHEETS] Logged/Updated submission for ${discordTag} for ${dayName}.`);


                    await message.react('✅');
                    const thankYouMsg = await message.channel.send(`🎉 Thank you, ${message.author.toString()}! Your screenshot for **${dayName}** has been logged. This message, your original image, and this ticket channel will be removed shortly.`);
                    await autoResizeSheetColumns();

                    setTimeout(() => { /* ... message and channel deletion logic ... */ }, 7000);

                } catch (error) {
                    console.error('[GAPI_ERROR] Failed during Discord download, Drive upload, or Sheets operation:', error.message);
                    if (error.response?.data?.error) console.error('[GAPI_ERROR_DETAILS]:', JSON.stringify(error.response.data.error, null, 2));
                    if (uploadedFileId) { /* ... orphan cleanup ... */ }
                    message.channel.send('⚠️ Error processing your screenshot (Drive/Sheets). Check console.').catch(console.error);
                    message.react('❌').catch(console.error);
                }
            } else { // Attachment is not a recognized image
                console.log(`[MSG_CREATE_DEBUG] Attachment is not a recognized image type.`);
                message.reply({ content: "It looks like that wasn't a recognized image file. Please upload a screenshot in a common format (PNG, JPG, WEBP, GIF).\nIf you need other assistance, an admin will be with you shortly."}).catch(console.error);
            }
        } else { // No attachments, just text
            console.log(`[MSG_CREATE_DEBUG] Message has no attachments. Replying as text message.`);
            message.reply({ content: "Thanks for your message! An admin will be with you shortly to assist. If you meant to submit a screenshot, please send it as an image attachment." }).catch(console.error);
        }
    });

    client.on(Events.ChannelDelete, channel => { /* ... same channel delete logic ... */ });

    try {
        await client.login(TOKEN);
        console.log("Login to Discord successful!");
    } catch (error) { /* ... same login error handling ... */ }

    console.log("[INFO] Bot is running and listening for events. Process will be kept alive.");
    await new Promise(() => {});

})();

