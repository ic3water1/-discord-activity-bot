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
const EXPECTED_HEADERS = [ /* ... 9 headers for daily slot format ... */ ];
// ... other constants for sheet columns ...

let sheetsClient;
let driveClient;
let googleAuthClient;
let numericSheetId;

const blankTicketTimeouts = new Map();
const EPHEMERAL_DELETE_DELAY = 10000;

async function replyEphemeralAutoDelete(interaction, options, isFollowUp = false, isEdit = false) { /* ... same ... */ }
async function ensureSheetHeadersAndStructure() { /* ... same as v19 ... */ }
async function authorizeGoogleAPIs() { /* ... same as v19 ... */ }
const GUILD_CONFIGS_PATH = path.join(__dirname, 'guild-configs.json');
let guildConfigs = {};
let openTickets = {};
function loadGuildConfigs() { /* ... same ... */ }
function saveGuildConfigs() { /* ... same ... */ }
function formatTimestamp(date, dateOnly = false) { /* ... same as v19 ... */ }
async function clearSheetWeekly() { /* ... same as v19 ... */ }
async function autoResizeSheetColumns() { /* ... same as v19 ... */ }
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
        console.error("[FATAL] Failed to authorize Google APIs. Bot will exit.");
        process.exit(1); // Exit if Google API auth fails
    }
    loadGuildConfigs();

    // --- DEBUGGING INTENTS ---
    console.log("[INTENT_DEBUG] Checking GatewayIntentBits values:");
    console.log(`[INTENT_DEBUG] GatewayIntentBits.Guilds: ${GatewayIntentBits.Guilds}`);
    console.log(`[INTENT_DEBUG] GatewayIntentBits.GuildMessages: ${GatewayIntentBits.GuildMessages}`);
    console.log(`[INTENT_DEBUG] GatewayIntentBits.MessageContent: ${GatewayIntentBits.MessageContent}`);
    console.log(`[INTENT_DEBUG] GatewayIntentBits.GuildMembers: ${GatewayIntentBits.GuildMembers}`);
    console.log(`[INTENT_DEBUG] GatewayIntentBits.GuildMessageReactions: ${GatewayIntentBits.GuildMessageReactions}`);

    const intentsArray = [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions,
    ];
    console.log("[INTENT_DEBUG] Constructed intentsArray:", intentsArray);
    // --- END DEBUGGING INTENTS ---

    const client = new Client({
        intents: intentsArray, // Use the constructed array
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
    client.on(Events.InteractionCreate, async interaction => { /* ... same interaction logic with debugging ... */ });
    client.on(Events.MessageCreate, async message => { /* ... same message creation logic for daily slot format ... */ });
    client.on(Events.ChannelDelete, channel => { /* ... same ... */ });

    try {
        await client.login(TOKEN);
        console.log("Login to Discord successful!");
    } catch (error) {
        console.error("\n[FATAL ERROR] Failed to log in to Discord:", error.message);
        if (error.code === 'ClientMissingIntents') {
            console.error("[FATAL_LOGIN_ERROR] ClientMissingIntents error during login. This should have been caught earlier if intentsArray was bad.");
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

