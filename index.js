// index.js

console.log("--- index.js script started ---");

const { Client, GatewayIntentBits, Events, Partials, Collection, PermissionsBitField, ChannelType, MessageFlags } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const { google } = require('googleapis');
const cron = require('node-cron');
const axios = require('axios');
const stream =require('stream');

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
// Column indices (0-based)
const TIMESTAMP_COLUMN_INDEX = EXPECTED_HEADERS.indexOf('Timestamp (UTC)');
const DRIVE_FILE_ID_COLUMN_INDEX = EXPECTED_HEADERS.indexOf('Drive File ID');

let sheetsClient;
let driveClient;
let googleAuthClient;
let numericSheetId;

const blankTicketTimeouts = new Map();
const EPHEMERAL_DELETE_DELAY = 10000;

async function replyEphemeralAutoDelete(interaction, options, isFollowUp = false, isEdit = false) { /* ... same as v17/full_bot_env_vars_clean_v2 ... */ }
async function ensureSheetHeaders() { /* ... same as v17/full_bot_env_vars_clean_v2 ... */ }

async function authorizeGoogleAPIs() {
    console.log("[GAPI_AUTH_DEBUG] Starting Google API authorization...");
    try {
        if (!GOOGLE_CREDENTIALS_JSON_CONTENT) {
            console.error("[GAPI_ERROR_AUTH] GOOGLE_CREDENTIALS_JSON environment variable is not set or is empty.");
            return false;
        }
        console.log("[GAPI_AUTH_DEBUG] GOOGLE_CREDENTIALS_JSON content length:", GOOGLE_CREDENTIALS_JSON_CONTENT.length);
        // console.log("[GAPI_AUTH_DEBUG] First 100 chars of GOOGLE_CREDENTIALS_JSON:", GOOGLE_CREDENTIALS_JSON_CONTENT.substring(0, 100)); // For deep debug if needed

        let googleCredentials;
        try {
            googleCredentials = JSON.parse(GOOGLE_CREDENTIALS_JSON_CONTENT);
            console.log("[GAPI_AUTH_DEBUG] Successfully parsed GOOGLE_CREDENTIALS_JSON.");
        } catch (parseError) {
            console.error("[GAPI_ERROR_AUTH] Failed to parse GOOGLE_CREDENTIALS_JSON. Ensure it's a valid JSON string passed correctly as a secret.", parseError);
            console.error("[GAPI_AUTH_DEBUG] Raw GOOGLE_CREDENTIALS_JSON (first 200 chars):", GOOGLE_CREDENTIALS_JSON_CONTENT.substring(0,200));
            return false;
        }
        
        if (!SPREADSHEET_ID) { console.error('[GAPI_ERROR_AUTH] SPREADSHEET_ID missing from environment variables.'); return false; }
        if (!SHEET_NAME) { console.error('[GAPI_ERROR_AUTH] SHEET_NAME missing from environment variables.'); return false; }
        if (!DRIVE_FOLDER_ID) { console.error('[GAPI_ERROR_AUTH] GOOGLE_DRIVE_FOLDER_ID missing from environment variables.'); return false; }

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
            await ensureSheetHeaders();
        } else {
            console.error(`[GSHEETS_ERROR] Could not find sheet named '${SHEET_NAME}' in spreadsheet '${SPREADSHEET_ID}'. Ensure it exists.`);
            // This could be a reason for overall auth to "fail" for bot operations
            return false;
        }
        console.log("[GAPI_AUTH_DEBUG] Google API authorization and sheet check successful.");
        return true;
    } catch (error) {
        console.error('[GAPI_ERROR_AUTH] Overall failure in authorizeGoogleAPIs:', error.message);
        console.error('[GAPI_ERROR_AUTH_FULL_STACK]', error); // Log full error stack
        return false;
    }
}

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
        // ... (debug logs for each env var from previous version) ...
        process.exit(1);
    }

    if (!await authorizeGoogleAPIs()) { // This await is important
        console.error("[FATAL_EXIT] Failed to authorize Google APIs. Bot cannot continue with full functionality. Exiting.");
        process.exit(1); // Ensure bot exits if Google API auth fails
    }

    loadGuildConfigs();
    const client = new Client({ /* ... intents & partials ... */ });
    client.updatePromptMessage = updatePromptMessage;
    client.commands = new Collection();
    const commandsPath = path.join(__dirname, 'commands');
    try { /* ... command loading ... */ } catch (error) { /* ... */ }

    client.once(Events.ClientReady, readyClient => { /* ... same ... */ });
    client.on(Events.InteractionCreate, async interaction => { /* ... same interaction logic, ensure deferReply and replyHelper are used ... */ });
    client.on(Events.MessageCreate, async message => { /* ... same message creation logic for daily slot format ... */ });
    client.on(Events.ChannelDelete, channel => { /* ... same ... */ });

    try {
        await client.login(TOKEN);
        console.log("Login to Discord successful!");
    } catch (error) { /* ... same login error handling ... */ process.exit(1); }

    console.log("[INFO] Bot is running and listening for events. Process will be kept alive.");
    await new Promise(() => {});
})();

