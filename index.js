// index.js

console.log("--- index.js script started ---");

// --- Environment Variable Debugging ---
console.log("[ENV_DEBUG] Attempting to read critical environment variables:");
console.log(`[ENV_DEBUG] BOT_TOKEN exists: ${!!process.env.BOT_TOKEN}`);
console.log(`[ENV_DEBUG] SPREADSHEET_ID exists: ${!!process.env.SPREADSHEET_ID}`);
console.log(`[ENV_DEBUG] SHEET_NAME exists: ${!!process.env.SHEET_NAME}`);
console.log(`[ENV_DEBUG] GOOGLE_DRIVE_FOLDER_ID exists: ${!!process.env.GOOGLE_DRIVE_FOLDER_ID}`);
console.log(`[ENV_DEBUG] GOOGLE_CREDENTIALS_JSON exists: ${!!process.env.GOOGLE_CREDENTIALS_JSON}`);
// console.log("[ENV_DEBUG] All process.env keys:", Object.keys(process.env).join(', ')); // Optional: very verbose


const { Client, GatewayIntentBits, Events, Partials, Collection, PermissionsBitField, ChannelType, MessageFlags } = require('discord.js');
// const config = require('./config.json'); // REMOVED - We will use environment variables

// Node.js built-in modules for file and path operations
const fs = require('node:fs');
const path = require('node:path');

// Google APIs Client Library
const { google } = require('googleapis');

// Cron job scheduler
const cron = require('node-cron');

// For downloading images
const axios = require('axios');
const stream = require('stream');

// --- Configuration from Environment Variables ---
const TOKEN = process.env.BOT_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Sheet1'; // Default if not set
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const GOOGLE_CREDENTIALS_JSON_CONTENT = process.env.GOOGLE_CREDENTIALS_JSON;

const API_SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file'
];

const EXPECTED_HEADERS = [
    'Discord Tag', 'Player Display Name', 'Screenshot', 'Timestamp (UTC)',
    'Verified', 'Strikes', 'Time in Server', 'Ticket Channel Name', 'Drive File ID'
];
const COLUMN_DISCORD_TAG = 'A';
const TIMESTAMP_COLUMN_INDEX = EXPECTED_HEADERS.indexOf('Timestamp (UTC)');
const DRIVE_FILE_ID_COLUMN_INDEX = EXPECTED_HEADERS.indexOf('Drive File ID');

let sheetsClient;
let driveClient;
let googleAuthClient;
let numericSheetId;

const blankTicketTimeouts = new Map();
const EPHEMERAL_DELETE_DELAY = 10000;

async function replyEphemeralAutoDelete(interaction, options, isFollowUp = false, isEdit = false) {
    try {
        let sentMessage;
        const currentOptions = { ...options, flags: [MessageFlags.Ephemeral] };
        if (isEdit) sentMessage = await interaction.editReply(currentOptions);
        else if (isFollowUp) sentMessage = await interaction.followUp(currentOptions);
        else sentMessage = await interaction.reply(currentOptions);

        if (sentMessage && typeof sentMessage.delete === 'function') {
            setTimeout(() => {
                sentMessage.delete().catch(err => {
                    if (err.code !== 10008) console.error(`[AUTO_DELETE_ERROR] Ephemeral reply ${sentMessage.id || 'unknown'}:`, err.message);
                });
            }, EPHEMERAL_DELETE_DELAY);
        }
    } catch (error) {
        console.error(`[REPLY_ERROR] Ephemeral auto-delete:`, error.message);
    }
}

async function ensureSheetHeaders() {
    if (!sheetsClient || !SPREADSHEET_ID || !SHEET_NAME) return;
    try {
        const rangeForHeaders = `'${SHEET_NAME}'!A1:${String.fromCharCode(64 + EXPECTED_HEADERS.length)}1`;
        const getResponse = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: rangeForHeaders,
        });
        const existingHeaders = getResponse.data.values ? getResponse.data.values[0] : [];
        let headersMatch = existingHeaders.length === EXPECTED_HEADERS.length && EXPECTED_HEADERS.every((h, i) => h === existingHeaders[i]);
        if (!headersMatch) {
            console.log(`[GSHEETS_HEADERS] Writing/updating headers in sheet '${SHEET_NAME}'.`);
            await sheetsClient.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID, range: `'${SHEET_NAME}'!A1`,
                valueInputOption: 'USER_ENTERED', resource: { values: [EXPECTED_HEADERS] },
            });
            console.log(`[GSHEETS_HEADERS] Successfully wrote/updated headers.`);
        } else {
            console.log(`[GSHEETS_HEADERS] Headers in sheet '${SHEET_NAME}' are correct.`);
        }
    } catch (error) {
        console.error(`[GSHEETS_HEADERS_ERROR] Failed for '${SHEET_NAME}':`, error.message);
        if (error.response?.data?.error?.message.includes("Unable to parse range")) {
             console.error(`[GSHEETS_HEADERS_ERROR_DETAILS] Sheet '${SHEET_NAME}' might not exist in spreadsheet '${SPREADSHEET_ID}'.`);
        }
    }
}

async function authorizeGoogleAPIs() {
    try {
        // Check if environment variables are loaded (this check is now more for confirmation after debug logs)
        if (!TOKEN || !SPREADSHEET_ID || !SHEET_NAME || !DRIVE_FOLDER_ID) {
            console.error('[GAPI_ERROR_INIT] One or more critical environment variables for Google API (SPREADSHEET_ID, SHEET_NAME, GOOGLE_DRIVE_FOLDER_ID) appear missing based on direct check.');
            // No early return here if GOOGLE_CREDENTIALS_JSON_CONTENT is present, as auth might still work if others are just for sheet ops
        }
        if (!GOOGLE_CREDENTIALS_JSON_CONTENT) {
            console.error('[GAPI_ERROR_INIT] GOOGLE_CREDENTIALS_JSON_CONTENT environment variable is definitely not set.');
            return false; // Cannot proceed without credentials
        }

        let googleCredentials;
        try {
            googleCredentials = JSON.parse(GOOGLE_CREDENTIALS_JSON_CONTENT);
        } catch (parseError) {
            console.error('[GAPI_ERROR_INIT] Failed to parse GOOGLE_CREDENTIALS_JSON. Ensure it is a valid JSON string.', parseError);
            return false;
        }
        
        googleAuthClient = new google.auth.GoogleAuth({
            credentials: googleCredentials,
            scopes: API_SCOPES
        });
        const authClient = await googleAuthClient.getClient();
        
        sheetsClient = google.sheets({ version: 'v4', auth: authClient });
        console.log(`[GSHEETS] Authorized. Target: ${SPREADSHEET_ID}, Sheet: ${SHEET_NAME}`);
        
        driveClient = google.drive({ version: 'v3', auth: authClient });
        console.log(`[GDRIVE] Authorized for Google Drive API.`);

        const spreadsheetMeta = await sheetsClient.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: 'sheets(properties(sheetId,title))' });
        const targetSheet = spreadsheetMeta.data.sheets.find(s => s.properties.title === SHEET_NAME);
        if (targetSheet) {
            numericSheetId = targetSheet.properties.sheetId;
            console.log(`[GSHEETS] Numeric sheetId for '${SHEET_NAME}' is: ${numericSheetId}`);
            await ensureSheetHeaders();
        } else {
            console.error(`[GSHEETS_ERROR] Could not find sheet named '${SHEET_NAME}'. Ensure it exists.`);
        }
        return true;
    } catch (error) {
        console.error('[GAPI_ERROR_AUTH] Failed to authorize Google Sheets/Drive or process sheet metadata:', error.message);
        return false;
    }
}

const GUILD_CONFIGS_PATH = path.join(__dirname, 'guild-configs.json');
let guildConfigs = {};
let openTickets = {};

function loadGuildConfigs() {
    // ... (same as before)
    try {
        if (fs.existsSync(GUILD_CONFIGS_PATH)) {
            guildConfigs = JSON.parse(fs.readFileSync(GUILD_CONFIGS_PATH, 'utf8'));
            console.log('[CONFIG] Loaded guild configurations.');
        } else {
            console.log('[CONFIG] guild-configs.json not found.'); guildConfigs = {};
        }
    } catch (error) {
        console.error('[ERROR] Failed to load guild-configs.json:', error); guildConfigs = {};
    }
    for (const guildId in guildConfigs) {
        if (!openTickets[guildId]) openTickets[guildId] = {};
    }
}

function saveGuildConfigs() {
    // ... (same as before)
    try {
        fs.writeFileSync(GUILD_CONFIGS_PATH, JSON.stringify(guildConfigs, null, 4));
        console.log('[CONFIG] Saved guild configurations.');
    } catch (error) {
        console.error('[ERROR] Failed to save guild-configs.json:', error);
    }
}

function formatTimestamp(date, includeSeconds = false, dateOnly = false) {
    // ... (same as before)
    const year = String(date.getUTCFullYear()).slice(-2);
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    if (dateOnly) return `${month}-${day}-${year}`;
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    if (!includeSeconds) return `${month}-${day}-${year} ${hours}:${minutes} UTC`;
    const seconds = String(date.getUTCSeconds()).padStart(2, '0');
    return `${month}-${day}-${year} ${hours}:${minutes}:${seconds} UTC`;
}

async function clearSheet() {
    // ... (same as before)
    if (!sheetsClient || !SPREADSHEET_ID || !SHEET_NAME) {
        console.log('[GSHEETS_CLEAR] Sheets client/config missing. Skipping clear.'); return false;
    }
    try {
        const rangeToClear = `'${SHEET_NAME}'!A2:${String.fromCharCode(64 + EXPECTED_HEADERS.length)}`;
        await sheetsClient.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: rangeToClear });
        console.log(`[GSHEETS_CLEAR] Cleared sheet '${SHEET_NAME}' at ${new Date().toUTCString()}`);
        return true;
    } catch (error) {
        console.error(`[GSHEETS_CLEAR_ERROR] Failed to clear sheet '${SHEET_NAME}':`, error.message); return false;
    }
}

async function autoResizeSheetColumns() {
    // ... (same as before)
    if (!sheetsClient || !SPREADSHEET_ID || typeof numericSheetId === 'undefined') {
        console.log('[GSHEETS_RESIZE] Sheets client/config missing. Skipping resize.'); return;
    }
    try {
        await sheetsClient.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            resource: { requests: [{ autoResizeDimensions: { dimensions: { sheetId: numericSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: EXPECTED_HEADERS.length } } }] }
        });
        console.log(`[GSHEETS_RESIZE] Requested auto-resize for sheetId ${numericSheetId}.`);
    } catch (error) {
        console.error(`[GSHEETS_RESIZE_ERROR] Failed for sheetId ${numericSheetId}:`, error.message);
    }
}

function formatDuration(ms, short = false) {
    // ... (same as before)
    if (ms < 0) ms = 0;
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (short) {
        if (days > 0) return `${days}d ${hours}h`;
        if (hours > 0) return `${hours}h ${minutes}m`;
        if (minutes > 0) return `${minutes}m ${seconds}s`;
        return `${seconds}s`;
    }
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

async function updatePromptMessage(guildId, messageId, channelId, clientInstance) {
    // ... (same as before)
    if (!clientInstance) { console.error(`[PROMPT_UPDATE_ERROR] clientInstance undefined for G:${guildId}`); return; }
    const guildConfig = guildConfigs[guildId];
    if (!guildConfig || guildConfig.promptMessageId !== messageId || guildConfig.promptChannelId !== channelId) return;
    try {
        const channel = await clientInstance.channels.fetch(channelId).catch(() => null);
        if (!channel || channel.type !== ChannelType.GuildText) return;
        const message = await channel.messages.fetch(messageId).catch(() => null);
        if (!message) return;
        const now = new Date();
        const nextSundayUTC = new Date(now);
        nextSundayUTC.setUTCHours(0, 0, 0, 0);
        const dayOfWeek = now.getUTCDay();
        let daysUntilSunday = (7 - dayOfWeek) % 7;
        if (daysUntilSunday === 0 && now.getTime() >= nextSundayUTC.getTime()) daysUntilSunday = 7;
        nextSundayUTC.setUTCDate(now.getUTCDate() + daysUntilSunday);
        const timeToWeeklyReset = nextSundayUTC.getTime() - now.getTime();
        const countdownFormatted = formatDuration(timeToWeeklyReset);
        const baseContent = `**Welcome to the Screenshot Submission System!** 🗓️\n\nClick the "🎟️ Open Ticket" button below to create a private channel where you can submit your **daily activity screenshot**.\n\n**Submission Guidelines:**\n- You are expected to submit one (1) screenshot per day for 7 consecutive days.\n- Submissions are logged, and admins will verify them.\n- This system is used to track activity—each day you fail to submit (without informing an admin) may count as a strike.\n- Three (3) strikes and you're out of the guild.\n- The strike log resets weekly on Sunday at 00:00 UTC.`;
        const newContent = `${baseContent}\n\n**Time until weekly reset:** ${countdownFormatted}`;
        if (message.content !== newContent) await message.edit({ content: newContent });
    } catch (error) {
        console.error(`[PROMPT_UPDATE_ERROR] G:${guildId} C:${channelId} M:${messageId}:`, error.message);
        if (error.code === 10008) console.log(`[PROMPT_UPDATE_ERROR] Prompt message ${messageId} likely deleted.`);
    }
}

async function updateAllPromptMessages(clientInstance) {
    // ... (same as before)
    for (const guildId in guildConfigs) {
        const config = guildConfigs[guildId];
        if (config.promptMessageId && config.promptChannelId) {
            await updatePromptMessage(guildId, config.promptMessageId, config.promptChannelId, clientInstance);
        }
    }
}

(async () => {
    console.log("--- Initializing Bot ---");
    // Moved the critical check here, after defining the constants from process.env
    if (!TOKEN || !SPREADSHEET_ID || !DRIVE_FOLDER_ID || !GOOGLE_CREDENTIALS_JSON_CONTENT) {
        console.error("[FATAL_CONFIG_ERROR] Critical environment variables (BOT_TOKEN, SPREADSHEET_ID, GOOGLE_DRIVE_FOLDER_ID, GOOGLE_CREDENTIALS_JSON) are not set. Exiting.");
        console.log(`[ENV_DEBUG_FATAL] BOT_TOKEN exists: ${!!TOKEN}`);
        console.log(`[ENV_DEBUG_FATAL] SPREADSHEET_ID exists: ${!!SPREADSHEET_ID}`);
        console.log(`[ENV_DEBUG_FATAL] SHEET_NAME exists: ${!!SHEET_NAME}`); // SHEET_NAME has a default, so it might appear true
        console.log(`[ENV_DEBUG_FATAL] GOOGLE_DRIVE_FOLDER_ID exists: ${!!DRIVE_FOLDER_ID}`);
        console.log(`[ENV_DEBUG_FATAL] GOOGLE_CREDENTIALS_JSON_CONTENT exists: ${!!GOOGLE_CREDENTIALS_JSON_CONTENT}`);
        process.exit(1);
    }

    if (!await authorizeGoogleAPIs()) {
        console.error("[FATAL] Failed to authorize Google APIs. Bot may have limited functionality or exit.");
        // process.exit(1); // Optional: exit if Google APIs are absolutely critical for startup
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
        cron.schedule('0 0 * * 0', () => { console.log('[CRON] Running weekly sheet clear job...'); clearSheet(); }, { scheduled: true, timezone: "UTC" });
        console.log('[CRON] Weekly sheet clear scheduled for Sunday 00:00 UTC.');
        setInterval(() => updateAllPromptMessages(client), 60000);
        updateAllPromptMessages(client);
        console.log('[PROMPT_UPDATE] Periodic prompt message updates scheduled (every 1 min).');
    });

    client.on(Events.InteractionCreate, async interaction => {
        // ... (Interaction logic from v17 - unchanged)
        if (!interaction.inGuild()) return;
        const guildConfig = guildConfigs[interaction.guildId];

        if (interaction.isChatInputCommand()) {
            const command = interaction.client.commands.get(interaction.commandName);
            if (!command) {
                replyEphemeralAutoDelete(interaction, { content: `Error: Command /${interaction.commandName} not found.` });
                return;
            }
            try {
                await command.execute(interaction, client, guildConfigs, saveGuildConfigs, clearSheet, replyEphemeralAutoDelete);
            } catch (error) {
                console.error(`Error executing /${interaction.commandName}:`, error);
                const errorReplyOptions = { content: 'Error executing command!' };
                if (interaction.replied || interaction.deferred) {
                    replyEphemeralAutoDelete(interaction, errorReplyOptions, true);
                } else {
                    replyEphemeralAutoDelete(interaction, errorReplyOptions);
                }
            }
        } else if (interaction.isButton()) {
            if (interaction.customId === 'create_ticket_button') {
                if (!guildConfig) { replyEphemeralAutoDelete(interaction, { content: 'Ticket system not configured.' }); return; }
                const member = interaction.member;
                if (guildConfig.shutdownRoleId && member.roles.cache.has(guildConfig.shutdownRoleId)) { replyEphemeralAutoDelete(interaction, { content: `You have the "${guildConfig.shutdownRoleName || 'shutdown'}" role and cannot create tickets.` }); return; }
                if (openTickets[interaction.guildId]?.[member.id]) {
                    const existingTicketChannel = interaction.guild.channels.cache.get(openTickets[interaction.guildId][member.id]);
                    if (existingTicketChannel) { replyEphemeralAutoDelete(interaction, { content: `You already have an open ticket: ${existingTicketChannel}.` }); return; }
                    delete openTickets[interaction.guildId][member.id];
                }
                const ticketCategory = interaction.guild.channels.cache.get(guildConfig.ticketCategoryId);
                if (!ticketCategory || ticketCategory.type !== ChannelType.GuildCategory) { replyEphemeralAutoDelete(interaction, { content: 'Error: Ticket category not found.' }); return; }
                const userNameForChannel = member.user.username.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() || 'user';
                const ticketChannelName = `ticket-${userNameForChannel}-${member.user.discriminator === '0' ? member.user.id.slice(-4) : member.user.discriminator}`;
                try {
                    await interaction.deferReply({ ephemeral: true });
                    const permissionOverwrites = [
                        { id: interaction.guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
                        { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
                        { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageChannels] },
                    ];
                    if (guildConfig.adminRoleIds?.length > 0) {
                        guildConfig.adminRoleIds.forEach(roleId => {
                            if (interaction.guild.roles.cache.has(roleId)) permissionOverwrites.push({ id: roleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles, PermissionsBitField.Flags.ManageMessages] });
                        });
                    }
                    const ticketChannel = await ticketCategory.children.create({ name: ticketChannelName, type: ChannelType.GuildText, topic: `Ticket for ${member.user.tag} (ID: ${member.user.id}). Created: ${new Date().toUTCString()}`, permissionOverwrites });
                    const adminMentions = guildConfig.adminRoleIds?.map(id => `<@&${id}>`).join(' ') || 'Administrators';
                    await ticketChannel.send({ content: `👋 Hello ${member.toString()}, welcome to your ticket!\n\n🛡️ ${adminMentions} have access to this channel.\n\n🖼️ Please send in your **daily activity screenshot** here or describe any issues you have.` });
                    if (!openTickets[interaction.guildId]) openTickets[interaction.guildId] = {};
                    openTickets[interaction.guildId][member.id] = ticketChannel.id;
                    replyEphemeralAutoDelete(interaction, { content: `Your ticket has been created: ${ticketChannel}` }, false, true);
                    console.log(`Ticket ${ticketChannel.name} created for ${member.user.tag}.`);
                    const timeoutId = setTimeout(async () => {
                        try {
                            const fetchedChannel = await client.channels.fetch(ticketChannel.id).catch(() => null);
                            if (fetchedChannel && fetchedChannel.lastMessageId === null) {
                                console.log(`[TICKET_CLEANUP] Ticket ${fetchedChannel.name} is blank after timeout, deleting.`);
                                await fetchedChannel.delete('Blank ticket auto-deleted');
                                blankTicketTimeouts.delete(ticketChannel.id);
                            }
                        } catch (err) {
                            console.error(`[TICKET_CLEANUP_ERROR] Could not delete blank ticket ${ticketChannel.name}:`, err.message);
                        }
                    }, 60000);
                    blankTicketTimeouts.set(ticketChannel.id, timeoutId);
                } catch (error) {
                    console.error(`[ERROR] Failed to create ticket for ${member.user.tag}:`, error);
                    replyEphemeralAutoDelete(interaction, { content: 'Error creating ticket. Ensure bot has permissions.'}, false, true);
                }
            } else if (interaction.customId === 'admin_view_sheet_button') {
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                    replyEphemeralAutoDelete(interaction, { content: 'You do not have permission to use this button.' }); return;
                }
                const currentGuildConfig = guildConfigs[interaction.guildId];
                let replyOptions;
                if (currentGuildConfig && currentGuildConfig.spreadsheetId) {
                    const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${currentGuildConfig.spreadsheetId}/edit`;
                    replyOptions = { content: `📊 **Activity Log Sheet:** <${spreadsheetUrl}>` };
                } else if (SPREADSHEET_ID) {
                     const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`;
                    replyOptions = { content: `📊 **Activity Log Sheet (Global Fallback):** <${spreadsheetUrl}>` };
                } else {
                    replyOptions = { content: 'Spreadsheet ID not configured.' };
                }
                replyEphemeralAutoDelete(interaction, replyOptions);
            }
        }
    });

    client.on(Events.MessageCreate, async message => {
        // ... (MessageCreate logic from v17 - unchanged)
        if (message.author.bot || !message.guild) return;
        if (blankTicketTimeouts.has(message.channel.id)) {
            clearTimeout(blankTicketTimeouts.get(message.channel.id));
            blankTicketTimeouts.delete(message.channel.id);
            console.log(`[TICKET_ACTIVITY] User messaged in ${message.channel.name}, blank ticket deletion cancelled.`);
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
                let oldDriveFileIdToReplace = null;

                try {
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
                    const dateOnlyString = formatTimestamp(currentDate, false, true);

                    const sheetDataRange = `'${SHEET_NAME}'!${COLUMN_DISCORD_TAG}2:${String.fromCharCode(64 + EXPECTED_HEADERS.length)}`;
                    const sheetDataResponse = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: sheetDataRange });
                    const rows = sheetDataResponse.data.values;
                    let existingRowNumber = -1;

                    if (rows && rows.length > 0) {
                        for (let i = 0; i < rows.length; i++) {
                            const row = rows[i];
                            if (row && row[0] === discordTag && typeof row[TIMESTAMP_COLUMN_INDEX] === 'string' && row[TIMESTAMP_COLUMN_INDEX].startsWith(dateOnlyString)) {
                                existingRowNumber = i + 2;
                                if (row[DRIVE_FILE_ID_COLUMN_INDEX]) oldDriveFileIdToReplace = row[DRIVE_FILE_ID_COLUMN_INDEX];
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
                    const fullTimestamp = formatTimestamp(currentDate, false);
                    const verified = ""; const flags = "";
                    const timeInServerFormatted = formatDuration(Date.now() - message.member.joinedTimestamp, true);
                    const ticketChannelName = message.channel.name;
                    const newRowData = [ discordTag, playerDisplayName, screenshotUrlFormula, fullTimestamp, verified, flags, timeInServerFormatted, ticketChannelName, uploadedFileId ];

                    if (existingRowNumber !== -1) {
                        const updateRange = `'${SHEET_NAME}'!A${existingRowNumber}:${String.fromCharCode(64 + EXPECTED_HEADERS.length)}${existingRowNumber}`;
                        console.log(`[GSHEETS_DEBUG] Updating row for ${discordTag} on ${dateOnlyString}. Range: ${updateRange}`);
                        await sheetsClient.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: updateRange, valueInputOption: 'USER_ENTERED', resource: { values: [newRowData] } });
                        console.log(`[GSHEETS] Updated screenshot for ${discordTag} on ${dateOnlyString}.`);
                    } else {
                        const rangeToAppend = SHEET_NAME;
                        console.log(`[GSHEETS_DEBUG] Appending new row for ${discordTag}. Range: ${rangeToAppend}`);
                        await sheetsClient.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: rangeToAppend, valueInputOption: 'USER_ENTERED', resource: { values: [newRowData] } });
                        console.log(`[GSHEETS] Logged new screenshot for ${discordTag}.`);
                    }

                    await message.react('✅');
                    const thankYouMsg = await message.channel.send(`🎉 Thank you, ${message.author.toString()}! Your screenshot has been logged. This message, your original image, and this ticket channel will be removed shortly.`);
                    await autoResizeSheetColumns();

                    setTimeout(() => {
                        message.delete().catch(err => console.error(`[MESSAGE_DELETE_ERROR] User message ${message.id}:`, err.message));
                        thankYouMsg.delete().catch(err => console.error(`[MESSAGE_DELETE_ERROR] Thank you message ${thankYouMsg.id}:`, err.message));
                        setTimeout(() => {
                            console.log(`[TICKET_CLOSE] Deleting ticket channel ${message.channel.name} (${message.channel.id})`);
                            message.channel.delete('Ticket closed after successful screenshot submission.')
                                .then(deletedChannel => console.log(`[TICKET_CLOSE] Deleted channel ${deletedChannel.name}`))
                                .catch(err => console.error(`[TICKET_CLOSE_ERROR] Ticket channel ${message.channel.name}:`, err.message));
                        }, 5000);
                    }, 7000);

                } catch (error) {
                    console.error('[GAPI_ERROR] Failed during Discord download, Drive upload, or Sheets operation:', error.message);
                    if (error.response?.data?.error) console.error('[GAPI_ERROR_DETAILS]:', JSON.stringify(error.response.data.error, null, 2));
                    if (uploadedFileId && !(error.message.includes("append") || error.message.includes("update"))) {
                        console.warn(`[GDRIVE_CLEANUP] Error after Drive upload (File ID: ${uploadedFileId}). Attempting to delete.`);
                        try {
                            await driveClient.files.delete({ fileId: uploadedFileId });
                            console.log(`[GDRIVE_CLEANUP] Successfully deleted orphaned Drive file ${uploadedFileId}.`);
                        } catch (deleteError) {
                            console.error(`[GDRIVE_CLEANUP_ERROR] Failed to delete orphaned Drive file ${uploadedFileId}:`, deleteError.message);
                        }
                    }
                    message.channel.send('⚠️ Error processing your screenshot (Drive/Sheets). Check console.').catch(console.error);
                    message.react('❌').catch(console.error);
                }
            } else {
                message.reply({ content: "It looks like that wasn't a recognized image file. Please upload a screenshot in a common format (PNG, JPG, WEBP, GIF).\nIf you need other assistance, an admin will be with you shortly."}).catch(console.error);
            }
        } else {
            message.reply({ content: "Thanks for your message! An admin will be with you shortly to assist. If you meant to submit a screenshot, please send it as an image attachment." }).catch(console.error);
        }
    });

    client.on(Events.ChannelDelete, channel => {
        // ... (ChannelDelete logic from v17 - unchanged)
        if (!channel.guild) return;
        const guildId = channel.guild.id;
        if (blankTicketTimeouts.has(channel.id)) {
            clearTimeout(blankTicketTimeouts.get(channel.id));
            blankTicketTimeouts.delete(channel.id);
        }
        if (openTickets[guildId]) {
            for (const userId in openTickets[guildId]) {
                if (openTickets[guildId][userId] === channel.id) {
                    delete openTickets[guildId][userId];
                    console.log(`[TICKETS] Removed ticket ref for user ${userId} (Channel ${channel.name} (${channel.id}) deleted).`);
                    break;
                }
            }
        }
    });

    client.login(TOKEN).then(() => console.log("Login to Discord successful!")).catch(error => {
        console.error("\n[FATAL ERROR] Failed to log in:", error.message);
        if (error.code === 'DisallowedIntents') console.error("[FATAL ERROR] Privileged Intents likely missing.");
        else if (error.message.includes("TOKEN_INVALID")) console.error("[FATAL ERROR] BOT TOKEN invalid/missing.");
        process.exit(1);
    });
})();

