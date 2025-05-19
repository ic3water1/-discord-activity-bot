// index.js

console.log("--- index.js script started ---");

// Node.js built-in modules for file and path operations
const fs = require('node:fs');
const path = require('node:path');

// Discord.js and other libraries
const { Client, GatewayIntentBits, Events, Partials, Collection, PermissionsBitField, ChannelType, MessageFlags } = require('discord.js');
const { google } = require('googleapis');
const cron = require('node-cron');
const axios = require('axios');
const stream = require('stream');

// --- Configuration from Environment Variables ---
const TOKEN = process.env.BOT_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Sheet1';
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
        const interactionType = interaction.isButton() ? "Button" : interaction.isChatInputCommand() ? "SlashCommand" : "UnknownInteraction";
        
        if (isEdit) {
            console.log(`[REPLY_HELPER_DEBUG] Attempting to editReply for ${interactionType} ${interaction.id}`);
            sentMessage = await interaction.editReply(currentOptions);
        } else if (isFollowUp) {
            console.log(`[REPLY_HELPER_DEBUG] Attempting to followUp for ${interactionType} ${interaction.id}`);
            sentMessage = await interaction.followUp(currentOptions);
        } else {
            console.log(`[REPLY_HELPER_DEBUG] Attempting to reply for ${interactionType} ${interaction.id}`);
            sentMessage = await interaction.reply(currentOptions);
        }
        console.log(`[REPLY_HELPER_DEBUG] Reply/Edit/FollowUp sent for ${interactionType} ${interaction.id}`);

        if (sentMessage && typeof sentMessage.delete === 'function') {
            setTimeout(() => {
                sentMessage.delete().catch(err => {
                    if (err.code !== 10008) console.error(`[AUTO_DELETE_ERROR] Ephemeral reply ${sentMessage.id || 'unknown'} for ${interactionType} ${interaction.id}:`, err.message);
                });
            }, EPHEMERAL_DELETE_DELAY);
        }
    } catch (error) {
        console.error(`[REPLY_ERROR] Failed to send/edit/followUp for interaction ${interaction.id}:`, error.message);
    }
}

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
            await ensureSheetHeadersAndStructure();
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

const GUILD_CONFIGS_PATH = path.join(__dirname, 'guild-configs.json');
let guildConfigs = {};
let openTickets = {};

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

function saveGuildConfigs() {
    try {
        fs.writeFileSync(GUILD_CONFIGS_PATH, JSON.stringify(guildConfigs, null, 4));
        console.log('[CONFIG] Saved guild configurations.');
    } catch (error) {
        console.error('[ERROR] Failed to save guild-configs.json:', error);
    }
}

function formatTimestamp(date, dateOnly = false) {
    const year = String(date.getUTCFullYear()).slice(-2);
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    if (dateOnly) return `${month}-${day}-${year}`;
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    return `${month}-${day}-${year} ${hours}:${minutes} UTC`;
}

async function clearSheetWeekly() {
    if (!sheetsClient || !SPREADSHEET_ID || !SHEET_NAME || typeof numericSheetId === 'undefined') {
        console.log('[GSHEETS_CLEAR_WEEKLY] Sheets client/config missing. Skipping clear.'); return false;
    }
    try {
        const rangesToClearInColumnB = [];
        for (let i = 0; i < DAYS_OF_WEEK.length; i++) {
            const startDataRowForDay = (i * ROWS_PER_DAY_BLOCK) + 2;
            const endDataRowForDay = startDataRowForDay + DAY_SUB_HEADERS.length - 1;
            rangesToClearInColumnB.push(`'${SHEET_NAME}'!B${startDataRowForDay}:B${endDataRowForDay}`);
        }
        if (rangesToClearInColumnB.length > 0) {
            await sheetsClient.spreadsheets.values.batchClear({
                spreadsheetId: SPREADSHEET_ID,
                resource: { ranges: rangesToClearInColumnB }
            });
        }
        console.log(`[GSHEETS_CLEAR_WEEKLY] Successfully cleared data in Column B for sheet '${SHEET_NAME}' at ${new Date().toUTCString()}`);
        return true;
    } catch (error) {
        console.error(`[GSHEETS_CLEAR_WEEKLY_ERROR] Failed to clear sheet '${SHEET_NAME}':`, error.message); return false;
    }
}

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

function formatDuration(ms, short = false) { /* ... same ... */ }
async function updatePromptMessage(guildId, messageId, channelId, clientInstance) { /* ... same ... */ }
async function updateAllPromptMessages(clientInstance) { /* ... same ... */ }

// --- Main Bot Logic (IIFE) ---
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
        console.error("[FATAL_EXIT] Failed to authorize Google APIs. Bot cannot continue with full functionality. Exiting.");
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
                if (['setup', 'close'].includes(interaction.commandName)) {
                    await command.execute(interaction, client, guildConfigs, saveGuildConfigs);
                } else if (['tableclear', 'testday', 'testweek'].includes(interaction.commandName)) {
                    await command.execute(interaction, client, guildConfigs, saveGuildConfigs,
                                          clearSheetWeekly,
                                          replyEphemeralAutoDelete, // This helper is defined in index.js
                                          sheetsClient, driveClient, SPREADSHEET_ID, SHEET_NAME, numericSheetId);
                } else {
                    await command.execute(interaction, client, guildConfigs, saveGuildConfigs, clearSheetWeekly, replyEphemeralAutoDelete);
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
            // ... (Button logic from discord_js_index_button_debug - ensure it uses the global replyEphemeralAutoDelete)
        }
    });

    client.on(Events.MessageCreate, async message => { /* ... same message creation logic for daily slot format from v19 ... */ });
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

