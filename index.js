// index.js

console.log("--- index.js script started ---"); // For basic startup confirmation

// Node.js built-in modules for file and path operations
const fs = require('node:fs');
const path = require('node:path');

// Discord.js and other libraries
const { Client, GatewayIntentBits, Events, Partials, Collection, PermissionsBitField, ChannelType, MessageFlags } = require('discord.js');
const { google } = require('googleapis'); // Google APIs Client Library
const cron = require('node-cron'); // Cron job scheduler
const axios = require('axios'); // For downloading images
const stream = require('stream'); // For converting buffer to stream for Drive upload

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

// Using the 9-column setup including Drive File ID
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
        if (!GOOGLE_CREDENTIALS_JSON_CONTENT) {
            console.error('[GAPI_ERROR_AUTH_PRECHECK] GOOGLE_CREDENTIALS_JSON environment variable not set or empty.');
            return false;
        }
        let googleCredentials;
        try {
            googleCredentials = JSON.parse(GOOGLE_CREDENTIALS_JSON_CONTENT);
        } catch (parseError) {
            console.error('[GAPI_ERROR_AUTH] Failed to parse GOOGLE_CREDENTIALS_JSON. Ensure it is a valid JSON string.', parseError);
            return false;
        }
        googleAuthClient = new google.auth.GoogleAuth({ credentials: googleCredentials, scopes: API_SCOPES });
        const authClient = await googleAuthClient.getClient();
        sheetsClient = google.sheets({ version: 'v4', auth: authClient });
        console.log(`[GSHEETS] Authorized. Target: ${SPREADSHEET_ID}, Sheet: ${SHEET_NAME}`);
        driveClient = google.drive({ version: 'v3', auth: authClient });
        console.log(`[GDRIVE] Authorized for Google Drive API.`);
        if (!SPREADSHEET_ID || !SHEET_NAME) {
            console.error("[GSHEETS_ERROR] SPREADSHEET_ID or SHEET_NAME is missing after authorization.");
            return true;
        }
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

function loadGuildConfigs() { /* ... same ... */ }
function saveGuildConfigs() { /* ... same ... */ }
function formatTimestamp(date, includeSeconds = false, dateOnly = false) { /* ... same (MM-DD-YY format) ... */ }
async function clearSheet() { /* ... same ... */ }
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
        console.error("[FATAL] Failed to authorize Google APIs.");
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
    client.on(Events.InteractionCreate, async interaction => { /* ... same, ensure replyEphemeralAutoDelete is used ... */ });
    client.on(Events.MessageCreate, async message => { /* ... same (Google Drive version) ... */ });
    client.on(Events.ChannelDelete, channel => { /* ... same ... */ });

    client.login(TOKEN).then(() => console.log("Login to Discord successful!")).catch(error => {
        console.error("\n[FATAL ERROR] Failed to log in:", error.message);
        if (error.code === 'DisallowedIntents') console.error("[FATAL ERROR] Privileged Intents likely missing.");
        else if (error.message.includes("TOKEN_INVALID")) console.error("[FATAL ERROR] BOT TOKEN invalid/missing.");
        process.exit(1);
    });
})();

