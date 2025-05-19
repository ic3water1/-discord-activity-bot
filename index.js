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

async function replyEphemeralAutoDelete(interaction, options, isFollowUp = false, isEdit = false) { /* ... same as v17/full_bot_env_vars_clean_v2 ... */ }
async function ensureSheetHeaders() { /* ... same as v17/full_bot_env_vars_clean_v2 ... */ }
async function authorizeGoogleAPIs() { /* ... same as v17/full_bot_env_vars_clean_v2 ... */ }
const GUILD_CONFIGS_PATH = path.join(__dirname, 'guild-configs.json');
let guildConfigs = {};
let openTickets = {};
function loadGuildConfigs() { /* ... same ... */ }
function saveGuildConfigs() { /* ... same ... */ }
function formatTimestamp(date, includeSeconds = false, dateOnly = false) { /* ... same (MM-DD-YY format) ... */ }
async function clearSheetWeekly() { /* ... This is the clearSheet function from v19 (renamed for clarity) ... */ }
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
        console.error("[FATAL_EXIT] Failed to authorize Google APIs. Bot cannot continue with full functionality. Exiting.");
        process.exit(1);
    }
    loadGuildConfigs();

    // --- DEBUGGING INTENTS ---
    console.log("[INTENT_DEBUG] Checking GatewayIntentBits values before Client instantiation:");
    console.log(`[INTENT_DEBUG]   typeof GatewayIntentBits: ${typeof GatewayIntentBits}`);
    console.log(`[INTENT_DEBUG]   GatewayIntentBits.Guilds: ${GatewayIntentBits?.Guilds}`);
    console.log(`[INTENT_DEBUG]   GatewayIntentBits.GuildMessages: ${GatewayIntentBits?.GuildMessages}`);
    console.log(`[INTENT_DEBUG]   GatewayIntentBits.MessageContent: ${GatewayIntentBits?.MessageContent}`);
    console.log(`[INTENT_DEBUG]   GatewayIntentBits.GuildMembers: ${GatewayIntentBits?.GuildMembers}`);
    console.log(`[INTENT_DEBUG]   GatewayIntentBits.GuildMessageReactions: ${GatewayIntentBits?.GuildMessageReactions}`);

    const intentsArray = [];
    if (GatewayIntentBits && typeof GatewayIntentBits === 'object') {
        if (GatewayIntentBits.Guilds) intentsArray.push(GatewayIntentBits.Guilds);
        if (GatewayIntentBits.GuildMessages) intentsArray.push(GatewayIntentBits.GuildMessages);
        if (GatewayIntentBits.MessageContent) intentsArray.push(GatewayIntentBits.MessageContent);
        if (GatewayIntentBits.GuildMembers) intentsArray.push(GatewayIntentBits.GuildMembers);
        if (GatewayIntentBits.GuildMessageReactions) intentsArray.push(GatewayIntentBits.GuildMessageReactions);
    }
    console.log("[INTENT_DEBUG] Constructed intentsArray:", intentsArray);
    if (intentsArray.length === 0) {
        console.error("[INTENT_DEBUG_ERROR] intentsArray is empty! This will cause ClientMissingIntents.");
    }
    // --- END DEBUGGING INTENTS ---

    const client = new Client({
        intents: intentsArray, // Use the constructed and verified array
        partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    });

    client.updatePromptMessage = updatePromptMessage;
    client.commands = new Collection();
    const commandsPath = path.join(__dirname, 'commands');
    try { /* ... command loading ... */ } catch (error) { /* ... */ }

    client.once(Events.ClientReady, readyClient => { /* ... same ... */ });
    client.on(Events.InteractionCreate, async interaction => { /* ... same interaction logic with debugging ... */ });
    client.on(Events.MessageCreate, async message => { /* ... same message creation logic for daily slot format ... */ });
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

