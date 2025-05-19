// index.js

console.log("--- index.js script started ---");

// Discord.js and other core Node.js modules
const { Client, GatewayIntentBits, Events, Partials, Collection, PermissionsBitField, ChannelType, MessageFlags } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

// Google APIs, cron, and HTTP client
const { google } = require('googleapis');
const cron = require('node-cron');
const axios = require('axios'); // For downloading images from Discord
const stream = require('stream'); // For streaming image data to Google Drive

// --- Configuration from Environment Variables ---
const TOKEN = process.env.BOT_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Sheet1'; // Default if not set
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const GOOGLE_CREDENTIALS_JSON_CONTENT = process.env.GOOGLE_CREDENTIALS_JSON;

// --- Google API Configuration ---
const API_SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file'
];

// --- Sheet Structure Configuration (for Daily Slot Format) ---
const DAYS_OF_WEEK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]; // Sunday is 0 in getUTCDay()
const DAY_SUB_HEADERS = [
    'Player Display Name', 'Screenshot', 'Timestamp (UTC)',
    'Verified', 'Strikes', 'Time in Server', 'Drive File ID'
];
const ROWS_PER_DAY_BLOCK = 1 + DAY_SUB_HEADERS.length; // 1 for Day Header + sub-headers
const DRIVE_FILE_ID_SUB_HEADER_INDEX = DAY_SUB_HEADERS.indexOf('Drive File ID'); // For direct access

// --- Global Variables (initialized in authorizeGoogleAPIs or main IIFE) ---
let sheetsClient;
let driveClient;
let googleAuthClient;
let numericSheetId; // Numerical ID of the sheet tab

const blankTicketTimeouts = new Map(); // For auto-deleting blank tickets
const openTickets = {}; // Tracks open tickets per guild/user: { guildId: { userId: channelId } }
const GUILD_CONFIGS_PATH = path.join(__dirname, 'guild-configs.json'); // Path for guild-specific settings
let guildConfigs = {}; // Loaded from GUILD_CONFIGS_PATH

const EPHEMERAL_DELETE_DELAY = 10000; // 10 seconds

// --- Helper Function: Ephemeral Replies with Auto-Delete ---
async function replyEphemeralAutoDelete(interaction, options, isFollowUp = false, isEdit = false) {
    try {
        let sentMessage;
        const currentOptions = { ...options, flags: [MessageFlags.Ephemeral] };
        const interactionType = interaction.isButton() ? "Button" : interaction.isChatInputCommand() ? "SlashCommand" : "UnknownInteraction";
        
        if (isEdit) {
            console.log(`[REPLY_HELPER] Attempting to editReply for ${interactionType} ${interaction.id}`);
            sentMessage = await interaction.editReply(currentOptions);
        } else if (isFollowUp) {
            console.log(`[REPLY_HELPER] Attempting to followUp for ${interactionType} ${interaction.id}`);
            sentMessage = await interaction.followUp(currentOptions);
        } else {
            console.log(`[REPLY_HELPER] Attempting to reply for ${interactionType} ${interaction.id}`);
            sentMessage = await interaction.reply(currentOptions);
        }
        console.log(`[REPLY_HELPER] Reply/Edit/FollowUp sent for ${interactionType} ${interaction.id}`);

        if (sentMessage && typeof sentMessage.delete === 'function') {
            setTimeout(() => {
                sentMessage.delete().catch(err => {
                    if (err.code !== 10008) console.error(`[AUTO_DELETE_ERROR] Ephemeral reply ${sentMessage.id || 'unknown'} for ${interactionType} ${interaction.id}:`, err.message);
                });
            }, EPHEMERAL_DELETE_DELAY);
        }
    } catch (error) {
        console.error(`[REPLY_ERROR] Failed to send/edit/followUp for interaction ${interaction.id}:`, error.message);
        // Avoid re-throwing or trying to reply again if the reply helper itself fails
    }
}

// --- Helper Function: Ensure Sheet Structure (Daily Slot Format) ---
async function ensureSheetHeadersAndStructure() {
    if (!sheetsClient || !SPREADSHEET_ID || !SHEET_NAME) {
        console.log('[GSHEETS_SETUP] Sheets client/config missing for header/structure setup.');
        return;
    }
    try {
        const expectedColumnAValues = [];
        DAYS_OF_WEEK.forEach(day => {
            expectedColumnAValues.push(day);
            DAY_SUB_HEADERS.forEach(subHeader => {
                expectedColumnAValues.push(`  ${subHeader}`);
            });
        });
        const rangeForColumnA = `'${SHEET_NAME}'!A1:A${expectedColumnAValues.length}`;
        const getResponse = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: rangeForColumnA,
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
            console.log(`[GSHEETS_SETUP] Sheet structure in '${SHEET_NAME}' needs update. Writing labels to Column A.`);
            const valuesForColumnA = expectedColumnAValues.map(val => [val]);
            await sheetsClient.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID, range: `'${SHEET_NAME}'!A1`,
                valueInputOption: 'USER_ENTERED', resource: { values: valuesForColumnA },
            });
            console.log(`[GSHEETS_SETUP] Successfully wrote labels to Column A of '${SHEET_NAME}'.`);
        } else {
            console.log(`[GSHEETS_SETUP] Column A labels in sheet '${SHEET_NAME}' are correct.`);
        }
    } catch (error) {
        console.error(`[GSHEETS_SETUP_ERROR] Failed for '${SHEET_NAME}':`, error.message);
        if (error.response?.data?.error?.message.includes("Unable to parse range") || error.message.includes("Requested entity was not found")) {
             console.error(`[GSHEETS_SETUP_ERROR_DETAILS] Sheet named '${SHEET_NAME}' might not exist in spreadsheet '${SPREADSHEET_ID}'. Please create it manually.`);
        }
    }
}

// --- Helper Function: Authorize Google APIs ---
async function authorizeGoogleAPIs() {
    console.log("[GAPI_AUTH_DEBUG] Starting Google API authorization...");
    try {
        if (!GOOGLE_CREDENTIALS_JSON_CONTENT) {
            console.error("[GAPI_ERROR_AUTH] GOOGLE_CREDENTIALS_JSON environment variable is not set or is empty.");
            return false;
        }
        console.log("[GAPI_AUTH_DEBUG] GOOGLE_CREDENTIALS_JSON content length:", GOOGLE_CREDENTIALS_JSON_CONTENT.length);
        let googleCredentials;
        try {
            googleCredentials = JSON.parse(GOOGLE_CREDENTIALS_JSON_CONTENT);
            console.log("[GAPI_AUTH_DEBUG] Successfully parsed GOOGLE_CREDENTIALS_JSON.");
        } catch (parseError) {
            console.error("[GAPI_ERROR_AUTH] Failed to parse GOOGLE_CREDENTIALS_JSON. Ensure it's a valid JSON string.", parseError);
            console.error("[GAPI_AUTH_DEBUG] Raw GOOGLE_CREDENTIALS_JSON (first 200 chars):", GOOGLE_CREDENTIALS_JSON_CONTENT.substring(0,200));
            return false;
        }
        if (!SPREADSHEET_ID) { console.error('[GAPI_ERROR_AUTH] SPREADSHEET_ID missing.'); return false; }
        if (!SHEET_NAME) { console.error('[GAPI_ERROR_AUTH] SHEET_NAME missing.'); return false; }
        if (!DRIVE_FOLDER_ID) { console.error('[GAPI_ERROR_AUTH] GOOGLE_DRIVE_FOLDER_ID missing.'); return false; }

        googleAuthClient = new google.auth.GoogleAuth({ credentials: googleCredentials, scopes: API_SCOPES });
        const authClient = await googleAuthClient.getClient();
        console.log("[GAPI_AUTH_DEBUG] GoogleAuth client obtained.");
        sheetsClient = google.sheets({ version: 'v4', auth: authClient });
        console.log(`[GSHEETS] Authorized. Target: ${SPREADSHEET_ID}, Sheet: ${SHEET_NAME}`);
        driveClient = google.drive({ version: 'v3', auth: authClient });
        console.log(`[GDRIVE] Authorized for Google Drive API.`);
        const spreadsheetMeta = await sheetsClient.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: 'sheets(properties(sheetId,title))' });
        const targetSheet = spreadsheetMeta.data.sheets.find(s => s.properties.title === SHEET_NAME);
        if (targetSheet) {
            numericSheetId = targetSheet.properties.sheetId;
            console.log(`[GSHEETS] Numeric sheetId for '${SHEET_NAME}' is: ${numericSheetId}`);
            await ensureSheetHeadersAndStructure(); // Call new structure setup
        } else {
            console.error(`[GSHEETS_ERROR] Could not find sheet named '${SHEET_NAME}'. Ensure it exists.`);
            return false;
        }
        console.log("[GAPI_AUTH_DEBUG] Google API authorization and sheet check successful.");
        return true;
    } catch (error) {
        console.error('[GAPI_ERROR_AUTH] Overall failure in authorizeGoogleAPIs:', error.message);
        console.error('[GAPI_ERROR_AUTH_FULL_STACK]', error);
        return false;
    }
}

// --- Helper Function: Load Guild Configurations ---
function loadGuildConfigs() {
    try {
        if (fs.existsSync(GUILD_CONFIGS_PATH)) {
            guildConfigs = JSON.parse(fs.readFileSync(GUILD_CONFIGS_PATH, 'utf8'));
            console.log('[CONFIG] Loaded guild configurations.');
        } else {
            console.log('[CONFIG] guild-configs.json not found. Starting with empty guild configs.');
            guildConfigs = {};
        }
    } catch (error) {
        console.error('[ERROR] Failed to load guild-configs.json:', error);
        guildConfigs = {};
    }
    for (const guildId in guildConfigs) {
        if (!openTickets[guildId]) openTickets[guildId] = {};
    }
}

// --- Helper Function: Save Guild Configurations ---
function saveGuildConfigs() {
    try {
        fs.writeFileSync(GUILD_CONFIGS_PATH, JSON.stringify(guildConfigs, null, 4));
        console.log('[CONFIG] Saved guild configurations.');
    } catch (error) {
        console.error('[ERROR] Failed to save guild-configs.json:', error);
    }
}

// --- Helper Function: Format Timestamp ---
function formatTimestamp(date, dateOnly = false) {
    const year = String(date.getUTCFullYear()).slice(-2);
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    if (dateOnly) return `${month}-${day}-${year}`;
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    return `${month}-${day}-${year} ${hours}:${minutes} UTC`;
}

// --- Helper Function: Clear Sheet Data Weekly (Column B only) ---
async function clearSheetWeekly() {
    if (!sheetsClient || !SPREADSHEET_ID || !SHEET_NAME || typeof numericSheetId === 'undefined') {
        console.log('[GSHEETS_CLEAR_WEEKLY] Sheets client/config missing. Skipping clear.'); return false;
    }
    try {
        const requests = [];
        for (let i = 0; i < DAYS_OF_WEEK.length; i++) {
            const startDataRowForDay = (i * ROWS_PER_DAY_BLOCK) + 2;
            const endDataRowForDay = startDataRowForDay + DAY_SUB_HEADERS.length - 1;
            requests.push({
                updateCells: {
                    range: { sheetId: numericSheetId, startRowIndex: startDataRowForDay - 1, endRowIndex: endDataRowForDay, startColumnIndex: 1, endColumnIndex: 2 },
                    rows: Array(DAY_SUB_HEADERS.length).fill({ values: [{ userEnteredValue: { stringValue: "" } }] }),
                    fields: "userEnteredValue"
                }
            });
        }
        if (requests.length > 0) {
            await sheetsClient.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests } });
        }
        console.log(`[GSHEETS_CLEAR_WEEKLY] Successfully cleared data in Column B for sheet '${SHEET_NAME}' at ${new Date().toUTCString()}`);
        return true;
    } catch (error) {
        console.error(`[GSHEETS_CLEAR_WEEKLY_ERROR] Failed to clear sheet '${SHEET_NAME}':`, error.message); return false;
    }
}

// --- Helper Function: Auto-Resize Columns A & B ---
async function autoResizeSheetColumns() {
    if (!sheetsClient || !SPREADSHEET_ID || typeof numericSheetId === 'undefined') {
        console.log('[GSHEETS_RESIZE] Sheets client/config missing. Skipping resize.'); return;
    }
    try {
        await sheetsClient.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            resource: { requests: [{ autoResizeDimensions: { dimensions: { sheetId: numericSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 2 } } }] }
        });
        console.log(`[GSHEETS_RESIZE] Requested auto-resize for columns A & B in sheetId ${numericSheetId}.`);
    } catch (error) {
        console.error(`[GSHEETS_RESIZE_ERROR] Failed for sheetId ${numericSheetId}:`, error.message);
    }
}

// --- Helper Function: Format Duration ---
function formatDuration(ms, short = false) {
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

// --- Helper Function: Update Prompt Message ---
async function updatePromptMessage(guildId, messageId, channelId, clientInstance) {
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

// --- Helper Function: Update All Prompt Messages ---
async function updateAllPromptMessages(clientInstance) {
    for (const guildId in guildConfigs) {
        const config = guildConfigs[guildId];
        if (config.promptMessageId && config.promptChannelId) {
            await updatePromptMessage(guildId, config.promptMessageId, config.promptChannelId, clientInstance);
        }
    }
}


// --- Main Bot Logic (IIFE) ---
(async () => {
    console.log("--- Initializing Bot ---");
    // Critical environment variable check
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
        console.error("[FATAL_EXIT] Failed to authorize Google APIs. Bot cannot continue. Exiting.");
        process.exit(1);
    }
    loadGuildConfigs();

    const client = new Client({
        intents: [ // Direct intent definition
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessageReactions,
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
        console.log(`Bot ID: ${readyClient.user.id}`);
        console.log(`Bot is in ${readyClient.guilds.cache.size} guilds.`);
        cron.schedule('0 0 * * 0', () => { console.log('[CRON] Running weekly sheet data clear job...'); clearSheetWeekly(); }, { scheduled: true, timezone: "UTC" });
        console.log('[CRON] Weekly sheet data clear scheduled for Sunday 00:00 UTC.');
        setInterval(() => updateAllPromptMessages(client), 60000);
        updateAllPromptMessages(client);
        console.log('[PROMPT_UPDATE] Periodic prompt message updates scheduled (every 1 min).');
    });

    client.on(Events.InteractionCreate, async interaction => {
        console.log(`[INTERACTION_DEBUG] Received interaction: Type=${interaction.type}, CustomID/CommandName=${interaction.customId || interaction.commandName}, User=${interaction.user.tag}, Guild=${interaction.guildId}`);
        if (!interaction.inGuild()) {
            replyEphemeralAutoDelete(interaction, { content: 'This interaction must be used in a server.' });
            return;
        }
        const guildConfig = guildConfigs[interaction.guildId];

        if (interaction.isChatInputCommand()) {
            console.log(`[INTERACTION_DEBUG] Handling ChatInputCommand: /${interaction.commandName}`);
            const command = interaction.client.commands.get(interaction.commandName);
            if (!command) {
                console.error(`[INTERACTION_ERROR] No command matching /${interaction.commandName} was found.`);
                replyEphemeralAutoDelete(interaction, { content: `Error: Command /${interaction.commandName} not found.` });
                return;
            }
            try {
                console.log(`[INTERACTION_DEBUG] Executing command: /${interaction.commandName}`);
                // Pass arguments based on what each command needs
                if (['setup', 'close'].includes(interaction.commandName)) {
                    await command.execute(interaction, client, guildConfigs, saveGuildConfigs);
                } else if (['tableclear', 'testday', 'testweek'].includes(interaction.commandName)) {
                    await command.execute(interaction, client, guildConfigs, saveGuildConfigs,
                                          clearSheetWeekly, // This is the sheet-only clear for /tableclear
                                          sheetsClient, driveClient, SPREADSHEET_ID, SHEET_NAME, numericSheetId);
                } else {
                    // Default for any other commands, adjust if they have specific needs
                    await command.execute(interaction, client, guildConfigs, saveGuildConfigs);
                }
            } catch (error) {
                console.error(`[INTERACTION_ERROR] Uncaught error executing /${interaction.commandName} in index.js:`, error);
                const errorReplyOptions = { content: 'Oops! Something went very wrong while running that command.' };
                if (interaction.deferred) {
                    console.log(`[INTERACTION_ERROR_HANDLER] Interaction was deferred, attempting editReply for general error.`);
                    replyEphemeralAutoDelete(interaction, errorReplyOptions, false, true);
                } else if (!interaction.replied) {
                    console.log(`[INTERACTION_ERROR_HANDLER] Interaction not replied/deferred, attempting initial reply for general error.`);
                    replyEphemeralAutoDelete(interaction, errorReplyOptions);
                } else {
                    console.log(`[INTERACTION_ERROR_HANDLER] Interaction already replied. No further error reply sent from global handler.`);
                }
            }
        } else if (interaction.isButton()) {
            console.log(`[INTERACTION_DEBUG] Handling ButtonInteraction: CustomID=${interaction.customId}`);
            if (interaction.customId === 'create_ticket_button') {
                console.log(`[TICKET_BUTTON_DEBUG] 'create_ticket_button' pressed by ${interaction.user.tag}.`);
                if (!guildConfig) {
                    replyEphemeralAutoDelete(interaction, { content: 'Ticket system not configured for this server yet. Please ask an administrator to run /setup.' });
                    return;
                }
                console.log(`[TICKET_BUTTON_DEBUG] GuildConfig found.`);
                const member = interaction.member;
                if (guildConfig.shutdownRoleId && member.roles.cache.has(guildConfig.shutdownRoleId)) {
                    replyEphemeralAutoDelete(interaction, { content: `You currently have the "${guildConfig.shutdownRoleName || 'shutdown'}" role and cannot create new tickets.` });
                    return;
                }
                if (openTickets[interaction.guildId]?.[member.id]) {
                    const existingTicketChannel = interaction.guild.channels.cache.get(openTickets[interaction.guildId][member.id]);
                    if (existingTicketChannel) {
                        replyEphemeralAutoDelete(interaction, { content: `You already have an open ticket: ${existingTicketChannel}. Please use your existing ticket or ask for it to be closed.` });
                        return;
                    }
                    delete openTickets[interaction.guildId][member.id];
                }
                const ticketCategory = interaction.guild.channels.cache.get(guildConfig.ticketCategoryId);
                if (!ticketCategory || ticketCategory.type !== ChannelType.GuildCategory) {
                    replyEphemeralAutoDelete(interaction, { content: 'Error: The configured ticket category could not be found. Please ask an admin to re-run /setup.' });
                    return;
                }
                try {
                    console.log(`[TICKET_BUTTON_DEBUG] Attempting to deferReply for create_ticket_button.`);
                    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                    console.log(`[TICKET_BUTTON_DEBUG] Reply deferred successfully for create_ticket_button.`);
                    const userNameForChannel = member.user.username.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() || 'user';
                    const ticketChannelName = `ticket-${userNameForChannel}-${member.user.discriminator === '0' ? member.user.id.slice(-4) : member.user.discriminator}`;
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
                    const timeoutId = setTimeout(async () => { /* ... blank ticket cleanup ... */ }, 60000);
                    blankTicketTimeouts.set(ticketChannel.id, timeoutId);
                } catch (error) {
                    console.error(`[TICKET_BUTTON_ERROR] Failed to create ticket for ${member.user.tag}:`, error);
                    replyEphemeralAutoDelete(interaction, { content: 'Error creating ticket. Ensure bot has permissions and setup is correct.'}, false, true);
                }
            } else if (interaction.customId === 'admin_view_sheet_button') {
                console.log(`[INTERACTION_DEBUG] 'admin_view_sheet_button' pressed.`);
                if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                    replyEphemeralAutoDelete(interaction, { content: 'You do not have permission to use this button.' }); return;
                }
                const currentGuildConfig = guildConfigs[interaction.guildId];
                let replyOptions;
                if (currentGuildConfig?.spreadsheetId) {
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
                    const currentDayIndex = currentDate.getUTCDay();
                    const dayName = DAYS_OF_WEEK[currentDayIndex];
                    const startDataRowForDay = (currentDayIndex * ROWS_PER_DAY_BLOCK) + 2;
                    const driveFileIdCellRowInSheet = startDataRowForDay + DAY_SUB_HEADERS.indexOf('Drive File ID');
                    
                    try {
                        const getResponse = await sheetsClient.spreadsheets.values.get({
                            spreadsheetId: SPREADSHEET_ID,
                            range: `'${SHEET_NAME}'!B${driveFileIdCellRowInSheet}`,
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
                    const timestamp = formatTimestamp(currentDate);
                    const verified = "";
                    const flags = "";
                    const timeInServerFormatted = formatDuration(Date.now() - message.member.joinedTimestamp, true);

                    const dayDataForSheet = [
                        playerDisplayName, screenshotUrlFormula, timestamp,
                        verified, flags, timeInServerFormatted, uploadedFileId
                    ];
                    const valuesToUpdate = dayDataForSheet.map(val => [val]);
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

    client.on(Events.ChannelDelete, channel => { /* ... same ... */ });

    try {
        await client.login(TOKEN);
        console.log("Login to Discord successful!");
    } catch (error) {
        console.error("\n[FATAL ERROR] Failed to log in to Discord:", error.message);
        if (error.code === 'ClientMissingIntents') {
            console.error("[FATAL_LOGIN_ERROR] ClientMissingIntents error during login. Check intentsArray and GatewayIntentBits values logged above.");
        } else if (error.code === 'DisallowedIntents') {
            console.error("[FATAL_LOGIN_ERROR] Privileged Gateway Intents likely missing or disabled for your bot in the Discord Developer Portal.");
        } else if (error.message.includes("TOKEN_INVALID") || (error.rawError && error.rawError.message === 'Unauthorized')) {
            console.error("[FATAL_LOGIN_ERROR] The BOT TOKEN is invalid or missing. Check your environment variable.");
        } else {
            console.error("[FATAL_LOGIN_ERROR] An unexpected error occurred during login:", error);
        }
        process.exit(1);
    }

    console.log("[INFO] Bot is running and listening for events. Process will be kept alive.");
    await new Promise(() => {});

})();

